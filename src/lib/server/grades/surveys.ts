// The candidate's survey (docs/domain.md, section 12.2): direction → specialization (open ones only, 10.5) → the
// declared stack (1–10 skills of the taxonomy) → work terms and expectations (the salary in roubles only). Every
// submission is a new version; the previous ones stay in the history. The terms of the latest survey are written to
// `candidates.preferences` in the same transaction with `profile_revision + 1`; editing them later in the settings does
// not rewrite the survey.
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	CATALOG,
	DIRECTION_KEYS,
	SPECIALIZATION_KEYS,
	specializationOpen,
	type DirectionKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { candidatePreferencesSchema, type CandidatePreferences } from '$lib/server/candidates/preferences';
import { recordProfileChange } from '$lib/server/candidates/settings';
import { currentCandidateVocabulary } from '$lib/server/candidates/vocabulary';
import type { Database, Executor } from '$lib/server/db';
import { candidates, candidateSurveys } from '$lib/server/db/schema';
import { ApiError, policyViolation, type ErrorDetail } from '$lib/server/errors/api-error';
import { regionReference } from '$lib/server/regions';
import { selfCandidate, type GradeRequestMeta } from './self';
import type { GradeSources } from './sources';

export const DECLARED_SKILLS_MIN = 1;
export const DECLARED_SKILLS_MAX = 10;
/** The currency of expectations in the survey (domain 0, block «вилка»). */
export const SURVEY_CURRENCY = 'RUB';

export interface SurveyInput {
	direction: string;
	specialization: string;
	declaredSkillKeys: readonly string[];
	preferences: CandidatePreferences;
}

export interface Survey {
	id: string;
	version: number;
	catalogVersion: string;
	taxonomyVersionId: string;
	direction: DirectionKey;
	specialization: SpecializationKey;
	declaredSkillKeys: string[];
	preferences: CandidatePreferences;
	createdAt: Date;
}

const invalid = (details: ErrorDetail[]) => new ApiError('validation_failed', { details });

const isDirection = (value: string): value is DirectionKey => (DIRECTION_KEYS as readonly string[]).includes(value);
const isSpecialization = (value: string): value is SpecializationKey =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(value);

/** A new version of the survey (`POST /me/surveys`). */
export async function submitSurvey(
	db: Database,
	sources: GradeSources,
	subject: AccessSubject,
	input: SurveyInput,
	meta: GradeRequestMeta
): Promise<{ surveyId: string; version: number }> {
	const { candidateId, userId } = selfCandidate(subject);
	const problems: ErrorDetail[] = [];
	const direction = isDirection(input.direction) ? input.direction : null;
	if (!direction)
		problems.push({ path: 'direction', code: 'unknown', message: 'Такого направления нет в справочнике' });
	const specialization = isSpecialization(input.specialization) ? input.specialization : null;
	if (!specialization) {
		problems.push({ path: 'specialization', code: 'unknown', message: 'Такой специализации нет в справочнике' });
	}
	const definition = CATALOG.specializations.find((s) => s.key === specialization);
	if (definition && direction && definition.direction !== direction) {
		problems.push({
			path: 'specialization',
			code: 'other_direction',
			message: 'Специализация относится к другому направлению'
		});
	}

	const skills = [...new Set(input.declaredSkillKeys)];
	if (skills.length < DECLARED_SKILLS_MIN || skills.length > DECLARED_SKILLS_MAX) {
		problems.push({
			path: 'declared_skill_keys',
			code: skills.length < DECLARED_SKILLS_MIN ? 'too_small' : 'too_big',
			message: `Выберите от ${DECLARED_SKILLS_MIN} до ${DECLARED_SKILLS_MAX} навыков`
		});
	}
	const parsed = candidatePreferencesSchema.safeParse(input.preferences);
	if (!parsed.success) {
		throw invalid(
			parsed.error.issues.map((issue) => ({
				path: ['preferences', ...issue.path].join('.'),
				code: issue.code,
				message: issue.message
			}))
		);
	}
	const preferences = parsed.data;
	if (preferences.salary_expectation && preferences.salary_expectation.currency !== SURVEY_CURRENCY) {
		problems.push({
			path: 'preferences.salary_expectation.currency',
			code: 'not_rub',
			message: 'Ожидания по зарплате — в рублях'
		});
	}
	const vocabulary = await currentCandidateVocabulary(db);
	if (!vocabulary) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы' });
	const known = (list: readonly { key: string }[], key: string) => list.some((item) => item.key === key);
	if (skills.some((key) => !known(vocabulary.skills, key))) {
		problems.push({ path: 'declared_skill_keys', code: 'unknown', message: 'Такого навыка нет в справочнике' });
	}
	if ((preferences.work_formats ?? []).some((key) => !known(vocabulary.workFormats, key))) {
		problems.push({ path: 'preferences.work_formats', code: 'unknown', message: 'Такого формата нет в справочнике' });
	}
	if ((preferences.employment_forms ?? []).some((key) => !known(vocabulary.employmentForms, key))) {
		problems.push({
			path: 'preferences.employment_forms',
			code: 'unknown',
			message: 'Такой занятости нет в справочнике'
		});
	}
	const regionCode = preferences.region_code;
	if (regionCode !== undefined && !(await regionReference()).has(regionCode)) {
		problems.push({ path: 'preferences.region_code', code: 'unknown', message: 'Такого региона нет в справочнике' });
	}
	if (problems.length > 0 || !direction || !specialization) throw invalid(problems);
	if (!specializationOpen(specialization, await sources.releasedSpecializations(db))) {
		throw policyViolation('specialization_closed', 'specialization');
	}

	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: candidates.id })
			.from(candidates)
			.where(eq(candidates.id, candidateId))
			.for('update');
		if (!locked) throw new ApiError('not_found');
		const [last] = await tx
			.select({ version: sql<number>`coalesce(max(${candidateSurveys.version}), 0)` })
			.from(candidateSurveys)
			.where(eq(candidateSurveys.candidateId, candidateId));
		const version = (last?.version ?? 0) + 1;
		const [row] = await tx
			.insert(candidateSurveys)
			.values({
				candidateId,
				version,
				catalogVersion: CATALOG.version,
				taxonomyVersionId: vocabulary.taxonomyVersionId,
				direction,
				specialization,
				declaredSkillKeys: skills,
				preferences
			})
			.returning({ id: candidateSurveys.id });
		if (!row) throw new Error('survey was not inserted');
		await tx.update(candidates).set({ preferences }).where(eq(candidates.id, candidateId));
		await recordProfileChange(tx, candidateId, {
			evidenceInput: false,
			createdBy: { kind: 'user', id: userId }
		});
		await recordAuditEvent(tx, {
			action: 'survey.submitted',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'candidate_survey', id: row.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { version, specialization }
		});
		return { surveyId: row.id, version };
	});
}

function toSurvey(row: typeof candidateSurveys.$inferSelect): Survey {
	return {
		id: row.id,
		version: row.version,
		catalogVersion: row.catalogVersion,
		taxonomyVersionId: row.taxonomyVersionId,
		direction: row.direction,
		specialization: row.specialization,
		declaredSkillKeys: row.declaredSkillKeys,
		preferences: candidatePreferencesSchema.parse(row.preferences),
		createdAt: row.createdAt
	};
}

/** The survey in force: the latest version; `null` — none yet. */
export async function latestSurvey(executor: Executor, candidateId: string): Promise<Survey | null> {
	const [row] = await executor
		.select()
		.from(candidateSurveys)
		.where(eq(candidateSurveys.candidateId, candidateId))
		.orderBy(desc(candidateSurveys.version))
		.limit(1);
	return row ? toSurvey(row) : null;
}

/** Every version, oldest first. */
export async function surveyHistory(executor: Executor, candidateId: string): Promise<Survey[]> {
	const rows = await executor
		.select()
		.from(candidateSurveys)
		.where(eq(candidateSurveys.candidateId, candidateId))
		.orderBy(asc(candidateSurveys.version));
	return rows.map(toSurvey);
}
