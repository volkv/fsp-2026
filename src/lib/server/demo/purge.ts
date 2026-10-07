// Removal of demo sessions (docs/domain.md, section 19.3): everything that belongs to a session — its clones and all
// they own, whoever created it, the visitor's own resume and every result derived from it included — goes in one
// transaction; the objects of its files leave the bucket and the sessions of its accounts are revoked after the commit.
// Originals, the background and other sessions are not touched: a row outside the session that still names one of its
// rows is a leak of the isolation and stops the removal of that session with the leak named, except the references
// the plan detaches: those lose the pointer. Waiting jobs of the removed rows are cancelled;
// the journal keeps its events and gets one more — the removal itself. Accounts whose person uploaded a resume of their own go to the erasure ledger, so that
// a restored backup removes them again.
import { and, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { revokeUserSessions } from '$lib/server/auth/sessions';
import type { Database, Transaction } from '$lib/server/db';
import { consentEvents, demoSessions, erasureLedger } from '$lib/server/db/schema';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { lastUseOf, redisDemoActivity } from './activity';
import { ownedDecision } from './clone-plan';
import { demoTerms } from './terms';
import {
	ident,
	inValues,
	insertionOrder,
	leafOwnerColumns,
	loadSchemaGraph,
	ownedClosure,
	ownedTables,
	type RowSet,
	type SchemaGraph
} from './graph';

export class DemoIsolationLeak extends Error {
	override name = 'DemoIsolationLeak';
	readonly leaks: readonly string[];

	constructor(sessionId: string, leaks: readonly string[]) {
		super(`demo session ${sessionId} is named from outside it: ${leaks.join(', ')}`);
		this.leaks = leaks;
	}
}

export interface PurgeDeps {
	db: Database;
	redis: Redis;
	store: ObjectStore;
}

export interface SessionPurge {
	sessionId: string;
	rowsRemoved: number;
	filesRemoved: number;
	jobsCancelled: number;
	referencesDetached: number;
}

/** The rows of a session: its roots and everything that belongs to them. */
export async function sessionRows(
	executor: Database | Transaction,
	graph: SchemaGraph,
	sessionId: string
): Promise<RowSet> {
	const seeds: RowSet = new Map();
	for (const table of ownedTables()) {
		if (ownedDecision(table)?.root !== true) continue;
		const rows = await executor.execute<{ id: string }>(
			sql`select id from ${ident(table)} where demo_session_id = ${sessionId}::uuid`
		);
		seeds.set(table, new Set(rows.map((row) => row.id)));
	}
	return ownedClosure(executor, graph, seeds);
}

/** Rows outside the session that name its rows: detached where the plan says so, a leak otherwise. */
async function referencesFromOutside(
	tx: Transaction,
	graph: SchemaGraph,
	rows: RowSet
): Promise<{ leaks: string[]; detached: number }> {
	const leaks: string[] = [];
	let detached = 0;
	for (const key of graph.keys) {
		const named = rows.get(key.references);
		if (!named || named.size === 0) continue;
		const kind = ownedDecision(key.table)?.edges[key.column];
		// A row that belongs to a row of the session is in the session itself (the closure followed the reference).
		if (kind === 'owner') continue;
		const outside = sql`${inValues(sql`t.${ident(key.column)}`, named, 'uuid')} and not ${removedWithSession(graph, key.table, rows)}`;
		if (kind === 'detach') {
			const cleared = await tx.execute<{ n: number }>(sql`
				with changed as (update ${ident(key.table)} t set ${ident(key.column)} = null where ${outside} returning 1)
				select count(*)::int as n from changed`);
			detached += cleared[0]?.n ?? 0;
			continue;
		}
		const [found] = await tx.execute<{ n: number }>(
			sql`select count(*)::int as n from ${ident(key.table)} t where ${outside}`
		);
		if ((found?.n ?? 0) > 0) leaks.push(`${key.table}.${key.column} ×${found?.n}`);
	}
	return { leaks, detached };
}

/** The condition «the row goes with the session» over a table (alias `t`). */
function removedWithSession(graph: SchemaGraph, table: string, rows: RowSet): SQL {
	if (ownedDecision(table) === null) return sql`false`;
	if (graph.idTables.has(table)) {
		const ids = rows.get(table);
		return ids && ids.size > 0 ? inValues(sql`t.id`, ids, 'uuid') : sql`false`;
	}
	const owned = leafOwnerColumns(graph, table).flatMap((owner) => {
		const ids = rows.get(owner.references);
		return ids && ids.size > 0 ? [inValues(sql`t.${ident(owner.column)}`, ids, 'uuid')] : [];
	});
	return owned.length > 0 ? sql`(${sql.join(owned, sql` or `)})` : sql`false`;
}

async function deleteRows(tx: Transaction, graph: SchemaGraph, table: string, rows: RowSet): Promise<number> {
	const condition = removedWithSession(graph, table, rows);
	// Append-only tables give up their rows to the retention role only (migration 0002).
	const guarded = graph.appendOnly.has(table);
	if (guarded) await tx.execute(sql`set local role fsp_retention`);
	const removed = await tx.execute<{ n: number }>(sql`
		with gone as (delete from ${ident(table)} t where ${condition} returning 1) select count(*)::int as n from gone`);
	if (guarded) await tx.execute(sql`reset role`);
	return removed[0]?.n ?? 0;
}

/**
 * Removes one demo session with everything it owns. `null` — the session is already gone (another worker removed it).
 * `requestId` — of the job that removes it, for the journal.
 */
export async function purgeDemoSession(
	deps: PurgeDeps,
	sessionId: string,
	now: Date,
	requestId: string
): Promise<SessionPurge | null> {
	const outcome = await deps.db.transaction(async (tx) => {
		const [session] = await tx
			.select({ id: demoSessions.id })
			.from(demoSessions)
			.where(eq(demoSessions.id, sessionId))
			.for('update');
		if (!session) return null;
		const graph = await loadSchemaGraph(tx);
		const rows = await sessionRows(tx, graph, sessionId);

		const { leaks, detached } = await referencesFromOutside(tx, graph, rows);
		if (leaks.length > 0) throw new DemoIsolationLeak(sessionId, leaks);

		const accounts = [...(rows.get('users') ?? [])];
		const fileIds = rows.get('files') ?? new Set<string>();
		const keys =
			fileIds.size === 0
				? []
				: await tx.execute<{ storage_key: string }>(
						sql`select storage_key from files t where ${inValues(sql`t.id`, fileIds, 'uuid')}`
					);
		// People who uploaded a resume of their own: their accounts go to the erasure ledger.
		const profiles = rows.get('candidates') ?? new Set<string>();
		const ownResume =
			profiles.size === 0
				? []
				: await tx
						.selectDistinct({ userId: consentEvents.signerUserId })
						.from(consentEvents)
						.where(
							and(
								eq(consentEvents.kind, 'demo_resume_upload'),
								inArray(consentEvents.subjectCandidateId, [...profiles])
							)
						);

		const ids = [...rows.values()].flatMap((set) => [...set]);
		const cancelled =
			ids.length === 0
				? []
				: await tx.execute<{ id: string }>(sql`
						update jobs set status = 'cancelled', finished_at = now()
						where status = 'queued' and exists (
							select 1 from jsonb_each_text(jobs.payload) p where ${inValues(sql`p.value`, ids, 'text')})
						returning id`);

		let rowsRemoved = 0;
		const order = insertionOrder(graph, ownedTables()).reverse();
		for (const table of order) rowsRemoved += await deleteRows(tx, graph, table, rows);

		const ledger = ownResume.flatMap((row) => (row.userId === null ? [] : [row.userId]));
		if (ledger.length > 0) {
			await tx
				.insert(erasureLedger)
				.values(ledger.map((userId) => ({ userId, requestedAt: now, purgedAt: now })))
				.onConflictDoNothing();
		}
		await tx.delete(demoSessions).where(eq(demoSessions.id, sessionId));
		await recordAuditEvent(tx, {
			action: 'demo.session_purged',
			outcome: 'success',
			actor: { kind: 'system' },
			object: { type: 'demo_session', id: sessionId },
			requestId,
			occurredAt: now,
			details: {
				rows_removed: rowsRemoved,
				files_removed: keys.length,
				jobs_cancelled: cancelled.length,
				references_detached: detached
			}
		});
		return {
			accounts,
			keys: keys.map((row) => row.storage_key),
			rowsRemoved,
			jobsCancelled: cancelled.length,
			referencesDetached: detached
		};
	});
	if (!outcome) return null;
	for (const key of outcome.keys) await deps.store.delete(key);
	for (const userId of outcome.accounts) await revokeUserSessions(deps.redis, userId);
	return {
		sessionId,
		rowsRemoved: outcome.rowsRemoved,
		filesRemoved: outcome.keys.length,
		jobsCancelled: outcome.jobsCancelled,
		referencesDetached: outcome.referencesDetached
	};
}

export interface ExpiredPurge {
	/** Sessions unused for the idle time of the terms, ended before their time and removed with the expired ones. */
	idle: string[];
	purged: SessionPurge[];
	/** Sessions whose removal stopped, with the reason; they are tried again on the next run. */
	failed: { sessionId: string; reason: string }[];
}

/** Ends now every live session nobody has used for the idle time of the terms of the stand (`terms.ts`). */
async function endIdleSessions(deps: PurgeDeps, now: Date): Promise<string[]> {
	const { idleMinutes } = await demoTerms(deps.db);
	const live = await deps.db
		.select({ id: demoSessions.id, createdAt: demoSessions.createdAt })
		.from(demoSessions)
		.where(gt(demoSessions.expiresAt, now));
	const used = await redisDemoActivity(deps.redis).lastUsed(live.map((session) => session.id));
	const idleSince = now.getTime() - idleMinutes * 60_000;
	const idle = live.filter((session) => lastUseOf(session, used).getTime() <= idleSince).map((session) => session.id);
	if (idle.length > 0) {
		await deps.db
			.update(demoSessions)
			.set({ expiresAt: now })
			.where(and(inArray(demoSessions.id, idle), gt(demoSessions.expiresAt, now)));
	}
	return idle;
}

/** Removes every session whose time is over or that stood idle, each in its own transaction. */
export async function purgeExpiredDemoSessions(deps: PurgeDeps, now: Date, requestId: string): Promise<ExpiredPurge> {
	const idle = await endIdleSessions(deps, now);
	const expired = await deps.db
		.select({ id: demoSessions.id })
		.from(demoSessions)
		.where(lte(demoSessions.expiresAt, now))
		.orderBy(demoSessions.expiresAt);
	const result: ExpiredPurge = { idle, purged: [], failed: [] };
	for (const { id } of expired) {
		try {
			const purged = await purgeDemoSession(deps, id, now, requestId);
			if (purged) result.purged.push(purged);
		} catch (error) {
			if (!(error instanceof DemoIsolationLeak)) throw error;
			result.failed.push({ sessionId: id, reason: error.message });
		}
	}
	await redisDemoActivity(deps.redis).forget(result.purged.map((purge) => purge.sessionId));
	return result;
}
