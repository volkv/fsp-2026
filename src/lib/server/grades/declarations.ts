// The grade hint and the declared grade (docs/domain.md, section 12.2). The hint is computed at every showing from the
// evidence in force; a declaration stores the hint as it was shown. The current declaration of a specialization is the
// latest one; another grade may be declared at any moment except while an attempt runs, and a declaration never
// touches the confirmed grade (12.3).
import { asc, eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	GRADE_KEYS,
	specializationOpen,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentCandidateVocabulary } from '$lib/server/candidates/vocabulary';
import { loadLatestRules, loadSnapshot } from '$lib/server/evidence/snapshot';
import type { Database, Executor } from '$lib/server/db';
import { candidates, gradeDeclarations } from '$lib/server/db/schema';
import { ApiError, policyViolation } from '$lib/server/errors/api-error';
import { gradeHint, gradeHintSchema, type GradeHint } from './hint';
import { blockedTestError } from './policy';
import { selfCandidate, type GradeRequestMeta } from './self';
import type { GradeSources } from './sources';
import { latestSurvey, type Survey } from './surveys';

export interface Declaration {
	id: string;
	surveyId: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	hint: GradeHint;
	declaredAt: Date;
}

/** `409 conflict (not_declared)`: the survey comes first (contracts 9.1). */
function noSurvey(): ApiError {
	return new ApiError('conflict', {
		message: 'Сначала пройдите опрос',
		details: [{ code: 'not_declared', message: 'Сначала пройдите опрос' }]
	});
}

/** The hint for a specialization of the candidate, from the evidence in force now. */
export async function computeGradeHint(
	db: Database,
	candidateId: string,
	specialization: SpecializationKey,
	now: Date
): Promise<GradeHint> {
	const [rules, loaded, vocabulary] = await Promise.all([
		loadLatestRules(db),
		loadSnapshot(db, candidateId),
		currentCandidateVocabulary(db)
	]);
	if (!rules || !vocabulary) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы' });
	if (!loaded) throw new ApiError('not_found');
	return gradeHint({
		snapshot: loaded.snapshot,
		rules,
		specialization,
		skillNames: Object.fromEntries(vocabulary.skills.map((skill) => [skill.key, skill.name])),
		asOf: now
	});
}

/** The hint for the specialization of the survey in force (`GET /me/grade-hint`). */
export async function hintForSelf(
	db: Database,
	subject: AccessSubject,
	now: Date
): Promise<{ survey: Survey; hint: GradeHint }> {
	const { candidateId } = selfCandidate(subject);
	const survey = await latestSurvey(db, candidateId);
	if (!survey) throw noSurvey();
	return { survey, hint: await computeGradeHint(db, candidateId, survey.specialization, now) };
}

const isGrade = (value: string): value is GradeKey => (GRADE_KEYS as readonly string[]).includes(value);

/** A declaration with the snapshot of the hint (`POST /me/grade-declarations`). */
export async function declareGrade(
	db: Database,
	sources: GradeSources,
	subject: AccessSubject,
	input: { specialization: string; grade: string },
	meta: GradeRequestMeta,
	now: Date
): Promise<Declaration> {
	const { candidateId, userId } = selfCandidate(subject);
	const grade = input.grade;
	if (!isGrade(grade)) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'grade', code: 'unknown', message: 'Такого грейда нет в справочнике' }]
		});
	}
	const survey = await latestSurvey(db, candidateId);
	if (!survey) throw noSurvey();
	if (input.specialization !== survey.specialization) {
		throw new ApiError('conflict', {
			message: 'Грейд заявляется в специализации действующего опроса',
			details: [
				{
					path: 'specialization',
					code: 'survey_specialization',
					message: 'Грейд заявляется в специализации действующего опроса'
				}
			]
		});
	}
	const specialization = survey.specialization;
	if (!specializationOpen(specialization, await sources.releasedSpecializations(db))) {
		throw policyViolation('specialization_closed', 'specialization');
	}
	const hint = await computeGradeHint(db, candidateId, specialization, now);

	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: candidates.id })
			.from(candidates)
			.where(eq(candidates.id, candidateId))
			.for('update');
		if (!locked) throw new ApiError('not_found');
		const running = (await sources.policyAttempts(tx, candidateId)).some((a) => a.state === 'in_progress');
		if (running) throw blockedTestError({ allowed: false, reason: 'attempt_in_progress', availableFrom: null });
		const [row] = await tx
			.insert(gradeDeclarations)
			.values({ candidateId, surveyId: survey.id, specialization, grade, hint, declaredAt: now })
			.returning();
		if (!row) throw new Error('declaration was not inserted');
		await recordAuditEvent(tx, {
			action: 'grade.declared',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'grade_declaration', id: row.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { specialization, grade, suggested: hint.suggested },
			occurredAt: now
		});
		return toDeclaration(row);
	});
}

function toDeclaration(row: typeof gradeDeclarations.$inferSelect): Declaration {
	return {
		id: row.id,
		surveyId: row.surveyId,
		specialization: row.specialization,
		grade: row.grade,
		hint: gradeHintSchema.parse(row.hint),
		declaredAt: row.declaredAt
	};
}

/** Every declaration of the candidate, oldest first. */
export async function declarationHistory(executor: Executor, candidateId: string): Promise<Declaration[]> {
	const rows = await executor
		.select()
		.from(gradeDeclarations)
		.where(eq(gradeDeclarations.candidateId, candidateId))
		.orderBy(asc(gradeDeclarations.declaredAt), asc(gradeDeclarations.id));
	return rows.map(toDeclaration);
}
