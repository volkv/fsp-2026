// `rank` of the evaluation bridge goes the product's way of a shortlist (contracts 11.1, domain 13.10): the need is a
// text read by the rules, its categories are the ones a shortlist takes by default, only the candidates holding one
// are ranked — by `rankForNeed` with the blocks of their tests — and the candidates without a category are apart. A
// candidate's decisions are applied in order by the owner of categories, the practice language of a confirmation is
// what its confirmed stack reads, a ranking of given sets ranks exactly them, and the experiment without a test admits
// by the grade hint of the resume.
import { createHash } from 'node:crypto';
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

const BLOCKS: Record<string, [string, string]> = {
	backend: ['be.db', 'be.concurrency'],
	qa: ['qa.auto', 'qa.design']
};

/** A decision; a confirmed one of a practice program names its language, a QA one (cases, not a program) — none. */
const decision = (specialization: string, grade: string, margin: number, language = 'python3') => ({
	specialization,
	grade,
	outcome: margin >= 0 ? 'confirmed' : 'not_confirmed',
	...(margin >= 0 && specialization !== 'qa' ? { practice_language: language } : {}),
	blocks: [
		{ block: BLOCKS[specialization]?.[0], items: 4, score: 48 + margin, cut: 48 },
		{ block: BLOCKS[specialization]?.[1], items: 3, score: 36 + margin, cut: 36 }
	]
});

/** The rows `resume.extract` would insert for a backend developer at work since 2018 writing Python. */
function resume() {
	const text = 'Python-разработчик, ООО «Северный Код», 01.2018 — н. в. Python';
	const quote = { extraction_id: 'x1', block_id: 'b1', start: 0, end: text.length, text };
	const entry = '0199a000-0000-7000-8000-000000000001';
	return {
		mode: 'rules_only',
		producer: 'resume-rules/test',
		evidence: {
			fact: {
				id: '0199a000-0000-7000-8000-000000000002',
				sourceRecordRef: 'resume:test',
				payload: { extraction_id: 'x1' },
				payloadSha256: createHash('sha256').update(text).digest('hex')
			},
			entries: [
				{
					id: entry,
					positionTitle: 'Python-разработчик',
					roleKey: 'backend',
					organizationName: 'ООО «Северный Код»',
					period: {
						from: { date: '2018-01-01', precision: 'month' },
						to: null,
						isCurrent: true,
						status: 'valid'
					},
					appliedSkillKeys: ['python'],
					quotes: [quote]
				}
			],
			claims: [
				{
					id: '0199a000-0000-7000-8000-000000000003',
					claimType: 'skill_mention',
					experienceEntryId: entry,
					rawText: 'Python',
					polarity: 'asserted',
					skillKey: 'python',
					normalization: null,
					value: null,
					quote: { ...quote, start: text.length - 6, text: 'Python' }
				}
			]
		}
	};
}

const deps = () => ({
	databaseUrl: database.url,
	migrationsDir: MIGRATIONS,
	taxonomyDir: TAXONOMY,
	models: modelsOff,
	embed: null
});

describe('the evaluation ranking', () => {
	it('shortlists a need read by the rules: its category only, stronger test first, the rest apart', async () => {
		const all = ['strong', 'weak', 'other', 'failed', 'retaken', 'untested'];
		const request = rankRequestSchema.parse({
			command: 'rank',
			as_of: '2026-10-01',
			candidates: [
				{ id: 'strong', resume: null, fsp: null, test_results: [decision('backend', 'middle', 10)] },
				{ id: 'weak', resume: null, fsp: null, test_results: [decision('backend', 'middle', 0, 'go')] },
				{ id: 'other', resume: null, fsp: null, test_results: [decision('qa', 'middle', 10)] },
				{ id: 'failed', resume: null, fsp: null, test_results: [decision('backend', 'middle', -5)] },
				{
					id: 'retaken',
					resume: null,
					fsp: null,
					preferences: { work_formats: ['remote'], region_code: 'RU-TA', relocation: false },
					test_results: [decision('backend', 'senior', -5), decision('backend', 'middle', 5)]
				},
				{ id: 'untested', resume: null, fsp: null, test_results: [] }
			],
			needs: [
				{
					id: 'n1',
					text: 'Middle Python-разработчик\nТребования: Python, SQL. Будет плюсом: Docker.'
				},
				{ id: 'n2', text: 'Python-разработчик от Junior\nТребования: Python, SQL.' }
			],
			rankings: [
				{ name: 'full', candidates: all, semantic: false, admission: 'categories' },
				{
					name: 'given',
					candidates: all,
					semantic: false,
					admission: 'given',
					per_need: { n1: ['failed', 'weak'], n2: [] }
				}
			]
		});
		const answer = await rankCandidates(request, deps());
		expect(answer.needs.n1).toMatchObject({
			specialization: 'backend',
			grade: 'middle–middle',
			categories: ['backend:middle']
		});
		expect(answer.needs.n1?.skill_keys).toEqual(expect.arrayContaining(['python', 'sql']));
		expect(answer.rankings.full?.n1).toEqual(['strong', 'retaken', 'weak']);
		// A range of grades takes every category of the range.
		expect(answer.needs.n2).toMatchObject({
			grade: 'junior–senior',
			categories: ['backend:junior', 'backend:middle', 'backend:senior']
		});
		expect(answer.unconfirmed.full?.n1?.sort()).toEqual(['failed', 'untested']);
		const [first] = answer.top.full?.n1 ?? [];
		expect(first?.components.test).toBeGreaterThan(answer.top.full?.n1?.[1]?.components.test ?? 1);
		expect(first?.reasons.length).toBeGreaterThan(0);
		expect(answer.catalog).toMatchObject({ candidates: 6, test_results: 6, categories: 4 });
		expect(answer.semantic.full).toEqual({ used: 0, unavailable: { no_query: 2 } });
		// The failed senior attempt does not take the middle confirmed after it; the practice language is what the
		// confirmed stack reads: Go confirms Go, not the first language of the specialization.
		expect(answer.categories.retaken).toEqual([
			expect.objectContaining({ specialization: 'backend', grade: 'middle' })
		]);
		expect(answer.categories.weak?.[0]?.confirmed_skill_keys).toContain('go');
		expect(answer.categories.weak?.[0]?.confirmed_skill_keys).not.toContain('python');
		expect(answer.categories.failed).toEqual([]);
		// The QA practice is cases a harness runs: its language is never confirmed, only the defining blocks' skills.
		expect(answer.categories.other?.[0]?.confirmed_skill_keys).not.toContain('python');
		expect(answer.categories.other?.[0]?.confirmed_skill_keys.length).toBeGreaterThan(0);
		expect(answer.categories.untested).toBeUndefined();
		// A given set is ranked as given, whatever the categories.
		expect(answer.rankings.given?.n1?.sort()).toEqual(['failed', 'weak']);
		expect(answer.rankings.given?.n2).toEqual([]);
	});

	it('refuses a language for a practice that is not a program, and a confirmed program without one', () => {
		const request = (result: Record<string, unknown>) => ({
			command: 'rank',
			as_of: '2026-10-01',
			candidates: [{ id: 'x', resume: null, fsp: null, test_results: [result] }],
			needs: [{ id: 'n', text: 'Junior QA-инженер' }],
			rankings: [{ name: 'full', candidates: ['x'], semantic: false, admission: 'categories' }]
		});
		expect(() => rankRequestSchema.parse(request(decision('qa', 'junior', 5)))).not.toThrow();
		expect(() =>
			rankRequestSchema.parse(request({ ...decision('qa', 'junior', 5), practice_language: 'python3' }))
		).toThrow(/not code the candidate writes/);
		const unnamed: Record<string, unknown> = { ...decision('backend', 'middle', 5) };
		delete unnamed.practice_language;
		expect(() => rankRequestSchema.parse(request(unnamed))).toThrow(/names its language/);
	});

	it('admits by the grade hint of the resume in the experiment without a test', async () => {
		const request = rankRequestSchema.parse({
			command: 'rank',
			as_of: '2026-10-01',
			candidates: [
				{ id: 'resume', resume: resume(), fsp: null, test_results: [] },
				{ id: 'nothing', resume: null, fsp: null, test_results: [] }
			],
			open_specializations: ['backend'],
			needs: [
				{ id: 'wide', text: 'Python-разработчик от Junior\nТребования: Python.' },
				{ id: 'intern', text: 'Стажёр Python-разработчик\nТребования: Python.' }
			],
			rankings: [
				{ name: 'hint', candidates: ['resume', 'nothing'], semantic: false, admission: 'grade_hint' },
				{ name: 'tests', candidates: ['resume', 'nothing'], semantic: false, admission: 'categories' }
			]
		});
		const answer = await rankCandidates(request, deps());
		// Eight years in the role give a hint inside Junior–Senior and above Intern; no evidence — no hint.
		expect(answer.rankings.hint?.wide).toEqual(['resume']);
		expect(answer.rankings.hint?.intern).toEqual([]);
		// Without a test nobody holds a category: the shortlist of the product is empty.
		expect(answer.rankings.tests?.wide).toEqual([]);
		expect(answer.unconfirmed.hint?.wide?.sort()).toEqual(['nothing', 'resume']);
	});
});
