// Product policies of invitations, hiring and reminders (domain 13.8). Records created under a policy keep a reference
// to its version: a later version changes neither sent terms nor open processes.
import { and, desc, eq, lte } from 'drizzle-orm';
import { parsePolicyParams, type PolicyParams } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { productPolicies } from '$lib/server/db/schema';

type Kind = 'invitation_policy' | 'hiring_policy' | 'notification_policy' | 'catalog_policy' | 'challenge_policy';

export interface PolicyVersion<K extends Kind> {
	id: string;
	version: number;
	params: PolicyParams<K>;
}

/** The version in force at `at`; `null` — none is published. */
export async function currentPolicy<K extends Kind>(
	executor: Executor,
	kind: K,
	at: Date
): Promise<PolicyVersion<K> | null> {
	const [row] = await executor
		.select({ id: productPolicies.id, version: productPolicies.version, params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, kind), lte(productPolicies.effectiveFrom, at)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	return row ? { id: row.id, version: row.version, params: parsePolicyParams(kind, row.params) } : null;
}

/**
 * The version in force, required: invitations and hiring processes cannot exist without their rules. Absence is a
 * deployment defect (the policies are published with the seed), not a state of the request.
 */
export async function requiredPolicy<K extends Kind>(executor: Executor, kind: K, at: Date): Promise<PolicyVersion<K>> {
	const policy = await currentPolicy(executor, kind, at);
	if (!policy) throw new Error(`no ${kind} is in force`);
	return policy;
}

/** The version a record refers to. */
export async function policyById<K extends Kind>(executor: Executor, kind: K, id: string): Promise<PolicyVersion<K>> {
	const [row] = await executor
		.select({ id: productPolicies.id, version: productPolicies.version, params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.id, id), eq(productPolicies.kind, kind)));
	if (!row) throw new Error(`policy ${id} of kind ${kind} does not exist`);
	return { id: row.id, version: row.version, params: parsePolicyParams(kind, row.params) };
}
