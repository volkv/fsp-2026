// Records the review of a family by an independent reviewer (docs/domain.md, 10.2 and 10.8) into its descriptor: the
// verdict on the rubric and the reference with the remarks, and the blind Angoff rating of every level. A review is
// made on the sources of the review pack (`review-pack.ts`); when the family has changed since, the review is refused
// — the reviewer judged other sources — and so is a review the validator rejects, such as one by an author.
//
//   node scripts/assessments/record-review.ts <review.json> [<review.json> …]
//
// A file holds one review or a list of them:
//   { "family": "be.db.filter-order", "sourceSha256": "<from the pack>",
//     "reviewer": { "kind": "model", "model": "…", "lineage": "…" } | { "kind": "person", "name": "…" },
//     "reviewedAt": "YYYY-MM-DD", "verdict": "approved" | "changes_requested", "remarks": ["…"],
//     "angoff": [{ "grade": "intern", "p": 0.55 }, …] }
// A new review by the same reviewer (a model counts by its lineage) on the same sources replaces the earlier one.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import {
	reviewerIdentity,
	type AngoffRating,
	type FamilyDescriptor,
	type FamilyReview
} from '../../src/lib/server/assessments/contract/bank.ts';
import { GRADE_KEYS } from '../../src/lib/server/assessments/contract/catalog.ts';
import { familyProblems } from '../../src/lib/server/assessments/contract/validate.ts';
import { withRatings } from './reviews.ts';
import { currentSourceSha256, DESCRIPTOR_FILE, loadTree } from './tree.ts';

const text = z.string().trim().min(1);
const onAngoffScale = (p: number): boolean => Math.abs(p * 20 - Math.round(p * 20)) < 1e-9;

const reviewSchema = z.strictObject({
	family: text,
	sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
	reviewer: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('model'), model: text, lineage: text }),
		z.strictObject({ kind: z.literal('person'), name: text })
	]),
	reviewedAt: z.iso.date(),
	verdict: z.enum(['approved', 'changes_requested']),
	remarks: z.array(text),
	angoff: z.array(
		z.strictObject({
			grade: z.enum(GRADE_KEYS),
			p: z.number().min(0.05).max(0.95).refine(onAngoffScale, 'not on the 0.05 scale')
		})
	)
});
type Review = z.infer<typeof reviewSchema>;

const defectsOf = (descriptor: FamilyDescriptor, source: string): string[] =>
	familyProblems(descriptor, source)
		.filter((p) => p.code === 'defect')
		.map((p) => p.message);

/** The descriptor with the review recorded, or why it cannot be. */
export function recordReview(
	descriptor: FamilyDescriptor,
	currentSource: string,
	review: Review
): FamilyDescriptor | string {
	const where = `${review.family} by ${reviewerIdentity(review.reviewer)}`;
	if (review.sourceSha256 !== currentSource)
		return `${where}: made on sources ${review.sourceSha256.slice(0, 12)}, the family is now ${currentSource.slice(0, 12)} — review it again`;
	const levels = descriptor.levels.map((l) => l.grade);
	const rated = review.angoff.map((a) => a.grade);
	if (rated.length !== levels.length || levels.some((g) => !rated.includes(g)))
		return `${where}: rates ${rated.join(', ') || 'no level'}, the family has ${levels.join(', ')} — rate every level once`;
	const identity = reviewerIdentity(review.reviewer);
	const entry: FamilyReview = {
		reviewer: review.reviewer,
		reviewedAt: review.reviewedAt,
		verdict: review.verdict,
		remarks: review.remarks,
		sourceSha256: currentSource
	};
	const recorded: FamilyDescriptor = {
		...descriptor,
		levels: descriptor.levels.map((level) => {
			const p = review.angoff.find((a) => a.grade === level.grade)?.p;
			if (p === undefined) throw new Error(`${where}: no rating of ${level.grade}`);
			const rating: AngoffRating = {
				rater: review.reviewer,
				p,
				ratedAt: review.reviewedAt,
				sourceSha256: currentSource
			};
			const others = level.angoff.ratings.filter(
				(r) => r.sourceSha256 === currentSource && reviewerIdentity(r.rater) !== identity
			);
			return { ...level, angoff: withRatings(level.angoff, [...others, rating]) };
		}),
		gates: {
			...descriptor.gates,
			rubricReviews: [
				...descriptor.gates.rubricReviews.filter(
					(r) => r.sourceSha256 === currentSource && reviewerIdentity(r.reviewer) !== identity
				),
				entry
			]
		}
	};
	// What the review itself brings in is refused: an author judging the family, a rating off the scale. Its verdict is
	// not: a request for changes is a defect by design, so the check runs as if the review approved.
	const asApproval: FamilyDescriptor = {
		...recorded,
		gates: {
			...recorded.gates,
			rubricReviews: recorded.gates.rubricReviews.map((r) => (r === entry ? { ...r, verdict: 'approved' as const } : r))
		}
	};
	const before = new Set(defectsOf(descriptor, currentSource));
	const added = defectsOf(asApproval, currentSource).filter((p) => !before.has(p));
	return added.length > 0 ? `${where}: ${added.join('; ')}` : recorded;
}

async function main(files: readonly string[]): Promise<number> {
	if (files.length === 0) throw new Error('usage: record-review.ts <review.json> [<review.json> …]');
	const reviews: Review[] = files.flatMap((file) => {
		const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
		return z.array(reviewSchema).parse(Array.isArray(raw) ? raw : [raw]);
	});
	const { families, problems } = loadTree();
	if (problems.length > 0) throw new Error(problems.join('\n'));
	let refused = 0;
	for (const review of reviews) {
		const family = families.find((f) => f.key === review.family);
		if (!family) {
			console.log(`refused ${review.family}: no such family`);
			refused += 1;
			continue;
		}
		const recorded = recordReview(family.descriptor, currentSourceSha256(family), review);
		if (typeof recorded === 'string') {
			console.log(`refused ${recorded}`);
			refused += 1;
			continue;
		}
		const path = join(family.dir, DESCRIPTOR_FILE);
		const options = (await resolveConfig(path)) ?? {};
		writeFileSync(path, await format(JSON.stringify(recorded), { ...options, filepath: path }));
		family.descriptor = recorded;
		const gaps = recorded.levels
			.map((l) => ({ grade: l.grade, ps: l.angoff.ratings.map((r) => r.p) }))
			.filter((l) => l.ps.length > 1 && Math.max(...l.ps) - Math.min(...l.ps) > 0.2 + 1e-9)
			.map((l) => `${l.grade} (${l.ps.join(' / ')})`);
		console.log(
			`recorded ${review.family}: ${review.verdict} by ${reviewerIdentity(review.reviewer)}, ${review.remarks.length} remarks` +
				(gaps.length ? `; ratings differ by more than 0.2 — second round: ${gaps.join(', ')}` : '')
		);
	}
	return refused > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
