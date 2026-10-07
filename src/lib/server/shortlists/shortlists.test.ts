// Pure parts of shortlists (docs/domain.md 13.10, contracts 10.2): the scale of salary intervals and the cohort answer,
// refinements and their diff, the team-draft interleaving and the judgement of a blind comparison.
import { describe, expect, it } from 'vitest';
import { intervalOf, salaryAnswerOf, type Cohort } from './cohort';
import { interleave, judge, type EvaluationCard } from './evaluation';
import { applyChange, diffQueries, whatIfQuery, type ShortlistQuery } from './query';

const BINS = [
	{ until: 300_000, step: 25_000 },
	{ until: 600_000, step: 50_000 },
	{ until: null, step: 100_000 }
];

describe('the salary scale', () => {
	it('cuts 25 000 up to 300 000, 50 000 up to 600 000, then 100 000', () => {
		expect(intervalOf(BINS, 0)).toEqual({ index: 0, from: 0, to: 25_000 });
		expect(intervalOf(BINS, 299_999)).toEqual({ index: 11, from: 275_000, to: 300_000 });
		expect(intervalOf(BINS, 300_000)).toEqual({ index: 12, from: 300_000, to: 350_000 });
		expect(intervalOf(BINS, 600_000)).toEqual({ index: 18, from: 600_000, to: 700_000 });
		expect(intervalOf(BINS, 1_250_000)).toEqual({ index: 24, from: 1_200_000, to: 1_300_000 });
	});

	it('answers a cohort by multiples of five, and nothing below five', () => {
		const cohort: Cohort = {
			size: 9,
			stated: { gross: 0, net: 8 },
			bins: { gross: [], net: [0, 0, 0, 0, 7, 0, 0, 0, 0, 1] }
		};
		expect(salaryAnswerOf(cohort, BINS, 5, { max: 110_000, tax_base: 'net' })).toMatchObject({
			not_below: { value: 5 },
			of: { value: 5 }
		});
		// The one expecting 225–250 thousand is not seen in any range.
		const near = salaryAnswerOf(cohort, BINS, 5, { max: 224_000, tax_base: 'net' });
		const far = salaryAnswerOf(cohort, BINS, 5, { max: 249_000, tax_base: 'net' });
		expect([near.not_below, near.of]).toEqual([far.not_below, far.of]);
		expect(salaryAnswerOf(cohort, BINS, 5, { max: 50_000, tax_base: 'net' }).not_below).toEqual({ below: 5 });
		expect(salaryAnswerOf(cohort, BINS, 5, { max: 500_000, tax_base: 'gross' })).toMatchObject({
			not_below: { below: 5 },
			of: { below: 5 }
		});
	});
});

const query: ShortlistQuery = {
	form: {
		specialization: 'backend',
		grade: { min: 'middle', max: 'middle' },
		skill_keys: ['go'],
		nice_skill_keys: [],
		work_format: 'office'
	},
	categories: [{ specialization: 'backend', grade: 'middle' }],
	filters: { fsp_only: false, work_formats: [], confirmed_skill_keys: [] }
};

describe('a refinement', () => {
	it('changes only what it names, clears with null, and its diff names each changed field', () => {
		const next = applyChange(query, { work_format: null, skill_keys: ['go', 'sql', 'go'], fsp_only: true });
		expect(next.form.work_format).toBeUndefined();
		expect(next.form.skill_keys).toEqual(['go', 'sql']);
		expect(next.form.grade).toEqual({ min: 'middle', max: 'middle' });
		expect(diffQueries(query, next)).toEqual({
			skill_keys: { from: ['go'], to: ['go', 'sql'] },
			work_format: { from: 'office', to: null },
			fsp_only: { from: false, to: true }
		});
		expect(diffQueries(query, applyChange(query, { fsp_only: false }))).toEqual({});
	});

	it('«what if» another grade takes that grade of every specialization of the shortlist', () => {
		expect(whatIfQuery(query, { grade: 'senior' }).categories).toEqual([
			{ specialization: 'backend', grade: 'senior' }
		]);
		expect(
			whatIfQuery(query, { confirmed_skill: { skill_key: 'sql', required: true } }).filters.confirmed_skill_keys
		).toEqual(['sql']);
	});
});

describe('the blind comparison', () => {
	it('interleaves without repeats, alternating picks, and shuffles reproducibly by the seed', () => {
		const product = ['a', 'b', 'c', 'd'];
		const keywords = ['c', 'e', 'a', 'f'];
		const picks = interleave(product, keywords, 'seed-1');
		expect(new Set(picks.map((p) => p.id)).size).toBe(picks.length);
		expect(picks.map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		const credits = { product: 0, keywords: 0 };
		for (const pick of picks) credits[pick.team]++;
		expect(Math.abs(credits.product - credits.keywords)).toBeLessThanOrEqual(1);
		expect(interleave(product, keywords, 'seed-1')).toEqual(picks);
	});

	it('counts Precision@10 out of ten, the preference by credits and the share without FSP', () => {
		const card = (position: number, extra: Partial<EvaluationCard>): EvaluationCard => ({
			position,
			team: 'product',
			product_rank: null,
			keyword_rank: null,
			fsp: false,
			pseudonym: null,
			...extra
		});
		const cards = [
			card(1, { team: 'product', product_rank: 1, fsp: true }),
			card(2, { team: 'keywords', keyword_rank: 1, product_rank: 2 }),
			card(3, { team: 'keywords', keyword_rank: 2 })
		];
		expect(judge(cards, new Set([1, 2]))).toEqual({
			selected: 2,
			precision_at_10: { product: 0.2, keywords: 0.1 },
			preference: { product: 1, keywords: 1, winner: 'tie' },
			without_fsp_top10: { product: 0.5, keywords: 1 },
			overlap: 1
		});
	});
});
