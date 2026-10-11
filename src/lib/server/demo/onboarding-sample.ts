// The example answers of a new candidate of a demo session (docs/domain.md, section 19.3): a visitor who creates a
// candidate on `/demo` or registers one within the session walks the registration steps by themselves — the consent,
// the survey, the declared grade, the test — but finds the survey filled in with a plausible Backend developer and the
// grade chosen, reads them, changes what they like and goes on. Nothing is stored before the visitor submits a step.
// A real candidate and a clone of the cast (it keeps the answers of its original) answer on the forms as they are.
import type { DirectionKey, GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { CandidatePreferences } from '$lib/server/candidates/preferences';
import type { CandidateVocabulary } from '$lib/server/candidates/vocabulary';
import type { Executor } from '$lib/server/db';
import { createdInSession } from './newcomer';

export interface SurveySample {
	direction: DirectionKey;
	specialization: SpecializationKey;
	declaredSkillKeys: string[];
	preferences: CandidatePreferences;
}

const SURVEY_SAMPLE = {
	direction: 'development',
	specialization: 'backend',
	declaredSkillKeys: ['python', 'fastapi', 'postgresql', 'sql', 'rest', 'docker', 'git'],
	workFormats: ['hybrid', 'remote'],
	employmentForms: ['full'],
	regionCode: 'RU-MOW',
	salary: { min: 180_000, max: 250_000 }
} as const satisfies {
	direction: DirectionKey;
	specialization: SpecializationKey;
	declaredSkillKeys: readonly string[];
	workFormats: readonly string[];
	employmentForms: readonly string[];
	regionCode: string;
	salary: { min: number; max: number };
};

/** The grade chosen for the visitor when the hint has no grounds — a new candidate has neither a resume nor FSP. */
export const GRADE_SAMPLE: GradeKey = 'middle';

/** Whether the registration steps of the candidate come with the example answers: a candidate created within a session. */
export async function onboardingSampleApplies(executor: Executor, candidateId: string): Promise<boolean> {
	return (await createdInSession(executor, [candidateId])).has(candidateId);
}

/**
 * The example survey within the taxonomy version in force: keys the version does not know are left out, so the form
 * shows only what it can submit. `null` while the test of the specialization is not released — a survey of it would
 * lead to no test.
 */
export function surveySample(
	vocabulary: Pick<CandidateVocabulary, 'skills' | 'workFormats' | 'employmentForms'>,
	released: ReadonlySet<SpecializationKey>
): SurveySample | null {
	if (!released.has(SURVEY_SAMPLE.specialization)) return null;
	const known = (list: readonly { key: string }[], keys: readonly string[]) =>
		keys.filter((key) => list.some((entry) => entry.key === key));
	return {
		direction: SURVEY_SAMPLE.direction,
		specialization: SURVEY_SAMPLE.specialization,
		declaredSkillKeys: known(vocabulary.skills, SURVEY_SAMPLE.declaredSkillKeys),
		preferences: {
			work_formats: known(vocabulary.workFormats, SURVEY_SAMPLE.workFormats),
			employment_forms: known(vocabulary.employmentForms, SURVEY_SAMPLE.employmentForms),
			region_code: SURVEY_SAMPLE.regionCode,
			relocation: false,
			salary_expectation: { ...SURVEY_SAMPLE.salary, currency: 'RUB', period: 'month', tax_base: 'net' }
		}
	};
}
