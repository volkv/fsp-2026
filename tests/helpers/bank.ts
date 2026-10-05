// A released fixture bank for integration tests: the release row of a specialization from `fixtureFamilies`, and the
// source of its generators for the engine (the fixture families live in memory, not in the bank tree).
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ModuleSource } from '../../src/lib/server/assessments/bank-store';
import { CATALOG, type GradeKey, type SpecializationKey } from '../../src/lib/server/assessments/contract/catalog';
import { GRADE_POLICY } from '../../src/lib/server/assessments/contract/policy';
import { PROCEDURE } from '../../src/lib/server/assessments/contract/procedure';
import type { LoadedFamily } from '../../src/lib/server/assessments/families';
import { assembleRelease } from '../../src/lib/server/assessments/release';
import type { Database } from '../../src/lib/server/db';
import {
	bankReleases,
	candidateSurveys,
	gradeDecisions,
	gradeDeclarations,
	testAttempts
} from '../../src/lib/server/db/schema';
import { createTaxonomyVersion } from './factories';
import { fixtureFamilies, type FixtureOptions } from './families';

export interface FixtureBank {
	releaseId: string;
	families: LoadedFamily[];
	modules: ModuleSource;
}

/** Releases the fixture bank of a specialization (it must have no problems) and returns its generators. */
export async function releaseFixtureBank(
	db: Database,
	specialization: SpecializationKey,
	options: FixtureOptions & { n?: number } = {}
): Promise<FixtureBank> {
	const families = fixtureFamilies(specialization, options);
	const sharedSha256 = '0'.repeat(64);
	const assembled = assembleRelease(specialization, families, sharedSha256, options.n ?? 1);
	if (assembled.problems.length > 0)
		throw new Error(`fixture bank: ${assembled.problems.map((p) => `${p.code}: ${p.message}`).join('; ')}`);
	await db.insert(bankReleases).values({
		id: assembled.release.id,
		specialization,
		catalogVersion: assembled.release.catalogVersion,
		procedureVersion: assembled.release.procedureVersion,
		contentSha256: assembled.contentSha256,
		sharedSha256,
		manifest: assembled.manifest,
		status: 'released',
		releasedAt: new Date()
	});
	const byKey = new Map(families.map((f) => [f.descriptor.key, f.module]));
	return {
		releaseId: assembled.release.id,
		families,
		modules: (family) => {
			const module = byKey.get(family.descriptor.key);
			if (!module) return Promise.reject(new Error(`no fixture generator for ${family.descriptor.key}`));
			return Promise.resolve(module);
		}
	};
}

/** A bare attempt row of a released bank, for tests about who reaches an attempt rather than how it runs. */
export async function insertAttempt(
	db: Database,
	input: { candidateId: string; releaseId: string; status: 'in_progress' | 'expired'; startedAt?: Date }
): Promise<typeof testAttempts.$inferSelect> {
	const startedAt = input.startedAt ?? new Date();
	const [attempt] = await db
		.insert(testAttempts)
		.values({
			candidateId: input.candidateId,
			purpose: 'grade',
			viaConfidentUpgrade: false,
			specialization: input.releaseId.split('@')[0] ?? '',
			grade: 'junior',
			catalogVersion: CATALOG.version,
			bankReleaseId: input.releaseId,
			procedureVersion: PROCEDURE.version,
			policyVersion: GRADE_POLICY.version,
			form: 'A',
			seed: randomBytes(16).toString('hex'),
			status: input.status,
			startedAt,
			deadlineAt: new Date(startedAt.getTime() + 3_600_000),
			endedAt: input.status === 'in_progress' ? null : startedAt
		})
		.returning();
	if (!attempt) throw new Error('attempt not inserted');
	return attempt;
}

/** A decided attempt with its valid decision (not confirmed), for tests that read decisions. */
export async function insertDecidedAttempt(
	db: Database,
	input: { candidateId: string; releaseId: string }
): Promise<{ attemptId: string; decisionId: string }> {
	const attempt = await insertAttempt(db, { ...input, status: 'expired' });
	await db.update(testAttempts).set({ status: 'decided' }).where(eq(testAttempts.id, attempt.id));
	const [decision] = await db
		.insert(gradeDecisions)
		.values({
			attemptId: attempt.id,
			candidateId: input.candidateId,
			specialization: attempt.specialization,
			grade: attempt.grade,
			outcome: 'not_confirmed',
			reason: 'sprt_lower',
			confident: false,
			llr: -2_300_000,
			scoreSum: 20,
			cutSum: 72,
			items: 6,
			extensionUsed: false,
			practice: { score: 0.4, gateMinScore: 0.4, passed: true },
			blocks: [],
			procedureVersion: PROCEDURE.version,
			bankReleaseId: input.releaseId,
			status: 'valid',
			decidedAt: attempt.startedAt
		})
		.returning({ id: gradeDecisions.id });
	if (!decision) throw new Error('decision not inserted');
	return { attemptId: attempt.id, decisionId: decision.id };
}

/** A survey of the specialization and a declaration of the grade, the way the candidate makes them (domain 12.2). */
export async function declareGrade(
	db: Database,
	candidateId: string,
	specialization: SpecializationKey,
	grade: GradeKey
): Promise<void> {
	const taxonomy = await createTaxonomyVersion(db);
	const direction = CATALOG.specializations.find((s) => s.key === specialization)?.direction;
	if (!direction) throw new Error(`no direction of ${specialization}`);
	const surveys = await db
		.select({ id: candidateSurveys.id })
		.from(candidateSurveys)
		.where(eq(candidateSurveys.candidateId, candidateId));
	const [survey] = await db
		.insert(candidateSurveys)
		.values({
			candidateId,
			version: surveys.length + 1,
			catalogVersion: CATALOG.version,
			taxonomyVersionId: taxonomy.id,
			direction,
			specialization,
			declaredSkillKeys: ['python'],
			preferences: {}
		})
		.returning({ id: candidateSurveys.id });
	if (!survey) throw new Error('survey not inserted');
	await db.insert(gradeDeclarations).values({
		candidateId,
		surveyId: survey.id,
		specialization,
		grade,
		hint: { suggested: null },
		declaredAt: new Date()
	});
}
