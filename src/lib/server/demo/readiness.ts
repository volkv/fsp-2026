// Whether the demo stand may be shown to a visitor: the seed of the batch the cast belongs to has finished. The seed
// marks the heroes as originals early on and fills their categories, needs and offers after; only its last step, the
// event `demo.seeded`, says the cast is whole (seed.ts). While it runs, a visitor is told when to come back: the
// reset that started the seed keeps in its event how long the previous seed took (reset.ts).
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { auditEvents } from '$lib/server/db/schema';
import { castOriginals, DemoCastMissing, type CastOriginals, type CastRole } from './cast';

/** The seed of the batch has finished: it writes `demo.seeded` last. */
export async function batchSeeded(executor: Executor, batch: string): Promise<boolean> {
	const [row] = await executor
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'demo.seeded'), sql`${auditEvents.details}->>'batch' = ${batch}`))
		.limit(1);
	return row !== undefined;
}

/** The originals of the cast (`castOriginals`) once the seed of their batch has finished; `DemoCastMissing` before. */
export async function seededCast(
	executor: Executor,
	crypto: FieldCrypto,
	roles: readonly CastRole[]
): Promise<CastOriginals> {
	const originals = await castOriginals(executor, crypto, roles);
	if (!(await batchSeeded(executor, originals.batch))) {
		throw new DemoCastMissing(`the demo batch ${originals.batch} is still being seeded`);
	}
	return originals;
}

const resetDetails = z.looseObject({ previous_seed_ms: z.int().nonnegative().nullable().optional() });

/**
 * Seconds until the running seed is expected to finish: the time the previous seed took, counted from the reset that
 * started this one. `null` — not known: no reset in the journal, no previous seed, or the seed runs longer than that.
 */
export async function seedRemainingSeconds(executor: Executor, now: Date): Promise<number | null> {
	const [reset] = await executor
		.select({ at: auditEvents.occurredAt, details: auditEvents.details })
		.from(auditEvents)
		.where(eq(auditEvents.action, 'demo.reset'))
		.orderBy(desc(auditEvents.occurredAt))
		.limit(1);
	if (!reset) return null;
	// A reset journalled before the events kept the time of the previous seed has no such key.
	const previous = resetDetails.parse(reset.details).previous_seed_ms;
	if (previous === undefined || previous === null) return null;
	const left = reset.at.getTime() + previous - now.getTime();
	return left > 0 ? Math.ceil(left / 1000) : null;
}
