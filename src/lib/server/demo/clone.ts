// Cloning the scenario cast into a new demo session (docs/domain.md, section 19.3). The session gets its own copy of
// every account, profile and company of the cast together with everything that belongs to them — facts, claims,
// categories, receipts, resumes and their files, vectors, matches, vacancies, invitations with their terms and
// answers, hiring processes, disputes, representatives' consents, notifications — so that what one visitor does
// happens to their copies only. Rows that already belong to another demo session (a row naming an original and a
// clone of another session) are not copied. Reference data, the journal and the rows of the background — other candidates, other
// companies, external vacancies — stay shared.
//
// Copies are made in the database: every row is read as JSON, every identifier of a copied row inside it — keys,
// references, identifiers inside JSON and text (storage keys, record references) — is replaced by the copy's, and the
// row is inserted back. Identifiers are UUIDs, unique across the schema, so a replaced value is always the same object.
import { randomBytes } from 'node:crypto';
import { eq, gt, inArray, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { newSecret, sha256Hex } from '$lib/server/auth/secrets';
import { base32 } from '$lib/server/crypto/encoding';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Transaction } from '$lib/server/db';
import { demoSessions, vacancies } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { enqueueMatchRefresh } from '$lib/server/vacancies/derivations';
import { DEMO_EVICTABLE_MINUTES, lastUseOf, type DemoActivity } from './activity';
import { castOriginals, castRoles, cloneEmail } from './cast';
import { ownedDecision } from './clone-plan';
import type { SeedData } from './data';
import {
	ident,
	inValues,
	insertionOrder,
	leafOwnerColumns,
	loadSchemaGraph,
	ownedClosure,
	ownedTables,
	ownersOf,
	sessionOwned,
	type RowSet,
	type SchemaGraph
} from './graph';

/**
 * Demo sessions alive at once. A visitor beyond them takes the place of the session quiet for the longest time, when it
 * has been quiet for `DEMO_EVICTABLE_MINUTES`; with every session in use the visitor is asked to come back later.
 */
export const MAX_LIVE_SESSIONS = 60;

/** Rows per insert statement. */
const CHUNK = 1000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export class DemoSessionsExhausted extends Error {
	override name = 'DemoSessionsExhausted';
}

export interface CloneDeps {
	db: Database;
	crypto: FieldCrypto;
	store: ObjectStore;
	activity: DemoActivity;
	now: () => Date;
}

export interface OpenedSession {
	sessionId: string;
	/** Handed to the visitor's browser; only its hash is stored. */
	joinToken: string;
	expiresAt: Date;
	/** The clone account of each role of the cast. */
	clones: Map<string, string>;
	rowsCopied: number;
	filesCopied: number;
	/** The quiet session ended to make room for this one. */
	evicted: string | null;
}

/**
 * Makes room for one more session when the stand holds `MAX_LIVE_SESSIONS` live ones: the session quiet for the longest
 * time ends now, when it has been quiet for `DEMO_EVICTABLE_MINUTES` (its sign-in sessions stop at their next request,
 * `demo.purge` removes its rows). `null` — there was room; the refusal when every session is in use.
 */
async function makeRoom(tx: Transaction, activity: DemoActivity, now: Date): Promise<string | null> {
	const live = await tx
		.select({ id: demoSessions.id, createdAt: demoSessions.createdAt })
		.from(demoSessions)
		.where(gt(demoSessions.expiresAt, now));
	if (live.length < MAX_LIVE_SESSIONS) return null;
	const used = await activity.lastUsed(live.map((session) => session.id));
	const quietest = live
		.map((session) => ({ id: session.id, lastUse: lastUseOf(session, used) }))
		.sort((a, b) => a.lastUse.getTime() - b.lastUse.getTime())[0];
	if (!quietest || quietest.lastUse.getTime() > now.getTime() - DEMO_EVICTABLE_MINUTES * 60_000) {
		throw new DemoSessionsExhausted(`${live.length} demo sessions are open and in use`);
	}
	await tx.update(demoSessions).set({ expiresAt: now }).where(eq(demoSessions.id, quietest.id));
	return quietest.id;
}

/** `\x…` — the text form of `bytea` that `jsonb_populate_record` reads. */
const byteaText = (bytes: Uint8Array) => `\\x${Buffer.from(bytes).toString('hex')}`;

interface CopyContext {
	tx: Transaction;
	graph: SchemaGraph;
	sessionId: string;
	crypto: FieldCrypto;
	/** Original id → id of the copy. */
	ids: Map<string, string>;
	/** Original address of each copied account. */
	emails: Map<string, string>;
	/** Storage keys: original → copy. */
	objects: Map<string, string>;
}

const remap = (ctx: CopyContext, text: string) => text.replace(UUID, (id) => ctx.ids.get(id) ?? id);

/** Values set on the copy of a row besides the replaced identifiers. */
function overridesOf(
	ctx: CopyContext,
	table: string,
	original: Record<string, unknown>,
	copy: Record<string, unknown>
): Record<string, unknown> {
	switch (table) {
		case 'users': {
			const email = ctx.emails.get(String(original.id));
			if (email === undefined) throw new Error(`user ${String(original.id)} of the cast has no address`);
			const address = cloneEmail(email, ctx.sessionId);
			return {
				email_enc: byteaText(ctx.crypto.encrypt(address, 'users.email')),
				email_hmac: ctx.crypto.lookupHmac('email', address),
				demo_session_id: ctx.sessionId,
				last_login_at: null,
				locked_until: null
			};
		}
		case 'candidates':
			return { demo_session_id: ctx.sessionId, demo_original: false };
		case 'athlete_links':
			// The link of the session: FSP shows as linked in the clone's profile, while the one active link of the
			// athlete outside sessions stays the original's and synchronization with FSP never reaches the clone.
			return { demo_session_id: ctx.sessionId };
		case 'companies':
			// The clone is the same company within the session: what was given to the original counts for it (the
			// consents of the background to the pool of a partner), and it keeps the taxpayer number, unique within the
			// session as outside sessions.
			return { demo_session_id: ctx.sessionId, demo_original: false, demo_clone_of: original.id };
		case 'vacancy_claims':
			// The claim holds within the place of its company (domain 13.3): the clone's claim is of the session.
			return { demo_session_id: ctx.sessionId };
		case 'external_identities':
			// The identity within the session: FSP ID finds the clone there and refuses it (the cast is entered at
			// `/demo`), while outside sessions the identity stays the original's.
			return { demo_session_id: ctx.sessionId };
		case 'verification_receipts':
		case 'category_attestations':
			return { handle: base32(randomBytes(16)) };
		case 'ml_results':
			// The job wrote the original's result; the copy is nobody's job.
			return { job_id: null };
		case 'notifications':
			return copy.dedup_key === original.dedup_key
				? { dedup_key: `${String(original.dedup_key)}:demo:${ctx.sessionId}` }
				: {};
		case 'files': {
			if (copy.storage_key === original.storage_key) {
				throw new Error(`storage key of file ${String(original.id)} does not carry its id`);
			}
			ctx.objects.set(String(original.storage_key), String(copy.storage_key));
			return {};
		}
		default:
			return {};
	}
}

async function insertCopies(ctx: CopyContext, table: string, rows: string[]): Promise<void> {
	for (let start = 0; start < rows.length; start += CHUNK) {
		const chunk = rows.slice(start, start + CHUNK);
		const copies: string[] = [];
		const overrides: Record<string, Record<string, unknown>> = {};
		for (const text of chunk) {
			const copied = remap(ctx, text);
			const original = JSON.parse(text) as Record<string, unknown>;
			const copy = JSON.parse(copied) as Record<string, unknown>;
			const extra = overridesOf(ctx, table, original, copy);
			if (Object.keys(extra).length > 0) {
				if (typeof copy.id !== 'string') throw new Error(`${table} has values to set but no id`);
				overrides[copy.id] = extra;
			}
			copies.push(copied);
		}
		// The rows are passed as their JSON text: numbers and bytes reach the database exactly as they were read.
		await ctx.tx.execute(sql`
			insert into ${ident(table)}
			select (jsonb_populate_record(null::${ident(table)},
				e.value || coalesce(${JSON.stringify(overrides)}::jsonb -> (e.value ->> 'id'), '{}'::jsonb))).*
			from jsonb_array_elements(${`[${copies.join(',')}]`}::jsonb) e`);
	}
}

/** JSON text of the rows of a table to copy. */
async function rowsToCopy(
	ctx: CopyContext,
	table: string,
	set: RowSet,
	memo: Map<string, Map<string, boolean>>
): Promise<string[]> {
	if (ctx.graph.idTables.has(table)) {
		const ids = set.get(table);
		if (!ids || ids.size === 0) return [];
		const rows = await ctx.tx.execute<{ row: string }>(
			sql`select to_jsonb(t)::text as row from ${ident(table)} t where ${inValues(sql`t.id`, ids, 'uuid')}`
		);
		return rows.map((r) => r.row);
	}
	// A leaf without id: the rows one of whose owners is copied and none belongs to another session.
	const owners = leafOwnerColumns(ctx.graph, table);
	const conditions = owners.flatMap((owner) => {
		const ids = set.get(owner.references);
		return ids && ids.size > 0 ? [inValues(sql`t.${ident(owner.column)}`, ids, 'uuid')] : [];
	});
	if (conditions.length === 0) return [];
	const rows = await ctx.tx.execute<Record<string, string | null> & { row: string }>(sql`
		select to_jsonb(t)::text as row, ${sql.join(
			owners.map((owner) => sql`t.${ident(owner.column)}::text as ${ident(`o_${owner.column}`)}`),
			sql`, `
		)}
		from ${ident(table)} t where ${sql.join(conditions, sql` or `)}`);
	const outside = new Map<string, Set<string>>();
	for (const row of rows) {
		for (const owner of owners) {
			const value = row[`o_${owner.column}`];
			if (value && !set.get(owner.references)?.has(value)) {
				let list = outside.get(owner.references);
				if (!list) outside.set(owner.references, (list = new Set()));
				list.add(value);
			}
		}
	}
	const foreign = new Map<string, Set<string>>();
	for (const [parent, ids] of outside) foreign.set(parent, await sessionOwned(ctx.tx, ctx.graph, memo, parent, ids));
	return rows
		.filter((row) =>
			owners.every((owner) => {
				const value = row[`o_${owner.column}`];
				return !value || !foreign.get(owner.references)?.has(value);
			})
		)
		.map((row) => row.row);
}

/** Copies the objects of the copied files; on failure the copies made so far are removed and the error goes on. */
async function copyObjects(store: ObjectStore, objects: Map<string, string>): Promise<void> {
	const made: string[] = [];
	try {
		for (const [from, to] of objects) {
			const object = await store.get(from);
			if (!object) throw new Error(`object ${from} of a demo original is missing from the bucket`);
			const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
			if (bytes.byteLength !== object.sizeBytes) throw new Error(`object ${from} was read short`);
			await store.put(to, bytes, object.contentType);
			made.push(to);
		}
	} catch (error) {
		await removeObjects(store, made, error);
		throw error;
	}
}

/** Removes objects after a failure; a failure to remove is reported together with the original one. */
async function removeObjects(store: ObjectStore, keys: readonly string[], cause: unknown): Promise<void> {
	const failures: unknown[] = [];
	for (const key of keys) {
		try {
			await store.delete(key);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0)
		throw new AggregateError([cause, ...failures], 'demo objects were not removed after a failure');
}

/**
 * Opens a demo session: the session row, the clones of the whole cast and copies of their files, and the event in the
 * journal. The rows are committed together; the objects are copied before the commit and removed again when it fails.
 */
export async function openDemoSession(
	deps: CloneDeps,
	data: SeedData,
	terms: { sessionHours: number },
	meta: RequestMeta
): Promise<OpenedSession> {
	const roles = castRoles(data);
	const joinToken = newSecret();
	const sessionId = uuidv7();
	const now = deps.now();
	const expiresAt = new Date(now.getTime() + terms.sessionHours * 3_600_000);
	const objects = new Map<string, string>();
	try {
		return await deps.db.transaction(async (tx) => {
			// One opening at a time: the limit of live sessions is counted and kept under the lock.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext('demo.open_session'))`);
			const evicted = await makeRoom(tx, deps.activity, now);
			const graph = await loadSchemaGraph(tx);
			const originals = await castOriginals(tx, deps.crypto, roles);
			await tx.insert(demoSessions).values({
				id: sessionId,
				joinTokenSha256: sha256Hex(joinToken),
				seedBatchId: originals.batch,
				expiresAt,
				createdAt: now
			});

			const memo = new Map<string, Map<string, boolean>>();
			const seeds: RowSet = new Map([
				['users', new Set([...originals.users.values()].map((user) => user.id))],
				['companies', new Set(originals.companyIds)],
				['candidates', new Set(originals.candidateIds)]
			]);
			const set = await ownedClosure(tx, graph, seeds, async (table, found) => {
				// A row found through an original is not copied when another of its owners belongs to a demo session.
				const owners = await ownersOf(tx, graph, table, found);
				const outside = new Map<string, Set<string>>();
				for (const list of owners.values()) {
					for (const owner of list) {
						let ids = outside.get(owner.table);
						if (!ids) outside.set(owner.table, (ids = new Set()));
						ids.add(owner.id);
					}
				}
				const foreign = new Map<string, Set<string>>();
				for (const [parent, ids] of outside) foreign.set(parent, await sessionOwned(tx, graph, memo, parent, ids));
				return new Set(
					[...found].filter((id) => (owners.get(id) ?? []).every((owner) => !foreign.get(owner.table)?.has(owner.id)))
				);
			});

			const ctx: CopyContext = {
				tx,
				graph,
				sessionId,
				crypto: deps.crypto,
				ids: new Map(),
				emails: new Map(),
				objects
			};
			const copied = ownedTables().filter((table) => ownedDecision(table)?.copy === true);
			for (const table of copied) {
				for (const id of set.get(table) ?? []) ctx.ids.set(id, uuidv7());
			}
			const emailOf = new Map(roles.map((role) => [role.key, role.email]));
			for (const [key, user] of originals.users) ctx.emails.set(user.id, emailOf.get(key) ?? '');

			let rowsCopied = 0;
			for (const table of insertionOrder(graph, copied)) {
				const rows = await rowsToCopy(ctx, table, set, memo);
				await insertCopies(ctx, table, rows);
				rowsCopied += rows.length;
			}
			// The pool of a copied vacancy is counted again within the session: its clones in place of the originals.
			const copiedVacancies = [...(set.get('vacancies') ?? [])].flatMap((id) => {
				const copy = ctx.ids.get(id);
				return copy === undefined ? [] : [copy];
			});
			if (copiedVacancies.length > 0) {
				const revisions = await tx
					.select({ id: vacancies.id, revision: vacancies.revision })
					.from(vacancies)
					.where(inArray(vacancies.id, copiedVacancies));
				for (const vacancy of revisions) {
					await enqueueMatchRefresh(tx, vacancy.id, vacancy.revision, { kind: 'system', id: 'demo-session' });
				}
			}
			await copyObjects(deps.store, objects);
			// The visitor is not signed in yet: the opening is journaled as anonymous, with the address of the request.
			await recordAuditEvent(tx, {
				action: 'demo.session_opened',
				outcome: 'success',
				actor: { kind: 'anonymous' },
				object: { type: 'demo_session', id: sessionId },
				requestId: meta.requestId,
				ip: meta.ip,
				userAgent: meta.userAgent,
				occurredAt: now,
				details: {
					seed_batch: originals.batch,
					rows_copied: rowsCopied,
					files_copied: objects.size,
					expires_at: expiresAt.toISOString(),
					...(evicted === null ? {} : { evicted_session: evicted })
				}
			});

			const clones = new Map<string, string>();
			for (const [key, user] of originals.users) {
				const clone = ctx.ids.get(user.id);
				if (!clone) throw new Error(`the account of ${key} was not cloned`);
				clones.set(key, clone);
			}
			return { sessionId, joinToken, expiresAt, clones, rowsCopied, filesCopied: objects.size, evicted };
		});
	} catch (error) {
		// The transaction is rolled back; objects copied before the failure of the commit go as well.
		if (objects.size > 0) await removeObjects(deps.store, [...objects.values()], error);
		throw error;
	}
}
