// The stored model parses of the repository (`seeds/model-parses.json`) cover the current seed: every scenario need
// and every hero's resume of `seeds/demo.json` has its answer under the schema and the taxonomy the seed reads them
// with. A need's key is the hash of its text and is checked whole; a resume's key is the hash of the blocks the
// parser gives, so here the resume is checked by its schema and taxonomy, the hash by the seed itself
// (tests/integration/demo-seed.test.ts, «reads a text without a stored parse by the rules»).
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { VACANCY_SCHEMA_VERSION } from '$lib/server/vacancies/text-extract';
import { readSeedData, type SeedData } from './data';
import { parseKey } from './model-parses';

const ROOT = resolve(import.meta.dirname, '../../../..');

let data: SeedData;
let taxonomy: string;

beforeAll(async () => {
	data = await readSeedData(resolve(ROOT, 'seeds'));
	taxonomy = (await readTaxonomyDatasets(resolve(ROOT, 'taxonomy'))).release.label;
});

describe('seeds/model-parses.json', () => {
	it('stores the parse of every scenario need of the seed', () => {
		const needs = data.demo.companies.flatMap((company) =>
			(company.needs ?? []).map((need) => ({
				about: `need ${company.key}.${need.key}`,
				key: parseKey(VACANCY_SCHEMA_VERSION, taxonomy, createHash('sha256').update(need.text).digest('hex'))
			}))
		);
		expect(needs.length).toBeGreaterThan(0);
		const missing = needs.filter((need) => !data.modelParses.has(need.key)).map((need) => `${need.about} ${need.key}`);
		expect(missing).toEqual([]);
	});

	it('stores a parse of every hero resume under the schema and taxonomy of the seed', () => {
		const heroResumes = data.demo.candidates.filter((hero) => hero.resume !== undefined);
		expect(heroResumes.length).toBeGreaterThan(0);
		const resumes = [...data.modelParses.values()].filter(
			(parse) => parse.schemaVersion === RESUME_SCHEMA_VERSION && parse.taxonomy === taxonomy
		);
		expect(resumes).toHaveLength(heroResumes.length);
	});
});
