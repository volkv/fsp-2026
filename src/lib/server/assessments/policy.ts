// `assessment_policy` (docs/domain.md, sections 10.3 and 13.8): the attempt limit, the pause between attempts and how
// long attempt artifacts are kept. Its values depend on the brief; the version in force is read at the moment of use.
import { and, desc, eq, lte } from 'drizzle-orm';
import { parsePolicyParams, type PolicyParams } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { productPolicies } from '$lib/server/db/schema';

export interface AssessmentPolicy {
	id: string;
	version: number;
	params: PolicyParams<'assessment_policy'>;
}

/**
 * The version in force at `at`. Absence is a deployment defect — the policies are published with the seed — not a
 * state of the request, so it fails loudly instead of falling back to a guess.
 */
export async function assessmentPolicy(executor: Executor, at: Date): Promise<AssessmentPolicy> {
	const [row] = await executor
		.select({ id: productPolicies.id, version: productPolicies.version, params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'assessment_policy'), lte(productPolicies.effectiveFrom, at)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	if (!row) throw new Error('no assessment_policy is in force');
	return { id: row.id, version: row.version, params: parsePolicyParams('assessment_policy', row.params) };
}

/** The date after which the content of an artifact created at `at` is cleared (domain 10.4). */
export function retentionUntil(policy: AssessmentPolicy, at: Date): string {
	const until = new Date(at.getTime() + policy.params.artifact_retention_days * 86_400_000);
	return until.toISOString().slice(0, 10);
}
