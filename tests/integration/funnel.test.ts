// The career funnel of the FSP operator by its dimensions (docs/domain.md, section 13.9): every dimension, two of them
// at once, the filters, the pooling of the small groups and a candidate in several groups. The world is written straight
// into the tables: the funnel reads them, the hiring flow that writes them is covered by hiring-process.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	categorizationRuns,
	categorizationRulesets,
	categoryAssignments,
	demoSessions,
	fspLevelAssignments,
	hiringProcesses,
	hiringReports,
	invitations,
	invitationTerms,
	productPolicies,
	sourceFacts
} from '$lib/server/db/schema';
import { careerFunnel, type FunnelDimension, type FunnelFilters, type FunnelGroup } from '$lib/server/hiring/funnel';
import { uuidv7 } from '$lib/server/ids';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00Z');

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

const operator: AccessSubject = {
	userId: uuidv7(),
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: true, admin: false, extraPermissions: [] }
};

let database: TestDatabase;
let deps: InvitationDeps;
let world: {
	taxonomyVersionId: string;
	rulesetId: string;
	invitationPolicyId: string;
	hiringPolicyId: string;
	companyId: string;
	memberId: string;
	memberUserId: string;
	vacancyId: string;
};

const C1 = { id: 'c-algo-2025', title: 'Кубок по алгоритмическому программированию', discipline: 'algorithmic' };
const C2 = { id: 'c-product-2025', title: 'Чемпионат по продуктовому программированию', discipline: 'product' };

interface Person {
	/** A clone of this demo session. */
	demoSessionId?: string;
	region?: string;
	seed?: boolean;
	category?: { role: string; grade: [string, string] };
	levels?: [string, string][];
	competitions?: (typeof C1)[];
}

async function person(setup: Person) {
	const { db } = database;
	const demoSessionId = setup.demoSessionId ?? null;
	const row = await createCandidate(db, {
		userId: (await createUser(db, { demoSessionId })).id,
		demoSessionId,
		seedBatchId: setup.seed ? 'demo-1' : null,
		preferences: setup.region === undefined ? {} : { region_code: setup.region }
	});
	const factIds: string[] = [];
	for (const competition of setup.competitions ?? []) {
		const [fact] = await db
			.insert(sourceFacts)
			.values({
				candidateId: row.id,
				source: 'fsp',
				factType: 'competition_result',
				sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
				eventKey: `fsp:competition:${competition.id}`,
				trustLevel: 'fsp_verified',
				ownershipBasis: 'operator_confirmed',
				payload: { competition: { ...competition, startDate: '2025-04-10' }, result: { award: 'participant' } },
				payloadSha256: randomSha256(),
				observedAt: NOW,
				lastVerifiedAt: NOW,
				status: 'active'
			})
			.returning({ id: sourceFacts.id });
		if (!fact) throw new Error('fact not inserted');
		factIds.push(fact.id);
	}
	if (setup.category || setup.levels) {
		const [run] = await db
			.insert(categorizationRuns)
			.values({
				candidateId: row.id,
				inputRevision: 1,
				inputSnapshotSha256: randomSha256(),
				inputRefs: { facts: factIds, claims: [] },
				taxonomyVersionId: world.taxonomyVersionId,
				rulesetId: world.rulesetId,
				asOf: NOW,
				computedAt: NOW,
				origin: 'automatic',
				outcome: setup.category ? 'complete' : 'insufficient_data',
				missing: {},
				experienceSummary: {},
				status: 'published'
			})
			.returning({ id: categorizationRuns.id });
		if (!run) throw new Error('run not inserted');
		if (setup.category)
			await db.insert(categoryAssignments).values({
				runId: run.id,
				rank: 'primary',
				roleStatus: 'established',
				roleKey: setup.category.role,
				score: '0.8',
				gradeStatus: 'established',
				gradeMin: setup.category.grade[0],
				gradeMax: setup.category.grade[1],
				gradeConfidence: '0.70',
				stackStatus: 'insufficient_data',
				explanation: {}
			});
		for (const [discipline, level] of setup.levels ?? [])
			await db.insert(fspLevelAssignments).values({
				runId: run.id,
				discipline,
				level: level as 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
				basisFactIds: factIds.length > 0 ? factIds : [uuidv7()]
			});
	}
	return row;
}

/**
 * An invitation of the company to the candidate: `sent` only, accepted and silent, or accepted and confirmed as hired
 * by both sides after an interview both reported.
 */
interface Sender {
	companyId: string;
	memberId: string;
	memberUserId: string;
	vacancyId: string;
}

async function invite(
	candidate: { id: string; userId: string },
	fate: 'sent' | 'silent' | 'hired',
	sentAt = new Date(NOW.getTime() - 60 * DAY),
	sender: Sender = world
) {
	const { db } = database;
	const invitationId = uuidv7();
	const termsId = uuidv7();
	const accepted = fate !== 'sent';
	await db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: sender.companyId,
			vacancyId: sender.vacancyId,
			candidateId: candidate.id,
			sentByMemberId: sender.memberId,
			status: accepted ? 'accepted' : 'sent',
			currentTermsId: termsId,
			acceptedTermsId: accepted ? termsId : null,
			policyId: world.invitationPolicyId,
			sentAt
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			vacancySnapshot: {},
			salaryMin: 200_000,
			salaryMax: 300_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(sentAt.getTime() + 3 * DAY),
			createdByMemberId: sender.memberId,
			createdAt: sentAt
		});
	});
	if (!accepted) return;
	const openedAt = new Date(sentAt.getTime() + DAY);
	const [process] = await db
		.insert(hiringProcesses)
		.values({
			invitationId,
			companyId: sender.companyId,
			candidateId: candidate.id,
			openedAt,
			outcomeDueAt: new Date(openedAt.getTime() + 30 * DAY),
			policyId: world.hiringPolicyId
		})
		.returning({ id: hiringProcesses.id });
	if (!process) throw new Error('process not inserted');
	if (fate !== 'hired') return;
	const at = (days: number) => new Date(openedAt.getTime() + days * DAY);
	await db.insert(hiringReports).values([
		{
			processId: process.id,
			party: 'company',
			reportedByUserId: sender.memberUserId,
			kind: 'stage',
			stage: 'interview_done',
			reportedAt: at(3)
		},
		{
			processId: process.id,
			party: 'candidate',
			reportedByUserId: candidate.userId,
			kind: 'stage',
			stage: 'interview_done',
			reportedAt: at(3)
		},
		{
			processId: process.id,
			party: 'company',
			reportedByUserId: sender.memberUserId,
			kind: 'outcome',
			outcome: 'hired',
			reportedAt: at(10)
		},
		{
			processId: process.id,
			party: 'candidate',
			reportedByUserId: candidate.userId,
			kind: 'outcome',
			outcome: 'hired',
			reportedAt: at(11)
		}
	]);
}

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	deps = { db, crypto, now: () => NOW };
	const taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	const [ruleset] = await db
		.insert(categorizationRulesets)
		.values({ version: 1, taxonomyVersionId, params: {} })
		.returning();
	const since = new Date(NOW.getTime() - 400 * DAY);
	const policies = await db
		.insert(productPolicies)
		.values([
			{
				kind: 'invitation_policy',
				version: 1,
				params: {
					response_window_hours: 72,
					decline_reason_codes: ['other'],
					reason_required: true,
					max_open_per_company_per_day: 50,
					reopen_cooldown_days: 14,
					max_reopens: 2
				},
				effectiveFrom: since
			},
			{
				kind: 'hiring_policy',
				version: 1,
				params: {
					outcome_due_days: 30,
					reminder_intervals_days: [7],
					max_reminders: 2,
					stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
					outcome_reason_codes: ['other']
				},
				effectiveFrom: since
			},
			{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom: since }
		])
		.returning({ id: productPolicies.id, kind: productPolicies.kind });
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	if (!ruleset || !member.userId) throw new Error('world not set up');
	world = {
		taxonomyVersionId,
		rulesetId: ruleset.id,
		invitationPolicyId: policies.find((p) => p.kind === 'invitation_policy')?.id ?? '',
		hiringPolicyId: policies.find((p) => p.kind === 'hiring_policy')?.id ?? '',
		companyId: company.id,
		memberId: member.id,
		memberUserId: member.userId,
		vacancyId: (await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId })).id
	};

	// A: six algorithmic L3 backend developers from Moscow, all hired; two of them also have product L1.
	for (let i = 0; i < 6; i++) {
		const both = i < 2;
		const row = await person({
			region: 'RU-MOW',
			category: { role: 'backend', grade: ['middle', 'senior'] },
			levels: both
				? [
						['algorithmic', 'L3'],
						['product', 'L1']
					]
				: [['algorithmic', 'L3']],
			competitions: both ? [C1, C2] : [C1]
		});
		await invite(row, 'hired');
	}
	// B: five product L2 junior frontend developers from Saint Petersburg, accepted, silent past the due date.
	for (let i = 0; i < 5; i++) {
		const row = await person({
			region: 'RU-SPE',
			category: { role: 'frontend', grade: ['junior', 'junior'] },
			levels: [['product', 'L2']],
			competitions: [C2]
		});
		await invite(row, 'silent');
	}
	// C: three from Krasnodar and D: two without a region, no category, no FSP; invited, no answer.
	for (let i = 0; i < 3; i++) await invite(await person({ region: 'RU-KDA' }), 'sent');
	for (let i = 0; i < 2; i++) await invite(await person({ seed: i === 0 }), 'sent');
});

afterAll(async () => {
	await database.drop();
});

const funnel = (filters: FunnelFilters) => careerFunnel(deps, operator, filters);
const rows = (groups: FunnelGroup[]) => groups.map((g) => [g.key, g.pooled, g.invited]);

describe('career funnel by dimension', () => {
	it('counts the whole selection stage by stage', async () => {
		const { total, groups } = await funnel({ dimensions: [] });
		expect(groups).toEqual([]);
		expect(total).toMatchObject({
			synthetic: true,
			invited: { value: 16 },
			contact: { value: 11 },
			interview: { total: { value: 6 }, bySource: { both: { value: 6 }, company: { value: 0 } } },
			hired: { confirmed: { value: 6 } },
			notHired: { value: 0 },
			unknown: { value: 5 }
		});
	});

	it('slices by every dimension, a candidate with two disciplines in both of them', async () => {
		const by = async (dimension: FunnelDimension) => rows((await funnel({ dimensions: [dimension] })).groups);
		// Two of A are in product too: 6 + 7 + 5 = 18 rows for 16 candidates.
		expect(await by('fsp_discipline')).toEqual([
			['product', 0, { value: 7 }],
			['algorithmic', 0, { value: 6 }],
			['none', 0, { value: 5 }]
		]);
		// L1 (two) is small; the pool takes L2, the next smallest, and stays unnamed.
		expect(await by('fsp_level')).toEqual([
			['L3', 0, { value: 6 }],
			['none', 0, { value: 5 }],
			['__small__', 2, { value: 7 }]
		]);
		expect(await by('role')).toEqual([
			['backend', 0, { value: 6 }],
			['frontend', 0, { value: 5 }],
			['none', 0, { value: 5 }]
		]);
		expect(await by('grade')).toEqual([
			['middle..senior', 0, { value: 6 }],
			['junior..junior', 0, { value: 5 }],
			['none', 0, { value: 5 }]
		]);
		expect(await by('competition')).toEqual([
			[C2.id, 0, { value: 7 }],
			[C1.id, 0, { value: 6 }],
			['none', 0, { value: 5 }]
		]);
		expect(await by('fsp_participant')).toEqual([
			['fsp', 0, { value: 11 }],
			['not_fsp', 0, { value: 5 }]
		]);
		expect(await by('month')).toEqual([['2026-04', 0, { value: 16 }]]);
		// Krasnodar (three) and «not given» (two) are pooled into five.
		expect(await by('region')).toEqual([
			['RU-MOW', 0, { value: 6 }],
			['RU-SPE', 0, { value: 5 }],
			['__small__', 2, { value: 5 }]
		]);

		const byCompetition = await funnel({ dimensions: ['competition'] });
		expect(byCompetition.competitions).toEqual({
			[C1.id]: { title: C1.title, startDate: '2025-04-10' },
			[C2.id]: { title: C2.title, startDate: '2025-04-10' }
		});
		const hired = byCompetition.groups.find((g) => g.key === C1.id);
		expect(hired).toMatchObject({ contact: { value: 6 }, hired: { confirmed: { value: 6 } }, unknown: { value: 0 } });
	});

	it('nests a second dimension inside each row, pooling small groups inside the row', async () => {
		const { groups } = await funnel({ dimensions: ['fsp_discipline', 'region'] });
		expect(groups.map((g) => [g.key, rows(g.children)])).toEqual([
			// Product: five from Saint Petersburg and two from Moscow — the two alone would be small.
			['product', [['__small__', 2, { value: 7 }]]],
			['algorithmic', [['RU-MOW', 0, { value: 6 }]]],
			['none', [['__small__', 2, { value: 5 }]]]
		]);
		expect(groups[1]?.children[0]).toMatchObject({ hired: { confirmed: { value: 6 } } });
	});

	it('pairs the discipline with the level in that discipline, not with every level of the candidate', async () => {
		const { groups } = await funnel({ dimensions: ['fsp_discipline', 'fsp_level'] });
		const algorithmic = groups.find((g) => g.key === 'algorithmic');
		// Crossed with every level, the product L1 of two of them would make a small group and pull L3 into the pool.
		expect(rows(algorithmic?.children ?? [])).toEqual([['L3', 0, { value: 6 }]]);
	});

	it('filters by a dimension, the level read in the filtered discipline', async () => {
		const product = await funnel({ dimensions: ['fsp_level'], where: { fsp_discipline: 'product' } });
		expect(product.total.invited).toEqual({ value: 7 });
		expect(rows(product.groups)).toEqual([['__small__', 2, { value: 7 }]]);

		const algorithmic = await funnel({
			dimensions: ['role'],
			where: { fsp_discipline: 'algorithmic', region: 'RU-MOW' }
		});
		expect(rows(algorithmic.groups)).toEqual([['backend', 0, { value: 6 }]]);

		const spb = await funnel({ dimensions: [], where: { region: 'RU-SPE' } });
		expect(spb.total).toMatchObject({ invited: { value: 5 }, contact: { value: 5 }, unknown: { value: 5 } });
	});

	it('hides every count of a selection smaller than the threshold, zeros included', async () => {
		const small = await funnel({ dimensions: ['role'], where: { region: 'RU-KDA' } });
		// Three people, none of them accepted: a visible zero would tell that about each of them.
		expect(small.total).toMatchObject({
			invited: { below: 5 },
			contact: { below: 5 },
			hired: { confirmed: { below: 5 } },
			unknown: { below: 5 }
		});
		expect(rows(small.groups)).toEqual([['__small__', 1, { below: 5 }]]);
	});

	it('shows zeros of an empty period', async () => {
		const empty = await funnel({ dimensions: ['region'], from: NOW });
		expect(empty.total).toMatchObject({ invited: { value: 0 }, contact: { value: 0 } });
		expect(empty.groups).toEqual([]);
	});
});

describe('career funnel and demo sessions', () => {
	it('does not count the invitations of a demo session', async () => {
		const { db } = database;
		const before = await funnel({ dimensions: ['region'] });
		const [session] = await db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
			.returning();
		if (!session) throw new Error('demo session not inserted');
		const company = await createCompany(db, { demoSessionId: session.id });
		const member = await createMember(db, company.id, {
			userId: (await createUser(db, { demoSessionId: session.id })).id
		});
		if (!member.userId) throw new Error('member without user');
		const clone: Sender = {
			companyId: company.id,
			memberId: member.id,
			memberUserId: member.userId,
			vacancyId: (
				await createOwnVacancy(db, {
					companyId: company.id,
					memberId: member.id,
					taxonomyVersionId: world.taxonomyVersionId
				})
			).id
		};
		// The clone company hires six clones, and reaches a candidate outside the session; a clone is reached from outside.
		for (let i = 0; i < 6; i++) {
			await invite(await person({ demoSessionId: session.id, region: 'RU-MOW' }), 'hired', undefined, clone);
		}
		await invite(await person({ region: 'RU-MOW' }), 'hired', undefined, clone);
		await invite(await person({ demoSessionId: session.id, region: 'RU-MOW' }), 'hired');

		expect(await funnel({ dimensions: ['region'] })).toEqual(before);
	});
});
