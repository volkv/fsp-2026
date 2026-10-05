import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { recommendCategories } = await import('./recommend');
const { SPECIALIZATION_KEYS, specializationOpen } = await import('$lib/server/assessments/contract/catalog');

/** Every bank released: open is what the catalog switches on. */
const open = new Set(SPECIALIZATION_KEYS.filter((s) => specializationOpen(s, new Set(SPECIALIZATION_KEYS))));
const empty = { skill_keys: [], nice_skill_keys: [] };

describe('recommendCategories', () => {
	it('gives the pair of the form and its neighbouring grades', () => {
		const categories = recommendCategories({ ...empty, specialization: 'backend', grade: 'middle' }, open);
		expect(categories.map((c) => [c.specialization, c.grade, c.basis])).toEqual([
			['backend', 'middle', 'form'],
			['backend', 'junior', 'neighbour_grade'],
			['backend', 'senior', 'neighbour_grade']
		]);
	});

	it('gives every grade of the specialization when the form names no grade', () => {
		const categories = recommendCategories({ ...empty, specialization: 'qa' }, open);
		expect(categories.map((c) => c.grade)).toEqual(['intern', 'junior', 'middle', 'senior']);
	});

	it('goes by the required skills the blocks confirm when the form names no specialization', () => {
		const categories = recommendCategories({ ...empty, skill_keys: ['sql'], grade: 'intern' }, open);
		expect(categories.length).toBeGreaterThan(0);
		expect(categories.every((c) => c.basis !== 'form' && c.coveredSkills.includes('sql'))).toBe(true);
		expect(categories.filter((c) => c.basis === 'skills').every((c) => c.grade === 'intern')).toBe(true);
	});

	it('suggests no closed specialization and nothing without a basis', () => {
		expect(recommendCategories({ ...empty, specialization: 'devops', grade: 'middle' }, open)).toEqual([]);
		expect(recommendCategories(empty, open)).toEqual([]);
		expect(recommendCategories({ ...empty, skill_keys: ['no_such_skill'] }, open)).toEqual([]);
	});
});
