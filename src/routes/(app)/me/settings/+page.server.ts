import { fail } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import type { CandidatePreferences } from '$lib/server/candidates/preferences';
import { loadSelfSettings } from '$lib/server/candidates/profile';
import { updateProfileSettings } from '$lib/server/candidates/settings';
import { db } from '$lib/server/db';
import { regionReference } from '$lib/server/regions';
import type { Actions, PageServerLoad } from './$types';

/** What the candidate states about the search: desired roles, work terms, the region and the salary expectation. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		const [settings, reference] = await Promise.all([loadSelfSettings(db(), subject, new Date()), regionReference()]);
		return { settings, regions: reference.regions };
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

export const actions: Actions = {
	save: async (event) => {
		const { subject } = await candidateRequest(event);
		const form = await event.request.formData();
		const fields: Record<string, string> = {};

		const min = amount(formText(form, 'salary_min'));
		const max = amount(formText(form, 'salary_max'));
		if (min === 'invalid') fields.salary_min = 'Целое число рублей без копеек';
		if (max === 'invalid') fields.salary_max = 'Целое число рублей без копеек';
		const period = PERIODS.find((value) => value === formText(form, 'salary_period'));
		const taxBase = TAX_BASES.find((value) => value === formText(form, 'salary_tax_base'));
		if (!period) fields.salary_period = 'Выберите период';
		if (!taxBase) fields.salary_tax_base = 'Выберите налоговую базу';
		const relocation = formText(form, 'relocation');
		const regionCode = formText(form, 'region_code');
		if (Object.keys(fields).length > 0 || min === 'invalid' || max === 'invalid' || !period || !taxBase) {
			return fail(400, { problem: { message: 'Проверьте поля формы', fields, code: 'validation_failed' } });
		}

		const preferences: CandidatePreferences = {
			work_formats: form.getAll('work_formats').filter((value): value is string => typeof value === 'string'),
			employment_forms: form.getAll('employment_forms').filter((value): value is string => typeof value === 'string'),
			...(regionCode === '' ? {} : { region_code: regionCode }),
			...(relocation === 'yes' ? { relocation: true } : relocation === 'no' ? { relocation: false } : {}),
			...(min === null && max === null
				? {}
				: {
						salary_expectation: {
							min,
							max,
							currency: formText(form, 'salary_currency') || 'RUB',
							period,
							tax_base: taxBase
						}
					})
		};
		const desiredRoleKeys = form
			.getAll('desired_role')
			.filter((value): value is string => typeof value === 'string' && value !== '');
		try {
			await updateProfileSettings(db(), subject, { preferences, desiredRoleKeys });
		} catch (cause) {
			return formFailure(cause);
		}
		return { saved: true };
	}
};
