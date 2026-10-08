// The specification of the test of a vacancy and of a need read against the database (docs/domain.md, 13.11): the
// families of the release in force, a closed specialization named, and the example set the page receives free of
// families, seeds and conditions of items.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vacancyTestSpec } from '$lib/server/assessments/vacancy-spec';
import type { NeedView } from '$lib/server/needs/service';
import { needTestSpecOf } from '$lib/server/needs/test-spec';
import { buildVacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import { banksInForce, textSeed, vacancySpecInput, vacancyTestSpecOf } from '$lib/server/vacancies/test-spec';
import { releaseFixtureBank, type FixtureBank } from '../helpers/bank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let database: TestDatabase;
let bank: FixtureBank;

const vocabulary = {
	skills: [
		{ key: 'java', name: 'Java' },
		{ key: 'sql', name: 'SQL' },
		{ key: 'rest', name: 'REST API' },
		{ key: 'postgresql', name: 'PostgreSQL' },
		{ key: 'manual_testing', name: 'Ручное тестирование' }
	],
	grades: ['intern', 'junior', 'middle', 'senior', 'lead'].map((key) => ({ key, name: key }))
};
const taxonomy = buildVacancyTaxonomy({
	id: 'test',
	label: 'test',
	aliases: vocabulary.skills.map(({ key, name }) => ({ aliasNormalized: name.toLowerCase(), skillKey: key })),
	grades: vocabulary.grades.map((g, ordinal) => ({ key: g.key, ordinal })),
	terms: [],
	roles: [{ key: 'backend', nameRu: 'Бэкенд-разработчик' }]
});
const vacancy = {
	roleKey: 'backend',
	gradeMin: 'middle',
	gradeMax: 'lead',
	requiredSkillKeys: ['java', 'sql', 'rest', 'postgresql'],
	niceSkillKeys: ['manual_testing'],
	description: 'Сервис биллинга.\n\nТребования: Java, SQL, REST API, PostgreSQL.\n\nБудет плюсом: Camunda.'
};

beforeAll(async () => {
	database = await createTestDatabase();
	bank = await releaseFixtureBank(database.db, 'backend');
});

afterAll(async () => {
	await database.drop();
});

describe('test of a vacancy against the releases in force', () => {
	it('reads the families of the release in force and gives the plan the page shows', async () => {
		const banks = await banksInForce(database.db);
		expect([...banks.keys()]).toEqual(['backend']);
		expect(banks.get('backend')?.map((f) => f.key)).toEqual(bank.families.map((f) => f.descriptor.key));

		const spec = await vacancyTestSpecOf(database.db, vacancy, vocabulary, taxonomy);
		expect(spec).toEqual(vacancyTestSpec(vacancySpecInput(vacancy, vocabulary, taxonomy), banks));
		// Middle, Senior, and Lead outside the catalog.
		expect(spec.plans.map((p) => [p.grade, p.status])).toEqual([
			['middle', 'open'],
			['senior', 'open']
		]);
		const middle = spec.plans[0];
		if (middle?.status !== 'open') throw new Error('Backend Middle is not open');
		expect(middle.requirements.map((r) => [r.name, r.coverage.kind])).toEqual([
			['Java', 'base_practice'],
			['SQL', 'base_stack'],
			['REST API', 'vacancy_block'],
			['PostgreSQL', 'not_tested'],
			// QA is not released here: no other specialization checks it.
			['Ручное тестирование', 'not_tested'],
			['Camunda', 'not_tested']
		]);
		const json = JSON.stringify(spec);
		for (const family of bank.families) expect(json).not.toContain(family.descriptor.key);
		expect(json).not.toContain(textSeed(vacancy.description));
	});

	it('names the specialization of a need that is not released and the test of a need without a grade', async () => {
		const need = (form: NeedView['form']): NeedView => ({
			id: '00000000-0000-7000-8000-000000000001',
			companyId: '00000000-0000-7000-8000-000000000002',
			text: null,
			form,
			parse: null,
			textCheck: {
				validator_version: 'test',
				result: 'clean',
				phrases: [],
				warnings_confirmed: null,
				moderation: null
			},
			status: 'active',
			createdAt: new Date(),
			updatedAt: new Date()
		});
		const qa = await needTestSpecOf(
			database.db,
			need({
				specialization: 'qa',
				grade: { min: 'junior', max: 'junior' },
				skill_keys: ['manual_testing'],
				nice_skill_keys: [],
				other_skills: ['Allure TestOps']
			}),
			vocabulary
		);
		expect(qa.plans).toEqual([
			{ status: 'closed', specialization: 'qa', grade: 'junior', title: 'QA · Младший', reason: 'not_released' }
		]);
		expect(qa.requirements.map((r) => [r.name, r.coverage])).toEqual([
			['Ручное тестирование', { kind: 'not_tested', reason: 'no_block' }],
			['Allure TestOps', { kind: 'not_tested', reason: 'outside_taxonomy' }]
		]);
		const noGrade = await needTestSpecOf(
			database.db,
			need({ role_key: 'backend', skill_keys: ['sql'], nice_skill_keys: [] }),
			vocabulary
		);
		expect(noGrade.gaps).toEqual(['no_grade']);
		expect(noGrade.plans).toEqual([]);
	});
});
