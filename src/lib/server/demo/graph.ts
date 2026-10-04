// The rows a demo session owns, found over the owner references of the clone plan (clone-plan.ts): downwards — every
// row that belongs to a set of rows; upwards — whether a row belongs to some demo session. Rows are named by their
// `id`; owned tables without one are leaves that nothing refers to, handled by the predicate over their owners.
import { sql, type SQL } from 'drizzle-orm';
import type { Database, Transaction } from '$lib/server/db';
import {
	compareWithClonePlan,
	DEMO_CLONE_PLAN,
	isPlanComplete,
	ownedDecision,
	planProblems,
	type ClonePlanMismatch,
	type ForeignKeyColumn,
	type OwnedDecision
} from './clone-plan';
import { schemaTables } from './reset';

type Executor = Database | Transaction;

/** Row ids by table. */
export type RowSet = Map<string, Set<string>>;

export class DemoClonePlanMismatch extends Error {
	override name = 'DemoClonePlanMismatch';
	readonly mismatch: ClonePlanMismatch;

	constructor(mismatch: ClonePlanMismatch) {
		super(planProblems(mismatch).join('; '));
		this.mismatch = mismatch;
	}
}

export interface SchemaGraph {
	keys: ForeignKeyColumn[];
	/** Owned tables with an `id` column. */
	idTables: Set<string>;
	/** Tables whose rows the retention role deletes (append-only guards). */
	appendOnly: Set<string>;
}

export const ident = (name: string): SQL => sql.raw(`"${name.replaceAll('"', '""')}"`);

/** `expr in (…)` over a set of values passed as one JSON parameter; `cast` — the SQL type of the values. */
export function inValues(expr: SQL, values: Iterable<string>, cast: 'uuid' | 'text'): SQL {
	return sql`${expr} in (select (jsonb_array_elements_text(${JSON.stringify([...values])}::jsonb))::${sql.raw(cast)})`;
}

export async function foreignKeyColumns(executor: Executor): Promise<ForeignKeyColumn[]> {
	const rows = await executor.execute<{
		table: string;
		columns: string[];
		references: string;
		deferrable: boolean;
	}>(sql`
		select src.relname as "table", dst.relname as "references", con.condeferrable as deferrable,
			array(select a.attname::text from unnest(con.conkey) k join pg_attribute a
				on a.attrelid = con.conrelid and a.attnum = k) as columns
		from pg_constraint con
		join pg_class src on src.oid = con.conrelid
		join pg_class dst on dst.oid = con.confrelid
		join pg_namespace n on n.oid = src.relnamespace
		where con.contype = 'f' and n.nspname = 'public' and not src.relispartition`);
	return rows.map((row) => {
		const [column, ...rest] = row.columns;
		if (column === undefined || rest.length > 0) {
			throw new Error(
				`foreign key of ${row.table} over ${row.columns.join(', ')}: only single-column keys are planned`
			);
		}
		return { table: row.table, column, references: row.references, deferrable: row.deferrable };
	});
}

/** The graph of the migrated schema; refuses when the clone plan does not match it. */
export async function loadSchemaGraph(executor: Executor): Promise<SchemaGraph> {
	const keys = await foreignKeyColumns(executor);
	const mismatch = compareWithClonePlan(await schemaTables(executor), keys);
	if (!isPlanComplete(mismatch)) throw new DemoClonePlanMismatch(mismatch);
	const withId = await executor.execute<{ table: string }>(sql`
		select c.table_name as "table" from information_schema.columns c
		where c.table_schema = 'public' and c.column_name = 'id'`);
	const owned = Object.keys(DEMO_CLONE_PLAN).filter((table) => ownedDecision(table));
	const idTables = new Set(withId.map((row) => row.table).filter((table) => owned.includes(table)));
	for (const table of owned) {
		if (idTables.has(table)) continue;
		const referred = keys.filter((key) => key.references === table);
		if (referred.length > 0)
			throw new Error(`owned table ${table} has no id but is referred to by ${referred[0]?.table}`);
	}
	const guarded = await executor.execute<{ table: string }>(sql`
		select c.relname as "table" from pg_trigger t join pg_class c on c.oid = t.tgrelid
		where not t.tgisinternal and t.tgname = c.relname || '_append_only'`);
	return { keys, idTables, appendOnly: new Set(guarded.map((row) => row.table)) };
}

function ownerEdges(graph: SchemaGraph, table: string, decision: OwnedDecision): ForeignKeyColumn[] {
	return graph.keys.filter((key) => key.table === table && decision.edges[key.column] === 'owner');
}

function add(set: RowSet, table: string, ids: Iterable<string>): string[] {
	let known = set.get(table);
	if (!known) {
		known = new Set();
		set.set(table, known);
	}
	const added: string[] = [];
	for (const id of ids) {
		if (!known.has(id)) {
			known.add(id);
			added.push(id);
		}
	}
	return added;
}

/** Ids of `table` rows that belong to rows of the frontier through one owner reference or a polymorphic owner. */
async function childrenOf(
	executor: Executor,
	graph: SchemaGraph,
	table: string,
	decision: OwnedDecision,
	frontier: RowSet
): Promise<Set<string>> {
	const conditions: SQL[] = [];
	for (const key of ownerEdges(graph, table, decision)) {
		const parents = frontier.get(key.references);
		if (parents && parents.size > 0) conditions.push(inValues(sql`t.${ident(key.column)}`, parents, 'uuid'));
	}
	const poly = decision.polymorphic;
	if (poly) {
		for (const [type, target] of Object.entries(poly.targets)) {
			const parents = frontier.get(target);
			if (parents && parents.size > 0) {
				conditions.push(sql`(${sql.raw(poly.type)} = ${type} and ${inValues(sql.raw(poly.id), parents, 'text')})`);
			}
		}
	}
	if (conditions.length === 0) return new Set();
	const rows = await executor.execute<{ id: string }>(
		sql`select t.id from ${ident(table)} t where ${sql.join(conditions, sql` or `)}`
	);
	return new Set(rows.map((row) => row.id));
}

/**
 * Every row that belongs to the rows of `seeds`, the seeds included. `admit` filters newly found rows of a table
 * before they join the result (and before their own children are looked for).
 */
export async function ownedClosure(
	executor: Executor,
	graph: SchemaGraph,
	seeds: RowSet,
	admit?: (table: string, ids: Set<string>) => Promise<Set<string>>
): Promise<RowSet> {
	const result: RowSet = new Map();
	let frontier: RowSet = new Map();
	for (const [table, ids] of seeds) {
		const added = add(result, table, ids);
		if (added.length > 0) frontier.set(table, new Set(added));
	}
	const rejected: RowSet = new Map();
	while (frontier.size > 0) {
		const next: RowSet = new Map();
		for (const table of graph.idTables) {
			const decision = ownedDecision(table);
			if (!decision) continue;
			const found = await childrenOf(executor, graph, table, decision, frontier);
			const known = result.get(table);
			const refused = rejected.get(table);
			const fresh = new Set([...found].filter((id) => !known?.has(id) && !refused?.has(id)));
			if (fresh.size === 0) continue;
			const admitted = admit ? await admit(table, fresh) : fresh;
			add(
				rejected,
				table,
				[...fresh].filter((id) => !admitted.has(id))
			);
			const added = add(result, table, admitted);
			if (added.length > 0) add(next, table, added);
		}
		frontier = next;
	}
	return result;
}

/** The owners of rows: for each row id, the rows its owner references and polymorphic owner name. */
export async function ownersOf(
	executor: Executor,
	graph: SchemaGraph,
	table: string,
	ids: Iterable<string>
): Promise<Map<string, { table: string; id: string }[]>> {
	const decision = ownedDecision(table);
	if (!decision) throw new Error(`${table} is not an owned table`);
	const edges = ownerEdges(graph, table, decision);
	const poly = decision.polymorphic;
	const columns = [
		sql`t.id`,
		...edges.map((edge) => sql`t.${ident(edge.column)}::text as ${ident(`o_${edge.column}`)}`),
		...(poly ? [sql`${sql.raw(poly.type)} as poly_type`, sql`${sql.raw(poly.id)} as poly_id`] : [])
	];
	const rows = await executor.execute<Record<string, string | null>>(
		sql`select ${sql.join(columns, sql`, `)} from ${ident(table)} t where ${inValues(sql`t.id`, ids, 'uuid')}`
	);
	const owners = new Map<string, { table: string; id: string }[]>();
	for (const row of rows) {
		const list: { table: string; id: string }[] = [];
		for (const edge of edges) {
			const value = row[`o_${edge.column}`];
			if (value) list.push({ table: edge.references, id: value });
		}
		if (poly && row.poly_type && row.poly_id) {
			const target = poly.targets[row.poly_type];
			if (target) list.push({ table: target, id: row.poly_id });
		}
		owners.set(String(row.id), list);
	}
	return owners;
}

const MAX_OWNER_DEPTH = 16;

/**
 * Which of the rows belong to some demo session: a root carrying `demo_session_id`, or a row one of whose owners
 * belongs to one. `memo` keeps the answers of one clone.
 */
export async function sessionOwned(
	executor: Executor,
	graph: SchemaGraph,
	memo: Map<string, Map<string, boolean>>,
	table: string,
	ids: Iterable<string>,
	depth = 0
): Promise<Set<string>> {
	if (depth > MAX_OWNER_DEPTH) throw new Error(`owner references of ${table} go deeper than ${MAX_OWNER_DEPTH}`);
	const decision = ownedDecision(table);
	if (!decision) throw new Error(`${table} is not an owned table`);
	let answers = memo.get(table);
	if (!answers) {
		answers = new Map();
		memo.set(table, answers);
	}
	const all = [...new Set(ids)];
	const unknown = all.filter((id) => !answers.has(id));
	if (unknown.length > 0) {
		if (decision.root) {
			const rows = await executor.execute<{ id: string }>(
				sql`select t.id from ${ident(table)} t where ${inValues(sql`t.id`, unknown, 'uuid')} and t.demo_session_id is not null`
			);
			const owned = new Set(rows.map((row) => row.id));
			for (const id of unknown) answers.set(id, owned.has(id));
		} else {
			const owners = await ownersOf(executor, graph, table, unknown);
			const byTable = new Map<string, Set<string>>();
			for (const list of owners.values()) {
				for (const owner of list) add(byTable, owner.table, [owner.id]);
			}
			const ownedParents = new Map<string, Set<string>>();
			for (const [parentTable, parentIds] of byTable) {
				ownedParents.set(parentTable, await sessionOwned(executor, graph, memo, parentTable, parentIds, depth + 1));
			}
			for (const id of unknown) {
				const list = owners.get(id) ?? [];
				answers.set(
					id,
					list.some((owner) => ownedParents.get(owner.table)?.has(owner.id) === true)
				);
			}
		}
	}
	return new Set(all.filter((id) => answers.get(id) === true));
}

/**
 * Owned tables in the order rows can be inserted: a table after every table its foreign keys refer to, except its
 * own rows and keys checked at commit. Deletion goes in the reverse order.
 */
export function insertionOrder(graph: SchemaGraph, tables: Iterable<string>): string[] {
	const pending = new Set(tables);
	const order: string[] = [];
	while (pending.size > 0) {
		const ready = [...pending].filter((table) =>
			graph.keys.every(
				(key) => key.table !== table || key.references === table || key.deferrable || !pending.has(key.references)
			)
		);
		if (ready.length === 0) throw new Error(`reference cycle among ${[...pending].join(', ')}`);
		for (const table of ready.sort()) {
			order.push(table);
			pending.delete(table);
		}
	}
	return order;
}

/** Owned tables of the plan. */
export function ownedTables(): string[] {
	return Object.keys(DEMO_CLONE_PLAN).filter((table) => ownedDecision(table) !== null);
}

/** Owner columns of an owned table without `id` (a leaf): its rows are found by their owners. */
export function leafOwnerColumns(graph: SchemaGraph, table: string): ForeignKeyColumn[] {
	const decision = ownedDecision(table);
	if (!decision) throw new Error(`${table} is not an owned table`);
	return ownerEdges(graph, table, decision);
}
