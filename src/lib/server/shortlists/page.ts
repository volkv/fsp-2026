// What the pages of shortlists need (docs/domain.md, section 13.10): the services built from the configured
// infrastructure, the reading of the posted refinement and of the «what if» of the address. Skills are written by
// their names and resolved by the taxonomy; a name the taxonomy does not know is a field error, never dropped.
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { formText } from '$lib/server/auth/http';
import { isGradeKey, isSpecializationKey } from '$lib/server/categories/labels';
import { db } from '$lib/server/db';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { matchingDeps } from '$lib/server/matching/deps';
import { loadVacancyTaxonomy, resolveSkill } from '$lib/server/vacancies/taxonomy';
import type { ShortlistDeps } from './service';

export function configuredShortlistDeps(): ShortlistDeps {
	return { ...matchingDeps(), db: db() };
}

const names = (value: string) =>
	value
		.split(/[,;\n]/u)
		.map((name) => name.trim())
		.filter((name) => name !== '');

/** Skill names of a field resolved to keys; unknown names are collected as field errors. */
async function skillsOf(form: FormData, fields: readonly string[]): Promise<Record<string, string[]>> {
	const taxonomy = await loadVacancyTaxonomy(db());
	const details: ErrorDetail[] = [];
	const result: Record<string, string[]> = {};
	for (const field of fields) {
		const keys: string[] = [];
		for (const name of names(formText(form, field))) {
			const key = resolveSkill(taxonomy, name);
			if (key === null)
				details.push({ path: `change.${field}`, code: 'unknown', message: `Навык «${name}» не найден` });
			else if (!keys.includes(key)) keys.push(key);
		}
		result[field] = keys;
	}
	if (details.length > 0) throw new ApiError('validation_failed', { details });
	return result;
}

/**
 * The refinement the page posts: the whole set of conditions of the form; the service keeps only what differs from
 * the current step and refuses a refinement that changes nothing.
 */
export async function refinementFromPost(form: FormData): Promise<Record<string, unknown>> {
	const skills = await skillsOf(form, ['skill_keys', 'nice_skill_keys', 'confirmed_skill_keys']);
	const categories = form
		.getAll('category')
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.split(':'))
		.flatMap(([specialization, grade]) =>
			specialization && grade && isSpecializationKey(specialization) && isGradeKey(grade)
				? [{ specialization, grade }]
				: []
		);
	const format = formText(form, 'work_format');
	const required = skills.skill_keys ?? [];
	return {
		...(categories.length > 0 ? { categories } : {}),
		skill_keys: required,
		nice_skill_keys: (skills.nice_skill_keys ?? []).filter((key) => !required.includes(key)),
		work_format: format === '' ? null : format,
		fsp_relevant: form.get('fsp_relevant') === 'on',
		fsp_only: form.get('fsp_only') === 'on',
		confirmed_skill_keys: skills.confirmed_skill_keys ?? []
	};
}

/** «What if» of the address: `whatIf` names the condition, the other parameters its value. */
export async function whatIfFromQuery(url: URL): Promise<Record<string, unknown> | null> {
	const kind = url.searchParams.get('whatIf');
	if (kind === null) return null;
	const value = url.searchParams.get('value') ?? '';
	switch (kind) {
		case 'work_format':
			return { work_format: value === '' ? null : value };
		case 'grade':
			return { grade: value };
		case 'fsp_only':
			return { fsp_only: value === 'on' };
		case 'confirmed_skill': {
			const taxonomy = await loadVacancyTaxonomy(db());
			const key = resolveSkill(taxonomy, value);
			if (key === null) {
				throw new ApiError('validation_failed', {
					details: [{ path: 'change.confirmed_skill', code: 'unknown', message: `Навык «${value}» не найден` }]
				});
			}
			return { confirmed_skill: { skill_key: key, required: url.searchParams.get('required') !== 'off' } };
		}
		case 'salary': {
			const amount = (name: string) => Number((url.searchParams.get(name) ?? '').replace(/\s/gu, ''));
			return {
				salary: { min: amount('min'), max: amount('max'), tax_base: url.searchParams.get('tax_base') ?? 'gross' }
			};
		}
		default:
			throw new ApiError('validation_failed', {
				details: [{ path: 'whatIf', code: 'unknown', message: 'Неизвестное условие «что если»' }]
			});
	}
}

/** Titles of the blocks of the catalog: the reasons name the block a skill was confirmed by. */
export function blockTitles(): Record<string, string> {
	return Object.fromEntries(CATALOG.blocks.map((block) => [block.code, block.title]));
}
