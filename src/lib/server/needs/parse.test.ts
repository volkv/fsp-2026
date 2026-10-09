// The range a need suggests from the model's reading of its text: an amount without a currency or a period in a need is
// roubles per month («120–160 тысяч на руки»); another currency or period, an unstated tax base or one bound give none.
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { repositoryTaxonomy } = await import('$lib/server/vacancies/fixtures/taxonomy');
const { fieldsFromItems, textBlocks } = await import('$lib/server/vacancies/from-text');
const { resolveSkill, vacancyLexicon } = await import('$lib/server/vacancies/taxonomy');
const { roleOfTitle } = await import('$lib/server/taxonomy/roles');
const { checkVacancyAnswer } = await import('$lib/server/ml/vacancy-extract');
const { suggestedSalary } = await import('./parse');

const taxonomy = await repositoryTaxonomy();

const EMPTY_ANSWER = {
	role_titles: [],
	grades: [],
	required_skills: [],
	nice_skills: [],
	salaries: [],
	work_formats: [],
	employment_forms: [],
	contract_types: [],
	cities: []
};

/** The suggested range of a text whose model answer has this one salary element. */
function suggested(text: string, salary: Record<string, unknown>) {
	const blocks = textBlocks(text);
	const checked = checkVacancyAnswer(
		{ ...EMPTY_ANSWER, salaries: [{ block_id: 'p1', ...salary }] },
		blocks,
		vacancyLexicon(taxonomy)
	);
	expect(checked.rejected).toEqual([]);
	const fields = fieldsFromItems(
		checked.items,
		blocks,
		(raw) => resolveSkill(taxonomy, raw),
		(title) => roleOfTitle(title, taxonomy.roleNames)
	);
	return suggestedSalary(fields.salary);
}

const NEED = 'Ищем Junior backend-разработчика на Python: SQL, PostgreSQL, REST API. Удалённо, 120–160 тысяч на руки';
const RANGE = {
	raw_text: '120–160 тысяч на руки',
	quote: '120–160 тысяч на руки',
	salary_min: 120_000,
	salary_max: 160_000,
	currency: 'not_stated',
	period: 'not_stated',
	tax_base: 'net'
};

describe('salary range of a need', () => {
	it('suggests a range without a currency or a period as roubles per month', () => {
		expect(suggested(NEED, RANGE)).toEqual({
			min: 120_000,
			max: 160_000,
			currency: 'RUB',
			period: 'month',
			tax_base: 'net'
		});
	});

	it('suggests none for another currency or period, an unstated tax base or a single bound', () => {
		const text = 'Python-разработчик, 3000–4000 $ в месяц на руки; 120–160 тысяч в год на руки; 120–160 тысяч';
		const dollars = { raw_text: '3000–4000 $ в месяц на руки', quote: '3000–4000 $ в месяц на руки' };
		expect(suggested(text, { ...RANGE, ...dollars, salary_min: 3000, salary_max: 4000, currency: 'USD' })).toBeNull();
		const yearly = { raw_text: '120–160 тысяч в год на руки', quote: '120–160 тысяч в год на руки' };
		expect(suggested(text, { ...RANGE, ...yearly, period: 'year' })).toBeNull();
		const untaxed = { raw_text: '120–160 тысяч', quote: '120–160 тысяч', tax_base: 'unknown' };
		expect(suggested(text, { ...RANGE, ...untaxed })).toBeNull();
		expect(suggested(NEED, { ...RANGE, salary_min: 0 })).toBeNull();
	});
});
