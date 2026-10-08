import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { compositeSpecializations, needCategoriesOf, recommendCategories } = await import('./recommend');
const { SPECIALIZATION_KEYS, specializationOpen } = await import('$lib/server/assessments/contract/catalog');

/** Every bank released but DevOps: a specialization stays closed until its bank is released. */
const released = new Set(SPECIALIZATION_KEYS.filter((s) => s !== 'devops'));
const open = new Set(SPECIALIZATION_KEYS.filter((s) => specializationOpen(s, released)));
const empty = { skill_keys: [], nice_skill_keys: [] };

describe('recommendCategories', () => {
	it('gives the pair of the form and its neighbouring grades', () => {
		const categories = recommendCategories(
			{ ...empty, specialization: 'backend', grade: { min: 'middle', max: 'middle' } },
			open
		);
		expect(categories.map((c) => [c.specialization, c.grade, c.basis])).toEqual([
			['backend', 'middle', 'form'],
			['backend', 'junior', 'neighbour_grade'],
			['backend', 'senior', 'neighbour_grade']
		]);
	});

	it('gives every grade of a range and the neighbours of the range', () => {
		const categories = recommendCategories(
			{ ...empty, specialization: 'backend', grade: { min: 'junior', max: 'middle' } },
			open
		);
		expect(categories.map((c) => [c.grade, c.basis])).toEqual([
			['junior', 'form'],
			['middle', 'form'],
			['intern', 'neighbour_grade'],
			['senior', 'neighbour_grade']
		]);
	});

	it('gives every grade of the specialization when the form names no grade', () => {
		const categories = recommendCategories({ ...empty, specialization: 'qa' }, open);
		expect(categories.map((c) => c.grade)).toEqual(['intern', 'junior', 'middle', 'senior']);
	});

	it('takes the first specialization of a composite role and offers the other: fullstack is backend, frontend offered', () => {
		const result = needCategoriesOf(
			{ ...empty, role_key: 'fullstack', skill_keys: ['sql'], grade: { min: 'middle', max: 'middle' } },
			open
		);
		expect(result.basis).toBe('role');
		expect(result.categories.map((c) => [c.specialization, c.grade, c.basis])).toEqual([
			['backend', 'middle', 'role'],
			['backend', 'junior', 'neighbour_grade'],
			['backend', 'senior', 'neighbour_grade'],
			['frontend', 'middle', 'composite_role']
		]);
		expect(compositeSpecializations({ ...empty, role_key: 'fullstack' })).toEqual(['backend', 'frontend']);
		expect(compositeSpecializations({ ...empty, role_key: 'backend' })).toEqual([]);
		expect(compositeSpecializations(empty)).toEqual([]);
	});

	it('keeps a role no test checks without a category and only suggests categories by its skills', () => {
		const result = needCategoriesOf(
			{ ...empty, role_key: 'data_engineer', skill_keys: ['python', 'sql'], grade: { min: 'middle', max: 'middle' } },
			open
		);
		expect(result.basis).toBe('unsupported_role');
		expect(result.categories.length).toBeGreaterThan(0);
		expect(result.categories.every((c) => c.basis === 'skills' && c.grade === 'middle')).toBe(true);
		expect(result.categories.every((c) => c.coveredSkills.length > 0)).toBe(true);
		// Nothing a block confirms: no suggestion either.
		expect(needCategoriesOf({ ...empty, role_key: 'data_engineer', skill_keys: ['airflow'] }, open)).toEqual({
			basis: 'unsupported_role',
			categories: [],
			closed: []
		});
	});

	it('says that the specialization of the role is closed instead of taking another', () => {
		const result = needCategoriesOf({ ...empty, role_key: 'sre' }, open);
		expect(result).toMatchObject({ basis: 'closed', closed: ['devops'] });
		expect(result.categories.every((c) => c.basis === 'skills')).toBe(true);
	});

	it('goes by the required skills the blocks confirm when the form names no specialization', () => {
		const categories = recommendCategories(
			{ ...empty, skill_keys: ['sql'], grade: { min: 'intern', max: 'intern' } },
			open
		);
		expect(categories.length).toBeGreaterThan(0);
		expect(categories.every((c) => c.basis !== 'form' && c.coveredSkills.includes('sql'))).toBe(true);
		expect(categories.filter((c) => c.basis === 'skills').every((c) => c.grade === 'intern')).toBe(true);
	});

	it('suggests no closed specialization and nothing without a basis', () => {
		expect(
			recommendCategories({ ...empty, specialization: 'devops', grade: { min: 'middle', max: 'middle' } }, open)
		).toEqual([]);
		expect(recommendCategories(empty, open)).toEqual([]);
		expect(recommendCategories({ ...empty, skill_keys: ['no_such_skill'] }, open)).toEqual([]);
	});
});
