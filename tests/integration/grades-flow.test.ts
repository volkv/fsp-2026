// The way to a test against the database (docs/domain.md, sections 12.2, 12.3): the survey — every submission a new
// version, its terms written to the profile; the grade hint and the declaration with the hint's snapshot; the refusals
// of a closed specialization and of a running attempt; the step to a category; the rows append-only.
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { auditEvents, candidates, candidateSurveys, gradeDeclarations } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { declarationHistory, declareGrade, hintForSelf } from '$lib/server/grades/declarations';
import { admitGradeTest } from '$lib/server/grades/policy';
import type { GradeSources, SourceAttempt } from '$lib/server/grades/sources';
import { loadGradeStanding } from '$lib/server/grades/standing';
import { submitSurvey, surveyHistory, type SurveyInput } from '$lib/server/grades/surveys';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import { createCandidate } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const meta = { requestId: 'grades-test', ip: '127.0.0.1', userAgent: 'vitest' };

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
}, 180_000);

afterAll(async () => {
	await database.drop();
});

/** The readers of the owners of releases, attempts and categories, as a test sets them. */
function sources(state: { released?: string[]; attempts?: SourceAttempt[] } = {}): GradeSources {
	return {
		releasedSpecializations: () =>
			Promise.resolve(new Set((state.released ?? ['backend', 'frontend']) as ('backend' | 'frontend')[])),
		activeCategories: () => Promise.resolve([]),
		policyAttempts: () => Promise.resolve(state.attempts ?? [])
	};
}

async function candidateSubject(status: 'active' | 'onboarding' = 'active') {
	const candidate = await createCandidate(database.db, { status });
	const subject: AccessSubject = {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { candidate, subject };
}

const backend: SurveyInput = {
	direction: 'development',
	specialization: 'backend',
	declaredSkillKeys: ['go', 'sql'],
	preferences: {
		work_formats: ['remote'],
		region_code: 'RU-MOW',
		salary_expectation: { min: 200_000, max: 260_000, currency: 'RUB', period: 'month', tax_base: 'net' }
	}
};

async function refusal(work: Promise<unknown>): Promise<ApiError> {
	const caught = await work.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(caught instanceof ApiError)) throw new Error(`expected a refusal, got ${String(caught)}`);
	return caught;
}

describe('the survey', () => {
	it('stores a new version every time and writes its terms to the profile with the revision moved', async () => {
		const { db } = database;
		const { candidate, subject } = await candidateSubject();
		const first = await submitSurvey(db, sources(), subject, backend, meta);
		expect(first.version).toBe(1);
		const [profile] = await db.select().from(candidates).where(eq(candidates.id, candidate.id));
		expect(profile?.preferences).toEqual(backend.preferences);
		expect(profile?.profileRevision).toBe(candidate.profileRevision + 1);

		const second = await submitSurvey(
			db,
			sources(),
			subject,
			{ ...backend, specialization: 'frontend', declaredSkillKeys: ['javascript'] },
			meta
		);
		expect(second.version).toBe(2);
		const history = await surveyHistory(db, candidate.id);
		expect(history.map((s) => [s.version, s.specialization, s.catalogVersion])).toEqual([
			[1, 'backend', CATALOG.version],
			[2, 'frontend', CATALOG.version]
		]);
		const journal = await db
			.select({ action: auditEvents.action })
			.from(auditEvents)
			.where(and(eq(auditEvents.subjectCandidateId, candidate.id), eq(auditEvents.action, 'survey.submitted')));
		expect(journal).toHaveLength(2);
	});

	it('refuses a closed specialization, an unknown skill, a foreign currency and a specialization of another direction', async () => {
		const { db } = database;
		const { subject } = await candidateSubject();
		const closed = await refusal(submitSurvey(db, sources({ released: ['frontend'] }), subject, backend, meta));
		expect(closed.status).toBe(422);
		expect(closed.details).toEqual([expect.objectContaining({ code: 'specialization_closed' })]);
		// Mobile is switched off in the catalog: a release would not open it.
		const mobile = await refusal(
			submitSurvey(
				db,
				sources({ released: ['mobile'] }),
				subject,
				{ ...backend, specialization: 'mobile', declaredSkillKeys: ['kotlin'] },
				meta
			)
		);
		expect(mobile.details).toEqual([expect.objectContaining({ code: 'specialization_closed' })]);

		const invalid = await refusal(
			submitSurvey(
				db,
				sources(),
				subject,
				{
					direction: 'quality',
					specialization: 'backend',
					declaredSkillKeys: ['go', 'no_such_skill'],
					preferences: {
						salary_expectation: { min: 3000, max: null, currency: 'USD', period: 'month', tax_base: 'gross' }
					}
				},
				meta
			)
		);
		expect(invalid.status).toBe(400);
		expect(invalid.details?.map((d) => `${d.path ?? ''}:${d.code}`).sort()).toEqual([
			'declared_skill_keys:unknown',
			'preferences.salary_expectation.currency:not_rub',
			'specialization:other_direction'
		]);
		const empty = await refusal(submitSurvey(db, sources(), subject, { ...backend, declaredSkillKeys: [] }, meta));
		expect(empty.details).toEqual([expect.objectContaining({ path: 'declared_skill_keys', code: 'too_small' })]);
	});

	it('is closed to a profile without the processing consent', async () => {
		const { subject } = await candidateSubject('onboarding');
		expect((await refusal(submitSurvey(database.db, sources(), subject, backend, meta))).status).toBe(403);
	});
});

describe('the hint and the declaration', () => {
	it('needs a survey first', async () => {
		const { subject } = await candidateSubject();
		const error = await refusal(hintForSelf(database.db, subject, new Date()));
		expect(error.status).toBe(409);
		expect(error.details).toEqual([expect.objectContaining({ code: 'not_declared' })]);
		const declaration = await refusal(
			declareGrade(database.db, sources(), subject, { specialization: 'backend', grade: 'junior' }, meta, new Date())
		);
		expect(declaration.details).toEqual([expect.objectContaining({ code: 'not_declared' })]);
	});

	it('stores the hint as shown with the declaration, in the specialization of the survey', async () => {
		const { db } = database;
		const { candidate, subject } = await candidateSubject();
		const survey = await submitSurvey(db, sources(), subject, backend, meta);
		const { hint } = await hintForSelf(db, subject, new Date());
		// No resume, no FSP, no public profile: nothing to suggest.
		expect(hint).toMatchObject({ version: 1, suggested: null, bases: [] });

		const other = await refusal(
			declareGrade(db, sources(), subject, { specialization: 'frontend', grade: 'junior' }, meta, new Date())
		);
		expect(other.details).toEqual([expect.objectContaining({ code: 'survey_specialization' })]);

		const at = new Date('2026-10-05T10:00:00Z');
		const declaration = await declareGrade(
			db,
			sources(),
			subject,
			{ specialization: 'backend', grade: 'middle' },
			meta,
			at
		);
		expect(declaration).toMatchObject({ surveyId: survey.surveyId, grade: 'middle', hint, declaredAt: at });
		// Another grade later: a new row, the history keeps both.
		await declareGrade(
			db,
			sources(),
			subject,
			{ specialization: 'backend', grade: 'junior' },
			meta,
			new Date('2026-10-06T10:00:00Z')
		);
		expect((await declarationHistory(db, candidate.id)).map((d) => d.grade)).toEqual(['middle', 'junior']);
	});

	it('refuses a declaration while an attempt runs', async () => {
		const { db } = database;
		const { subject } = await candidateSubject();
		await submitSurvey(db, sources(), subject, backend, meta);
		const running: SourceAttempt = {
			specialization: 'backend',
			grade: 'junior',
			startedAt: new Date(),
			endedAt: null,
			state: 'in_progress'
		};
		const error = await refusal(
			declareGrade(
				db,
				sources({ attempts: [running] }),
				subject,
				{ specialization: 'backend', grade: 'middle' },
				meta,
				new Date()
			)
		);
		expect(error.status).toBe(409);
		expect(error.details).toEqual([expect.objectContaining({ code: 'attempt_in_progress' })]);
	});
});

describe('the policy over the stored declaration', () => {
	it('admits the declared test, refuses others with the reason, and leads the step to the category', async () => {
		const { db } = database;
		const { candidate, subject } = await candidateSubject();
		const now = new Date('2026-10-05T10:00:00Z');
		let standing = await loadGradeStanding(db, sources(), candidate.id, now);
		expect(standing.next).toEqual({ kind: 'survey' });
		expect(standing.steps).toEqual({ survey: false, declaration: false, test: false });

		await submitSurvey(db, sources(), subject, backend, meta);
		standing = await loadGradeStanding(db, sources(), candidate.id, now);
		expect(standing.next).toEqual({ kind: 'declare', specialization: 'backend' });
		const closedTest = await refusal(
			admitGradeTest(db, sources(), { candidateId: candidate.id, specialization: 'backend', grade: 'junior', now })
		);
		expect(closedTest.details).toEqual([expect.objectContaining({ code: 'not_declared' })]);

		await declareGrade(db, sources(), subject, { specialization: 'backend', grade: 'middle' }, meta, now);
		const request = { candidateId: candidate.id, specialization: 'backend' as const, now };
		expect(await admitGradeTest(db, sources(), { ...request, grade: 'middle' })).toEqual({ kind: 'declared' });
		const above = await refusal(admitGradeTest(db, sources(), { ...request, grade: 'senior' }));
		expect(above.details).toEqual([expect.objectContaining({ code: 'above_declared' })]);
		const closedSpecialization = await refusal(
			admitGradeTest(db, sources({ released: ['frontend'] }), { ...request, grade: 'middle' })
		);
		expect(closedSpecialization.status).toBe(422);

		// After a failure on the declared grade: the grade below at once, the same grade after the retake interval.
		const failed: SourceAttempt = {
			specialization: 'backend',
			grade: 'middle',
			startedAt: now,
			endedAt: now,
			state: { decided: 'not_confirmed', reason: 'sprt_lower' }
		};
		standing = await loadGradeStanding(db, sources({ attempts: [failed] }), candidate.id, now);
		expect(standing.steps).toEqual({ survey: true, declaration: true, test: false });
		expect(standing.next).toEqual({ kind: 'test', grade: 'junior', option: 'lower_after_failure' });
		expect(standing.options.find((o) => o.grade === 'middle')).toMatchObject({
			available: false,
			reason: 'retake_interval'
		});
	});
});

describe('surveys and declarations are append-only', () => {
	it('refuse UPDATE and DELETE', async () => {
		const { db } = database;
		const { candidate, subject } = await candidateSubject();
		await submitSurvey(db, sources(), subject, backend, meta);
		await declareGrade(db, sources(), subject, { specialization: 'backend', grade: 'junior' }, meta, new Date());
		await expectDbError(
			db.update(candidateSurveys).set({ version: 9 }).where(eq(candidateSurveys.candidateId, candidate.id)),
			SQLSTATE.restrictViolation,
			/append-only/
		);
		await expectDbError(
			db.delete(gradeDeclarations).where(eq(gradeDeclarations.candidateId, candidate.id)),
			SQLSTATE.restrictViolation,
			/append-only/
		);
	});
});
