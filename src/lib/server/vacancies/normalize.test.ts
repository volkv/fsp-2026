import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixturePath, repositoryTaxonomy } from './fixtures/taxonomy';
import { gradeOf, normalizePosting, originalTermsOf, roleOfTitle, salaryOf, type OriginalTerms } from './normalize';
import { habrPostingFromFeed, parseFeed } from './sources/habr';

const taxonomy = await repositoryTaxonomy();

const terms = (overrides: Partial<OriginalTerms> = {}): OriginalTerms => ({
	salary_text: null,
	salary: { min: null, max: null, currency: null, period: null, tax_base: null },
	grade_raw: null,
	employment_raw: null,
	location: { city: null, remote: null, raw: null },
	skills_raw: [],
	description: null,
	contacts_removed: false,
	...overrides
});

describe('role by title', () => {
	it.each([
		['Backend-разработчик (Go)', 'backend'],
		['Go-разработчик', 'backend'],
		['Senior Python Developer', 'backend'],
		['Frontend developer React', 'frontend'],
		['Fullstack-разработчик', 'fullstack'],
		['Руководитель Frontend-разработки / Head of Frontend', 'team_lead'],
		['Инженер по автоматизации тестирования', 'qa_automation'],
		['Тестировщик (Верификатор) / QA Engineer', 'qa_manual'],
		['Data Engineer (команда RecSys)', 'data_engineer'],
		['Аналитик данных', 'data_analyst'],
		['Системный аналитик', 'systems_analyst'],
		['Программист 1С', 'onec'],
		['Android-разработчик', 'mobile'],
		['DevOps-инженер', 'devops'],
		['Инженер техподдержки', 'tech_support'],
		['UI/UX дизайнер', 'ui_ux_designer']
	])('%s → %s', (title, role) => {
		expect(roleOfTitle(title, taxonomy)).toEqual({ key: role, method: 'title_rules', rule: role });
	});

	it.each(['Программист', 'Инженер-программист', 'Менеджер по продажам IT', 'Копирайтер'])(
		'names no role for «%s»',
		(title) => {
			expect(roleOfTitle(title, taxonomy).key).toBeNull();
		}
	);
});

describe('grade', () => {
	it('takes the grade field of the source when it consists of grade words', () => {
		expect(gradeOf('Разработчик', 'Senior', taxonomy)).toEqual({
			min: 'senior',
			max: 'senior',
			basis: 'stated',
			method: 'source_field'
		});
		expect(gradeOf('Разработчик', 'middle, senior', taxonomy)).toMatchObject({ min: 'middle', max: 'senior' });
	});

	it('infers the grade from the title when the field says something else', () => {
		expect(gradeOf('Junior QA', 'Инженер-программист I-II категории', taxonomy)).toEqual({
			min: 'junior',
			max: 'junior',
			basis: 'inferred',
			method: 'title_rules'
		});
	});

	it('leaves an unknown grade unknown', () => {
		expect(gradeOf('Программист', 'Высшее образование', taxonomy)).toEqual({
			min: null,
			max: null,
			basis: 'unknown',
			method: 'none'
		});
	});
});

describe('skills', () => {
	it('resolves feed tags, including ones written without spaces, and keeps unknown ones as written', async () => {
		const rss = await readFile(fixturePath('habr-rss.xml'), 'utf8');
		const item = parseFeed(rss).find((i) => i.guid === '1000168749');
		const posting = item && habrPostingFromFeed(item);
		if (!posting) throw new Error('fixture item is missing');
		const normalized = normalizePosting(posting.title, originalTermsOf(posting, false), taxonomy);
		expect(normalized.skills.required).toEqual(expect.arrayContaining(['postgresql', 'cpp', 'clickhouse']));
		expect(normalized.skills.methods.postgresql).toBe('source_tag');
		expect(normalized.grade).toMatchObject({ min: 'senior', basis: 'stated' });
		expect(normalized.skills.unknown).toContain('YandexDatabase');
	});

	// Tags of the Habr Career feed are written without spaces; the forms below are the ones the feed uses.
	it.each([
		['Базыданных', 'databases'],
		['Техническаяподдержка', 'technical_support'],
		['Алгоритмыиструктурыданных', 'algorithms'],
		['Работавкоманде', 'teamwork'],
		['Управлениепроектами', 'project_management'],
		['MicrosoftExcel', 'excel'],
		['MicrosoftSQL', 'mssql'],
		['ApacheKafka', 'kafka'],
		['1C:ERP', 'onec'],
		['Разработкапод1С', 'onec'],
		['АдминистрированиеоборудованияCisco', 'networking'],
		['CI/CD', 'cicd'],
		['.NET', 'dotnet'],
		['C++', 'cpp']
	])('resolves the glued feed tag «%s» to %s', (tag, key) => {
		const normalized = normalizePosting('Специалист', terms({ skills_raw: [tag] }), taxonomy);
		expect(normalized.skills.required).toEqual([key]);
		expect(normalized.skills.unknown).toEqual([]);
	});

	it('leaves a glued tag with a typo unknown instead of guessing it by a fuzzy match', () => {
		const normalized = normalizePosting(
			'Специалист',
			terms({ skills_raw: ['АдминистрированиеоборудованияCsico'] }),
			taxonomy
		);
		expect(normalized.skills.required).toEqual([]);
		expect(normalized.skills.unknown).toEqual(['АдминистрированиеоборудованияCsico']);
	});

	it.each([
		'Информационныетехнологии',
		'Интернетмаркетинг',
		'Emailмаркетинг',
		'SEOоптимизация',
		'РазработкаSEOстратегии',
		'ОрганизацияработысCRM',
		'Управлениелюдьми',
		'Ведениепереговоров',
		'MicrosoftVisio',
		'AutodeskRevit',
		'YandexDatabase',
		'Mobile',
		'Web'
	])('does not take «%s» for a skill it is not', (tag) => {
		const normalized = normalizePosting('Специалист', terms({ skills_raw: [tag] }), taxonomy);
		expect(normalized.skills.required).toEqual([]);
		expect(normalized.skills.unknown).toEqual([tag]);
	});

	it('reads phrases of the government portal', () => {
		const normalized = normalizePosting(
			'Программист',
			terms({
				skills_raw: ['Навык работы с PHP', 'JavaScript (JS)', 'Владение Git', 'Умение разбираться с чужим кодом']
			}),
			taxonomy
		);
		expect(normalized.skills.required).toEqual(['php', 'javascript', 'git']);
		expect(normalized.skills.unknown).toEqual(['Умение разбираться с чужим кодом']);
	});

	it('scans a stored description for nice-to-have skills without matching inside words', () => {
		const normalized = normalizePosting(
			'Разработчик',
			terms({ description: 'Опыт с PostgreSQL и Docker. Знание JavaScript будет плюсом.' }),
			taxonomy
		);
		expect(normalized.skills.nice).toEqual(expect.arrayContaining(['postgresql', 'docker', 'javascript']));
		expect(normalized.skills.nice).not.toContain('java');
		expect(normalized.skills.methods.docker).toBe('text_scan');
	});
});

describe('salary', () => {
	it('is absent when the source states none', () => {
		expect(salaryOf(terms())).toMatchObject({ status: 'absent', min: null });
	});

	it('keeps a one-sided range with an unknown tax base', () => {
		expect(
			salaryOf(terms({ salary: { min: 200_000, max: null, currency: 'RUB', period: 'month', tax_base: null } }))
		).toEqual({
			status: 'stated',
			reason: null,
			min: 200_000,
			max: null,
			currency: 'RUB',
			period: 'month',
			tax_base: 'unknown'
		});
	});

	it('refuses to store a range without currency or period', () => {
		expect(
			salaryOf(terms({ salary: { min: 1, max: 2, currency: null, period: 'month', tax_base: null } }))
		).toMatchObject({ status: 'unusable', reason: 'currency_unknown', min: null });
		expect(
			salaryOf(terms({ salary: { min: 1, max: 2, currency: 'RUB', period: null, tax_base: null } }))
		).toMatchObject({ status: 'unusable', reason: 'period_unknown' });
	});
});

describe('work terms', () => {
	it('recognizes remote work and the employment form', () => {
		const normalized = normalizePosting(
			'Разработчик',
			terms({
				employment_raw: 'Дистанционная (удаленная) работа; Полный рабочий день',
				location: { city: 'Казань', remote: true, raw: null }
			}),
			taxonomy
		);
		expect(normalized).toMatchObject({ work_format: 'remote', employment_form: 'full', city: 'Казань' });
	});
});
