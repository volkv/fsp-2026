// «In the pool ≈N confirmed candidates» of a vacancy before it is saved (CONCEPT, promise 4): the draft from pasted
// text is counted by the same function as the pool of a saved vacancy — within the reach of the company, visible to
// some verified company, at the pool threshold, a required skill confirmed directly — with the threshold of small
// counts, and nothing is written.
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	candidates,
	categorizationRulesets,
	evidenceRuns,
	consentEvents,
	demoSessions,
	jobs,
	matchScores,
	productPolicies,
	skillInferences,
	sourceFacts,
	taxonomyVersions,
	vacancies
} from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { fail, ok } from '$lib/server/ml/result';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { extractVacancyFromText, unsavedVacancyOf } from '$lib/server/vacancies/from-text';
import { createOwnVacancy, type VacancyAuthor } from '$lib/server/vacancies/own';
import { estimateVacancyPool, loadPoolCount, type UnsavedVacancy } from '$lib/server/vacancies/pool';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPublishedDocument,
	randomSha256
} from '../helpers/factories';
import { memoryTextParseCache } from '$lib/server/vacancies/text-extract';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;

const TEXT = [
	'Senior Python-разработчик',
	'Обязательно: Python, PostgreSQL.',
	'Зарплата 300 000 – 400 000 руб. в месяц на руки, удалённо'
].join('\n');

let database: TestDatabase;
let taxonomyVersionId: string;
let categorizationRulesetId: string;
let documents: Record<'pd' | 'catalog', string>;

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
	const [ruleset] = await db.select({ id: categorizationRulesets.id }).from(categorizationRulesets);
	if (!version || !ruleset) throw new Error('the taxonomy release was not published');
	taxonomyVersionId = version.id;
	categorizationRulesetId = ruleset.id;
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing')).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility')).id
	};
	const since = new Date(Date.now() - DAY);
	await db.insert(productPolicies).values([
		{ kind: 'matching_policy', version: 1, params: { store_threshold: 0.3 }, effectiveFrom: since },
		{ kind: 'market_policy', version: 1, params: { window_days: 30, min_sample: 3 }, effectiveFrom: since },
		// Exact counts from one: the small-count rule is checked with the policy of the next version.
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 1 }, effectiveFrom: since },
		{
			kind: 'catalog_policy',
			version: 2,
			params: { small_count_threshold: 5 },
			effectiveFrom: new Date(Date.now() + DAY)
		}
	]);
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

async function consent(candidateId: string, userId: string, kind: 'pd_processing' | 'catalog_visibility') {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind,
		documentId: kind === 'pd_processing' ? documents.pd : documents.catalog,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - DAY)
	});
}

type Attestation = 'direct' | 'claimed';

/**
 * An adult senior backend developer of the catalog with Python and PostgreSQL in a published run: `direct` — confirmed
 * by an FSP result, `claimed` — only stated. `demoSessionId` puts the candidate into a demo session.
 */
async function candidate(attestation: Attestation, demoSessionId: string | null = null) {
	const { db } = database;
	const row = await createCandidate(db, {
		birthDate: '1996-01-15',
		visibility: 'catalog',
		// The grade decision moves the profile to revision 1, the one of the run.
		profileRevision: 0,
		demoSessionId
	});
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
		['python', 'postgresql'].map((skillKey) => ({
			runId: run.id,
			candidateId: row.id,
			skillKey,
			strength: '0.800',
			strengthBand: 'strong' as const,
			attestation,
			badgeTrust: attestation === 'direct' ? ('fsp_verified' as const) : null,
			contributions: [{ fact_id: fact.id, attestation }]
		}))
	);
	await decide(db, row.id, { specialization: 'backend', grade: 'senior' });
	return row;
}

async function employer(demoSessionId: string | null = null): Promise<VacancyAuthor> {
	const company = await createCompany(database.db, { demoSessionId });
	const member = await createMember(database.db, company.id);
	if (!member.userId) throw new Error('member without user');
	return {
		memberId: member.id,
		companyId: company.id,
		audit: { kind: 'user', userId: member.userId, companyId: company.id },
		requestId: 'req-test'
	};
}

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'test', expiresAt: new Date(Date.now() + DAY) })
		.returning({ id: demoSessions.id });
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

const models: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embeddings are switched off')),
	rerank: (request) =>
		Promise.resolve(
			ok({
				model: { modelId: 'test-reranker' },
				scores: request.documents.map((document) => ({ id: document.id, score: 0.9 })),
				latencyMs: 1
			})
		)
};

/** The extraction model is switched off: the rules read the text, as the page does without the model. */
const extractOff = { extract: () => Promise.resolve(fail('disabled', 'switched off', { reason: 'switched_off' })) };

async function draftOf(author: VacancyAuthor) {
	return extractVacancyFromText(
		{ db: database.db, models: extractOff, parseCache: memoryTextParseCache() },
		author,
		TEXT
	);
}

const estimate = (author: VacancyAuthor, unsaved: UnsavedVacancy, now = new Date()) =>
	estimateVacancyPool(database.db, models, author.companyId, unsaved, { now });

/** `match.refresh` of the saved vacancy as the worker runs it. */
async function refresh() {
	const { db } = database;
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

describe('pool estimate of an unsaved vacancy', () => {
	it('counts the draft from pasted text as its pool will be counted after saving, and writes nothing', async () => {
		await candidate('direct');
		await candidate('direct');
		// Matches by the score, but no required skill is confirmed directly: not in the pool.
		await candidate('claimed');
		const author = await employer();
		const draft = await draftOf(author);
		expect(draft.fields.roleKey).toBe('backend');

		const unsaved = unsavedVacancyOf(draft);
		expect(unsaved).toMatchObject({
			roleKey: 'backend',
			gradeMin: 'senior',
			gradeMax: 'senior',
			requiredSkillKeys: ['python', 'postgresql'],
			taxonomyVersionId
		});
		expect(await estimate(author, unsaved)).toEqual({ status: 'counted', count: 2 });
		expect(await database.db.select().from(vacancies).where(eq(vacancies.id, draft.vacancyId))).toEqual([]);
		expect(await database.db.select().from(matchScores)).toEqual([]);

		// Saved as it was parsed, the vacancy gets the same number from `match.refresh`.
		await database.db.delete(jobs).where(eq(jobs.status, 'queued'));
		const saved = await createOwnVacancy(
			{ db: database.db, now: () => new Date() },
			author,
			{
				title: 'Senior Python-разработчик',
				description: TEXT,
				roleKey: 'backend',
				gradeMin: 'senior',
				gradeMax: 'senior',
				requiredSkillKeys: ['python', 'postgresql'],
				niceSkillKeys: [],
				workFormat: 'remote',
				employmentForm: 'full',
				contractTypes: ['labor'],
				cityId: null,
				timezoneOverlapHours: null,
				salary: { min: 300_000, max: 400_000, currency: 'RUB', period: 'month', taxBase: 'net' }
			},
			{ fromText: { mlResultId: draft.mlResultId } }
		);
		await database.db.delete(jobs).where(eq(jobs.type, 'vacancy.embed'));
		await refresh();
		expect(await loadPoolCount(database.db, saved.id, new Date())).toMatchObject({ status: 'counted', count: 2 });
	});

	it('says «fewer than N» below the small-count threshold of the catalog policy', async () => {
		await candidate('direct');
		const author = await employer();
		const unsaved = unsavedVacancyOf(await draftOf(author));
		expect(await estimate(author, unsaved)).toEqual({ status: 'counted', count: 1 });
		expect(await estimate(author, unsaved, new Date(Date.now() + 2 * DAY))).toEqual({
			status: 'below_threshold',
			threshold: 5
		});
	});

	it('needs required skills to count: a role alone leaves nobody confirmed', async () => {
		await candidate('direct');
		const author = await employer();
		const unsaved = unsavedVacancyOf(await draftOf(author));
		expect(unsaved.roleKey).not.toBeNull();
		expect(await estimate(author, { ...unsaved, requiredSkillKeys: [] })).toEqual({ status: 'insufficient_data' });
		// Skills alone are enough.
		expect(await estimate(author, { ...unsaved, roleKey: null })).toEqual({ status: 'counted', count: 1 });
	});

	it('counts within the reach of the company: a demo session adds its own candidates', async () => {
		const session = await demoSession();
		await candidate('direct');
		await candidate('direct', session);
		await candidate('direct', await demoSession());

		const outside = await employer();
		expect(await estimate(outside, unsavedVacancyOf(await draftOf(outside)))).toEqual({ status: 'counted', count: 1 });
		const visitor = await employer(session);
		expect(await estimate(visitor, unsavedVacancyOf(await draftOf(visitor)))).toEqual({ status: 'counted', count: 2 });
	});
});
