import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	consentEvents,
	disclosures,
	documentAcceptances,
	hiringProcesses,
	invitations,
	invitationTerms,
	jobs,
	legalRepresentatives,
	matchRulesets,
	matchScores,
	notifications,
	productPolicies,
	representations,
	users,
	vacancies
} from '$lib/server/db/schema';
import { getHiringProcess, reportHiring } from '$lib/server/hiring/process';
import { uuidv7 } from '$lib/server/ids';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import { recipientContacts, revokeDisclosureConsent } from '$lib/server/invitations/disclosure';
import { Refusal } from '$lib/server/invitations/errors';
import { createInvitationExpireHandler, createInvitationRemindDueHandler } from '$lib/server/invitations/jobs';
import { getInvitation, listInvitations } from '$lib/server/invitations/read';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, reviseInvitation, withdrawInvitation } from '$lib/server/invitations/send';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import type { JobPayload, JobType } from '$lib/server/jobs/registry';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { storedComponent } from '$lib/server/matching/storage';
import { closeOwnVacancy } from '$lib/server/vacancies/own';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	randomSha256
} from '../helpers/factories';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Everything shared is dated well before any clock a test moves back to. */
const EPOCH = new Date(Date.now() - 400 * DAY);

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

let database: TestDatabase;
let taxonomyVersionId: string;
let documents: Record<'pd' | 'catalog' | 'disclosure' | 'minorTerms', { id: string }>;
let clock = new Date();
let deps: InvitationDeps;
const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };

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
	const published = { publishedAt: EPOCH };
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', published),
		catalog: await createPublishedDocument(db, 'catalog_visibility', published),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', published),
		minorTerms: await createPublishedDocument(db, 'minor_employment_terms', published)
	};
	await db.insert(productPolicies).values([
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'format', 'stack', 'not_looking', 'other'],
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
		{
			kind: 'notification_policy',
			version: 1,
			params: { response_due_reminder_hours: [24, 2] },
			effectiveFrom: EPOCH
		},
		{
			kind: 'minor_policy',
			version: 1,
			params: { enabled: true, authority_methods: ['in_person'] },
			effectiveFrom: EPOCH
		}
	]);
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCMonth(0, 15);
	return date.toISOString().slice(0, 10);
};

async function employer(options: { status?: 'verified' | 'submitted'; minorTerms?: boolean } = {}) {
	const { db } = database;
	const status = options.status ?? 'verified';
	const company = await createCompany(db, { status });
	const member = await createMember(db, company.id);
	if (!member.userId) throw new Error('member without user');
	let minorTermsAcceptanceId: string | null = null;
	if (options.minorTerms) {
		const [acceptance] = await db
			.insert(documentAcceptances)
			.values({ documentId: documents.minorTerms.id, userId: member.userId, companyId: company.id, acceptedAt: EPOCH })
			.returning();
		if (!acceptance) throw new Error('acceptance not inserted');
		minorTermsAcceptanceId = acceptance.id;
	}
	const vacancy = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId },
		{ salaryMin: 250_000, salaryMax: 350_000 }
	);
	const subject: AccessSubject = {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: { memberId: member.id, companyId: company.id, role: 'owner', status: 'active', companyStatus: status },
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, member, vacancy, subject, userId: member.userId, minorTermsAcceptanceId };
}

async function consent(
	candidateId: string,
	userId: string,
	kind: 'pd_processing' | 'catalog_visibility',
	extra: { action?: 'grant' | 'revoke'; representationId?: string; at?: Date } = {}
) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind,
		documentId: kind === 'pd_processing' ? documents.pd.id : documents.catalog.id,
		action: extra.action ?? 'grant',
		...(extra.representationId
			? { signerKind: 'representative' as const, representationId: extra.representationId }
			: { signerKind: 'subject' as const, signerUserId: userId }),
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: extra.at ?? new Date(EPOCH.getTime() + DAY)
	});
}

async function candidate(options: { birthYearsAgo?: number; catalogConsent?: boolean } = {}) {
	const { db } = database;
	const email = `candidate-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email)
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	const row = await createCandidate(db, {
		userId: user.id,
		birthDate: yearsAgo(options.birthYearsAgo ?? 28),
		visibility: 'catalog',
		lastNameEnc: crypto.encrypt('Иванова', 'candidates.last_name'),
		firstNameEnc: crypto.encrypt('Анна', 'candidates.first_name'),
		phoneEnc: crypto.encrypt('+79990001122', 'candidates.phone')
	});
	const adult = (options.birthYearsAgo ?? 28) >= 18;
	if (adult) {
		await consent(row.id, user.id, 'pd_processing');
		if (options.catalogConsent !== false) await consent(row.id, user.id, 'catalog_visibility');
	}
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { ...row, email, subject };
}

/** A candidate aged 16 with the consents of the subject and of a representative in the given state. */
async function minor(representativeStatus: 'authority_pending' | 'authority_verified') {
	const { db } = database;
	const row = await candidate({ birthYearsAgo: 16 });
	const [representative] = await db
		.insert(legalRepresentatives)
		.values({ fullNameEnc: randomBytes(32), emailEnc: randomBytes(32), emailHmac: randomSha256() })
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: row.id,
			representativeId: representative.id,
			relation: 'parent',
			status: representativeStatus,
			invitedAt: EPOCH,
			contactConfirmedAt: EPOCH
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	for (const kind of ['pd_processing', 'catalog_visibility'] as const) {
		await consent(row.id, row.userId, kind);
		await consent(row.id, row.userId, kind, { representationId: representation.id });
	}
	return { ...row, representationId: representation.id };
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

async function send(
	company: Awaited<ReturnType<typeof employer>>,
	person: { id: string },
	salary: [number, number] = [300_000, 340_000]
) {
	return createInvitation(deps, company.subject, meta, {
		vacancyId: company.vacancy.id,
		candidateId: person.id,
		salaryMin: salary[0],
		salaryMax: salary[1],
		message: 'Здравствуйте! Приглашаем на собеседование.'
	});
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

async function notificationsOf(userId: string) {
	return database.db.select().from(notifications).where(eq(notifications.userId, userId));
}

const accept = (
	person: { subject: AccessSubject },
	invitationId: string,
	termsId: string,
	fields = ['full_name', 'email']
) =>
	respondToInvitation(deps, person.subject, meta, invitationId, {
		termsId,
		decision: 'accept',
		discloseFields: fields,
		disclosureDocumentId: documents.disclosure.id
	});

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('the reverse flow', () => {
	it('goes from an invitation to a start confirmed by both sides', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();

		const sent = await send(company, person);
		expect(sent.version).toBe(1);
		expect(sent.responseDueAt.getTime()).toBe(clock.getTime() + 72 * HOUR);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row).toMatchObject({ status: 'sent', currentTermsId: sent.termsId, sentByMemberId: company.member.id });
		const [terms] = await database.db.select().from(invitationTerms).where(eq(invitationTerms.id, sent.termsId));
		// Currency, period and tax base come from the vacancy.
		expect(terms).toMatchObject({
			salaryMin: 300_000,
			salaryMax: 340_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			changes: null
		});
		expect((await notificationsOf(person.userId)).map((n) => n.type)).toEqual(['invitation.received']);
		const scheduled = await database.db
			.select({ type: jobs.type, runAfter: jobs.runAfter })
			.from(jobs)
			.where(eq(jobs.inputVersion, sent.termsId));
		expect(scheduled.map((job) => job.type).sort()).toEqual(['invitation.expire', 'invitation.remind_due']);

		expect(await markInvitationViewed(deps, person.subject, sent.invitationId)).toBe('viewed');
		const answer = await accept(person, sent.invitationId, sent.termsId, ['full_name', 'email', 'phone']);
		expect(answer).toMatchObject({ status: 'accepted', disclosedFields: ['full_name', 'email', 'phone'] });
		if (!answer.processId) throw new Error('no hiring process');

		const [disclosure] = await database.db
			.select()
			.from(disclosures)
			.where(eq(disclosures.invitationId, sent.invitationId));
		expect(disclosure).toMatchObject({
			candidateId: person.id,
			companyId: company.company.id,
			recipientMemberId: company.member.id,
			fields: ['full_name', 'email', 'phone'],
			channel: 'ui'
		});
		expect((await notificationsOf(company.userId)).map((n) => n.type)).toEqual(['invitation.answered']);

		const contacts = await recipientContacts(deps, company.subject, meta, sent.invitationId);
		expect(contacts).toMatchObject({
			candidateId: person.id,
			fullName: { last: 'Иванова', first: 'Анна', middle: null },
			email: person.email,
			phone: '+79990001122'
		});
		expect(contacts.resumeFileId).toBeUndefined();

		// The invitation status never carries hiring stages.
		await reportHiring(deps, company.subject, meta, answer.processId, {
			party: 'company',
			kind: 'stage',
			stage: 'interview_scheduled'
		});
		await reportHiring(deps, person.subject, meta, answer.processId, {
			party: 'candidate',
			kind: 'stage',
			stage: 'interview_done'
		});
		await reportHiring(deps, company.subject, meta, answer.processId, {
			party: 'company',
			kind: 'stage',
			stage: 'offer_made'
		});
		const single = await reportHiring(deps, company.subject, meta, answer.processId, {
			party: 'company',
			kind: 'outcome',
			outcome: 'hired',
			startDate: '2026-11-02'
		});
		expect(single.state.outcome).toBe('single_party');
		const confirmed = await reportHiring(deps, person.subject, meta, answer.processId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: 'hired'
		});
		expect(confirmed.state).toMatchObject({
			outcome: 'confirmed',
			result: 'hired',
			stage: { stage: 'offer_made', reportedBy: ['company'] }
		});
		expect(confirmed.state.confirmedAt).toEqual(clock);

		const [after] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(after?.status).toBe('accepted');
		const view = await getHiringProcess(deps, person.subject, answer.processId);
		expect(view).toMatchObject({ viewer: 'candidate', outcome: 'confirmed', otherSideDiffers: false });

		const journal = await database.db
			.select({ action: auditEvents.action })
			.from(auditEvents)
			.where(eq(auditEvents.subjectCandidateId, person.id));
		expect(journal.map((e) => e.action)).toEqual(
			expect.arrayContaining([
				'invitation.sent',
				'consent.granted',
				'contacts.disclosed',
				'invitation.responded',
				'card.viewed_recipient',
				'hiring.reported'
			])
		);
	});

	it('keeps the match of the pair at the first sending, however low: «why invited»', async () => {
		clock = new Date();
		const company = await employer();
		// No categorization run: nothing confirmed, the score is far below any store threshold.
		const person = await candidate();

		const sent = await send(company, person);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		if (!row?.matchScoreId) throw new Error('the invitation does not refer to its match');
		const [match] = await database.db.select().from(matchScores).where(eq(matchScores.id, row.matchScoreId));
		expect(match).toMatchObject({
			vacancyId: company.vacancy.id,
			vacancyRevision: company.vacancy.revision,
			candidateId: person.id,
			candidateRevision: person.profileRevision,
			categorizationRunId: null,
			jobId: null
		});
		expect(Number(match?.score)).toBeLessThan(0.3);
		expect(match && storedComponent(match, 'required')).toEqual({ status: 'unavailable', value: null });
		expect(match && storedComponent(match, 'reranker')).toEqual({ status: 'unavailable', value: null });
	});

	it('shows the invitation only to its company and its candidate', async () => {
		clock = new Date();
		const company = await employer();
		const other = await employer();
		const person = await candidate();
		const stranger = await candidate();
		const sent = await send(company, person);

		const asCompany = await getInvitation(deps, company.subject, sent.invitationId);
		expect(asCompany).toMatchObject({
			viewer: 'company',
			candidatePseudonym: crypto.pseudonym(person.id, company.company.id)
		});
		const asCandidate = await getInvitation(deps, person.subject, sent.invitationId);
		expect(asCandidate).toMatchObject({ viewer: 'candidate', candidatePseudonym: null, companyName: 'Пример' });
		expect((await refusal(getInvitation(deps, other.subject, sent.invitationId))).code).toBe('not_found');
		expect((await refusal(getInvitation(deps, stranger.subject, sent.invitationId))).code).toBe('not_found');
		expect((await listInvitations(deps, person.subject, 'candidate')).map((i) => i.id)).toEqual([sent.invitationId]);
		expect(await listInvitations(deps, other.subject, 'company')).toEqual([]);
	});
});

describe('refusals of an invitation', () => {
	it('gives another company’s vacancy 404', async () => {
		clock = new Date();
		const owner = await employer();
		const foreign = await employer();
		const person = await candidate();
		const error = await refusal(
			createInvitation(deps, foreign.subject, meta, {
				vacancyId: owner.vacancy.id,
				candidateId: person.id,
				salaryMin: 300_000,
				salaryMax: 340_000
			})
		);
		expect([error.code, error.reason]).toEqual(['not_found', 'foreign_vacancy']);
		const [denied] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'invitation.sent'), eq(auditEvents.subjectCandidateId, person.id)));
		expect(denied).toMatchObject({ outcome: 'denied', details: { reason: 'foreign_vacancy' } });
	});

	it('forbids a member of an unverified company', async () => {
		clock = new Date();
		const company = await employer({ status: 'submitted' });
		const person = await candidate();
		const error = await refusal(send(company, person));
		expect([error.code, error.reason]).toEqual(['forbidden', 'company_not_verified']);
	});

	it('refuses an external vacancy as not invitable', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const external = await createExternalVacancy(database.db, taxonomyVersionId, {
			salaryMin: 200_000,
			salaryMax: 300_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			claimedCompanyId: company.company.id
		});
		const error = await refusal(
			createInvitation(deps, company.subject, meta, {
				vacancyId: external.id,
				candidateId: person.id,
				salaryMin: 250_000,
				salaryMax: 300_000
			})
		);
		expect(error.code).toBe('policy_violation');
		expect(error.details?.[0]?.code).toBe('vacancy_not_invitable');
	});

	it('does not reveal a candidate who revoked the catalog consent', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		await consent(person.id, person.userId, 'catalog_visibility', {
			action: 'revoke',
			at: new Date(Date.now() - HOUR)
		});
		const error = await refusal(send(company, person));
		expect([error.code, error.reason]).toEqual(['not_found', 'no_catalog_consent']);
	});

	it('does not reveal a minor without a verified representative, and invites one with it', async () => {
		clock = new Date();
		const company = await employer({ minorTerms: true });
		const minorVacancy = await createOwnVacancy(
			database.db,
			{ companyId: company.company.id, memberId: company.member.id, taxonomyVersionId },
			{ minAge: 14, minorTermsAcceptanceId: company.minorTermsAcceptanceId }
		);
		const invite = (person: { id: string }, vacancyId: string) =>
			createInvitation(deps, company.subject, meta, {
				vacancyId,
				candidateId: person.id,
				salaryMin: 260_000,
				salaryMax: 300_000
			});

		const pending = await minor('authority_pending');
		const denied = await refusal(invite(pending, minorVacancy.id));
		// Without a verified representative no consent of a minor is in effect, so the profile is not shown at all.
		expect([denied.code, denied.reason]).toEqual(['not_found', 'no_processing_consent']);

		const verified = await minor('authority_verified');
		// A vacancy that is not open to minors does not show them either.
		const adultsOnly = await refusal(invite(verified, company.vacancy.id));
		expect([adultsOnly.code, adultsOnly.reason]).toEqual(['not_found', 'vacancy_not_eligible']);
		const sent = await invite(verified, minorVacancy.id);
		expect(sent.version).toBe(1);

		// Acceptance needs the representative's disclosure consent for this invitation as well: it waits for them.
		const waiting = await accept(verified, sent.invitationId, sent.termsId, ['full_name', 'email', 'phone']);
		expect(waiting).toMatchObject({ status: 'sent', awaitingRepresentative: true, disclosedFields: [] });
		expect(await database.db.select().from(disclosures).where(eq(disclosures.invitationId, sent.invitationId))).toEqual(
			[]
		);
		// The representative answers by the link of a letter: tests/integration/representative-consent.test.ts.
	});

	it('refuses a second invitation of the same company, vacancy and candidate', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const first = await send(company, person);
		await withdrawInvitation(deps, company.subject, meta, first.invitationId);
		const error = await refusal(send(company, person, [260_000, 280_000]));
		expect([error.code, error.reason]).toEqual(['conflict', 'invitation_exists']);
		const rows = await database.db.select().from(invitations).where(eq(invitations.candidateId, person.id));
		expect(rows).toHaveLength(1);
	});

	it('refuses an offer below the range of the vacancy', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const error = await refusal(send(company, person, [200_000, 300_000]));
		expect(error.details?.[0]?.code).toBe('salary_below_vacancy');
	});
});

describe('terms versions', () => {
	it('keep sent terms immutable: a revision down is a new version marked as lowered and accepted separately', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person, [300_000, 340_000]);

		clock = new Date(clock.getTime() + HOUR);
		const revised = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 260_000,
			salaryMax: 300_000,
			message: 'Здравствуйте! Приглашаем на собеседование.'
		});
		expect(revised).toMatchObject({ version: 2, reopened: false });
		expect(revised.changes).toMatchObject({
			previous_version: 1,
			salary_comparison: 'overlap',
			salary_lowered: true,
			lowered_against_versions: [1]
		});
		expect(revised.changes.fields.map((f) => f.field)).toEqual(['salary_min', 'salary_max']);

		const [first] = await database.db.select().from(invitationTerms).where(eq(invitationTerms.id, sent.termsId));
		expect(first).toMatchObject({ version: 1, salaryMin: 300_000, salaryMax: 340_000, changes: null });
		await expectDbError(
			database.db.update(invitationTerms).set({ salaryMin: 1 }).where(eq(invitationTerms.id, sent.termsId)),
			SQLSTATE.restrictViolation,
			/append-only/
		);
		const audit = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'invitation.terms_revised'), eq(auditEvents.objectId, sent.invitationId)));
		expect(audit[0]?.details).toMatchObject({ salary_lowered: true });
		expect((await notificationsOf(person.userId)).map((n) => n.type).sort()).toEqual([
			'invitation.received',
			'invitation.terms_revised'
		]);

		// The replaced version is not answerable; the candidate sees what changed.
		const stale = await refusal(accept(person, sent.invitationId, sent.termsId));
		expect([stale.code, stale.reason]).toEqual(['conflict', 'terms_replaced']);
		expect(stale.details?.map((d) => d.path)).toEqual(['salary_min', 'salary_max']);

		await accept(person, sent.invitationId, revised.termsId);

		// A revision of an accepted invitation keeps the accepted version until the candidate answers the new one.
		const third = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 280_000,
			salaryMax: 320_000,
			message: 'Здравствуйте! Приглашаем на собеседование.'
		});
		expect(third.changes).toMatchObject({
			salary_comparison: 'overlap',
			salary_lowered: true,
			lowered_against_versions: [1]
		});
		let [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row).toMatchObject({ status: 'accepted', acceptedTermsId: revised.termsId, currentTermsId: third.termsId });
		await respondToInvitation(deps, person.subject, meta, sent.invitationId, {
			termsId: third.termsId,
			decision: 'decline',
			reasonCode: 'salary'
		});
		[row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row).toMatchObject({ status: 'accepted', acceptedTermsId: revised.termsId });

		// One process for the invitation, one disclosure: the revised acceptance did not add fields.
		expect(
			await database.db.select().from(hiringProcesses).where(eq(hiringProcesses.invitationId, sent.invitationId))
		).toHaveLength(1);
		expect(
			await database.db.select().from(disclosures).where(eq(disclosures.invitationId, sent.invitationId))
		).toHaveLength(1);
	});

	it('compares ranges only in the same unit: a changed tax base is not «lower»', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person, [300_000, 340_000]);
		await database.db
			.update(vacancies)
			.set({ salaryTaxBase: 'net', salaryMin: 200_000, salaryMax: 300_000 })
			.where(eq(vacancies.id, company.vacancy.id));
		const revised = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 220_000,
			salaryMax: 260_000
		});
		expect(revised.changes).toMatchObject({ salary_comparison: 'not_comparable', salary_lowered: false });
	});

	it('reopens a declined invitation only after the cooldown, and a lower reopening is marked', async () => {
		clock = new Date(Date.now() - 20 * DAY);
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person, [300_000, 340_000]);
		await respondToInvitation(deps, person.subject, meta, sent.invitationId, {
			termsId: sent.termsId,
			decision: 'decline',
			reasonCode: 'salary',
			reasonText: 'Ожидаю больше'
		});
		const again = await refusal(
			respondToInvitation(deps, person.subject, meta, sent.invitationId, {
				termsId: sent.termsId,
				decision: 'decline',
				reasonCode: 'other'
			})
		);
		expect([again.code, again.reason]).toEqual(['conflict', 'invitation_closed']);

		clock = new Date(clock.getTime() + DAY);
		const early = await refusal(
			reviseInvitation(deps, company.subject, meta, sent.invitationId, { salaryMin: 280_000, salaryMax: 300_000 })
		);
		expect(early.details?.[0]?.code).toBe('reopen_cooldown');

		clock = new Date(clock.getTime() + 15 * DAY);
		const reopened = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 280_000,
			salaryMax: 300_000
		});
		expect(reopened).toMatchObject({ version: 2, reopened: true });
		expect(reopened.changes.salary_lowered).toBe(true);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row).toMatchObject({ status: 'sent', reopenCount: 1, closedAt: null });
	});

	it('requires a decline reason from the reference list', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person);
		const noReason = await refusal(
			respondToInvitation(deps, person.subject, meta, sent.invitationId, { termsId: sent.termsId, decision: 'decline' })
		);
		expect(noReason.code).toBe('validation_failed');
		const unknown = await refusal(
			respondToInvitation(deps, person.subject, meta, sent.invitationId, {
				termsId: sent.termsId,
				decision: 'decline',
				reasonCode: 'too_far'
			})
		);
		expect(unknown.code).toBe('validation_failed');
	});
});

describe('disclosure', () => {
	it('gives contacts only to the company of the accepted invitation, and only while the consent is in effect', async () => {
		clock = new Date();
		const company = await employer();
		const other = await employer();
		const person = await candidate();
		const sent = await send(company, person);
		const otherSent = await createInvitation(deps, other.subject, meta, {
			vacancyId: other.vacancy.id,
			candidateId: person.id,
			salaryMin: 300_000,
			salaryMax: 340_000
		});

		// Before acceptance nobody receives contacts.
		const early = await refusal(recipientContacts(deps, company.subject, meta, sent.invitationId));
		expect([early.code, early.reason]).toEqual(['not_found', 'no_disclosure_consent']);

		await accept(person, sent.invitationId, sent.termsId);
		expect((await recipientContacts(deps, company.subject, meta, sent.invitationId)).email).toBe(person.email);

		// Another company learns nothing: neither through this invitation nor through its own unaccepted one.
		const foreign = await refusal(recipientContacts(deps, other.subject, meta, sent.invitationId));
		expect([foreign.code, foreign.reason]).toEqual(['not_found', 'foreign_invitation']);
		const own = await refusal(recipientContacts(deps, other.subject, meta, otherSent.invitationId));
		expect([own.code, own.reason]).toEqual(['not_found', 'no_disclosure_consent']);
		const rows = await database.db.select().from(disclosures).where(eq(disclosures.candidateId, person.id));
		expect(rows.map((r) => r.companyId)).toEqual([company.company.id]);

		// A revocation closes further access; the disclosure record stays.
		await revokeDisclosureConsent(deps, person.subject, meta, sent.invitationId);
		const revoked = await refusal(recipientContacts(deps, company.subject, meta, sent.invitationId));
		expect([revoked.code, revoked.reason]).toEqual(['not_found', 'no_disclosure_consent']);
		expect(await database.db.select().from(disclosures).where(eq(disclosures.candidateId, person.id))).toHaveLength(1);
	});
});

describe('deadline jobs', () => {
	it('remind before the deadline and expire an unanswered invitation', async () => {
		clock = new Date(Date.now() - 80 * HOUR);
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person);
		clock = new Date();

		const remind = createInvitationRemindDueHandler({ now: () => new Date(sent.responseDueAt.getTime() - HOUR) });
		expect(await runJob(remind, { terms_id: sent.termsId })).toBe(true);
		const reminders = (await notificationsOf(person.userId)).filter((n) => n.type === 'invitation.response_due_soon');
		expect(reminders.map((n) => n.dedupKey).sort()).toEqual([
			`invitation.response_due_soon:${sent.invitationId}:v1:24h`,
			`invitation.response_due_soon:${sent.invitationId}:v1:2h`
		]);
		// Repeating the job does not repeat a reminder of the same slot.
		await runJob(remind, { terms_id: sent.termsId });
		expect(
			(await notificationsOf(person.userId)).filter((n) => n.type === 'invitation.response_due_soon')
		).toHaveLength(2);

		const expire = createInvitationExpireHandler({ now: () => new Date() });
		expect(await runJob(expire, { terms_id: sent.termsId })).toBe(true);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row?.status).toBe('expired');
		expect((await notificationsOf(company.userId)).map((n) => n.type)).toContain('invitation.expired');
		const late = await refusal(accept(person, sent.invitationId, sent.termsId));
		expect([late.code, late.reason]).toEqual(['conflict', 'invitation_closed']);
	});

	it('leave an answered or replaced version alone', async () => {
		clock = new Date(Date.now() - 80 * HOUR);
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person);
		const revised = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 300_000,
			salaryMax: 350_000
		});
		clock = new Date();
		const expire = createInvitationExpireHandler({ now: () => new Date() });
		expect(await runJob(expire, { terms_id: sent.termsId })).toBe(false);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row?.status).toBe('sent');
		const cancelled = await database.db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.inputVersion, sent.termsId), eq(jobs.type, 'invitation.expire')));
		expect(cancelled.map((j) => j.status)).toEqual(['cancelled']);
		expect(revised.version).toBe(2);
		const [candidateRow] = await database.db.select().from(candidates).where(eq(candidates.id, person.id));
		expect(candidateRow?.status).toBe('active');
	});
});

describe('a closed vacancy', () => {
	const closeVacancy = (company: Awaited<ReturnType<typeof employer>>) =>
		closeOwnVacancy(
			{ db: database.db, now: () => clock },
			{
				memberId: company.member.id,
				companyId: company.company.id,
				audit: { kind: 'user', userId: company.userId, companyId: company.company.id },
				requestId: 'close-request'
			},
			company.vacancy.id
		);

	it('withdraws its unanswered invitations and tells their candidates; accepted ones keep their processes', async () => {
		clock = new Date();
		const company = await employer();
		const waiting = await candidate();
		const hired = await candidate();
		const open = await send(company, waiting);
		const answered = await send(company, hired);
		const acceptance = await accept(hired, answered.invitationId, answered.termsId);

		await closeVacancy(company);

		const [withdrawn] = await database.db.select().from(invitations).where(eq(invitations.id, open.invitationId));
		expect(withdrawn).toMatchObject({ status: 'withdrawn', closedAt: clock });
		const [kept] = await database.db.select().from(invitations).where(eq(invitations.id, answered.invitationId));
		expect(kept?.status).toBe('accepted');
		if (!acceptance.processId) throw new Error('no hiring process');
		expect(await getHiringProcess(deps, hired.subject, acceptance.processId)).toMatchObject({ viewer: 'candidate' });

		const told = (await notificationsOf(waiting.userId)).find((n) => n.type === 'invitation.withdrawn');
		expect(told?.payload).toMatchObject({ invitation_id: open.invitationId, cause: 'vacancy_closed' });
		expect((await notificationsOf(hired.userId)).map((n) => n.type)).not.toContain('invitation.withdrawn');
		const [journal] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'invitation.withdrawn'), eq(auditEvents.objectId, open.invitationId)));
		expect(journal?.details).toMatchObject({ cause: 'vacancy_closed' });
		const deadlines = await database.db
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.inputVersion, open.termsId));
		expect(deadlines.map((job) => job.status)).toEqual(['cancelled', 'cancelled']);

		const late = await refusal(accept(waiting, open.invitationId, open.termsId));
		expect([late.code, late.reason]).toEqual(['conflict', 'invitation_closed']);
	});

	it('does not take an acceptance, even of a revision of an accepted invitation', async () => {
		clock = new Date();
		const company = await employer();
		const person = await candidate();
		const sent = await send(company, person);
		await accept(person, sent.invitationId, sent.termsId);
		const revised = await reviseInvitation(deps, company.subject, meta, sent.invitationId, {
			salaryMin: 320_000,
			salaryMax: 360_000,
			message: 'Здравствуйте! Приглашаем на собеседование.'
		});

		await closeVacancy(company);

		const refused = await refusal(accept(person, sent.invitationId, revised.termsId));
		expect([refused.code, refused.reason]).toEqual(['conflict', 'vacancy_closed']);
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, sent.invitationId));
		expect(row).toMatchObject({ status: 'accepted', acceptedTermsId: sent.termsId });
	});
});
