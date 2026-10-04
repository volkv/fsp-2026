// The erasure ledger applied again after a restore from a backup (docs/domain.md, section 19.2; case 39). The ledger
// lives in the same database as the data, so a restored dump brings back both the accounts deleted after it was taken
// and a ledger that no longer names them. Hence the order of a restore (docs/deploy.md, «Бэкап и восстановление»): the
// ledger is exported from the live database first, the dump is restored, and the export is replayed into it.
//
// Each entry goes the way the deletion went the first time. An account the restore brought back begins its deletion
// again with the system as the actor (`ledger_replay`: the processing consent lapses, memberships and invitations end,
// pools are counted again) and is purged at once, objects first, by the code of `account.purge`; an account whose
// deletion is pending is purged; a clone of a demo session goes with its whole session, as `demo.purge` removes it. An
// account the restore cannot delete (a staff role or the last owner of a company, restored from before the role was
// taken or the ownership passed) is named and left as it is: the operator decides, the command fails. The ledger keeps
// the moment of the person's request, not of the replay. A second replay of the same export changes nothing.
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '$lib/server/db';
import { erasureLedger, users } from '$lib/server/db/schema';
import { purgeDemoSession } from '$lib/server/demo/purge';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { purgeAccountNow } from '../purge';
import { beginAccountDeletion, type DeletionRefusal } from '../request';

export interface LedgerEntry {
	userId: string;
	requestedAt: Date;
	purgedAt: Date | null;
}

export interface ReplayDeps {
	db: Database;
	redis: Redis;
	store: ObjectStore;
	now: () => Date;
}

/** What the replay did with each entry. */
export type ReplayOutcome =
	/** The restore brought the account back: its deletion began again and it was purged. */
	| 'deleted_again'
	/** The deletion was pending in the restored data: the account was purged. */
	| 'purged'
	/** A clone of a demo session: the session went with everything it owns. */
	| 'demo_session_removed'
	/** The restored data already hold the account purged, or hold no account at all. */
	| 'already_erased';

export interface ReplayRefusal {
	userId: string;
	reason: Exclude<DeletionRefusal['reason'], 'already_requested'>;
	companyName?: string;
}

export interface ReplaySummary {
	entries: number;
	outcomes: Record<ReplayOutcome, number>;
	/** Accounts left as they are, each with the reason; a replay with any fails. */
	refused: ReplayRefusal[];
}

const entryLine = z.strictObject({
	user_id: z.uuid(),
	requested_at: z.iso.datetime({ offset: true }),
	purged_at: z.iso.datetime({ offset: true }).nullable()
});

/** The ledger as the export writes it: one JSON object per line, oldest request first. */
export function formatLedger(entries: readonly LedgerEntry[]): string {
	return entries
		.map((entry) =>
			JSON.stringify({
				user_id: entry.userId,
				requested_at: entry.requestedAt.toISOString(),
				purged_at: entry.purgedAt?.toISOString() ?? null
			})
		)
		.map((line) => `${line}\n`)
		.join('');
}

/** Reads an export; a line that is not an entry stops the replay before anything is touched, naming the line. */
export function parseLedger(text: string): LedgerEntry[] {
	const entries: LedgerEntry[] = [];
	text.split('\n').forEach((line, index) => {
		if (line.trim() === '') return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`line ${index + 1} of the ledger is not JSON`);
		}
		const parsed = entryLine.safeParse(value);
		if (!parsed.success)
			throw new Error(`line ${index + 1} of the ledger is not an entry: ${z.prettifyError(parsed.error)}`);
		entries.push({
			userId: parsed.data.user_id,
			requestedAt: new Date(parsed.data.requested_at),
			purgedAt: parsed.data.purged_at === null ? null : new Date(parsed.data.purged_at)
		});
	});
	return entries;
}

export async function exportLedger(db: Database): Promise<LedgerEntry[]> {
	return db
		.select({ userId: erasureLedger.userId, requestedAt: erasureLedger.requestedAt, purgedAt: erasureLedger.purgedAt })
		.from(erasureLedger)
		.orderBy(erasureLedger.requestedAt, erasureLedger.userId);
}

/**
 * The entry in the restored ledger with the moment of the person's request: the deletion begun again stamps the moment
 * of the replay, and a restore from before the request holds no entry at all.
 */
async function keepRequestMoment(db: Database, entry: LedgerEntry): Promise<void> {
	await db
		.insert(erasureLedger)
		.values({ userId: entry.userId, requestedAt: entry.requestedAt, purgedAt: entry.purgedAt })
		.onConflictDoUpdate({
			target: erasureLedger.userId,
			set: {
				requestedAt: sql`least(${erasureLedger.requestedAt}, excluded.requested_at)`,
				purgedAt: sql`greatest(${erasureLedger.purgedAt}, excluded.purged_at)`
			}
		});
}

async function replayEntry(
	deps: ReplayDeps,
	entry: LedgerEntry,
	requestId: string
): Promise<ReplayOutcome | ReplayRefusal> {
	const [user] = await deps.db
		.select({ status: users.status, demoSessionId: users.demoSessionId })
		.from(users)
		.where(eq(users.id, entry.userId));
	if (!user) {
		await keepRequestMoment(deps.db, entry);
		return 'already_erased';
	}
	if (user.demoSessionId !== null) {
		await purgeDemoSession(deps, user.demoSessionId, deps.now(), requestId);
		await keepRequestMoment(deps.db, entry);
		return 'demo_session_removed';
	}
	// A tombstone in the restored data was purged before the dump; a purge that keeps authority evidence waits in the
	// restored queue for the end of its period, as it did before.
	if (user.status === 'deleted') {
		await keepRequestMoment(deps.db, entry);
		return 'already_erased';
	}
	let outcome: ReplayOutcome = 'purged';
	if (user.status !== 'deletion_pending') {
		const refusal = await deps.db.transaction((tx) =>
			beginAccountDeletion(tx, {
				userId: entry.userId,
				cause: 'ledger_replay',
				actor: { kind: 'system' },
				requestId,
				at: deps.now()
			})
		);
		if (refusal !== null && refusal.reason !== 'already_requested') return { userId: entry.userId, ...refusal };
		outcome = 'deleted_again';
	}
	await purgeAccountNow(deps, entry.userId, requestId);
	await keepRequestMoment(deps.db, entry);
	return outcome;
}

/** Applies an exported ledger to the restored database; entries go one by one, a refused one does not stop the rest. */
export async function replayLedger(
	deps: ReplayDeps,
	entries: readonly LedgerEntry[],
	requestId: string
): Promise<ReplaySummary> {
	const summary: ReplaySummary = {
		entries: entries.length,
		outcomes: { deleted_again: 0, purged: 0, demo_session_removed: 0, already_erased: 0 },
		refused: []
	};
	for (const entry of entries) {
		const result = await replayEntry(deps, entry, requestId);
		if (typeof result === 'string') summary.outcomes[result] += 1;
		else summary.refused.push(result);
	}
	return summary;
}
