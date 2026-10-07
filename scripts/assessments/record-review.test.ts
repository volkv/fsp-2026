// Recording reviews: only on the sources the reviewer saw, never by an author, every level rated; two models of
// different lineages admit the rubric and the ratings, a model of the same lineage replaces its earlier review.
import { describe, expect, it } from 'vitest';
import type { FamilyDescriptor } from '../../src/lib/server/assessments/contract/bank.ts';
import { familyProblems } from '../../src/lib/server/assessments/contract/validate.ts';
import { recordReview } from './record-review.ts';
import { currentSourceSha256, loadTree } from './tree.ts';

const family = loadTree().families.find((f) => f.key === 'be.db.filter-order');
if (!family) throw new Error('be.db.filter-order is not in the tree');
const source = currentSourceSha256(family);
/** The family before any judgement, whatever reviews the tree holds already. */
const unjudged: FamilyDescriptor = {
	...family.descriptor,
	levels: family.descriptor.levels.map((l) => ({ ...l, angoff: { ...l.angoff, ratings: [] } })),
	gates: { ...family.descriptor.gates, rubricReviews: [] }
};
const grades = family.descriptor.levels.map((l) => l.grade);

const review = (lineage: string, p: number, verdict: 'approved' | 'changes_requested' = 'approved') => ({
	family: family.key,
	sourceSha256: source,
	reviewer: { kind: 'model' as const, model: `model-${lineage}`, lineage },
	reviewedAt: '2026-10-06',
	verdict,
	remarks: verdict === 'approved' ? [] : ['условие неоднозначно'],
	angoff: grades.map((grade) => ({ grade, p }))
});

function record(descriptor: FamilyDescriptor, r: ReturnType<typeof review>): FamilyDescriptor {
	const result = recordReview(descriptor, source, r);
	if (typeof result === 'string') throw new Error(result);
	return result;
}

const pending = (d: FamilyDescriptor) => familyProblems(d, source).filter((p) => p.code !== 'defect');

describe('recordReview', () => {
	it('refuses a review made on other sources, by an author, or without every level', () => {
		expect(recordReview(unjudged, source, { ...review('a', 0.6), sourceSha256: '0'.repeat(64) })).toMatch(
			/review it again/
		);
		expect(
			recordReview(unjudged, source, {
				...review('a', 0.6),
				reviewer: { kind: 'model', model: 'claude-opus', lineage: 'anthropic' }
			})
		).toMatch(/author/);
		expect(recordReview(unjudged, source, { ...review('a', 0.6), angoff: [] })).toMatch(/rate every level/);
	});

	it('admits the rubric and the cut after two approvals of different lineages, the cut being their mean', () => {
		const once = record(unjudged, review('openai', 0.55));
		expect(pending(once).length).toBeGreaterThan(0);
		const twice = record(once, review('anthropic', 0.6));
		expect(familyProblems(twice, source)).toEqual([]);
		expect(twice.levels.map((l) => l.angoff.mean)).toEqual(grades.map(() => 0.6));
	});

	it('replaces the earlier review of the same lineage, and a request for changes blocks', () => {
		const first = record(unjudged, review('openai', 0.55));
		const again = record(first, review('openai', 0.7, 'changes_requested'));
		expect(again.gates.rubricReviews).toHaveLength(1);
		expect(again.levels[0]?.angoff.ratings).toHaveLength(1);
		const both = record(again, review('anthropic', 0.7));
		expect(familyProblems(both, source).some((p) => p.message.includes('requests changes'))).toBe(true);
	});
});
