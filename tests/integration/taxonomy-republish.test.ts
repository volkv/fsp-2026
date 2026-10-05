// A new release of the rule sets or of the taxonomy (docs/domain.md, sections 11, 13.4, 17.3): the derivations computed
// on the previous ones — the evidence run, the match rows, the pool counter of a vacancy — are found by
// `derivations.reconcile`, which the publication enqueues at once, and recalculated, once, and the pool converges. Until then a read does not mix versions: the
// search document of a candidate names roles from one taxonomy version.
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	categorizationRulesets,
	evidenceRuns,
	consentEvents,
	experienceEntries,
	jobs,
	matchRulesets,
	matchScores,
	skillInferences,
	sourceFacts,
	vacancies
} from '$lib/server/db/schema';
import { derivationsReconcile } from '$lib/server/derivations/reconcile';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { candidateDocuments } from '$lib/server/matching/documents';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { fail } from '$lib/server/ml/result';
import { publishTaxonomy, type PublishOutcome } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets, type TaxonomyRelease } from '$lib/server/taxonomy/release';
import type { TaxonomyDatasets } from '$lib/server/taxonomy/datasets';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const POLICIES_DIR = fileURLToPath(new URL('../../policies', import.meta.url));

let database: TestDatabase;
let client: postgres.Sql;
let datasets: TaxonomyDatasets;
let first: PublishOutcome;

const modelsOff: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
};
const matchRefresh = createMatchRefreshHandler(() => modelsOff);

beforeAll(async () => {
	database = await createTestDatabase();
	client = postgres(database.url, { max: 1, onnotice: () => {} });
	datasets = await readTaxonomyDatasets(TAXONOMY_DIR);
	first = await publishTaxonomy(client, buildRelease(datasets));
	await publishPolicies(client, await readPolicyRelease(POLICIES_DIR));
});

afterAll(async () => {
	await client.end({ timeout: 5 });
	await database.drop();
});

/** The repository release with changes applied to a copy of its datasets. */
function changedRelease(change: (copy: TaxonomyDatasets) => void): TaxonomyRelease {
	const copy = structuredClone(datasets);
	change(copy);
	return buildRelease(copy);
}

/** An adult candidate in the catalog with a published evidence run: a directly confirmed strong `algorithms`. */
async function catalogCandidate() {
	const { db } = database;
	const row = await createCandidate(db, {
		visibility: 'catalog',
		profileRevision: 1,
		desiredRoleKeys: ['algo_engineer']
	});
	const catalogDocument = await createPublishedDocument(db, 'catalog_visibility');
	await db.insert(consentEvents).values({
		subjectCandidateId: row.id,
		kind: 'catalog_visibility',
		documentId: catalogDocument.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: row.userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - 60_000)
	});
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
	const [ruleset] = await db
		.select({ id: categorizationRulesets.id })
		.from(categorizationRulesets)
		.orderBy(desc(categorizationRulesets.version))
		.limit(1);
	if (!ruleset) throw new Error('no categorization rule set');
	const [run] = await db
		.insert(evidenceRuns)
		.values({
			candidateId: row.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [fact.id], claims: [] },
			taxonomyVersionId: first.taxonomyVersionId,
			rulesetId: ruleset.id,
			asOf: new Date(),
			computedAt: new Date(),
			experienceSummary: {},
			status: 'published'
		})
		.returning();
	if (!run) throw new Error('run not inserted');
	await db.insert(skillInferences).values({
		runId: run.id,
		candidateId: row.id,
		skillKey: 'algorithms',
		strength: '0.800',
		strengthBand: 'strong',
		attestation: 'direct',
		badgeTrust: 'fsp_verified',
		contributions: [{ fact_id: fact.id, attestation: 'direct' }]
	});
	return row;
}

async function algorithmsVacancy() {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	return createOwnVacancy(
		db,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId: first.taxonomyVersionId },
		{ title: 'Разработчик алгоритмов', roleKey: 'algo_engineer', requiredSkillKeys: ['algorithms'] }
	);
}

/** Captures and runs waiting `match.refresh` jobs the way the worker does, until none is due. */
async function runMatchJobs(): Promise<string[]> {
	const { db } = database;
	const outcomes: string[] = [];
	for (;;) {
		const claimed = await claimJob(db, 'test-worker', ['match.refresh']);
		if (!claimed) return outcomes;
		const job: ClaimedJob<'match.refresh'> = {
			...claimed,
			type: 'match.refresh',
			payload: JOB_TYPES['match.refresh'].payload.parse(claimed.payload)
		};
		try {
			const result = await matchRefresh.run({
				job,
				db,
				signal: new AbortController().signal,
				requestId: `job:${job.id}`,
				log: createLogger({}, () => undefined)
			});
			outcomes.push(await completeJob(db, job, result));
		} catch (error) {
			if (!(error instanceof JobFailure)) throw error;
			outcomes.push(await failJob(db, job, { code: error.code, retryable: false, message: error.message }));
		}
	}
}

async function reconcile(period: string) {
	await database.db.transaction((tx) =>
		enqueueJob(tx, 'derivations.reconcile', { period }, { inputVersion: period, createdBy: { kind: 'system' } })
	);
	await runReconcile();
}

/** The reconciliations waiting in the queue, by who enqueued them. */
async function waitingReconciles(): Promise<unknown[]> {
	const rows = await database.db
		.select({ createdBy: jobs.createdBy })
		.from(jobs)
		.where(and(eq(jobs.type, 'derivations.reconcile'), eq(jobs.status, 'queued')));
	return rows.map((row) => row.createdBy);
}

/** Captures the waiting reconciliation and completes it as the worker does it. */
async function runReconcile() {
	const { db } = database;
	const claimed = (await claimJob(db, 'reconcile-test', [
		'derivations.reconcile'
	])) as ClaimedJob<'derivations.reconcile'> | null;
	if (!claimed) throw new Error('reconcile job was not captured');
	const result = await derivationsReconcile.run({
		job: claimed,
		db,
		signal: new AbortController().signal,
		requestId: `job:${claimed.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(db, claimed, result)).toBe('succeeded');
}

/** Waiting jobs by deduplication key, as `type@input_version`; every job of these keys, whatever its status. */
async function jobsOf(keys: string[]) {
	const rows = await database.db
		.select({ key: jobs.dedupKey, type: jobs.type, inputVersion: jobs.inputVersion, status: jobs.status })
		.from(jobs)
		.where(inArray(jobs.dedupKey, keys));
	return {
		queued: rows
			.filter((row) => row.status === 'queued')
			.map((row) => `${row.key}@${row.inputVersion}`)
			.sort(),
		total: rows.length
	};
}

async function vacancyState(vacancyId: string) {
	const { db } = database;
	const [vacancy] = await db
		.select({ poolCount: vacancies.poolCount })
		.from(vacancies)
		.where(eq(vacancies.id, vacancyId));
	const rows = await db
		.select({ rulesetVersion: matchRulesets.version })
		.from(matchScores)
		.innerJoin(matchRulesets, eq(matchRulesets.id, matchScores.matchRulesetId))
		.where(eq(matchScores.vacancyId, vacancyId));
	return { pool: vacancy?.poolCount ?? null, rulesets: rows.map((row) => row.rulesetVersion).sort() };
}

describe('a new match rule set', () => {
	it('recounts the pool and the matches computed on the previous one, once', async () => {
		const { db } = database;
		const person = await catalogCandidate();
		const vacancy = await algorithmsVacancy();
		const vacancyKey = `match:vacancy:${vacancy.id}`;
		const candidateKey = `match:candidate:${person.id}`;
		const evidenceKey = `evidence:${person.id}`;
		const keys = [vacancyKey, candidateKey, evidenceKey];
		const shipped = datasets.matchRuleset.version;

		await db.transaction(async (tx) => {
			const options = { inputVersion: '1', createdBy: { kind: 'system' as const } };
			await enqueueJob(tx, 'match.refresh', { scope: 'vacancy', vacancy_id: vacancy.id }, options);
			await enqueueJob(tx, 'match.refresh', { scope: 'candidate', candidate_id: person.id }, options);
		});
		await runMatchJobs();
		expect(await vacancyState(vacancy.id)).toEqual({ pool: 1, rulesets: [shipped] });

		// The first publication enqueued its reconciliation; everything stands on the rule sets in force, so there is
		// nothing to reconcile for the pair.
		expect(await waitingReconciles()).toEqual([{ kind: 'system', id: 'taxonomy.publish' }]);
		await runReconcile();
		expect((await jobsOf(keys)).queued).toEqual([]);

		// A rule set whose pool threshold the pair does not reach.
		const outcome = await publishTaxonomy(
			client,
			changedRelease((copy) => {
				copy.matchRuleset.version = shipped + 1;
				copy.matchRuleset.params.poolThreshold = 0.99;
			})
		);
		expect(outcome).toMatchObject({
			taxonomy: 'unchanged',
			ruleset: { outcome: 'unchanged' },
			matchRuleset: { version: shipped + 1, outcome: 'created' }
		});

		// The publication enqueued the reconciliation at once; publishing the same release again adds none.
		expect(await waitingReconciles()).toEqual([{ kind: 'system', id: 'taxonomy.publish' }]);
		await publishTaxonomy(
			client,
			changedRelease((copy) => {
				copy.matchRuleset.version = shipped + 1;
				copy.matchRuleset.params.poolThreshold = 0.99;
			})
		);
		expect(await waitingReconciles()).toHaveLength(1);
		await runReconcile();
		const enqueued = await jobsOf(keys);
		// The evidence run stands on the categorization rule set in force; the matches and the pool do not.
		expect(enqueued.queued).toEqual([`${candidateKey}@1`, `${vacancyKey}@${vacancy.revision}`].sort());

		// The next hour adds nothing while they wait.
		await reconcile('2026-10-06T12');
		expect(await jobsOf(keys)).toEqual(enqueued);

		// The candidate's recalculation happens to run first: it replaces the pair's row of the old rule set and sees no
		// change of the pool under the new one — nothing asks for the vacancy, the counter is still the old one, and
		// only the vacancy's own recount, enqueued by the reconciliation, corrects it.
		await db
			.update(jobs)
			.set({ runAfter: sql`now() + interval '1 hour'` })
			.where(and(eq(jobs.dedupKey, vacancyKey), eq(jobs.status, 'queued')));
		expect(await runMatchJobs()).toEqual(['succeeded']);
		expect(await vacancyState(vacancy.id)).toEqual({ pool: 1, rulesets: [shipped + 1] });
		expect((await jobsOf([vacancyKey])).queued).toEqual([`${vacancyKey}@${vacancy.revision}`]);
		await db
			.update(jobs)
			.set({ runAfter: sql`now()` })
			.where(and(eq(jobs.dedupKey, vacancyKey), eq(jobs.status, 'queued')));
		expect(await runMatchJobs()).toEqual(['succeeded']);
		expect(await vacancyState(vacancy.id)).toEqual({ pool: 0, rulesets: [shipped + 1] });

		// Processed under the rule set in force: nothing more.
		const done = await jobsOf(keys);
		await reconcile('2026-10-06T13');
		expect(await jobsOf(keys)).toEqual(done);
	});
});

describe('a new taxonomy release', () => {
	it('recomputes the evidence and, until then, names roles from one taxonomy version per search document', async () => {
		const { db } = database;
		const withRun = await catalogCandidate();
		// Without a run: a desired role and an experience role, named by the version in force.
		const withoutRun = await createCandidate(db, { profileRevision: 1, desiredRoleKeys: ['algo_engineer'] });
		const [fact] = await db
			.insert(sourceFacts)
			.values({
				candidateId: withoutRun.id,
				source: 'resume',
				factType: 'resume_document',
				sourceRecordRef: `resume:${randomSha256().slice(0, 12)}`,
				trustLevel: 'claimed',
				ownershipBasis: 'self_upload',
				payload: {},
				payloadSha256: randomSha256(),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		if (!fact) throw new Error('fact not inserted');
		await db.insert(experienceEntries).values({
			candidateId: withoutRun.id,
			factId: fact.id,
			roleKey: 'backend',
			isCurrent: false,
			quotes: ['Бэкенд'],
			periodStatus: 'missing',
			status: 'active'
		});

		const names = (copy: TaxonomyDatasets) =>
			Object.fromEntries(copy.roles.roles.map((role) => [role.key, role.nameRu] as const));
		const before = names(datasets);
		const [year, month, number] = datasets.release.label.split('.');
		const renamed = changedRelease((copy) => {
			copy.release.label = `${year}.${month}.${Number(number) + 1}`;
			copy.categorizationRuleset.version += 1;
			copy.matchRuleset.version += 2;
			for (const role of copy.roles.roles) {
				if (role.key === 'algo_engineer' || role.key === 'backend') role.nameRu = `${role.nameRu} (новое название)`;
			}
		});
		const outcome = await publishTaxonomy(client, renamed);
		expect(outcome).toMatchObject({
			taxonomy: 'published',
			ruleset: { outcome: 'created' },
			matchRuleset: { outcome: 'created' }
		});

		const documents = await candidateDocuments(db, [withRun.id, withoutRun.id], null);
		const occurrences = (text: string, part: string) => text.split(part).length - 1;
		const withRunBody = documents.get(withRun.id)?.body ?? '';
		const unwithRunBody = documents.get(withoutRun.id)?.body ?? '';
		// The run was computed on the first release: its document keeps the names of that release, once each.
		expect(occurrences(withRunBody, 'новое название')).toBe(0);
		expect(occurrences(withRunBody, before.algo_engineer ?? '-')).toBeGreaterThan(0);
		// Without a run the version in force names both the desired and the experience role, the old name never.
		expect(occurrences(unwithRunBody, 'новое название')).toBe(2);
		expect(occurrences(unwithRunBody, before.algo_engineer ?? '-')).toBe(1);
		expect(occurrences(unwithRunBody, before.backend ?? '-')).toBe(1);

		expect(await waitingReconciles()).toEqual([{ kind: 'system', id: 'taxonomy.publish' }]);
		await runReconcile();
		expect((await jobsOf([`evidence:${withRun.id}`])).queued).toEqual([`evidence:${withRun.id}@1`]);
	});
});
