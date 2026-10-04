// Small numbers of the operator's aggregates (docs/domain.md 7.4, 13.9): a count below the threshold of
// `catalog_policy` is shown as «< N», so a small group does not point at a person. Zero stays zero: it reveals nobody.
import { requiredPolicy } from '$lib/server/invitations/policies';
import type { Executor } from '$lib/server/db';

/** A count, or «fewer than `below`». The same shape as the cells of the career funnel. */
export type SmallCell = { value: number } | { below: number };

export function smallCell(value: number, threshold: number): SmallCell {
	return value > 0 && value < threshold ? { below: threshold } : { value };
}

/** The threshold in force: `catalog_policy.small_count_threshold`. */
export async function smallCountThreshold(executor: Executor, now: Date): Promise<number> {
	return (await requiredPolicy(executor, 'catalog_policy', now)).params.small_count_threshold;
}
