import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { categoryName } from '$lib/components/product/model.js';
import { GRADE_KEYS } from '$lib/server/assessments/contract/catalog';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { CATEGORY_GRADE_NAMES, CATEGORY_OPTIONS, categoryGradeName } = await import('./labels');
const { gradeTitle, testTitle } = await import('$lib/server/assessments/titles');
const { categoryTitle } = await import('$lib/server/attestations/statement');
const { catalogNames } = await import('$lib/server/contact/page');

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../taxonomy', import.meta.url));
let published: Record<string, string>;

beforeAll(async () => {
	// The names the taxonomy release publishes: what the pages read through the vocabulary.
	const release = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR));
	published = Object.fromEntries(release.content.grades.map((grade) => [grade.key, grade.name]));
});

describe('one name of a category grade', () => {
	it('names every grade of the catalog by the taxonomy the pages read', () => {
		for (const key of GRADE_KEYS) expect(CATEGORY_GRADE_NAMES[key]).toBe(published[key]);
		expect(CATEGORY_OPTIONS.grades).toEqual(GRADE_KEYS.map((key) => ({ key, name: published[key] })));
		expect(categoryGradeName('middle')).toBe('Средний');
	});

	it('gives the screens of the tests, the attestation, the contact pages and the shortlist the same name', () => {
		for (const key of GRADE_KEYS) {
			expect(gradeTitle(key)).toBe(published[key]);
			expect(categoryTitle('backend', key).grade).toBe(published[key]);
			expect(catalogNames().grades[key]).toBe(published[key]);
		}
		const vocabulary = { specializations: { backend: 'Backend' }, grades: published };
		expect(testTitle('backend', 'middle')).toBe('Backend · Средний');
		expect(categoryName({ specialization: 'backend', grade: 'middle' }, vocabulary)).toBe('Backend · Средний');
	});
});
