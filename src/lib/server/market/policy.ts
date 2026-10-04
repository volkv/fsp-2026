// Parameters of the category market (docs/domain.md, sections 7.4, 12.5, 13.8): the data window and the minimal sample
// of `market_policy`, and the small-count threshold of `catalog_policy` that the candidate indicator also obeys. The
// market is not computed without its policies: a threshold chosen here would be a decision nobody made.
import { and, desc, eq, lte } from 'drizzle-orm';
import { parsePolicyParams, type PolicyKind, type PolicyParams } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { productPolicies } from '$lib/server/db/schema';
import type { MarketInput } from './aggregate';

export class MarketPolicyMissing extends Error {
	override name = 'MarketPolicyMissing';
}

export interface MarketPolicy {
	windowDays: number;
	/** Minimal sample of each indicator; the candidate indicator never shows fewer than the catalog threshold. */
	threshold: Record<MarketInput['indicator'] | 'external_reference', number>;
	/** The catalog threshold itself: a candidate count below it is shown as «< N». */
	smallCountThreshold: number;
}

async function policyInForce<K extends PolicyKind>(executor: Executor, kind: K, now: Date): Promise<PolicyParams<K>> {
	const [row] = await executor
		.select({ params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, kind), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	if (!row) throw new MarketPolicyMissing(`no ${kind} is in force at ${now.toISOString()}`);
	return parsePolicyParams(kind, row.params);
}

export async function loadMarketPolicy(executor: Executor, now: Date): Promise<MarketPolicy> {
	const market = await policyInForce(executor, 'market_policy', now);
	const catalog = await policyInForce(executor, 'catalog_policy', now);
	return {
		windowDays: market.window_days,
		threshold: {
			candidate_expectations: Math.max(market.min_sample, catalog.small_count_threshold),
			vacancy_ranges: market.min_sample,
			external_reference: market.min_sample
		},
		smallCountThreshold: catalog.small_count_threshold
	};
}
