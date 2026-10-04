import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categorizationRulesets, categorizationRuns, categoryAssignments } from '$lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import { createCandidate, createTaxonomyVersion, randomSha256 } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

let rulesetVersion = 0;

async function createRun(outcome: 'complete' | 'partial' | 'insufficient_data') {
	const { db } = database;
	const candidate = await createCandidate(db);
	const taxonomy = await createTaxonomyVersion(db);
	const [ruleset] = await db
		.insert(categorizationRulesets)
		.values({ version: ++rulesetVersion, taxonomyVersionId: taxonomy.id, params: {} })
		.returning();
	if (!ruleset) throw new Error('ruleset not inserted');
	const [run] = await db
		.insert(categorizationRuns)
		.values({
			candidateId: candidate.id,
			inputRevision: 0,
			inputSnapshotSha256: randomSha256(),
			inputRefs: { facts: [], claims: [] },
			taxonomyVersionId: taxonomy.id,
			rulesetId: ruleset.id,
			asOf: new Date(),
			computedAt: new Date(),
			origin: 'automatic',
			outcome,
			missing: { grade: [{ code: 'no_dated_experience' }] },
			experienceSummary: {},
			status: 'computed'
		})
		.returning();
	if (!run) throw new Error('run not inserted');
	return run;
}

const partialAxes = {
	rank: 'primary' as const,
	roleStatus: 'established' as const,
	roleKey: 'backend',
	score: '0.8',
	gradeStatus: 'insufficient_data' as const,
	stackStatus: 'established' as const,
	stackSkillKeys: ['go'],
	explanation: { contributions: [] }
};

describe('partial categorization', () => {
	it('keeps the established axes when grade has insufficient data', async () => {
		const { db } = database;
		const run = await createRun('partial');
		await db.insert(categoryAssignments).values({ runId: run.id, ...partialAxes });
		const [stored] = await db.select().from(categoryAssignments).where(eq(categoryAssignments.runId, run.id));
		expect(stored).toMatchObject({
			roleStatus: 'established',
			roleKey: 'backend',
			gradeStatus: 'insufficient_data',
			gradeMin: null,
			gradeMax: null,
			stackStatus: 'established',
			stackSkillKeys: ['go']
		});
	});

	it('refuses an assignment without any established axis', async () => {
		const run = await createRun('partial');
		await expectDbError(
			database.db.insert(categoryAssignments).values({
				runId: run.id,
				...partialAxes,
				roleStatus: 'insufficient_data',
				roleKey: null,
				score: null,
				stackStatus: 'insufficient_data',
				stackSkillKeys: []
			}),
			SQLSTATE.checkViolation,
			/category_assignments_some_axis/
		);
	});

	it('refuses a value on an axis marked insufficient and a grade without its range', async () => {
		const run = await createRun('partial');
		await expectDbError(
			database.db.insert(categoryAssignments).values({ runId: run.id, ...partialAxes, gradeMin: 'middle' }),
			SQLSTATE.checkViolation,
			/category_assignments_grade_axis/
		);
		await expectDbError(
			database.db
				.insert(categoryAssignments)
				.values({ runId: run.id, ...partialAxes, gradeStatus: 'established', gradeMin: 'middle' }),
			SQLSTATE.checkViolation,
			/category_assignments_grade_axis/
		);
	});

	it('allows one primary and requires a role on a secondary category', async () => {
		const { db } = database;
		const run = await createRun('complete');
		await db.insert(categoryAssignments).values({ runId: run.id, ...partialAxes });
		await expectDbError(
			db.insert(categoryAssignments).values({ runId: run.id, ...partialAxes }),
			SQLSTATE.uniqueViolation,
			/category_assignments_one_primary/
		);
		await expectDbError(
			db.insert(categoryAssignments).values({
				runId: run.id,
				...partialAxes,
				rank: 'secondary',
				roleStatus: 'insufficient_data',
				roleKey: null,
				score: null
			}),
			SQLSTATE.checkViolation,
			/category_assignments_secondary_role/
		);
	});
});
