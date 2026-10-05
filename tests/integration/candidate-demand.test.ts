// «Что ищет рынок в твоей категории» against the database (CONCEPT, promises 3 and 5): the required skills of the open
// vacancies the candidate can reach, counted in the roles of the category's specialization and its grade with the next
// one, the gaps among them with the way to confirm each, the whole specialization when the grade has too few vacancies,
// and «недостаточно данных» below the minimal sample of `market_policy`. The published taxonomy and assessment bank are
// the real ones; the evidence runs are written straight into the tables, the categories come from grade decisions.
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { readAssessmentBank } from '$lib/server/assessments/bank';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { publishAssessmentBank } from '$lib/server/assessments/publish';
import { candidateDemand, type CandidateDemand } from '$lib/server/candidates/demand';
import {
	categorizationRulesets,
	evidenceRuns,
	demoSessions,
	productPolicies,
	skillInferences,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createOwnVacancy,
	createUser,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const BANK_DIR = fileURLToPath(new URL('../../assessments', import.meta.url));
const NOW = new Date();
const DAY = 86_400_000;
/** `market_policy.min_sample`: the fewest vacancies a share is shown for. */
const MIN_SAMPLE = 5;

let database: TestDatabase;
let taxonomyVersionId: string;
let rulesetId: string;
let session: string;
const assessmentIds = new Map<string, string>();

type SkillRow = {
	skillKey: string;
	attestation: 'direct' | 'derived' | 'claimed';
	badgeTrust?: 'fsp_verified' | 'platform_verified' | 'public_verifiable';
};

/**
 * A candidate with the category given, if any, and — unless `run` is false — a published run of the inferences given.
 */
async function categorized(input: {
	category: { specialization: SpecializationKey; grade: GradeKey } | null;
	skills?: SkillRow[];
	run?: boolean;
	session?: string;
}): Promise<AccessSubject> {
	const { db } = database;
	const user = await createUser(db, input.session ? { demoSessionId: input.session } : {});
	const person = await createCandidate(db, {
		userId: user.id,
		// The grade decision moves the profile to revision 1, the one of the run.
		profileRevision: input.category ? 0 : 1,
		...(input.session ? { demoSessionId: input.session } : {})
	});
	if (input.category) await decide(db, person.id, input.category);
	if (input.run === false) return subjectOf(user.id, person.id);
	const [fact] = await db
		.insert(sourceFacts)
		.values({
			candidateId: person.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:result:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: NOW,
			lastVerifiedAt: NOW,
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('fact not inserted');
	const [run] = await db
		.insert(evidenceRuns)
		.values({
			candidateId: person.id,
			inputRevision: 1,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [fact.id], claims: [] },
			taxonomyVersionId,
			rulesetId,
			asOf: NOW,
			computedAt: NOW,
			experienceSummary: {},
			status: 'published'
		})
		.returning({ id: evidenceRuns.id });
	if (!run) throw new Error('run not inserted');
	for (const skill of input.skills ?? []) {
		await db.insert(skillInferences).values({
			runId: run.id,
			candidateId: person.id,
			skillKey: skill.skillKey,
			strength: '0.800',
			strengthBand: 'strong',
			attestation: skill.attestation,
			badgeTrust: skill.badgeTrust ?? null,
			contributions: [{ fact_id: fact.id, source: 'fsp', attestation: skill.attestation }]
		});
	}
	return subjectOf(user.id, person.id);
}

function subjectOf(userId: string, candidateId: string): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: { id: candidateId, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

function available(result: CandidateDemand) {
	if (result.status !== 'available') throw new Error(`expected an available demand, got ${result.status}`);
	return result;
}

const shares = (result: ReturnType<typeof available>) =>
	Object.fromEntries(result.gaps.map((gap) => [gap.skillKey, [gap.vacancies, gap.status]]));

beforeAll(async () => {
	database = await createTestDatabase();
	const { db } = database;
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
		for (const item of (await publishAssessmentBank(client, await readAssessmentBank(BANK_DIR))).assessments) {
			assessmentIds.set(item.key, item.assessmentId);
		}
	} finally {
		await client.end({ timeout: 5 });
	}
	const [version] = await db
		.select({ id: taxonomyVersions.id })
		.from(taxonomyVersions)
		.where(eq(taxonomyVersions.status, 'published'))
		.orderBy(desc(taxonomyVersions.publishedAt))
		.limit(1);
	if (!version) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	const [ruleset] = await db
		.select({ id: categorizationRulesets.id })
		.from(categorizationRulesets)
		.where(and(eq(categorizationRulesets.taxonomyVersionId, taxonomyVersionId)))
		.limit(1);
	if (!ruleset) throw new Error('the release has no categorization ruleset');
	rulesetId = ruleset.id;
	const since = new Date(NOW.getTime() - 400 * DAY);
	await db.insert(productPolicies).values([
		{ kind: 'market_policy', version: 1, params: { window_days: 30, min_sample: MIN_SAMPLE }, effectiveFrom: since },
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom: since }
	]);

	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	const own = (overrides: Parameters<typeof createOwnVacancy>[2]) =>
		createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId }, overrides);
	// Backend, meeting the grades middle–senior: four middle–senior, one junior–middle, one senior–lead.
	for (let i = 0; i < 4; i++) await own({ requiredSkillKeys: ['go', 'sql', 'docker'] });
	await own({ gradeMin: 'junior', gradeMax: 'middle', requiredSkillKeys: ['go', 'kafka', 'algorithms'] });
	await own({ gradeMin: 'senior', gradeMax: 'lead', requiredSkillKeys: ['go', 'kubernetes'] });
	// An external backend posting with a stated middle grade.
	await createExternalVacancy(db, taxonomyVersionId, {
		roleKey: 'backend',
		gradeMin: 'middle',
		gradeMax: 'middle',
		gradeBasis: 'inferred',
		requiredSkillKeys: ['sql', 'python']
	});
	// Backend outside the grades, backend of unknown grade, another role, and vacancies nobody can be matched with.
	await own({ gradeMin: 'lead', gradeMax: 'principal', requiredSkillKeys: ['rust'] });
	await createExternalVacancy(db, taxonomyVersionId, { roleKey: 'backend', requiredSkillKeys: ['php'] });
	await own({ roleKey: 'frontend', requiredSkillKeys: ['javascript'] });
	await own({ status: 'draft', publishedAt: null, requiredSkillKeys: ['haskell'] });
	await createExternalVacancy(db, taxonomyVersionId, {
		roleKey: 'backend',
		status: 'closed',
		closedAt: NOW,
		requiredSkillKeys: ['perl']
	});
	const pending = await createCompany(db, { status: 'submitted' });
	await createOwnVacancy(
		db,
		{ companyId: pending.id, memberId: (await createMember(db, pending.id)).id, taxonomyVersionId },
		{ requiredSkillKeys: ['cobol'] }
	);

	// A demo session with its own company: its backend vacancy is within reach of the session only.
	const [row] = await db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-demand', expiresAt: new Date(Date.now() + DAY) })
		.returning({ id: demoSessions.id });
	if (!row) throw new Error('demo session not inserted');
	session = row.id;
	const demoCompany = await createCompany(db, { demoSessionId: session, seedBatchId: 'demo-demand' });
	await createOwnVacancy(
		db,
		{ companyId: demoCompany.id, memberId: (await createMember(db, demoCompany.id)).id, taxonomyVersionId },
		{ requiredSkillKeys: ['go', 'graphql'], seedBatchId: 'demo-demand' }
	);
});

afterAll(async () => {
	await database.drop();
});

describe('what the market asks for in the category', () => {
	const middleBackend: Parameters<typeof categorized>[0] = {
		category: { specialization: 'backend', grade: 'middle' },
		skills: [
			{ skillKey: 'go', attestation: 'direct', badgeTrust: 'platform_verified' },
			{ skillKey: 'sql', attestation: 'claimed' },
			{ skillKey: 'docker', attestation: 'derived' },
			{ skillKey: 'python', attestation: 'direct', badgeTrust: 'public_verifiable' }
		]
	};

	it('counts the reachable vacancies of the specialization in the grade and the next one, and names the unconfirmed skills', async () => {
		const result = available(await candidateDemand(database.db, await categorized(middleBackend), NOW));

		expect(result.cohort).toEqual({
			specialization: 'backend',
			gradeKeys: ['middle', 'senior'],
			widenedFrom: null
		});
		expect(result.threshold).toBe(MIN_SAMPLE);
		expect(result.source).toMatchObject({ vacancies: 7, own: 6, external: 1, synthetic: false });
		expect(result.source.latestSeenAt).toBeInstanceOf(Date);
		// Go is confirmed by the platform and is not a gap; a claim, a derived inference and a public profile are.
		expect(shares(result)).toEqual({
			sql: [5, 'claimed'],
			docker: [4, 'derived'],
			algorithms: [1, 'missing'],
			kafka: [1, 'missing'],
			kubernetes: [1, 'missing'],
			python: [1, 'public_profile']
		});
		expect(result.gaps.map((gap) => gap.skillKey).slice(0, 2)).toEqual(['sql', 'docker']);
		expect(result.gaps[0]?.share).toBeCloseTo(5 / 7);
		expect(result.confirmed).toEqual([{ skillKey: 'go', share: 6 / 7 }]);
	});

	it('points each gap to a platform test or an FSP result, or says there is neither', async () => {
		const result = available(await candidateDemand(database.db, await categorized(middleBackend), NOW));
		const path = (key: string) => result.gaps.find((gap) => gap.skillKey === key)?.path;

		expect(path('sql')?.tests.map((test) => [test.assessmentId, test.kind])).toContainEqual([
			assessmentIds.get('quiz-sql'),
			'quiz'
		]);
		expect(path('docker')?.tests.map((test) => test.kind)).toContain('quiz');
		expect(path('algorithms')).toMatchObject({ fspDisciplines: ['algorithmic'] });
		expect(path('kafka')).toEqual({ tests: [], fspDisciplines: [] });
	});

	it('counts the whole specialization when the grade has fewer vacancies than the minimal sample', async () => {
		const intern = await categorized({ category: { specialization: 'backend', grade: 'intern' } });
		const result = available(await candidateDemand(database.db, intern, NOW));

		// Intern and junior meet one vacancy; backend has nine reachable ones, the unknown grade included.
		expect(result.cohort).toMatchObject({
			specialization: 'backend',
			gradeKeys: null,
			widenedFrom: { gradeKeys: ['intern', 'junior'], vacancies: 1 }
		});
		expect(result.source).toMatchObject({ vacancies: 9, own: 7, external: 2 });
	});

	it('says there is not enough data below the minimal sample, across the grades too', async () => {
		const result = await candidateDemand(
			database.db,
			await categorized({ category: { specialization: 'frontend', grade: 'middle' } }),
			NOW
		);

		expect(result).toMatchObject({
			status: 'insufficient_data',
			cohort: {
				specialization: 'frontend',
				gradeKeys: null,
				widenedFrom: { gradeKeys: ['middle', 'senior'], vacancies: 1 }
			},
			vacancies: 1,
			threshold: MIN_SAMPLE
		});
	});

	it('has nothing to count without a category in force, and waits for the evidence of a new one', async () => {
		expect(await candidateDemand(database.db, await categorized({ category: null }), NOW)).toEqual({
			status: 'no_category'
		});
		const { db } = database;
		const person = await createCandidate(db);
		expect(await candidateDemand(db, subjectOf(person.userId, person.id), NOW)).toEqual({ status: 'no_category' });
		// A category is in force, its evidence is not computed yet: what is confirmed is not known.
		const waiting = await categorized({ category: { specialization: 'backend', grade: 'middle' }, run: false });
		expect(await candidateDemand(db, waiting, NOW)).toEqual({ status: 'evidence_recalculating' });
	});

	it('counts the vacancies of a demo session for the session only', async () => {
		const clone = await categorized({ ...middleBackend, session });
		const inside = available(await candidateDemand(database.db, clone, NOW));

		expect(inside.source).toMatchObject({ vacancies: 8, own: 7, synthetic: true });
		expect(shares(inside)).toMatchObject({ graphql: [1, 'missing'] });
		const outside = available(await candidateDemand(database.db, await categorized(middleBackend), NOW));
		expect(outside.source).toMatchObject({ vacancies: 7, synthetic: false });
		expect(shares(outside)).not.toHaveProperty('graphql');
	});

	it('refuses a subject without a candidate profile', async () => {
		await expect(
			candidateDemand(
				database.db,
				{
					userId: null,
					via: 'anonymous',
					candidate: null,
					membership: null,
					staff: { operator: false, admin: false, extraPermissions: [] }
				},
				NOW
			)
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
