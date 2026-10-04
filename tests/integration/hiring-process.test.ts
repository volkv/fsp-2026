import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { sha256Hex } from '$lib/server/auth/secrets';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	candidates,
	consentEvents,
	demoSessions,
	hiringProcesses,
	jobs,
	matchRulesets,
	notifications,
	productPolicies
} from '$lib/server/db/schema';
import { careerFunnel } from '$lib/server/hiring/funnel';
import { createHiringOutcomeRequestHandler } from '$lib/server/hiring/jobs';
import { getHiringProcess, reportHiring } from '$lib/server/hiring/process';
import { uuidv7 } from '$lib/server/ids';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import { Refusal } from '$lib/server/invitations/errors';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import type { JobPayload, JobType } from '$lib/server/jobs/registry';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser
} from '../helpers/factories';

const DAY = 86_400_000;
const EPOCH = new Date(Date.now() - 400 * DAY);

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure', { id: string }>;
let clock = new Date();
let deps: InvitationDeps;
const meta: RequestMeta = { requestId: 'test-request' };

const operator: AccessSubject = {
	userId: uuidv7(),
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: true, admin: false, extraPermissions: [] }
};

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	deps = { db, crypto, now: () => clock };
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', { publishedAt: EPOCH }),
		catalog: await createPublishedDocument(db, 'catalog_visibility', { publishedAt: EPOCH }),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', { publishedAt: EPOCH })
	};
	await db.insert(productPolicies).values([
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'other'],
				reason_required: true,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom: EPOCH
		},
		{
			kind: 'hiring_policy',
			version: 1,
			params: {
				outcome_due_days: 30,
				reminder_intervals_days: [7],
				max_reminders: 2,
				stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
				outcome_reason_codes: ['salary', 'other']
			},
			effectiveFrom: EPOCH
		},
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom: EPOCH }
	]);
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function employer(options: { demoSessionId?: string } = {}) {
	const { db } = database;
	const demoSessionId = options.demoSessionId ?? null;
	const company = await createCompany(db, { demoSessionId });
	const member = await createMember(db, company.id, { userId: (await createUser(db, { demoSessionId })).id });
	if (!member.userId) throw new Error('member without user');
	const vacancy = await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId });
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, member, vacancy, subject, userId: member.userId };
}

async function candidate(options: { seed?: boolean; region?: string; demoSessionId?: string } = {}) {
	const { db } = database;
	const demoSessionId = options.demoSessionId ?? null;
	const row = await createCandidate(db, {
		userId: (await createUser(db, { demoSessionId })).id,
		demoSessionId,
		visibility: 'catalog',
		seedBatchId: options.seed ? 'demo-1' : null,
		preferences: options.region === undefined ? {} : { region_code: options.region }
	});
	for (const kind of ['pd_processing', 'catalog_visibility'] as const) {
		await db.insert(consentEvents).values({
			subjectCandidateId: row.id,
			kind,
			documentId: kind === 'pd_processing' ? documents.pd.id : documents.catalog.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: row.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(EPOCH.getTime() + DAY)
		});
	}
	const subject: AccessSubject = {
		userId: row.userId,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { ...row, subject };
}

/** An invitation accepted at the current clock: returns the process. */
async function acceptedProcess(
	company: Awaited<ReturnType<typeof employer>>,
	person: Awaited<ReturnType<typeof candidate>>
) {
	const sent = await createInvitation(deps, company.subject, meta, {
		vacancyId: company.vacancy.id,
		candidateId: person.id,
		salaryMin: 260_000,
		salaryMax: 300_000
	});
	const answer = await respondToInvitation(deps, person.subject, meta, sent.invitationId, {
		termsId: sent.termsId,
		decision: 'accept',
		discloseFields: ['full_name', 'email'],
		disclosureDocumentId: documents.disclosure.id
	});
	if (!answer.processId) throw new Error('no process');
	return { processId: answer.processId, invitationId: sent.invitationId };
}

async function runJob<T extends JobType>(handler: JobHandler<T>, payload: JobPayload<T>): Promise<boolean> {
	const { db } = database;
	const result = await handler.run({
		job: {
			id: uuidv7(),
			type: handler.type,
			payload,
			inputVersion: 'test',
			attempt: 1,
			maxAttempts: 3,
			leaseOwner: 'test'
		},
		db,
		signal: new AbortController().signal,
		requestId: 'job:test',
		log: createLogger({}, () => undefined)
	});
	return db.transaction(async (tx) => {
		const current = await result.isCurrent(tx);
		if (current) await result.write(tx);
		return current;
	});
}

async function refusal(operation: Promise<unknown>): Promise<Refusal> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Refusal) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

const typesOf = async (userId: string) =>
	(
		await database.db.select({ type: notifications.type }).from(notifications).where(eq(notifications.userId, userId))
	).map((n) => n.type);

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('hiring outcomes', () => {
	it('show a divergence to both sides without the other side’s reasons', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const { processId } = await acceptedProcess(company, person);

		await reportHiring(deps, company.subject, meta, processId, {
			party: 'company',
			kind: 'outcome',
			outcome: 'hired',
			startDate: '2026-11-02'
		});
		const diverged = await reportHiring(deps, person.subject, meta, processId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: 'not_hired',
			reasonCode: 'salary'
		});
		expect(diverged.state.outcome).toBe('diverged');
		expect(await typesOf(person.userId)).toContain('hiring.reports_diverged');
		expect(await typesOf(company.userId)).toContain('hiring.reports_diverged');

		const asCompany = await getHiringProcess(deps, company.subject, processId);
		expect(asCompany).toMatchObject({ viewer: 'company', outcome: 'diverged', otherSideDiffers: true });
		const candidateReport = asCompany.reports.find((r) => r.party === 'candidate');
		expect(candidateReport).toMatchObject({ outcome: 'not_hired', reasonCode: null });
		const asCandidate = await getHiringProcess(deps, person.subject, processId);
		expect(asCandidate.reports.find((r) => r.party === 'candidate')?.reasonCode).toBe('salary');

		// A side corrects only its own report, explicitly; a second outcome without a correction is refused.
		const repeated = await refusal(
			reportHiring(deps, person.subject, meta, processId, { party: 'candidate', kind: 'outcome', outcome: 'hired' })
		);
		expect([repeated.code, repeated.reason]).toEqual(['conflict', 'outcome_already_reported']);
		const impostor = await refusal(
			reportHiring(deps, person.subject, meta, processId, { party: 'company', kind: 'outcome', outcome: 'not_hired' })
		);
		expect(impostor.code).toBe('not_found');
		const corrected = await reportHiring(deps, person.subject, meta, processId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: 'hired',
			supersedesReportId: candidateReport?.id
		});
		expect(corrected.state).toMatchObject({ outcome: 'confirmed', result: 'hired' });
	});

	it('keep a silent process unknown after the reminders, never «not hired»', async () => {
		// The process is opened now and read 60 days later: past the due date and every reminder.
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const { processId } = await acceptedProcess(company, person);
		clock = new Date(Date.now() + 60 * DAY);

		const [process] = await database.db.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId));
		if (!process) throw new Error('no process');
		const handler = createHiringOutcomeRequestHandler({ now: () => clock });
		expect(await runJob(handler, { process_id: processId, reminder: 0 })).toBe(true);
		expect(await typesOf(person.userId)).toContain('hiring.outcome_requested');
		expect(await typesOf(company.userId)).toContain('hiring.outcome_requested');
		expect(await runJob(handler, { process_id: processId, reminder: 1 })).toBe(true);
		expect(await runJob(handler, { process_id: processId, reminder: 2 })).toBe(true);
		expect((await typesOf(person.userId)).filter((t) => t === 'hiring.outcome_reminder')).toHaveLength(2);

		// Each request enqueues the next one until the maximum of the policy.
		const scheduled = await database.db
			.select({ key: jobs.dedupKey, runAfter: jobs.runAfter })
			.from(jobs)
			.where(eq(jobs.type, 'hiring.outcome_request'));
		const ofProcess = scheduled.filter((job) => job.key?.startsWith(`hiring.outcome:${processId}:`));
		expect(ofProcess.map((job) => job.key).sort()).toEqual([
			`hiring.outcome:${processId}:0`,
			`hiring.outcome:${processId}:1`,
			`hiring.outcome:${processId}:2`
		]);
		const reminderTwo = ofProcess.find((job) => job.key?.endsWith(':2'));
		expect(reminderTwo?.runAfter.getTime()).toBe(process.outcomeDueAt.getTime() + 14 * DAY);

		expect((await getHiringProcess(deps, person.subject, processId)).outcome).toBe('unknown');

		// A late report turns unknown into a one-sided report, and the requests stop.
		const late = await reportHiring(deps, person.subject, meta, processId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: 'hired'
		});
		expect(late.state.outcome).toBe('single_party');
		await reportHiring(deps, company.subject, meta, processId, { party: 'company', kind: 'outcome', outcome: 'hired' });
		expect(await runJob(handler, { process_id: processId, reminder: 2 })).toBe(false);
	});

	it('does not let a suspended company report, the candidate still may', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const { processId } = await acceptedProcess(company, person);
		const suspended: AccessSubject = {
			...company.subject,
			membership: company.subject.membership && { ...company.subject.membership, companyStatus: 'suspended' }
		};
		const denied = await refusal(
			reportHiring(deps, suspended, meta, processId, { party: 'company', kind: 'stage', stage: 'interview_scheduled' })
		);
		expect(denied.code).toBe('forbidden');
		await reportHiring(deps, person.subject, meta, processId, {
			party: 'candidate',
			kind: 'stage',
			stage: 'interview_done'
		});
		const denyOperator = await refusal(
			reportHiring(deps, operator, meta, processId, { party: 'company', kind: 'outcome', outcome: 'hired' })
		);
		expect(denyOperator.code).toBe('not_found');
	});

	it('are hidden from a company of another demo session: neither read nor reported', async () => {
		clock = new Date();
		const { db } = database;
		const session = async () => {
			const [row] = await db
				.insert(demoSessions)
				.values({
					joinTokenSha256: sha256Hex(randomUUID()),
					seedBatchId: 'demo-1',
					expiresAt: new Date(Date.now() + DAY)
				})
				.returning({ id: demoSessions.id });
			if (!row) throw new Error('demo session not inserted');
			return row.id;
		};
		const [own, other] = [await session(), await session()];
		const company = await employer({ demoSessionId: own });
		const person = await candidate({ demoSessionId: own });
		const { processId } = await acceptedProcess(company, person);
		const stranger = await employer({ demoSessionId: other });

		expect((await refusal(getHiringProcess(deps, stranger.subject, processId))).code).toBe('not_found');
		const denied = await refusal(
			reportHiring(deps, stranger.subject, meta, processId, { party: 'company', kind: 'outcome', outcome: 'hired' })
		);
		expect([denied.code, denied.reason]).toEqual(['not_found', 'not_party']);
		expect((await getHiringProcess(deps, company.subject, processId)).reports).toEqual([]);
	});
});

describe('career funnel', () => {
	it('counts the stages separately, with sources, small cells hidden and seeds marked', async () => {
		// Invitations of this test are sent in the future, so the period filter leaves out those of other tests.
		clock = new Date(Date.now() + 100 * DAY);
		const sentAt = clock;
		const since = new Date(clock.getTime() - 1000);
		const company = await employer();
		const people = await Promise.all(Array.from({ length: 6 }, (_, i) => candidate({ seed: i === 0 })));
		const processes = [];
		for (const person of people) processes.push({ person, ...(await acceptedProcess(company, person)) });
		const extra = await candidate();
		await createInvitation(deps, company.subject, meta, {
			vacancyId: company.vacancy.id,
			candidateId: extra.id,
			salaryMin: 260_000,
			salaryMax: 300_000
		});
		clock = new Date(sentAt.getTime() + 45 * DAY);

		for (const { person, processId } of processes.slice(0, 5)) {
			await reportHiring(deps, company.subject, meta, processId, {
				party: 'company',
				kind: 'stage',
				stage: 'interview_done'
			});
			await reportHiring(deps, person.subject, meta, processId, {
				party: 'candidate',
				kind: 'stage',
				stage: 'interview_done'
			});
			await reportHiring(deps, company.subject, meta, processId, {
				party: 'company',
				kind: 'outcome',
				outcome: 'hired'
			});
			await reportHiring(deps, person.subject, meta, processId, {
				party: 'candidate',
				kind: 'outcome',
				outcome: 'hired'
			});
		}

		const denied = await refusal(careerFunnel(deps, company.subject, { dimensions: [] }));
		expect(denied.code).toBe('forbidden');

		const funnel = await careerFunnel(deps, operator, { dimensions: [], from: since });
		expect(funnel.threshold).toBe(5);
		expect(funnel.groups).toEqual([]);
		expect(funnel.total).toMatchObject({
			key: 'all',
			synthetic: true,
			invited: { value: 7 },
			contact: { value: 6 },
			interview: { total: { value: 5 }, bySource: { both: { value: 5 }, company: { value: 0 } } },
			offer: { total: { value: 0 } },
			hired: { confirmed: { value: 5 }, diverged: { value: 0 } },
			// One process is silent: 45 days after acceptance it is pending past the due date — shown as unknown,
			// in a cell too small to show.
			unknown: { below: 5 }
		});

		const [seeded] = await database.db
			.select()
			.from(candidates)
			.where(eq(candidates.id, people[0]?.id ?? ''));
		expect(seeded?.seedBatchId).toBe('demo-1');
		const byMonth = await careerFunnel(deps, operator, { dimensions: ['month'], from: since });
		expect(byMonth.groups.map((g) => g.key)).toEqual([sentAt.toISOString().slice(0, 7)]);
	});

	it('groups by the region of the candidate and pools the small groups until the pool is not small', async () => {
		// A period of its own, after the invitations of the other tests.
		clock = new Date(Date.now() + 200 * DAY);
		const since = new Date(clock.getTime() - 1000);
		const company = await employer();
		const people = [
			...(await Promise.all(Array.from({ length: 5 }, () => candidate({ region: 'RU-MOW' })))),
			await candidate({ region: 'RU-SPE' }),
			await candidate()
		];
		for (const person of people) await acceptedProcess(company, person);

		const byRegion = await careerFunnel(deps, operator, { dimensions: ['region'], from: since });
		expect(byRegion.dimensions).toEqual(['region']);
		// RU-SPE and «not given» have one candidate each; the pool of two is still small, so it takes the next smallest
		// group too — otherwise the total minus RU-MOW would give the two away.
		expect(byRegion.groups.map((g) => [g.key, g.pooled, g.invited, g.contact])).toEqual([
			['__small__', 3, { value: 7 }, { value: 7 }]
		]);
		const moscow = [
			...(await Promise.all(Array.from({ length: 5 }, () => candidate({ region: 'RU-MOW' })))),
			...(await Promise.all(Array.from({ length: 3 }, () => candidate({ region: 'RU-KDA' }))))
		];
		for (const person of moscow) await acceptedProcess(company, person);
		const wider = await careerFunnel(deps, operator, { dimensions: ['region'], from: since });
		expect(wider.groups.map((g) => [g.key, g.pooled, g.invited])).toEqual([
			['RU-MOW', 0, { value: 10 }],
			['__small__', 3, { value: 5 }]
		]);
	});
});
