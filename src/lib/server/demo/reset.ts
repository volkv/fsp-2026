// Reset of the demonstration stand (docs/domain.md, section 19.2; counterexample 46): every table of the schema is
// emptied except the reference data — taxonomy, legal texts, policies, rulesets, the releases of the test bank,
// embedding spaces and evaluation runs. Each table of the database has a decision below; a table without one stops the
// reset (and its invariant test) instead of staying out of it. The real staff of the stand stay: their accounts, passwords,
// roles, email channels and notification settings (sessions go with Redis). Objects of the removed files leave the bucket, Redis
// (sessions, counters, caches) is emptied, and the simulator returns to its seeded dataset.
import { sql, type SQL } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Transaction } from '$lib/server/db';
import { haltJobs } from '$lib/server/jobs/queue';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';

type TableDecision =
	/** Reference data: published by the start-up scripts or measured, kept as it is. */
	| { kind: 'reference' }
	/** Demonstration data: every row goes. */
	| { kind: 'clear' }
	/** Demonstration data, except the rows the predicate keeps (a SQL condition over the table's own columns). */
	| { kind: 'clear_except'; keep: string; why: string }
	/**
	 * Demonstration data emptied by the `TRUNCATE` of the tables it refers to, except the rows the predicate keeps: they
	 * are set aside and put back after it. For a table that refers to one the reset can only truncate (an append-only
	 * journal), where keeping rows in place would hold that table back; a kept row must refer to kept rows only.
	 */
	| { kind: 'carry_over'; keep: string; why: string };

const reference: TableDecision = { kind: 'reference' };
const clear: TableDecision = { kind: 'clear' };

/**
 * Real staff of the stand: accounts outside the demo data (no seed batch, no demo session) that hold or held a staff
 * role — the bootstrap administrator from the environment and those an administrator gave roles to. Demo actors cannot
 * grant roles (`access/demo-actor.ts`), so every grant and revocation of a kept role points to a kept account.
 */
const REAL_ACCOUNT = 'seed_batch_id is null and demo_session_id is null';
const REAL_STAFF = `${REAL_ACCOUNT} and id in (select user_id from staff_roles)`;

/** The decision for every table of the schema. A new table is added here, or the reset and its test refuse to run. */
export const DEMO_RESET_PLAN: Readonly<Record<string, TableDecision>> = {
	// Reference data (domain 11, 6.2, 13.2, 13.8, 10.1, 16.2, 16.4).
	taxonomy_versions: reference,
	roles: reference,
	skills: reference,
	skill_aliases: reference,
	grades: reference,
	work_formats: reference,
	fsp_projection_rules: reference,
	fsp_strength_params: reference,
	fsp_level_rules: reference,
	categorization_rulesets: reference,
	match_rulesets: reference,
	receipt_templates: reference,
	salary_references: reference,
	pd_operators: reference,
	legal_documents: reference,
	product_policies: reference,
	bank_releases: reference,
	embedding_spaces: reference,
	search_settings: reference,
	eval_runs: reference,

	// Demo sessions and their clones (domain 19.3): the clones are rows of the tables below.
	demo_sessions: clear,
	demo_letters: clear,
	// Accounts, companies and access (domain 3, 4, 5).
	users: {
		kind: 'clear_except',
		keep: REAL_STAFF,
		why: 'the real staff of the stand are not demonstration data: the administrator keeps the stand running'
	},
	password_credentials: {
		kind: 'clear_except',
		keep: `user_id in (select id from users where ${REAL_STAFF})`,
		why: 'the password of a kept staff account'
	},
	email_tokens: clear,
	external_identities: clear,
	athlete_links: clear,
	staff_roles: {
		kind: 'clear_except',
		keep: `user_id in (select id from users where ${REAL_ACCOUNT})`,
		why: 'the roles of the real staff, with their history'
	},
	companies: clear,
	company_members: clear,
	company_verifications: clear,
	api_keys: clear,
	competition_partnerships: clear,
	// Consents, representatives and disclosures (domain 6).
	document_acceptances: clear,
	consent_events: clear,
	legal_representatives: clear,
	representations: clear,
	authority_checks: clear,
	disclosures: clear,
	// Candidates and their evidence (domain 7, 9, 10, 12).
	candidates: clear,
	candidate_company_blocks: clear,
	external_profiles: clear,
	source_facts: clear,
	claims: clear,
	skill_inferences: clear,
	experience_entries: clear,
	verification_receipts: clear,
	test_attempts: clear,
	test_items: clear,
	test_artifacts: clear,
	grade_decisions: clear,
	evidence_runs: clear,
	fsp_level_assignments: clear,
	candidate_categories: clear,
	assessment_objections: clear,
	candidate_surveys: clear,
	grade_declarations: clear,
	profile_experience_entries: clear,
	profile_suggestions: clear,
	category_attestations: clear,
	// Vacancies, matches, invitations and hiring (domain 13).
	vacancies: clear,
	match_scores: clear,
	market_snapshots: clear,
	hiring_needs: clear,
	invitations: clear,
	invitation_terms: clear,
	invitation_messages: clear,
	invitation_responses: clear,
	hiring_processes: clear,
	hiring_reports: clear,
	// Shortlists of needs (domain 13.10).
	shortlists: clear,
	shortlist_revisions: clear,
	shortlist_marks: clear,
	shortlist_evaluations: clear,
	salary_cohort_snapshots: clear,
	// Calls, requests of a confirmation, block results, applications (domain 13.11, 13.12, 13.5).
	company_challenges: clear,
	challenge_deliveries: clear,
	challenge_solutions: clear,
	confirmation_requests: clear,
	block_confirmations: clear,
	applications: clear,
	// Files, parsing, models (domain 15, 16).
	files: {
		kind: 'clear_except',
		keep: 'id in (select report_file_id from eval_runs where report_file_id is not null)',
		why: 'the report file of an evaluation run stays with the run'
	},
	resume_documents: clear,
	document_extractions: clear,
	ml_results: clear,
	embeddings: {
		kind: 'clear_except',
		keep: "owner_type = 'skill'",
		why: 'vectors of taxonomy skills are reference data of the embedding space, not demonstration data'
	},
	// Notifications, journal, integrations, jobs (domain 3.7, 17, 18).
	notification_channels: {
		kind: 'carry_over',
		keep: `kind = 'email' and user_id in (select id from users where ${REAL_STAFF})`,
		why: 'the email of a kept staff account; the channels refer to consent events, which go by truncation only, and an email channel rests on none'
	},
	telegram_link_tokens: clear,
	notification_preferences: {
		kind: 'clear_except',
		keep: `user_id in (select id from users where ${REAL_STAFF})`,
		why: 'the notification settings of a kept staff account'
	},
	notifications: clear,
	notification_deliveries: clear,
	audit_events: clear,
	erasure_ledger: clear,
	inbound_events: clear,
	jobs: {
		kind: 'clear_except',
		keep: "type = 'demo.reset'",
		why: 'the running reset owns its row, and a night whose reset ran must not get another one'
	},
	// Complaints of candidates and outgoing events of companies (domain 5.6, 5.7, 13.14).
	invitation_complaints: clear,
	event_subscriptions: clear,
	event_deliveries: clear,
	ats_links: clear
};

export class DemoResetPlanMismatch extends Error {
	override name = 'DemoResetPlanMismatch';
	readonly unplanned: readonly string[];
	readonly missing: readonly string[];

	constructor(unplanned: readonly string[], missing: readonly string[]) {
		super(
			[
				unplanned.length > 0 ? `tables without a reset decision: ${unplanned.join(', ')}` : null,
				missing.length > 0 ? `planned tables absent from the database: ${missing.join(', ')}` : null
			]
				.filter((part) => part !== null)
				.join('; ')
		);
		this.unplanned = unplanned;
		this.missing = missing;
	}
}

/** Tables of the `public` schema; partitions of the journal are part of their parent. */
export async function schemaTables(executor: Database | Transaction): Promise<string[]> {
	const rows = await executor.execute<{ name: string }>(sql`
		select c.relname as name
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
		order by c.relname`);
	return rows.map((row) => row.name);
}

/** Compares the plan with the tables of the database. */
export function compareWithPlan(tables: readonly string[]): { unplanned: string[]; missing: string[] } {
	const present = new Set(tables);
	return {
		unplanned: tables.filter((table) => !Object.hasOwn(DEMO_RESET_PLAN, table)),
		missing: Object.keys(DEMO_RESET_PLAN).filter((table) => !present.has(table))
	};
}

interface ForeignKey {
	from: string;
	to: string;
}

async function foreignKeys(tx: Transaction): Promise<ForeignKey[]> {
	const rows = await tx.execute<{ from_table: string; to_table: string }>(sql`
		select distinct src.relname as from_table, dst.relname as to_table
		from pg_constraint con
		join pg_class src on src.oid = con.conrelid
		join pg_class dst on dst.oid = con.confrelid
		join pg_namespace n on n.oid = src.relnamespace
		where con.contype = 'f' and n.nspname = 'public' and not src.relispartition`);
	return rows.map((row) => ({ from: row.from_table, to: row.to_table }));
}

interface ResetOrder {
	/** Emptied by one `TRUNCATE`: no table outside the set refers to a table in it. */
	truncate: string[];
	/** Emptied by `DELETE` after the truncation, children first, each with the rows its decision keeps. */
	delete: string[];
}

/**
 * Splits the cleared tables: `TRUNCATE` needs every referring table in the same statement, so a table referred to by a
 * kept table (or by a table that keeps some rows) and everything it holds back are deleted row by row instead.
 */
function resetOrder(keys: readonly ForeignKey[]): ResetOrder {
	const cleared = Object.entries(DEMO_RESET_PLAN).filter(([, decision]) => decision.kind !== 'reference');
	const truncate = new Set(
		cleared.filter(([, d]) => d.kind === 'clear' || d.kind === 'carry_over').map(([table]) => table)
	);
	const deleted = new Set(cleared.filter(([, d]) => d.kind === 'clear_except').map(([table]) => table));
	for (let changed = true; changed;) {
		changed = false;
		for (const { from, to } of keys) {
			if (truncate.has(to) && !truncate.has(from) && from !== to) {
				truncate.delete(to);
				deleted.add(to);
				changed = true;
			}
		}
	}
	// Children first: a table is deleted after every deleted table that refers to it.
	const order: string[] = [];
	const pending = new Set(deleted);
	while (pending.size > 0) {
		const ready = [...pending].filter((table) =>
			keys.every(({ from, to }) => to !== table || from === table || !pending.has(from))
		);
		if (ready.length === 0) throw new Error(`reference cycle among ${[...pending].join(', ')}`);
		for (const table of ready.sort()) {
			order.push(table);
			pending.delete(table);
		}
	}
	return { truncate: [...truncate].sort(), delete: order };
}

const ident = (name: string): SQL => sql.raw(`"${name.replaceAll('"', '""')}"`);

interface ResetDeps {
	db: Database;
	redis: Redis;
	store: ObjectStore;
	/** Control endpoints of the simulator (`POST /mock/reset`). */
	fspMock: { origin: string; controlToken: string };
	fetch?: typeof fetch;
	/** How long the reset waits for the running jobs, and how often it looks; `QUIET` by default. */
	quiet?: { waitMs: number; pollMs: number };
}

/**
 * The wait for the running jobs: a worker extends the lease of a job while it runs, so the wait has no natural end; it
 * is cut at the longest lease the registry gives a job (30 minutes, `embedding.reindex` and `retention.sweep`): a job
 * that runs longer is stuck rather than slow, and the reset names it.
 */
const QUIET = { waitMs: 30 * 60_000, pollMs: 1000 };

/** Jobs still ran when the wait of the reset ran out: nothing was emptied. */
export class DemoResetBusy extends Error {
	override name = 'DemoResetBusy';
	constructor(running: readonly { id: string; type: string }[], waitMs: number) {
		super(
			`the demo reset waited ${Math.round(waitMs / 1000)} s for running jobs and found them still running: ` +
				running.map((job) => `${job.type} ${job.id}`).join(', ')
		);
	}
}

interface ResetSummary {
	tablesCleared: number;
	rowsKept: number;
	filesRemoved: number;
}

interface Cleared {
	tablesCleared: number;
	rowsKept: number;
	storageKeys: string[];
}

/**
 * Empties the demonstration data in the caller's transaction, the queue stopped (`haltJobs`). Append-only tables refuse
 * `TRUNCATE` by a statement trigger; the reset switches those triggers off inside its transaction only (the change is
 * rolled back with any failure and is invisible to other sessions, which wait on the table lock).
 */
async function clearTables(
	tx: Transaction,
	journal: { requestId: string; trigger: DemoResetTrigger }
): Promise<Cleared> {
	const order = resetOrder(await foreignKeys(tx));
	// How long the last seed took, from the reset before it to its end: the journal goes, the estimate for visitors
	// waiting for the next seed stays in the new reset's event (readiness.ts).
	const [previous] = await tx.execute<{ ms: number }>(sql`
		select round(extract(epoch from s.occurred_at - r.occurred_at) * 1000)::int as ms
		from audit_events s
		cross join lateral (
			select occurred_at from audit_events
			where action = 'demo.reset' and occurred_at <= s.occurred_at
			order by occurred_at desc limit 1
		) r
		where s.action = 'demo.seeded'
		order by s.occurred_at desc limit 1`);
	// Keys of the objects whose rows go: read before the rows disappear.
	const files = DEMO_RESET_PLAN.files;
	if (files?.kind !== 'clear_except') throw new Error('the reset plan of files keeps the evaluation reports');
	const keys = await tx.execute<{ storage_key: string }>(
		sql`select storage_key from files where not (${sql.raw(files.keep)})`
	);

	const guarded = await tx.execute<{ table_name: string; trigger_name: string }>(sql`
		select c.relname as table_name, t.tgname as trigger_name
		from pg_trigger t join pg_class c on c.oid = t.tgrelid
		where not t.tgisinternal and t.tgname like '%\\_append\\_only\\_truncate'
			and c.relname in (${sql.join(
				order.truncate.map((table) => sql`${table}`),
				sql`, `
			)})`);
	for (const row of guarded) {
		await tx.execute(sql`alter table ${ident(row.table_name)} disable trigger ${ident(row.trigger_name)}`);
	}
	const carried = order.truncate.flatMap((table) => {
		const decision = DEMO_RESET_PLAN[table];
		return decision?.kind === 'carry_over' ? [{ table, keep: decision.keep }] : [];
	});
	for (const { table, keep } of carried) {
		await tx.execute(
			sql`create temporary table ${ident(`carried_${table}`)} on commit drop as
				select * from ${ident(table)} where ${sql.raw(keep)}`
		);
	}
	if (order.truncate.length > 0) {
		await tx.execute(sql`truncate table ${sql.join(order.truncate.map(ident), sql`, `)}`);
	}
	for (const row of guarded) {
		await tx.execute(sql`alter table ${ident(row.table_name)} enable trigger ${ident(row.trigger_name)}`);
	}

	let rowsKept = 0;
	for (const { table } of carried) {
		const back = await tx.execute(
			sql`insert into ${ident(table)} select * from ${ident(`carried_${table}`)} returning 1`
		);
		rowsKept += back.length;
	}
	for (const table of order.delete) {
		const decision = DEMO_RESET_PLAN[table];
		if (decision?.kind === 'clear_except') {
			await tx.execute(sql`delete from ${ident(table)} where not (${sql.raw(decision.keep)})`);
			const [kept] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${ident(table)}`);
			rowsKept += kept?.n ?? 0;
		} else {
			await tx.execute(sql`delete from ${ident(table)}`);
		}
	}
	const tablesCleared = order.truncate.length + order.delete.length;
	// The first event of the emptied journal.
	await recordAuditEvent(tx, {
		action: 'demo.reset',
		outcome: 'success',
		actor: { kind: 'system' },
		requestId: journal.requestId,
		details: {
			trigger: journal.trigger,
			tables_cleared: tablesCleared,
			rows_kept: rowsKept,
			files_removed: keys.length,
			previous_seed_ms: previous?.ms ?? null
		}
	});
	return { tablesCleared, rowsKept, storageKeys: keys.map((row) => row.storage_key) };
}

/** `clearTables` in the first transaction that finds no other job running; `DemoResetBusy` once the wait runs out. */
async function clearWhenQuiet(
	db: Database,
	journal: { requestId: string; trigger: DemoResetTrigger },
	quiet: { waitMs: number; pollMs: number }
): Promise<Cleared> {
	const waitUntil = Date.now() + quiet.waitMs;
	for (;;) {
		const step = await db.transaction(async (tx) => {
			const { running } = await haltJobs(tx, ['demo.reset']);
			return running.length > 0 ? { running, cleared: null } : { running, cleared: await clearTables(tx, journal) };
		});
		if (step.cleared !== null) return step.cleared;
		if (Date.now() >= waitUntil) throw new DemoResetBusy(step.running, quiet.waitMs);
		await new Promise((resolve) => setTimeout(resolve, quiet.pollMs));
	}
}

/** What started a reset, kept in the journal: the night's job, the start of the application, the command line. */
export type DemoResetTrigger = 'nightly' | 'startup' | 'manual';

/**
 * Empties the demonstration data in one transaction, once no other job runs: every attempt stops the queue, cancels the
 * waiting jobs (the reset removes them anyway) and, while some job still runs — the chain a stopped seed enqueued, a
 * calculation of the stand — commits the cancellations and waits for it instead of truncating tables that job's
 * transactions hold. Objects of the removed files and Redis are cleaned after the commit: a failure there is reported,
 * the database is already empty. A repeated reset finds nothing of the previous one running and does the same.
 */
export async function resetDemo(
	deps: ResetDeps,
	journal: { requestId: string; trigger: DemoResetTrigger }
): Promise<ResetSummary> {
	const { db } = deps;
	const plan = compareWithPlan(await schemaTables(db));
	if (plan.unplanned.length > 0 || plan.missing.length > 0) {
		throw new DemoResetPlanMismatch(plan.unplanned, plan.missing);
	}

	const outcome = await clearWhenQuiet(db, journal, deps.quiet ?? QUIET);
	for (const key of outcome.storageKeys) await deps.store.delete(key);
	await deps.redis.flushDb();
	const response = await (deps.fetch ?? fetch)(`${deps.fspMock.origin}/mock/reset`, {
		method: 'POST',
		headers: { authorization: `Bearer ${deps.fspMock.controlToken}` }
	});
	await response.body?.cancel();
	if (!response.ok) throw new Error(`the simulator refused its reset: status ${response.status}`);

	return { tablesCleared: outcome.tablesCleared, rowsKept: outcome.rowsKept, filesRemoved: outcome.storageKeys.length };
}
