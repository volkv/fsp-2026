// What the pages of the employer cabinet need for hiring needs (docs/domain.md, section 13.10): the services built from
// the configured infrastructure and the reading of the posted form. Skills are written by their names and resolved by
// the taxonomy; a name the taxonomy does not know is a field error, never dropped silently.
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { modelAdapter } from '$lib/server/ml';
import { loadVacancyTaxonomy, resolveSkill } from '$lib/server/vacancies/taxonomy';
import { currentVocabulary } from '$lib/server/employer/vocabulary';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';
import { regionReference } from '$lib/server/regions';
import type { NeedDeps } from './service';

export function configuredNeedDeps(): NeedDeps {
	return { db: db(), models: modelAdapter(), now: () => new Date() };
}

const names = (value: string) =>
	value
		.split(/[,;\n]/u)
		.map((name) => name.trim())
		.filter((name) => name !== '');

const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());
const amount = (value: string) => Number(value.replace(/\s/gu, ''));

/**
 * The form of a need as the page posts it, in the shape of `needFormSchema`; the service validates the rest. An
 * unknown skill name is `400` with the field it is in.
 */
export async function needFormFromPost(form: FormData): Promise<Record<string, unknown>> {
	const taxonomy = await loadVacancyTaxonomy(db());
	const details: ErrorDetail[] = [];
	const skills = (field: string) =>
		names(formText(form, field)).flatMap((name) => {
			const key = resolveSkill(taxonomy, name);
			if (key === null) details.push({ path: `form.${field}`, code: 'unknown', message: `Навык «${name}» не найден` });
			return key === null ? [] : [key];
		});
	const skillKeys = skills('skill_keys');
	const niceSkillKeys = skills('nice_skill_keys').filter((key) => !skillKeys.includes(key));
	if (details.length > 0) throw new ApiError('validation_failed', { details });
	const min = formText(form, 'salary_min');
	const max = formText(form, 'salary_max');
	const specialization = optional(formText(form, 'specialization'));
	const grade = optional(formText(form, 'grade'));
	const team = optional(formText(form, 'team'));
	const workFormat = optional(formText(form, 'work_format'));
	const region = optional(formText(form, 'region_code'));
	return {
		skill_keys: [...new Set(skillKeys)],
		nice_skill_keys: [...new Set(niceSkillKeys)],
		...(specialization === undefined ? {} : { specialization }),
		...(grade === undefined ? {} : { grade }),
		...(team === undefined ? {} : { team }),
		...(workFormat === undefined ? {} : { work_format: workFormat }),
		...(region === undefined ? {} : { region_code: region }),
		...(min.trim() === '' && max.trim() === ''
			? {}
			: {
					salary: {
						min: amount(min),
						max: amount(max),
						currency: 'RUB',
						period: 'month',
						tax_base: formText(form, 'salary_tax_base')
					}
				}),
		...(form.get('fsp_relevant') === 'on' ? { fsp_relevant: true } : {})
	};
}

/** The choices of the form: open specializations and grades of the catalog, work formats by name, regions. */
export async function needFormOptions() {
	const [vocabulary, regions, open] = await Promise.all([
		currentVocabulary(db()),
		regionReference(),
		openSpecializations(db())
	]);
	const formatNames = new Map(vocabulary.terms.work_format.map(({ key, name }) => [key, name]));
	return {
		specializations: CATALOG.specializations
			.filter((item) => open.has(item.key))
			.map(({ key, title }) => ({ key, title })),
		grades: CATALOG.grades.map(({ key, title }) => ({ key, title })),
		workFormats: OFFER_WORK_FORMATS.map((key) => ({ key, name: formatNames.get(key) ?? key })),
		regions: regions.regions.map(({ code, name }) => ({ code, name })),
		skillNames: Object.fromEntries(vocabulary.skills.map(({ key, name }) => [key, name]))
	};
}
