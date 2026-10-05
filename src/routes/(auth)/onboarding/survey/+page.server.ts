import { fail, redirect } from '@sveltejs/kit';
import { CATALOG, specializationOpen } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/auth/http';
import { parsePreferences, type CandidatePreferences } from '$lib/server/candidates/preferences';
import { currentCandidateVocabulary } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';
import { gradeCandidate } from '$lib/server/grades/http';
import { specializationSkills } from '$lib/server/grades/hint';
import { gradeSources } from '$lib/server/grades/sources';
import { DECLARED_SKILLS_MAX, latestSurvey, submitSurvey, SURVEY_CURRENCY } from '$lib/server/grades/surveys';
import { formFailure, pageError } from '$lib/server/http/page';
import { regionReference } from '$lib/server/regions';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

/**
 * The survey in four steps (domain 12.2): direction, specialization (open ones only), the declared stack, work terms and
 * expectations. A repeated survey starts from the answers in force; a new specialization is a new survey.
 */
export const load: PageServerLoad = async (event) => {
	const { candidateId } = await gradeCandidate(event);
	try {
		const executor = db();
		const [vocabulary, released, survey, reference, [profile]] = await Promise.all([
			currentCandidateVocabulary(executor),
			gradeSources.releasedSpecializations(executor),
			latestSurvey(executor, candidateId),
			regionReference(),
			executor.select({ preferences: candidates.preferences }).from(candidates).where(eq(candidates.id, candidateId))
		]);
		if (!vocabulary || !profile) redirect(303, '/onboarding');
		const preferences: CandidatePreferences = survey?.preferences ?? parsePreferences(candidateId, profile.preferences);
		return {
			directions: CATALOG.directions.map((d) => ({ key: d.key, title: d.title })),
			specializations: CATALOG.specializations.map((s) => ({
				key: s.key,
				title: s.title,
				direction: s.direction,
				summary: s.summary,
				open: specializationOpen(s.key, released),
				suggestedSkills: [...specializationSkills(s.key)].filter((key) =>
					vocabulary.skills.some((skill) => skill.key === key)
				)
			})),
			skills: vocabulary.skills,
			workFormats: vocabulary.workFormats,
			employmentForms: vocabulary.employmentForms,
			regions: reference.regions,
			maxSkills: DECLARED_SKILLS_MAX,
			current: survey && {
				version: survey.version,
				direction: survey.direction,
				specialization: survey.specialization,
				declaredSkillKeys: survey.declaredSkillKeys
			},
			preferences
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const PERIODS = ['month', 'year', 'hour', 'project'] as const;
const TAX_BASES = ['gross', 'net', 'unknown'] as const;

/** A whole non-negative amount, or `null` for an empty field; anything else is a field error. */
function amount(value: string): number | null | 'invalid' {
	const text = value.replace(/\s/g, '');
	if (text === '') return null;
	if (!/^\d{1,12}$/.test(text)) return 'invalid';
	return Number(text);
}

const strings = (form: FormData, name: string) =>
	form.getAll(name).filter((value): value is string => typeof value === 'string' && value !== '');

export const actions: Actions = {
	default: async (event) => {
		const { subject, meta } = await gradeCandidate(event);
		const form = await event.request.formData();
		const fields: Record<string, string> = {};
		const min = amount(formText(form, 'salary_min'));
		const max = amount(formText(form, 'salary_max'));
		if (min === 'invalid') fields['preferences.salary_expectation.min'] = 'Целое число рублей без копеек';
		if (max === 'invalid') fields['preferences.salary_expectation.max'] = 'Целое число рублей без копеек';
		const period = PERIODS.find((value) => value === formText(form, 'salary_period'));
		const taxBase = TAX_BASES.find((value) => value === formText(form, 'salary_tax_base'));
		if (!period) fields['preferences.salary_expectation.period'] = 'Выберите период';
		if (!taxBase) fields['preferences.salary_expectation.tax_base'] = 'Выберите налоговую базу';
		if (min === 'invalid' || max === 'invalid' || !period || !taxBase) {
			return fail(400, { problem: { message: 'Проверьте поля формы', fields, code: 'validation_failed' } });
		}
		const relocation = formText(form, 'relocation');
		const regionCode = formText(form, 'region_code');
		const preferences: CandidatePreferences = {
			work_formats: strings(form, 'work_formats'),
			employment_forms: strings(form, 'employment_forms'),
			...(regionCode === '' ? {} : { region_code: regionCode }),
			...(relocation === 'yes' ? { relocation: true } : relocation === 'no' ? { relocation: false } : {}),
			...(min === null && max === null
				? {}
				: {
						salary_expectation: { min, max, currency: SURVEY_CURRENCY, period, tax_base: taxBase }
					})
		};
		try {
			await submitSurvey(
				db(),
				gradeSources,
				subject,
				{
					direction: formText(form, 'direction'),
					specialization: formText(form, 'specialization'),
					declaredSkillKeys: strings(form, 'declared_skill_keys'),
					preferences
				},
				meta
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, '/onboarding/grade');
	}
};
