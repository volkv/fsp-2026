// Age on the sign-up path (domain 7.2, 7.3): a self-declared birth date decides whether a candidate profile opens.
import { and, desc, eq, lte } from 'drizzle-orm';
import { parsePolicyParams } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { productPolicies } from '$lib/server/db/schema';
import { ageBand, type AgeBand } from '$lib/server/visibility/age';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OLDEST_YEARS = 120;

/** A real calendar date `YYYY-MM-DD` not in the future and not absurdly old; `null` otherwise. */
export function parseBirthDate(value: string, now: Date): string | null {
	const match = DATE.exec(value);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	if (date.getTime() > now.getTime()) return null;
	if (now.getUTCFullYear() - year > OLDEST_YEARS) return null;
	return value;
}

/** The date `years` after `date`; 29 February moves to 1 March in a non-leap year. */
export function addYears(date: string, years: number): string {
	const match = DATE.exec(date);
	if (!match) throw new Error('date must be YYYY-MM-DD');
	const shifted = new Date(Date.UTC(Number(match[1]) + years, Number(match[2]) - 1, Number(match[3])));
	return shifted.toISOString().slice(0, 10);
}

export type AgeDecision =
	| { kind: 'eligible'; band: Exclude<AgeBand, 'unknown' | 'under_14'> }
	/** No candidate profile; the birth date is replaced by the day it becomes possible (domain 7.3). */
	| { kind: 'ineligible'; eligibleFrom: string };

/**
 * Under 14 — refusal until the 14th birthday. When the minor policy is off, 14–17 are treated the same way until the
 * 18th birthday (domain 7.3).
 */
export function decideAge(birthDate: string, now: Date, minorsAllowed: boolean): AgeDecision {
	const band = ageBand({ birthDate, precision: 'day', status: 'unverified' }, now);
	if (band === 'unknown') throw new Error('a day-precision unverified birth date always has a band');
	if (band === 'under_14') return { kind: 'ineligible', eligibleFrom: addYears(birthDate, 14) };
	if (band !== 'adult' && !minorsAllowed) return { kind: 'ineligible', eligibleFrom: addYears(birthDate, 18) };
	return { kind: 'eligible', band };
}

/**
 * `minor_policy.enabled` in force. Without a published policy the product runs as designed for the MVP, with
 * candidates of 14–17 in the protected mode (domain 7.3, 20); the policy exists to switch that off.
 */
export async function minorsAllowed(executor: Executor, now: Date): Promise<boolean> {
	const [row] = await executor
		.select({ params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'minor_policy'), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	return row ? parsePolicyParams('minor_policy', row.params).enabled : true;
}
