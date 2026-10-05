import { describe, expect, it } from 'vitest';
import { checkResumeItems } from '$lib/server/ml/resume-extract';
import { normalizeSkillText } from '$lib/server/taxonomy/normalize';
import { sliceByCodePoints } from '$lib/text/offsets';
import { planEvidence } from './evidence';
import { extractByRules, type RuleBlock } from './rules';
import { buildResumeTaxonomy, resumeLexicon } from './taxonomy';

const SKILLS: Record<string, string[]> = {
	python: ['Python', 'питон'],
	go: ['Go', 'Golang', 'го'],
	postgresql: ['PostgreSQL', 'Postgres'],
	fastapi: ['FastAPI'],
	nextjs: ['Next.js'],
	cpp: ['C++'],
	ci_cd: ['CI/CD'],
	r: ['R'],
	docker: ['Docker'],
	jetpack_compose: ['Jetpack Compose', 'compose'],
	ui: ['UI-дизайн', 'UI'],
	java: ['Java'],
	spring: ['Spring Framework', 'Spring'],
	kubernetes: ['Kubernetes', 'k8s'],
	pandas: ['Pandas'],
	pandoc: ['Pandoc'],
	junit: ['JUnit', 'TestNG'],
	prometheus: ['Prometheus', 'мониторинг'],
	english: ['Английский язык', 'English']
};

const taxonomy = buildResumeTaxonomy({
	id: '00000000-0000-7000-8000-000000000001',
	label: 'test',
	aliases: Object.entries(SKILLS).flatMap(([skillKey, spellings]) =>
		spellings.map((spelling) => ({ aliasNormalized: normalizeSkillText(spelling), skillKey }))
	),
	roles: [
		{ key: 'backend', nameRu: 'Бэкенд-разработчик' },
		{ key: 'frontend', nameRu: 'Фронтенд-разработчик' },
		{ key: 'team_lead', nameRu: 'Тимлид / руководитель группы разработки' }
	]
});

const AS_OF = new Date('2026-09-25T12:00:00Z');

const BLOCKS: RuleBlock[] = [
	{ id: 'p1-b001', kind: 'heading', column: null, text: 'Примеров Алексей' },
	{ id: 'p1-b002', kind: 'paragraph', column: null, text: 'Ведущий Python-разработчик' },
	{ id: 'p1-b003', kind: 'heading', column: null, text: 'Опыт работы — 7 лет 1 месяц' },
	{ id: 'p1-b004', kind: 'paragraph', column: null, text: 'Март 2021 —\nнастоящее время\n5 лет 7 месяцев' },
	{ id: 'p1-b005', kind: 'paragraph', column: null, text: 'ООО «Пример Технолоджиз»' },
	{ id: 'p1-b006', kind: 'paragraph', column: null, text: 'Ведущий Python-разработчик' },
	{ id: 'p1-b007', kind: 'list_item', column: null, text: '• Сервисы на FastAPI и PostgreSQL, не работал с Go.' },
	{ id: 'p1-b008', kind: 'list_item', column: null, text: '• Наставничество для четырёх младших разработчиков.' },
	{ id: 'p1-b009', kind: 'heading', column: null, text: 'Навыки' },
	{ id: 'p1-b010', kind: 'paragraph', column: null, text: 'Знание языков: Русский — Родной; Английский — B2' },
	{ id: 'p1-b011', kind: 'paragraph', column: null, text: 'Next.js, C++, CI/CD, R, го и Postgres' }
];

function read() {
	const blocks = BLOCKS.map((b) => ({ id: b.id, text: b.text }));
	return checkResumeItems(extractByRules(BLOCKS, taxonomy), blocks, resumeLexicon(taxonomy));
}

describe('resume by rules', () => {
	it('gives items whose quotes lie in their blocks', () => {
		const { items, rejected } = read();
		expect(rejected).toEqual([]);
		for (const item of items) {
			const block = BLOCKS.find((b) => b.id === item.quote.blockId);
			expect(block).toBeDefined();
			expect(sliceByCodePoints(block?.text ?? '', item.quote)).toBe(item.quote.text);
		}
	});

	it('groups a job: period, organization, title, applied skills and markers', () => {
		const { items } = read();
		const job = items.filter((item) => item.group === 'job-1');
		expect(job.map((item) => [item.kind, item.rawText])).toEqual(
			expect.arrayContaining([
				['experience_period', 'Март 2021 —\nнастоящее время'],
				['organization', 'ООО «Пример Технолоджиз»'],
				['role_title', 'Ведущий Python-разработчик'],
				['skill_mention', 'FastAPI'],
				['skill_mention', 'PostgreSQL'],
				['responsibility_marker', 'Наставничество']
			])
		);
		// The desired position above the experience section is not a job.
		expect(items.filter((item) => item.quote.blockId === 'p1-b002').map((item) => item.group)).toEqual([null]);
	});

	it('keeps a negated skill as negated', () => {
		const go = read().items.find((item) => item.kind === 'skill_mention' && item.rawText === 'Go');
		expect(go?.polarity).toBe('negated');
	});

	it('plans an experience entry with the role, the period and only asserted skills', () => {
		const plan = planEvidence(read().items, {
			resumeDocumentId: '00000000-0000-7000-8000-00000000000a',
			extractionId: '00000000-0000-7000-8000-00000000000b',
			fileSha256: 'a'.repeat(64),
			extractorVersion: '1.0.0+test',
			processingMode: 'rules_only',
			producer: 'resume-rules/4',
			taxonomy,
			asOf: AS_OF
		});
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]).toMatchObject({
			positionTitle: 'Ведущий Python-разработчик',
			roleKey: 'backend',
			organizationName: 'ООО «Пример Технолоджиз»',
			period: { from: { date: '2021-03-01', precision: 'month' }, to: null, isCurrent: true, status: 'valid' },
			appliedSkillKeys: ['fastapi', 'postgresql', 'python']
		});
		const marker = plan.claims.find((claim) => claim.claimType === 'responsibility_marker');
		expect(marker?.value).toEqual({ marker: 'mentoring' });
		const languages = plan.claims.filter((claim) => claim.claimType === 'language_level');
		expect(languages.map((claim) => [claim.rawText, claim.value])).toEqual([['Английский', { level: 'B2' }]]);
	});
});

describe('jobs, languages and education by rules', () => {
	const kinds = (blocks: RuleBlock[]) =>
		extractByRules(blocks, taxonomy).map((item) => [item.kind, item.group ?? null, item.raw_text]);

	it('gives the title and the organization written before the period to the job of that period', () => {
		const blocks: RuleBlock[] = [
			{ id: 'd-b001', kind: 'heading', column: null, text: 'Опыт работы' },
			{ id: 'd-b002', kind: 'paragraph', column: null, text: 'Junior Python-разработчик' },
			{ id: 'd-b003', kind: 'paragraph', column: null, text: '01.2024 – н. в.' },
			{ id: 'd-b004', kind: 'list_item', column: null, text: 'Сервисы на FastAPI' },
			{ id: 'd-b005', kind: 'paragraph', column: null, text: 'АО «Пример»' },
			{ id: 'd-b006', kind: 'paragraph', column: null, text: 'Стажёр-разработчик' },
			{ id: 'd-b007', kind: 'paragraph', column: null, text: '06.2023 – 12.2023' },
			{ id: 'd-b008', kind: 'list_item', column: null, text: 'Тесты на Go' }
		];
		expect(kinds(blocks).filter(([kind]) => kind !== 'skill_mention')).toEqual([
			['role_title', 'job-1', 'Junior Python-разработчик'],
			['experience_period', 'job-1', '01.2024 – н. в.'],
			// The first job has no organization: the one after its description opens the next job.
			['organization', 'job-2', 'АО «Пример»'],
			['role_title', 'job-2', 'Стажёр-разработчик'],
			['experience_period', 'job-2', '06.2023 – 12.2023']
		]);
		expect(kinds(blocks).filter(([kind]) => kind === 'skill_mention')).toEqual([
			['skill_mention', 'job-1', 'Python'],
			['skill_mention', 'job-1', 'FastAPI'],
			['skill_mention', 'job-2', 'Go']
		]);
	});

	it('tells a company with initials from a sentence of the description', () => {
		const blocks: RuleBlock[] = [
			{ id: 'd-b001', kind: 'heading', column: null, text: 'Опыт работы' },
			{ id: 'd-b002', kind: 'paragraph', column: null, text: 'Сентябрь 2018 —\nМай 2019\n9 месяцев' },
			{ id: 'd-b003', kind: 'paragraph', column: null, text: 'ИП Выдумкин Н. Н.' },
			{ id: 'd-b004', kind: 'paragraph', column: null, text: 'Казань' },
			{ id: 'd-b005', kind: 'paragraph', column: null, text: 'Младший разработчик' },
			{ id: 'd-b006', kind: 'paragraph', column: null, text: 'Запустил сервис «Биллинг» для разработчиков.' }
		];
		expect(kinds(blocks)).toEqual([
			['experience_period', 'job-1', 'Сентябрь 2018 —\nМай 2019'],
			['organization', 'job-1', 'ИП Выдумкин Н. Н.'],
			['role_title', 'job-1', 'Младший разработчик']
		]);
	});

	it('reads each column under its own headings: a sidebar does not interrupt the experience beside it', () => {
		// Blocks in reading order of a page cut into bands: the sidebar and the main column alternate.
		const blocks: RuleBlock[] = [
			{ id: 'p1-b001', kind: 'heading', column: null, text: 'Мария Туманова' },
			{ id: 'p1-b002', kind: 'heading', column: 1, text: 'Навыки' },
			{ id: 'p1-b003', kind: 'heading', column: 2, text: 'Опыт работы' },
			{ id: 'p1-b004', kind: 'paragraph', column: 1, text: 'Docker\nGo' },
			{ id: 'p1-b006', kind: 'heading', column: 2, text: 'Python-разработчик' },
			{ id: 'p1-b007', kind: 'paragraph', column: 2, text: 'ООО «Северный Код»' },
			{ id: 'p1-b005', kind: 'heading', column: 1, text: 'Языки' },
			{ id: 'p1-b008', kind: 'paragraph', column: 1, text: 'Английский — B2' },
			{ id: 'p1-b009', kind: 'paragraph', column: 2, text: '2022 — 2023' },
			{ id: 'p1-b010', kind: 'list_item', column: 2, text: '— Сервисы на FastAPI' },
			{ id: 'p1-b011', kind: 'heading', column: null, text: 'Образование' },
			{ id: 'p1-b012', kind: 'paragraph', column: 2, text: 'Северо-Восточный институт информатики' }
		];
		expect(kinds(blocks)).toEqual([
			['full_name', null, 'Мария Туманова'],
			['skill_mention', null, 'Docker'],
			['skill_mention', null, 'Go'],
			['role_title', 'job-1', 'Python-разработчик'],
			['skill_mention', 'job-1', 'Python'],
			['organization', 'job-1', 'ООО «Северный Код»'],
			['language_level', null, 'Английский'],
			['skill_mention', null, 'Английский'],
			['experience_period', 'job-1', '2022 — 2023'],
			['skill_mention', 'job-1', 'FastAPI'],
			['education', null, 'Северо-Восточный институт информатики']
		]);
	});

	it('takes a language stated with its level for the skill the taxonomy names «<язык> язык»', () => {
		const blocks: RuleBlock[] = [
			{ id: 'l-b001', kind: 'heading', column: null, text: 'Языки' },
			{ id: 'l-b002', kind: 'paragraph', column: null, text: 'Английский — B2' },
			{ id: 'l-b003', kind: 'paragraph', column: null, text: 'English — C1' },
			{ id: 'l-b004', kind: 'paragraph', column: null, text: 'Немецкий — A2' },
			{ id: 'l-b005', kind: 'heading', column: null, text: 'О себе' },
			{ id: 'l-b006', kind: 'paragraph', column: null, text: 'Читаю документацию на английский манер' }
		];
		expect(kinds(blocks)).toEqual([
			['language_level', null, 'Английский'],
			['skill_mention', null, 'Английский'],
			['skill_mention', null, 'English'],
			['language_level', null, 'English'],
			['language_level', null, 'Немецкий']
		]);
		const { items } = checkResumeItems(
			extractByRules(blocks, taxonomy),
			blocks.map((b) => ({ id: b.id, text: b.text })),
			resumeLexicon(taxonomy)
		);
		const plan = planEvidence(items, {
			resumeDocumentId: '00000000-0000-7000-8000-00000000000a',
			extractionId: '00000000-0000-7000-8000-00000000000b',
			fileSha256: 'a'.repeat(64),
			extractorVersion: '1.0.0+test',
			processingMode: 'rules_only',
			producer: 'resume-rules/4',
			taxonomy,
			asOf: AS_OF
		});
		expect(
			plan.claims.filter((claim) => claim.claimType === 'skill_mention').map((c) => [c.rawText, c.skillKey])
		).toEqual([
			['Английский', 'english'],
			['English', 'english']
		]);
	});

	it('goes on with the experience under a sidebar that has ended', () => {
		const blocks: RuleBlock[] = [
			{ id: 'p1-b001', kind: 'heading', column: 2, text: 'Опыт работы' },
			{ id: 'p1-b002', kind: 'heading', column: 1, text: 'Языки' },
			{ id: 'p1-b003', kind: 'paragraph', column: 1, text: 'Английский — B2' },
			{ id: 'p1-b004', kind: 'list_item', column: 2, text: '— Сервисы на FastAPI' },
			// The sidebar is over: the rest of the page is one column.
			{ id: 'p1-b005', kind: 'heading', column: null, text: 'Python-разработчик' },
			{ id: 'p1-b006', kind: 'paragraph', column: null, text: '2025 — по настоящее время' }
		];
		expect(kinds(blocks).filter(([kind]) => kind !== 'skill_mention')).toEqual([
			['language_level', null, 'Английский'],
			['role_title', 'job-1', 'Python-разработчик'],
			['experience_period', 'job-1', '2025 — по настоящее время']
		]);
	});

	it('takes the dates in a column without headings beside the jobs for the experience section', () => {
		const blocks: RuleBlock[] = [
			{ id: 'p1-b001', kind: 'heading', column: null, text: 'Опыт работы — 2 года' },
			{ id: 'p1-b002', kind: 'paragraph', column: 1, text: 'Март 2021 —\nнастоящее время' },
			{ id: 'p1-b003', kind: 'paragraph', column: 2, text: 'ООО «Пример»' },
			{ id: 'p1-b004', kind: 'paragraph', column: 2, text: 'Python-разработчик' },
			{ id: 'p1-b005', kind: 'heading', column: 1, text: 'Образование' },
			{ id: 'p1-b006', kind: 'paragraph', column: 1, text: 'Высшее\n2019' },
			{ id: 'p1-b007', kind: 'paragraph', column: 2, text: 'Московский учебный университет' }
		];
		expect(kinds(blocks).filter(([kind]) => kind !== 'skill_mention')).toEqual([
			['experience_period', 'job-1', 'Март 2021 —\nнастоящее время'],
			['organization', 'job-1', 'ООО «Пример»'],
			['role_title', 'job-1', 'Python-разработчик'],
			['education', null, 'Московский учебный университет']
		]);
	});

	it('keeps an undated job of the experience section as a job', () => {
		const blocks: RuleBlock[] = [
			{ id: 'd-b001', kind: 'heading', column: null, text: 'Опыт работы' },
			{ id: 'd-b002', kind: 'heading', column: null, text: 'Frontend-разработчик' },
			{ id: 'd-b003', kind: 'paragraph', column: null, text: 'Студия «Журавль»' },
			{ id: 'd-b004', kind: 'list_item', column: null, text: '— Вёрстка на Next.js' },
			{ id: 'd-b005', kind: 'heading', column: null, text: 'Тимлид' },
			{ id: 'd-b006', kind: 'paragraph', column: null, text: 'ООО «Граница»' }
		];
		expect(kinds(blocks).filter(([kind]) => kind !== 'skill_mention')).toEqual([
			['role_title', 'job-1', 'Frontend-разработчик'],
			['organization', 'job-1', 'Студия «Журавль»'],
			['role_title', 'job-2', 'Тимлид'],
			['responsibility_marker', 'job-2', 'Тимлид'],
			['organization', 'job-2', 'ООО «Граница»']
		]);
	});

	it('reads a language level written with the word «язык»', () => {
		const items = extractByRules(
			[{ id: 'd-b001', kind: 'paragraph', column: null, text: 'Английский язык: B2' }],
			taxonomy
		);
		expect(items.filter((item) => item.kind === 'language_level')).toEqual([
			expect.objectContaining({ raw_text: 'Английский', level: 'B2', quote: 'Английский язык: B2' })
		]);
	});

	it('does not take the degree line of an education entry for another entry', () => {
		const blocks: RuleBlock[] = [
			{ id: 'd-b001', kind: 'heading', column: null, text: 'Образование' },
			{ id: 'd-b002', kind: 'paragraph', column: null, text: 'Северо-Восточный институт информатики' },
			{ id: 'd-b003', kind: 'paragraph', column: null, text: 'Бакалавр, прикладная информатика, 2024' },
			{ id: 'd-b004', kind: 'paragraph', column: null, text: 'Магистратура: МГТУ им. Н. Э. Баумана' }
		];
		expect(kinds(blocks)).toEqual([
			['education', null, 'Северо-Восточный институт информатики'],
			['education', null, 'Магистратура: МГТУ им. Н. Э. Баумана']
		]);
	});
});

describe('profile values by rules', () => {
	const kinds = (blocks: RuleBlock[]) =>
		extractByRules(blocks, taxonomy).map((item) => [item.kind, item.group ?? null, item.raw_text]);

	it('reads the name at the top, the own contacts of the header and the stated soft skills', () => {
		const blocks: RuleBlock[] = [
			{ id: 'h-b001', kind: 'heading', column: null, text: 'Резюме' },
			{ id: 'h-b002', kind: 'heading', column: null, text: 'Туманова Мария Сергеевна' },
			{ id: 'h-b003', kind: 'paragraph', column: null, text: 'Python-разработчик' },
			{
				id: 'h-b004',
				kind: 'paragraph',
				column: null,
				text: '8 (912) 345-67-89 · maria@example.org · Telegram: @maria_dev'
			},
			{ id: 'h-b005', kind: 'heading', column: null, text: 'О себе' },
			{ id: 'h-b006', kind: 'paragraph', column: null, text: 'Коммуникабельна, люблю работать в команде.' },
			{ id: 'h-b007', kind: 'heading', column: null, text: 'Опыт работы' },
			{ id: 'h-b008', kind: 'paragraph', column: null, text: '2022 — 2023' },
			{ id: 'h-b009', kind: 'paragraph', column: null, text: 'Python-разработчик' },
			{ id: 'h-b010', kind: 'list_item', column: null, text: '— Наставник двух стажёров' },
			{
				id: 'h-b011',
				kind: 'paragraph',
				column: null,
				text: 'Рекомендации: Петров Пётр, +7 900 000-00-00, petrov@example.org'
			}
		];
		const profileKinds = ['full_name', 'contact_phone', 'contact_email', 'contact_telegram', 'soft_skill'];
		const found = kinds(blocks).filter(([kind]) => profileKinds.includes(kind ?? ''));
		expect(found).toEqual([
			['full_name', null, 'Туманова Мария Сергеевна'],
			['contact_phone', null, '8 (912) 345-67-89'],
			['contact_email', null, 'maria@example.org'],
			['contact_telegram', null, '@maria_dev'],
			['soft_skill', null, 'Коммуникабельна'],
			['soft_skill', null, 'работать в команде'],
			['soft_skill', null, 'Наставник']
		]);
		const { items, rejected } = checkResumeItems(
			extractByRules(blocks, taxonomy),
			blocks.map((b) => ({ id: b.id, text: b.text })),
			resumeLexicon(taxonomy)
		);
		expect(rejected).toEqual([]);
		expect(items.filter((item) => item.kind === 'full_name').map((item) => item.quote.blockId)).toEqual(['h-b002']);
	});
});
