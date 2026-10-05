// `rank` of the evaluation bridge goes the product's way of a shortlist (contracts 11.1, domain 13.10): the need is a
// text read by the rules, its categories are the ones a shortlist takes by default, only the candidates holding one
// are ranked — by `rankForNeed` with the blocks of their tests — and the candidates without a category are apart.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fail } from '$lib/server/ml/result';
import { rankCandidates, rankRequestSchema } from '../../src/eval/rank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const MIGRATIONS = fileURLToPath(new URL('../../src/lib/server/db/migrations/', import.meta.url));
const TAXONOMY = fileURLToPath(new URL('../../taxonomy/', import.meta.url));

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

const modelsOff = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
};

const confirmed = (specialization: string, grade: string, margin: number) => ({
	specialization,
	grade,
	outcome: 'confirmed',
	blocks: [
		{ block: specialization === 'qa' ? 'qa.auto' : 'be.db', items: 4, score: 48 + margin, cut: 48 },
		{ block: specialization === 'qa' ? 'qa.design' : 'be.concurrency', items: 3, score: 36 + margin, cut: 36 }
	]
});

describe('the evaluation ranking', () => {
	it('shortlists a need read by the rules: its category only, stronger test first, the rest apart', async () => {
		const request = rankRequestSchema.parse({
			command: 'rank',
			as_of: '2026-10-01',
			candidates: [
				{ id: 'strong', resume: null, fsp: null, test_result: confirmed('backend', 'middle', 10) },
				{ id: 'weak', resume: null, fsp: null, test_result: confirmed('backend', 'middle', 0) },
				{ id: 'other', resume: null, fsp: null, test_result: confirmed('qa', 'middle', 10) },
				{
					id: 'failed',
					resume: null,
					fsp: null,
					test_result: { specialization: 'backend', grade: 'middle', outcome: 'not_confirmed' }
				},
				{ id: 'untested', resume: null, fsp: null, test_result: null }
			],
			needs: [
				{
					id: 'n1',
					text: 'Middle Python-разработчик\nТребования: Python, SQL. Будет плюсом: Docker.'
				},
				{ id: 'n2', text: 'Python-разработчик от Junior\nТребования: Python, SQL.' }
			],
			rankings: [{ name: 'full', candidates: ['strong', 'weak', 'other', 'failed', 'untested'], semantic: false }]
		});
		const answer = await rankCandidates(request, {
			databaseUrl: database.url,
			migrationsDir: MIGRATIONS,
			taxonomyDir: TAXONOMY,
			models: modelsOff,
			embed: null
		});
		expect(answer.needs.n1).toMatchObject({
			specialization: 'backend',
			grade: 'middle–middle',
			categories: ['backend:middle']
		});
		expect(answer.needs.n1?.skill_keys).toEqual(expect.arrayContaining(['python', 'sql']));
		expect(answer.rankings.full?.n1).toEqual(['strong', 'weak']);
		// A range of grades takes every category of the range.
		expect(answer.needs.n2).toMatchObject({
			grade: 'junior–senior',
			categories: ['backend:junior', 'backend:middle', 'backend:senior']
		});
		expect(answer.unconfirmed.full?.n1?.sort()).toEqual(['failed', 'untested']);
		const [first] = answer.top.full?.n1 ?? [];
		expect(first?.components.test).toBeGreaterThan(answer.top.full?.n1?.[1]?.components.test ?? 1);
		expect(answer.catalog).toMatchObject({ candidates: 5, test_results: 4, categories: 3 });
		expect(answer.semantic.full).toEqual({ used: 0, unavailable: { no_query: 2 } });
	});
});
