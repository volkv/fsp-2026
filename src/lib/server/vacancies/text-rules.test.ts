import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { repositoryTaxonomy } = await import('./fixtures/taxonomy');
const { fieldsFromItems, missingFields, textBlocks } = await import('./from-text');
const { roleOfTitle } = await import('./normalize');
const { resolveSkill, vacancyLexicon } = await import('./taxonomy');
const { extractVacancyByRules, readVacancyByRules } = await import('./text-rules');

const taxonomy = await repositoryTaxonomy();

function read(text: string) {
	const blocks = textBlocks(text);
	const checked = extractVacancyByRules(blocks, taxonomy, vacancyLexicon(taxonomy));
	const fields = fieldsFromItems(
		checked.items,
		blocks,
		(raw) => resolveSkill(taxonomy, raw),
		(title) => roleOfTitle(title, taxonomy).key
	);
	return { fields, rejected: checked.rejected, blocks };
}

const keys = (skills: readonly { key: string | null }[]) => skills.map((skill) => skill.key);

describe('vacancy text by rules', () => {
	it('reads every field the text states, each with a quote from its line', () => {
		const { fields, rejected, blocks } = read(
			[
				'#вакансия #middle #senior',
				'Вакансия: Python-разработчик',
				'Требования:',
				'• Python, PostgreSQL',
				'• Java не требуется',
				'Будет плюсом:',
				'• Kafka',
				'Условия:',
				'• Зарплата от 250 000 до 350 000 ₽ в месяц на руки',
				'• Удалённая работа, полная занятость',
				'• Оформление по ТК РФ',
				'• Офис для встреч в Москве',
				'• Курсы Kubernetes за счёт компании'
			].join('\n')
		);
		expect(rejected).toEqual([]);
		expect(fields.title?.value).toBe('Python-разработчик');
		expect(fields.roleKey).toBe('backend');
		expect(fields.grade?.value).toEqual({ min: 'middle', max: 'senior' });
		expect(keys(fields.requiredSkills)).toEqual(['python', 'postgresql']);
		expect(keys(fields.negatedSkills)).toEqual(['java']);
		// Skills of the offer are not requirements.
		expect(keys(fields.niceSkills)).toEqual(['kafka']);
		expect(fields.salary?.value).toEqual({
			min: 250_000,
			max: 350_000,
			currency: 'RUB',
			period: 'month',
			taxBase: 'net'
		});
		expect(fields.workFormat?.value).toBe('remote');
		expect(fields.employmentForm?.value).toBe('full');
		expect(fields.contractTypes.map((contract) => contract.value)).toEqual(['labor']);
		expect(fields.city?.value).toBe('Москва');
		expect(missingFields(fields)).toEqual([]);
		const byId = new Map(blocks.map((block) => [block.id, block.text]));
		expect(byId.get(fields.salary?.quote.blockId ?? '')).toContain(fields.salary?.quote.text);
	});

	it('takes the title from a sentence of search and a wish inside a line of requirements', () => {
		const { fields } = read(
			[
				'Ищем ведущего Go-разработчика в команду платежей.',
				'Нужно: Go, gRPC; Kubernetes будет плюсом',
				'Откликнуться: пришлите CV в Telegram'
			].join('\n')
		);
		expect(fields.title?.value).toBe('ведущего Go-разработчика');
		expect(fields.roleKey).toBe('backend');
		expect(fields.grade?.value).toEqual({ min: 'senior', max: 'senior' });
		expect(keys(fields.requiredSkills)).toEqual(['go', 'grpc']);
		expect(keys(fields.niceSkills)).toEqual(['kubernetes']);
	});

	it.each([
		['Вилка 200–300 тыс. руб.', { min: 200_000, max: 300_000, currency: 'RUB' }],
		['Зарплата от 200 до 300 тыс. руб.', { min: 200_000, max: 300_000, currency: 'RUB' }],
		['Зарплата от 200 тыс. до 300 тыс.', { min: 200_000, max: 300_000 }],
		['Зарплата до 300 тыс.', { min: null, max: 300_000 }],
		['Доход от 1,5 до 2 млн в год', { min: 1_500_000, max: 2_000_000, period: 'year' }],
		['Зарплата 150 000 – 2 млн руб.', { min: 150_000, max: 2_000_000, currency: 'RUB' }],
		['Зарплата: до 400 000 рублей', { min: null, max: 400_000, currency: 'RUB' }],
		['ЗП от 250k', { min: 250_000, max: null, currency: null }],
		['$3000–5000 per month', { min: 3_000, max: 5_000, currency: 'USD', period: 'month' }],
		['Оклад 180 000 до вычета НДФЛ', { min: 180_000, max: null, taxBase: 'gross' }]
	])('reads the range of «%s»', (line, expected) => {
		expect(read(`Backend-разработчик\n${line}`).fields.salary?.value).toMatchObject(expected);
	});

	it.each([
		['Зарплата от 200 до 300 тыс. руб.', [200_000, 300_000]],
		['Зарплата от 200 тыс. до 300 тыс.', [200_000, 300_000]],
		['Зарплата 200–300 тыс.', [200_000, 300_000]],
		['Доход от 1,5 до 2 млн в год', [1_500_000, 2_000_000]],
		['Зарплата 150 000 – 2 млн руб.', [150_000, 2_000_000]]
	])('gives both ends of «%s» the unit written once', (line, [min, max]) => {
		const { salaries } = readVacancyByRules(textBlocks(`Backend-разработчик\n${line}`), taxonomy);
		expect(salaries.map((salary) => [salary.salary_min, salary.salary_max])).toEqual([[min, max]]);
	});

	it.each(['Опыт от 3 до 5 лет', 'Премия 2 раза в год', 'Команда из 12 человек, 3 офиса'])(
		'finds no range in «%s»',
		(line) => {
			expect(read(`Backend-разработчик\n${line}`).fields.salary).toBeNull();
		}
	);

	it('reads alternatives as a skill each: a choice is a wish, a slash alone keeps the section', () => {
		const { fields } = read(
			[
				'Backend-разработчик',
				'Требования:',
				'• Go или Rust',
				'• PostgreSQL',
				'• HTML/CSS',
				'Будет плюсом:',
				'• C++ или Python'
			].join('\n')
		);
		// The vacancy has no «one of»: requiring both Go and Rust would demand what the text does not.
		expect(keys(fields.requiredSkills)).toEqual(['postgresql', 'html', 'css']);
		expect(keys(fields.niceSkills)).toEqual(['go', 'rust', 'cpp', 'python']);
	});

	it('guesses nothing the text does not state', () => {
		const { fields } = read('Программист\nДелаем интересные проекты для клиентов.');
		expect(fields.roleKey).toBeNull();
		expect(fields.grade).toBeNull();
		expect(fields.salary).toBeNull();
		expect(fields.workFormat).toBeNull();
		expect(missingFields(fields)).toEqual([
			'roleKey',
			'grade',
			'workFormat',
			'employmentForm',
			'contractTypes',
			'salary.bounds',
			'salary.currency',
			'salary.period',
			'salary.taxBase'
		]);
	});
});
