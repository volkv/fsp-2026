// «In the pool N confirmed, M more matching» of a vacancy against the database: the pool is counted by `match.refresh`,
// the matching ones are read from its stored matches — at the pool threshold by the score, no required skill confirmed
// directly, visible to some verified company when read — with the required skills a published platform test confirms.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';
import {
	candidates,
	categorizationRulesets,
	evidenceRuns,
	consentEvents,
	grades,
	jobs,
	matchRulesets,
	productPolicies,
	roles,
	skillInferences,
	skills,
	sourceFacts,
	vacancies,
	vacancyImportRuns,
	vacancyPostings
} from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { ok } from '$lib/server/ml/result';
import { recomputeCluster } from '$lib/server/vacancies/clusters';
import type { NormalizedPosting } from '$lib/server/vacancies/normalize';
import { loadPoolCount, loadPoolCounter } from '$lib/server/vacancies/pool';
import { HABR_SOURCE_KEY, registerVacancySources } from '$lib/server/vacancies/sources/definitions';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { releaseFixtureBank } from '../helpers/bank';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

const DAY = 86_400_000;

let database: TestDatabase;
let taxonomyVersionId: string;
let categorizationRulesetId: string;
let documents: Record<'pd' | 'catalog', string>;

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(grades).values(
		['intern', 'junior', 'middle', 'senior', 'lead'].map((key, ordinal) => ({
			taxonomyVersionId,
			key,
			ordinal,
			name: key
		}))
	);
	await db.insert(skills).values([
		{ taxonomyVersionId, key: 'go', kind: 'language', name: 'Go' },
		{ taxonomyVersionId, key: 'postgresql', kind: 'database', name: 'PostgreSQL' },
		{ taxonomyVersionId, key: 'python', kind: 'language', name: 'Python' }
	]);
	await db.insert(roles).values({
		taxonomyVersionId,
		key: 'backend',
		family: 'development',
		nameRu: 'Бэкенд-разработчик',
		coreSkillGroups: [],
		typicalSkills: ['go'],
		hhRoleId: [],
		habrSpec: [],
		profStandard: []
	});
	// The rule set the product ships, bound to this hand-made taxonomy version.
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	const [categorizationRuleset] = await db
		.insert(categorizationRulesets)
		.values({ version: 1, taxonomyVersionId, params: {} })
		.returning();
	if (!categorizationRuleset) throw new Error('categorization rule set not inserted');
	categorizationRulesetId = categorizationRuleset.id;
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing')).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility')).id
	};
	await releaseFixtureBank(db, 'backend');
	const since = new Date(Date.now() - DAY);
	await db.insert(productPolicies).values([
		{ kind: 'matching_policy', version: 1, params: { store_threshold: 0.3 }, effectiveFrom: since },
		// Exact counts from one: the small-count rule is checked with the policy of the next version.
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 1 }, effectiveFrom: since },
		{
			kind: 'catalog_policy',
			version: 2,
			params: { small_count_threshold: 5 },
			effectiveFrom: new Date(Date.now() + DAY)
		}
	]);

	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await registerVacancySources(client);
	} finally {
		await client.end({ timeout: 5 });
	}
});

afterAll(async () => {
	await database.drop();
});

afterEach(async () => {
	// Every test counts its own candidates: those of the previous ones leave the catalog.
	await database.db.update(candidates).set({ visibility: 'hidden' });
	await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function consent(
	candidateId: string,
	userId: string,
	kind: 'pd_processing' | 'catalog_visibility',
	action: 'grant' | 'revoke' = 'grant'
) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind,
		documentId: kind === 'pd_processing' ? documents.pd : documents.catalog,
		action,
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - (action === 'grant' ? DAY : 1000))
	});
}

type Skill = { key: string; band: 'weak' | 'moderate' | 'strong'; attestation: 'direct' | 'claimed' };

/** An adult of the catalog with a published run of the skills and the category of the specialization, grade middle. */
async function candidate(skillsOf: Skill[], specialization: SpecializationKey = 'backend') {
	const { db } = database;
	// The grade decision moves the profile to revision 1, the one of the run.
	const row = await createCandidate(db, { birthDate: '1996-01-15', visibility: 'catalog', profileRevision: 0 });
	await consent(row.id, row.userId, 'pd_processing');
	await consent(row.id, row.userId, 'catalog_visibility');
	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: row.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');
	const [run] = await db
		.insert(evidenceRuns)
		.values({
			candidateId: row.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [fact.id], claims: [] },
			taxonomyVersionId,
			rulesetId: categorizationRulesetId,
			asOf: new Date(),
			computedAt: new Date(),
			experienceSummary: {},
			status: 'published'
		})
		.returning();
	if (!run) throw new Error('run not inserted');
	await db.insert(skillInferences).values(
		skillsOf.map((skill) => ({
			runId: run.id,
			candidateId: row.id,
			skillKey: skill.key,
			strength: skill.band === 'strong' ? '0.800' : skill.band === 'moderate' ? '0.500' : '0.200',
			strengthBand: skill.band,
			attestation: skill.attestation,
			badgeTrust: skill.attestation === 'direct' ? ('fsp_verified' as const) : null,
			contributions: [{ fact_id: fact.id, attestation: skill.attestation }]
		}))
	);
	await decide(db, row.id, { specialization, grade: 'middle' });
	return row;
}

async function ownVacancy(requiredSkillKeys: string[]) {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id, { userId: (await createUser(db)).id });
	return createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId }, { requiredSkillKeys });
}

const models: MatchingModels = {
	embed: (request) =>
		Promise.resolve(
			ok({
				spaceId: request.spaceId,
				vectors: request.inputs.map((input) => ({ id: input.id, vector: [1, 0, 0] })),
				latencyMs: 1
			})
		),
	rerank: (request) =>
		Promise.resolve(
			ok({
				model: { modelId: 'test-reranker' },
				scores: request.documents.map((document) => ({ id: document.id, score: 0.9 })),
				latencyMs: 1
			})
		)
};

/** `match.refresh` of the vacancy as the worker runs it, on a queue without other jobs. */
async function refresh(vacancyId: string) {
	const { db } = database;
	await db.delete(jobs).where(eq(jobs.status, 'queued'));
	await db.transaction((tx) =>
		enqueueJob(
			tx,
			'match.refresh',
			{ scope: 'vacancy', vacancy_id: vacancyId },
			{ inputVersion: '1', createdBy: { kind: 'system' } }
		)
	);
	const claimed = await claimJob(db, 'test-worker', ['match.refresh']);
	if (claimed?.type !== 'match.refresh') throw new Error('no match.refresh job to run');
	const job: ClaimedJob<'match.refresh'> = {
		...claimed,
		type: 'match.refresh',
		payload: JOB_TYPES['match.refresh'].payload.parse(claimed.payload)
	};
	const result = await createMatchRefreshHandler(() => models).run({
		job,
		db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(db, job, result)).toBe('succeeded');
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('pool of a vacancy and the matching candidates without confirmation', () => {
	it('counts next to the pool the candidates that match without a directly confirmed required skill', async () => {
		const vacancy = await ownVacancy(['go', 'postgresql']);
		await candidate([
			{ key: 'go', band: 'strong', attestation: 'direct' },
			{ key: 'postgresql', band: 'strong', attestation: 'claimed' }
		]);
		const claimed = [
			{ key: 'go', band: 'strong', attestation: 'claimed' },
			{ key: 'postgresql', band: 'strong', attestation: 'claimed' }
		] satisfies Skill[];
		await candidate(claimed);
		const leaving = await candidate(claimed);
		// Another specialization and none of the required skills: below the pool threshold, counted nowhere.
		await candidate([{ key: 'python', band: 'weak', attestation: 'claimed' }], 'data_ml');

		await refresh(vacancy.id);
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toEqual({
			status: 'counted',
			count: 1,
			countedAt: expect.any(Date) as Date,
			matching: {
				unconfirmed: { status: 'counted', count: 2 },
				// The released Backend test confirms Go by its practice, nothing confirms PostgreSQL.
				confirmableSkills: [{ key: 'go', name: 'Go' }]
			}
		});

		// Visibility is decided when read: a candidate who left the catalog is not counted from a stored match.
		await consent(leaving.id, leaving.userId, 'catalog_visibility', 'revoke');
		const after = await loadPoolCounter(database.db, vacancy.id, new Date());
		expect(after).toMatchObject({
			status: 'counted',
			count: 1,
			matching: { unconfirmed: { status: 'counted', count: 1 } }
		});

		// Below the small-count threshold of the policy both numbers are «fewer than N».
		const later = new Date(Date.now() + 2 * DAY);
		expect(await loadPoolCounter(database.db, vacancy.id, later)).toMatchObject({
			status: 'below_threshold',
			threshold: 5,
			matching: { unconfirmed: { status: 'below_threshold', threshold: 5 } }
		});
	});

	it('names nothing to confirm when no published test covers a required skill', async () => {
		const vacancy = await ownVacancy(['postgresql']);
		await candidate([{ key: 'postgresql', band: 'strong', attestation: 'claimed' }]);
		await refresh(vacancy.id);
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toMatchObject({
			// No one in the pool: zero is below the threshold of one.
			status: 'below_threshold',
			threshold: 1,
			matching: { unconfirmed: { status: 'counted', count: 1 }, confirmableSkills: [] }
		});
	});

	it('counts only the matches of the current revision and needs required skills to count', async () => {
		const vacancy = await ownVacancy(['go']);
		await candidate([{ key: 'go', band: 'strong', attestation: 'claimed' }]);
		await refresh(vacancy.id);
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toMatchObject({
			matching: { unconfirmed: { status: 'counted', count: 1 } }
		});
		// A new revision: the stored matches of the previous one are not matches of this one until its refresh.
		await database.db
			.update(vacancies)
			.set({ revision: vacancy.revision + 1 })
			.where(eq(vacancies.id, vacancy.id));
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toMatchObject({
			matching: { unconfirmed: { status: 'below_threshold', threshold: 1 } }
		});
		await refresh(vacancy.id);
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toMatchObject({
			matching: { unconfirmed: { status: 'counted', count: 1 } }
		});
		// Before the first count there is nothing to read.
		await database.db
			.update(vacancies)
			.set({ poolCount: null, poolCountedAt: null })
			.where(eq(vacancies.id, vacancy.id));
		expect(await loadPoolCounter(database.db, vacancy.id, new Date())).toEqual({ status: 'pending' });

		const external = await createExternalVacancy(database.db, taxonomyVersionId);
		expect(await loadPoolCounter(database.db, external.id, new Date())).toEqual({ status: 'insufficient_data' });

		// A role without required skills: nobody can have a required skill confirmed, so the pool is not counted at all.
		const roleOnly = await ownVacancy([]);
		expect(roleOnly.roleKey).not.toBeNull();
		await refresh(roleOnly.id);
		const [stored] = await database.db
			.select({ poolCount: vacancies.poolCount })
			.from(vacancies)
			.where(eq(vacancies.id, roleOnly.id));
		expect(stored?.poolCount).toBeNull();
		expect(await loadPoolCounter(database.db, roleOnly.id, new Date())).toEqual({ status: 'insufficient_data' });
	});

	it('reads the pool without the matching candidates for readers that do not show them', async () => {
		const vacancy = await ownVacancy(['go']);
		await candidate([{ key: 'go', band: 'strong', attestation: 'direct' }]);
		await candidate([{ key: 'go', band: 'strong', attestation: 'claimed' }]);
		await refresh(vacancy.id);
		const full = await loadPoolCounter(database.db, vacancy.id, new Date());
		expect(full).toMatchObject({ status: 'counted', count: 1, matching: { unconfirmed: { count: 1 } } });
		expect(await loadPoolCount(database.db, vacancy.id, new Date())).toEqual({
			status: 'counted',
			count: 1,
			countedAt: expect.any(Date) as Date
		});
		expect(await loadPoolCount(database.db, randomUUID(), new Date())).toBeNull();
	});

	it('is counted anew when an import raises the revision of an external vacancy, and kept when it does not', async () => {
		const { db } = database;
		const vacancy = await createExternalVacancy(db, taxonomyVersionId, {
			roleKey: 'backend',
			requiredSkillKeys: ['go'],
			poolCount: 3,
			poolCountedAt: new Date()
		});
		const at = new Date();
		const [run] = await db
			.insert(vacancyImportRuns)
			.values({
				source: HABR_SOURCE_KEY,
				adapterVersion: 'test/1',
				mode: 'full',
				startedAt: at,
				finishedAt: at,
				status: 'succeeded',
				completeness: 'complete',
				counts: {}
			})
			.returning({ id: vacancyImportRuns.id });
		if (!run) throw new Error('import run not inserted');
		const normalized = (required: string[]): NormalizedPosting => ({
			rules_version: 'test',
			role: { key: 'backend', method: 'title_rules', rule: null },
			grade: { min: null, max: null, basis: 'unknown', method: 'none' },
			skills: { required, nice: [], unknown: [], methods: {} },
			salary: { status: 'absent', reason: null, min: null, max: null, currency: null, period: null, tax_base: null },
			work_format: null,
			employment_form: null,
			city: null
		});
		const externalId = randomSha256().slice(0, 12);
		await db.insert(vacancyPostings).values({
			vacancyId: vacancy.id,
			source: HABR_SOURCE_KEY,
			externalId,
			url: `https://career.habr.com/vacancies/${externalId}`,
			organization: { name: 'Пример', inn: null, source_org_id: null },
			title: vacancy.title,
			originalTerms: {
				salary_text: null,
				salary: { min: null, max: null, currency: null, period: null, tax_base: null },
				grade_raw: null,
				employment_raw: null,
				location: { city: null, remote: null, raw: null },
				skills_raw: [],
				description: vacancy.description,
				contacts_removed: false
			},
			rawSha256: randomSha256(),
			normalized: normalized(['go']),
			normalizationVersion: 'test',
			firstFetchedAt: at,
			lastFetchedAt: at,
			lastCheckedAt: at,
			freshness: 'active',
			dedup: { method: 'exact', score: 1 },
			lastImportRunId: run.id
		});
		const recompute = () =>
			db.transaction((tx) =>
				recomputeCluster(tx, vacancy.id, { taxonomyVersionId: null, now: new Date(), staleAfterDays: null })
			);

		// The same content keeps the revision, and the count of it stays.
		expect(await recompute()).toMatchObject({ revision: vacancy.revision, revised: false });
		expect(await loadPoolCount(db, vacancy.id, new Date())).toMatchObject({ status: 'counted', count: 3 });

		// A new required skill is a new revision: until its refresh the old count is not shown.
		await db
			.update(vacancyPostings)
			.set({ normalized: normalized(['go', 'postgresql']) })
			.where(eq(vacancyPostings.vacancyId, vacancy.id));
		expect(await recompute()).toMatchObject({ revision: vacancy.revision + 1, revised: true });
		expect(await loadPoolCounter(db, vacancy.id, new Date())).toEqual({ status: 'pending' });
	});
});
