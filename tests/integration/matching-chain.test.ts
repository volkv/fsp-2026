// The chain from FSP achievements to matches, with each job run the way the worker runs it: `fsp.sync` against the
// simulator `services/fsp-mock` → `categorization.compute` from the handler registry → a published category →
// `match.refresh` of the candidate and of the vacancy → `match_scores` and the pool counter. A result annulled at the
// source blocks the category at once and the recalculation drops its contribution.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	athleteLinks,
	candidates,
	categorizationRuns,
	consentEvents,
	externalIdentities,
	jobs,
	matchScores,
	skillInferences,
	sourceFacts,
	taxonomyVersions,
	vacancies
} from '$lib/server/db/schema';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import type { Result } from '$lib/server/fsp/types';
import { JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { JOB_HANDLERS } from '$lib/server/jobs/handlers';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobPayload, type JobType } from '$lib/server/jobs/registry';
import { loadVacancySnapshot } from '$lib/server/matching/evidence';
import { COMPONENT_KEYS } from '$lib/server/matching/params';
import { scoreCandidatesForVacancy } from '$lib/server/matching/rank';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { storedComponent } from '$lib/server/matching/storage';
import { fail } from '$lib/server/ml/result';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument
} from '../helpers/factories';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const POLICIES_DIR = fileURLToPath(new URL('../../policies', import.meta.url));
const HERO = 'Алгоритмист, КМС';
const HERO_BIRTH_DATE = '2003-06-15';

let database: TestDatabase;
let mock: FspMock;
let fspSync: JobHandler<'fsp.sync'>;

/** Models switched off: matching runs on the rules alone, semantic and reranker components are unavailable. */
const modelsOff: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
};
const matchRefresh = createMatchRefreshHandler(() => modelsOff);

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
		await publishPolicies(client, await readPolicyRelease(POLICIES_DIR));
	} finally {
		await client.end({ timeout: 5 });
	}

	// No webhook receiver: every change at the source is followed by a sync the test enqueues itself.
	mock = await startFspMock();
	const credentials = FSP_MOCK_CREDENTIALS;
	const source = new HttpAchievementsSource({
		baseUrl: mock.origin,
		webhookSecret: credentials.webhookSecret,
		pageSize: 50
	});
	const grants = new ServiceGrantIssuer({
		issuer: mock.issuer,
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		assertionSecret: credentials.assertionSecret
	});
	const signer = createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) });
	fspSync = createFspSyncHandler(() => ({ source, grants, signer }));
});

afterAll(async () => {
	await mock.stop();
	await database.drop();
});

type Outcome = 'succeeded' | 'discarded_stale' | 'failed' | 'queued' | 'lease_lost';

/** What the worker does with the next captured job of the type. */
async function runNext<T extends JobType>(type: T, handler: JobHandler<T>): Promise<Outcome> {
	const { db } = database;
	const claimed = await claimJob(db, 'test-worker', [type]);
	if (claimed?.type !== type) throw new Error(`no ${type} job to run`);
	const job: ClaimedJob<T> = {
		...claimed,
		type,
		payload: JOB_TYPES[type].payload.parse(claimed.payload) as JobPayload<T>
	};
	try {
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		return await completeJob(db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
}

function registered<T extends JobType>(type: T): JobHandler<T> {
	const handler = JOB_HANDLERS.get(type);
	if (!handler) throw new Error(`no registered handler of ${type}`);
	return handler as JobHandler<T>;
}

async function queued(dedupKey: string) {
	return database.db
		.select()
		.from(jobs)
		.where(and(eq(jobs.dedupKey, dedupKey), eq(jobs.status, 'queued')));
}

/** An adult candidate in the catalog, signed in with FSP ID, who linked the athlete and granted the consents. */
async function linkHero() {
	const { db } = database;
	const fspId = await mock.heroId(HERO);

	const candidate = await createCandidate(db, { birthDate: HERO_BIRTH_DATE, visibility: 'catalog' });
	const [identity] = await db
		.insert(externalIdentities)
		.values({
			userId: candidate.userId,
			issuer: mock.issuer,
			subject: fspId,
			linkedAt: new Date(),
			linkMethod: 'signup_via_provider'
		})
		.returning();
	if (!identity) throw new Error('identity not inserted');
	const [link] = await db
		.insert(athleteLinks)
		.values({
			userId: candidate.userId,
			source: 'fsp',
			sourceAthleteId: fspId,
			basisIdentityId: identity.id,
			resolutionMethod: 'subject_equals_athlete_id',
			status: 'active',
			linkedAt: new Date()
		})
		.returning();
	if (!link) throw new Error('link not inserted');
	for (const kind of ['pd_processing', 'catalog_visibility', 'fsp_import'] as const) {
		const document = await createPublishedDocument(db, kind);
		await db.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind,
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: { document_sha256: document.bodySha256 },
			occurredAt: new Date(Date.now() - 60_000)
		});
	}
	return { candidateId: candidate.id, linkId: link.id };
}

async function enqueueSync(linkId: string): Promise<void> {
	await database.db.transaction((tx) =>
		enqueueJob(
			tx,
			'fsp.sync',
			{ athlete_link_id: linkId },
			{ inputVersion: `${linkId}:${randomUUID()}`, createdBy: { kind: 'system' } }
		)
	);
}

async function runsOf(candidateId: string) {
	return database.db
		.select()
		.from(categorizationRuns)
		.where(eq(categorizationRuns.candidateId, candidateId))
		.orderBy(categorizationRuns.id);
}

/** The stored match of the pair, if significant, and the facts behind its skill matches as the pair is read now. */
async function currentMatch(vacancyId: string, candidateId: string) {
	const { db } = database;
	const [row] = await db
		.select()
		.from(matchScores)
		.where(and(eq(matchScores.vacancyId, vacancyId), eq(matchScores.candidateId, candidateId)))
		.orderBy(desc(matchScores.computedAt))
		.limit(1);
	const vacancy = await loadVacancySnapshot(db, vacancyId);
	if (!vacancy) throw new Error('no vacancy');
	const scoring = await scoreCandidatesForVacancy(db, modelsOff, vacancy, [candidateId], {
		ruleset: await loadActiveMatchRuleset(db)
	});
	const [read] = scoring.ranked;
	if (!read) throw new Error('the pair is not scored');
	const { matches } = read.result.explanation;
	return {
		row: row ?? null,
		result: read.result,
		factIds: new Set(matches.flatMap((m) => (m.kind === 'skill' ? m.fact_ids : [])))
	};
}

async function poolCount(vacancyId: string) {
	const [row] = await database.db
		.select({ poolCount: vacancies.poolCount })
		.from(vacancies)
		.where(eq(vacancies.id, vacancyId));
	return row?.poolCount;
}

describe('achievements to matches', () => {
	let hero: { candidateId: string; linkId: string };
	let vacancyId: string;
	/** A fact behind the matched skill, whose result the source annuls. */
	let annulledFactId: string;
	/** Score of the pair while its category was published. */
	let pooledScore: number;

	beforeAll(async () => {
		const { db } = database;
		hero = await linkHero();
		// The algorithm role is only desired: FSP results confirm skills, they do not establish a kind of work.
		await db
			.update(candidates)
			.set({ desiredRoleKeys: ['algo_engineer'] })
			.where(eq(candidates.id, hero.candidateId));
		const company = await createCompany(db);
		const member = await createMember(db, company.id);
		const [version] = await db.select({ id: taxonomyVersions.id }).from(taxonomyVersions);
		if (!version) throw new Error('taxonomy not published');
		const vacancy = await createOwnVacancy(
			db,
			{ companyId: company.id, memberId: member.id, taxonomyVersionId: version.id },
			{ title: 'Разработчик алгоритмов', roleKey: 'algo_engineer', requiredSkillKeys: ['algorithms'] }
		);
		vacancyId = vacancy.id;
	});

	it('registers the chain in the worker handler registry', () => {
		for (const type of ['fsp.sync', 'categorization.compute', 'match.refresh'] as const) {
			expect(JOB_HANDLERS.get(type)?.type).toBe(type);
		}
	});

	it('turns synced achievements into a category, matches and a pool', async () => {
		const { db } = database;
		// Achievements → facts; the sync asks for the category and nothing else.
		await enqueueSync(hero.linkId);
		expect(await runNext('fsp.sync', fspSync)).toBe('succeeded');
		expect(await queued(`match:candidate:${hero.candidateId}`)).toEqual([]);

		// Category: published by the registered handler, which asks for the candidate's matches in the same write.
		expect(await runNext('categorization.compute', registered('categorization.compute'))).toBe('succeeded');
		const [first] = await runsOf(hero.candidateId);
		expect(first).toMatchObject({ status: 'published', inputRevision: 1 });
		const [algorithms] = await db
			.select()
			.from(skillInferences)
			.where(and(eq(skillInferences.runId, first?.id ?? ''), eq(skillInferences.skillKey, 'algorithms')));
		expect(algorithms?.attestation).toBe('direct');
		expect(await queued(`match:candidate:${hero.candidateId}`)).toHaveLength(1);

		// Matches of the candidate; the pair entering the pool asks for the vacancy's counter.
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		const match = await currentMatch(vacancyId, hero.candidateId);
		pooledScore = match.result.score;
		expect(match.row).toMatchObject({ candidateRevision: 1, categorizationRunId: first?.id });
		expect(Number(match.row?.score)).toBe(match.result.score);
		expect(match.result.components.role).toMatchObject({
			status: 'computed',
			value: (await loadActiveMatchRuleset(db)).params.role.desired,
			details: { vacancy: 'algo_engineer', candidate: [], basis: 'desired' }
		});
		// The stored decomposition is the one read now, the role component included.
		const row = match.row;
		if (!row) throw new Error('the pair is not stored');
		for (const key of COMPONENT_KEYS) {
			const { status, value } = match.result.components[key];
			expect(storedComponent(row, key)).toEqual({ status, value });
		}
		expect(match.result.components.trust.value ?? 0).toBeGreaterThan(0);
		expect(await queued(`match:vacancy:${vacancyId}`)).toHaveLength(1);
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		expect(await poolCount(vacancyId)).toBe(1);

		const contributing = (
			await db
				.select()
				.from(sourceFacts)
				.where(and(eq(sourceFacts.candidateId, hero.candidateId), eq(sourceFacts.status, 'active')))
		).find((fact) => match.factIds.has(fact.id) && fact.factType === 'competition_result');
		if (!contributing) throw new Error('no competition result behind the matched skill');
		annulledFactId = contributing.id;
	});

	it('blocks the category at once when a result is annulled at the source and takes the pair out of the pool', async () => {
		const { db } = database;
		const [fact] = await db.select().from(sourceFacts).where(eq(sourceFacts.id, annulledFactId));
		const resultId = (fact?.payload as { result: Result }).result.id;
		expect((await mock.control('PATCH', `results/${resultId}?notify=false`, { status: 'annulled' })).status).toBe(200);
		await enqueueSync(hero.linkId);
		expect(await runNext('fsp.sync', fspSync)).toBe('succeeded');

		// The withdrawal blocks the category in its own transaction and asks for the category and the matches.
		const [candidate] = await db
			.select({ revision: candidates.profileRevision, floor: candidates.evidenceFloorRevision })
			.from(candidates)
			.where(eq(candidates.id, hero.candidateId));
		expect(candidate).toEqual({ revision: 2, floor: 2 });
		expect((await runsOf(hero.candidateId)).map((r) => r.status)).toEqual(['blocked']);
		expect(await queued(`categorization:${hero.candidateId}`)).toHaveLength(1);
		expect(await queued(`match:candidate:${hero.candidateId}`)).toHaveLength(1);

		// Without a published category nothing confirms the requirement: the pair leaves the pool, its row of the old
		// snapshot goes and the new one is below the store threshold; read, it says there is not enough data, and the
		// skills it can no longer read count as unconfirmed instead of leaving the score to the rest.
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		const blocked = await currentMatch(vacancyId, hero.candidateId);
		expect(blocked.row).toBeNull();
		expect(blocked.factIds.size).toBe(0);
		expect(blocked.result.components.required).toMatchObject({
			status: 'unavailable',
			details: { reason: 'no_published_run' }
		});
		expect(blocked.result.explanation.to_verify).toContainEqual({ code: 'profile_insufficient_data' });
		expect(blocked.result.score).toBeLessThan(pooledScore);
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		expect(await poolCount(vacancyId)).toBe(0);
	});

	it('recomputes the matches from the category published without the annulled result', async () => {
		expect(await runNext('categorization.compute', registered('categorization.compute'))).toBe('succeeded');
		const second = (await runsOf(hero.candidateId)).find((r) => r.status === 'published');
		expect(second).toMatchObject({ inputRevision: 2 });
		expect(await queued(`match:candidate:${hero.candidateId}`)).toHaveLength(1);
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		const after = await currentMatch(vacancyId, hero.candidateId);
		expect(after.row).toMatchObject({ candidateRevision: 2, categorizationRunId: second?.id });
		expect(after.factIds.size).toBeGreaterThan(0);
		expect(after.factIds.has(annulledFactId)).toBe(false);
		expect(await runNext('match.refresh', matchRefresh)).toBe('succeeded');
		expect(await poolCount(vacancyId)).toBe(1);
	});
});
