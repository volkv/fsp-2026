// Transactions and savepoints: the committed state after a script of BEGIN, SAVEPOINT, ROLLBACK TO, RELEASE, COMMIT
// and ROLLBACK, with id allocation and an audit trigger at the senior level. The answer is the result of the script
// in SQLite; the misconceptions run through a small model of the savepoint stack.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

/** One statement of the script. */
type Op =
	| { kind: 'begin' | 'commit' | 'rollback' }
	| { kind: 'savepoint' | 'rollback-to' | 'release'; name: string }
	| { kind: 'add'; id: number; delta: number }
	| { kind: 'add-below'; limit: number; delta: number }
	| { kind: 'insert'; owner: string; balance: number };

interface Row {
	owner: string;
	balance: number;
}

interface Log {
	accountId: number;
	newBalance: number;
}

/** Accounts and audit rows by id. */
interface State {
	accounts: Map<number, Row>;
	audit: Map<number, Log>;
}

interface Rules {
	rollbackToCloses: boolean;
	releaseCommits: boolean;
	rollbackToWhole: boolean;
	triggerSurvives: boolean;
	idsNotReused: boolean;
	nameFindsOuter: boolean;
	savepointNoTransaction: boolean;
}

const RIGHT: Rules = {
	rollbackToCloses: false,
	releaseCommits: false,
	rollbackToWhole: false,
	triggerSurvives: false,
	idsNotReused: false,
	nameFindsOuter: false,
	savepointNoTransaction: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'rollback-to-closes': { rollbackToCloses: true },
	'release-commits': { releaseCommits: true },
	'rollback-to-whole': { rollbackToWhole: true },
	'trigger-survives': { triggerSurvives: true },
	'ids-not-reused': { idsNotReused: true },
	'name-finds-outer': { nameFindsOuter: true },
	'savepoint-no-transaction': { savepointNoTransaction: true }
};

function copy(s: State): State {
	return {
		accounts: new Map([...s.accounts].map(([id, r]) => [id, { ...r }])),
		audit: new Map([...s.audit].map(([id, l]) => [id, { ...l }]))
	};
}

/** Brings `target` to `source` on the keys that differ between `base` and `source` (changes made after `base`). */
function carry<T>(target: Map<number, T>, base: Map<number, T>, source: Map<number, T>): void {
	for (const id of new Set([...base.keys(), ...source.keys()])) {
		const now = source.get(id);
		if (JSON.stringify(now) === JSON.stringify(base.get(id))) continue;
		if (now === undefined) target.delete(id);
		else target.set(id, structuredClone(now));
	}
}

/** Runs the script through the model of a savepoint stack; returns the committed state. */
function simulate(initial: State, ops: readonly Op[], trigger: boolean, rules: Rules): State {
	let state = copy(initial);
	const frames: { name: string | null; snapshot: State }[] = [];
	// The largest id ever handed out, for the misconception that rolled-back ids are not reused.
	const issued = {
		accounts: Math.max(0, ...initial.accounts.keys()),
		audit: Math.max(0, ...initial.audit.keys())
	};
	const nextId = (table: 'accounts' | 'audit'): number => {
		const id = rules.idsNotReused ? issued[table] + 1 : Math.max(0, ...state[table].keys()) + 1;
		issued[table] = Math.max(issued[table], id);
		return id;
	};
	const restore = (snapshot: State): void => {
		const audit = state.audit;
		state = copy(snapshot);
		if (rules.triggerSurvives) state.audit = audit;
	};
	const find = (name: string): number => {
		if (rules.nameFindsOuter) return frames.findIndex((f) => f.name === name);
		for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i]?.name === name) return i;
		return -1;
	};
	const update = (id: number, row: Row, delta: number): void => {
		row.balance += delta;
		if (trigger) state.audit.set(nextId('audit'), { accountId: id, newBalance: row.balance });
	};
	for (const op of ops) {
		switch (op.kind) {
			case 'begin':
				frames.push({ name: null, snapshot: copy(state) });
				break;
			case 'savepoint':
				if (rules.savepointNoTransaction && frames.length === 0) break;
				frames.push({ name: op.name, snapshot: copy(state) });
				break;
			case 'rollback-to': {
				const i = find(op.name);
				if (i < 0) break;
				restore((rules.rollbackToWhole ? frames[0] : frames[i])?.snapshot ?? state);
				frames.length = rules.rollbackToCloses ? i : i + 1;
				break;
			}
			case 'release': {
				const i = find(op.name);
				if (i < 0) break;
				if (rules.releaseCommits) {
					const base = frames[i]?.snapshot ?? state;
					for (const below of frames.slice(0, i)) {
						carry(below.snapshot.accounts, base.accounts, state.accounts);
						carry(below.snapshot.audit, base.audit, state.audit);
					}
				}
				frames.length = i;
				break;
			}
			case 'commit':
				frames.length = 0;
				break;
			case 'rollback':
				if (frames[0]) restore(frames[0].snapshot);
				frames.length = 0;
				break;
			case 'add': {
				const row = state.accounts.get(op.id);
				if (row) update(op.id, row, op.delta);
				break;
			}
			case 'add-below':
				for (const [id, row] of [...state.accounts].sort((a, b) => a[0] - b[0]))
					if (row.balance < op.limit) update(id, row, op.delta);
				break;
			case 'insert':
				state.accounts.set(nextId('accounts'), { owner: op.owner, balance: op.balance });
				break;
		}
	}
	if (frames.length > 0) throw new Error('the script leaves a transaction open');
	return state;
}

function rowsOf(s: State, trigger: boolean): string[] {
	const accounts = [...s.accounts]
		.sort((a, b) => a[0] - b[0])
		.map(([id, r]) => (trigger ? `account | ${id} | ${r.owner} | ${r.balance}` : `${id} | ${r.owner} | ${r.balance}`));
	if (!trigger) return accounts;
	const audit = [...s.audit]
		.sort((a, b) => a[0] - b[0])
		.map(([id, l]) => `audit | ${id} | ${l.accountId} | ${l.newBalance}`);
	return [...accounts, ...audit];
}

interface Scenario {
	table: string;
	initial: State;
	ops: Op[];
	trigger: boolean;
	/** Misconceptions every instance of the class must expose. */
	required: string[];
}

function sqlOf(table: string, op: Op): string {
	switch (op.kind) {
		case 'begin':
			return 'BEGIN;';
		case 'commit':
			return 'COMMIT;';
		case 'rollback':
			return 'ROLLBACK;';
		case 'savepoint':
			return `SAVEPOINT ${op.name};`;
		case 'rollback-to':
			return `ROLLBACK TO ${op.name};`;
		case 'release':
			return `RELEASE ${op.name};`;
		case 'add':
			return `UPDATE ${table} SET balance = balance ${op.delta < 0 ? '-' : '+'} ${Math.abs(op.delta)} WHERE id = ${op.id};`;
		case 'add-below':
			return `UPDATE ${table} SET balance = balance + ${op.delta} WHERE balance < ${op.limit};`;
		case 'insert':
			return `INSERT INTO ${table} (owner, balance) VALUES (${sqlText(op.owner)}, ${op.balance});`;
	}
}

function scriptOf(sc: Scenario): { setup: string; query: string } {
	const ddl = [`CREATE TABLE ${sc.table} (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, balance INTEGER NOT NULL);`];
	if (sc.trigger) {
		ddl.push(
			'CREATE TABLE audit (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, new_balance INTEGER NOT NULL);',
			`CREATE TRIGGER log_balance AFTER UPDATE OF balance ON ${sc.table}\nBEGIN\n  INSERT INTO audit (account_id, new_balance) VALUES (NEW.id, NEW.balance);\nEND;`
		);
	}
	const seed = [...sc.initial.accounts]
		.sort((a, b) => a[0] - b[0])
		.map(([, r]) => `INSERT INTO ${sc.table} (owner, balance) VALUES (${sqlText(r.owner)}, ${r.balance});`);
	const body = sc.ops.map((op) => sqlOf(sc.table, op));
	const query = sc.trigger
		? `SELECT 'account', id, owner, balance FROM ${sc.table} UNION ALL SELECT 'audit', id, account_id, new_balance FROM audit ORDER BY 1, 2;`
		: `SELECT id, owner, balance FROM ${sc.table} ORDER BY id;`;
	return { setup: [...ddl, ...seed, '', ...body].join('\n'), query };
}

const SAVEPOINT_NAMES = ['step', 'item', 'batch', 'outer_sp', 'inner_sp', 'chunk', 'attempt', 'part'] as const;

/** A generator of the DML of one scenario: updates of the starting accounts and inserts of new owners. */
function dml(
	rng: Rng,
	accountIds: readonly number[],
	owners: string[]
): { add: () => Op; insert: () => Op; some: (n: number) => Op[] } {
	const add = (): Op => ({ kind: 'add', id: rng.pick(accountIds), delta: rng.pick([-1, 1]) * rng.int(1, 12) * 10 });
	const insert = (): Op => ({ kind: 'insert', owner: owners.shift() ?? 'nobody', balance: rng.int(1, 30) * 10 });
	return { add, insert, some: (n) => Array.from({ length: n }, () => (rng.bool(0.75) ? add() : insert())) };
}

function base(rng: Rng, count: number): { table: string; initial: State; owners: string[] } {
	const names = rng.sample(PERSON_NAMES, count + 6);
	const accounts = new Map<number, Row>();
	for (let i = 1; i <= count; i += 1) accounts.set(i, { owner: names[i - 1] ?? 'x', balance: rng.int(5, 40) * 10 });
	return {
		table: rng.pick(['accounts', 'wallets', 'balances']),
		initial: { accounts, audit: new Map() },
		owners: names.slice(count)
	};
}

function rollbackToKeepsOpen(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const sp = rng.pick(SAVEPOINT_NAMES);
	// A retry loop: two failed attempts rolled back to the same savepoint, then a successful one.
	const ops: Op[] = [
		{ kind: 'begin' },
		...d.some(1),
		{ kind: 'savepoint', name: sp },
		...d.some(rng.int(1, 2)),
		{ kind: 'rollback-to', name: sp },
		...d.some(rng.int(1, 2)),
		{ kind: 'rollback-to', name: sp },
		...d.some(rng.int(1, 2)),
		{ kind: 'release', name: sp },
		{ kind: 'commit' }
	];
	return { ...b, ops, trigger: false, required: ['rollback-to-closes', 'rollback-to-whole'] };
}

function releaseThenRollback(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const [outer, inner] = rng.sample(SAVEPOINT_NAMES, 2) as [string, string];
	const ops: Op[] = [
		{ kind: 'begin' },
		...d.some(1),
		{ kind: 'savepoint', name: outer },
		...d.some(1),
		{ kind: 'savepoint', name: inner },
		...d.some(rng.int(1, 2)),
		{ kind: 'release', name: inner },
		...d.some(1),
		{ kind: 'rollback-to', name: outer },
		...d.some(1),
		{ kind: 'commit' },
		{ kind: 'begin' },
		{ kind: 'savepoint', name: inner },
		...d.some(1),
		{ kind: 'release', name: inner },
		{ kind: 'rollback' }
	];
	return { ...b, ops, trigger: false, required: ['release-commits', 'rollback-to-whole'] };
}

function twoTransactions(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const sp = rng.pick(SAVEPOINT_NAMES);
	const ops: Op[] = [
		{ kind: 'begin' },
		...d.some(rng.int(1, 2)),
		{ kind: 'savepoint', name: sp },
		...d.some(rng.int(1, 2)),
		{ kind: 'rollback-to', name: sp },
		...d.some(1),
		{ kind: 'commit' },
		{ kind: 'begin' },
		...d.some(rng.int(1, 2)),
		{ kind: 'rollback' },
		d.add()
	];
	return { ...b, ops, trigger: false, required: ['rollback-to-whole'] };
}

function nestedSavepoints(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const [outer, mid, inner] = rng.sample(SAVEPOINT_NAMES, 3) as [string, string, string];
	// No BEGIN: the first savepoint opens the transaction and its RELEASE commits it.
	const ops: Op[] = [
		{ kind: 'savepoint', name: outer },
		...d.some(1),
		{ kind: 'savepoint', name: mid },
		...d.some(1),
		{ kind: 'savepoint', name: inner },
		...d.some(rng.int(1, 2)),
		{ kind: 'release', name: inner },
		...d.some(1),
		{ kind: 'rollback-to', name: mid },
		...d.some(1),
		{ kind: 'release', name: outer },
		{ kind: 'begin' },
		...d.some(1),
		{ kind: 'savepoint', name: inner },
		...d.some(1),
		{ kind: 'release', name: inner },
		{ kind: 'rollback' }
	];
	return { ...b, ops, trigger: false, required: ['release-commits', 'rollback-to-whole'] };
}

function triggerAudit(rng: Rng): Scenario {
	const b = base(rng, 4);
	const d = dml(rng, [1, 2, 3, 4], b.owners);
	const sp = rng.pick(SAVEPOINT_NAMES);
	const sorted = [...b.initial.accounts.values()].map((r) => r.balance).sort((x, y) => x - y);
	// A bulk update that touches two or three rows: one audit row per changed row.
	const limit = (sorted[rng.int(1, 2)] ?? 100) + 5;
	const ops: Op[] = [
		{ kind: 'begin' },
		d.add(),
		{ kind: 'savepoint', name: sp },
		{ kind: 'add-below', limit, delta: rng.int(1, 5) * 10 },
		d.add(),
		{ kind: 'rollback-to', name: sp },
		d.add(),
		{ kind: 'release', name: sp },
		{ kind: 'commit' },
		{ kind: 'add-below', limit: limit + rng.int(0, 10) * 10, delta: rng.int(1, 5) * 10 }
	];
	return { ...b, ops, trigger: true, required: ['trigger-survives', 'ids-not-reused'] };
}

function reusedIds(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const [outer, inner] = rng.sample(SAVEPOINT_NAMES, 2) as [string, string];
	const ops: Op[] = [
		{ kind: 'savepoint', name: outer },
		d.insert(),
		{ kind: 'savepoint', name: inner },
		d.insert(),
		d.add(),
		{ kind: 'release', name: inner },
		{ kind: 'rollback-to', name: outer },
		d.insert(),
		{ kind: 'release', name: outer },
		{ kind: 'begin' },
		d.insert(),
		d.add(),
		{ kind: 'rollback' },
		d.insert()
	];
	return { ...b, ops, trigger: false, required: ['release-commits', 'ids-not-reused'] };
}

function savepointOpensTransaction(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const [outer, inner, later] = rng.sample(SAVEPOINT_NAMES, 3) as [string, string, string];
	// No BEGIN: the first SAVEPOINT opens a transaction, so the plain ROLLBACK undoes everything since it.
	const ops: Op[] = [
		...d.some(1),
		{ kind: 'savepoint', name: outer },
		...d.some(1),
		{ kind: 'savepoint', name: inner },
		...d.some(rng.int(1, 2)),
		{ kind: 'release', name: inner },
		...d.some(1),
		{ kind: 'rollback' },
		...d.some(1),
		{ kind: 'savepoint', name: later },
		...d.some(1),
		{ kind: 'release', name: later }
	];
	return { ...b, ops, trigger: false, required: ['release-commits', 'savepoint-no-transaction'] };
}

function duplicateNames(rng: Rng): Scenario {
	const b = base(rng, 3);
	const d = dml(rng, [1, 2, 3], b.owners);
	const sp = rng.pick(SAVEPOINT_NAMES);
	// Two open savepoints with the same name: ROLLBACK TO and RELEASE address the most recent one.
	const ops: Op[] = [
		{ kind: 'begin' },
		...d.some(1),
		{ kind: 'savepoint', name: sp },
		...d.some(1),
		{ kind: 'savepoint', name: sp },
		...d.some(1),
		{ kind: 'rollback-to', name: sp },
		...d.some(1),
		{ kind: 'release', name: sp },
		...d.some(1),
		{ kind: 'rollback-to', name: sp },
		...d.some(1),
		{ kind: 'release', name: sp },
		{ kind: 'commit' }
	];
	return { ...b, ops, trigger: false, required: ['name-finds-outer', 'rollback-to-closes'] };
}

const SCENARIOS: Record<string, (rng: Rng) => Scenario> = {
	'middle/savepoint-opens-transaction': savepointOpensTransaction,
	'senior/duplicate-names': duplicateNames,
	'middle/rollback-to-keeps-open': rollbackToKeepsOpen,
	'middle/release-then-rollback': releaseThenRollback,
	'middle/two-transactions': twoTransactions,
	'senior/nested-savepoints': nestedSavepoints,
	'senior/trigger-audit': triggerAudit,
	'senior/reused-ids': reusedIds
};

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

const STATEMENT = [
	'Скрипт выполняется целиком в одном соединении SQLite в режиме автофиксации (оператор вне транзакции фиксируется сразу); ни один оператор не завершается ошибкой.',
	'Что вернёт последний запрос?',
	'',
	SQL_ROW_FORMAT
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = SCENARIOS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId}`);
	// Scenarios are drawn until every misconception the class requires changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const sc = make(rng);
		const { setup, query } = scriptOf(sc);
		const answer = runSql(setup, query);
		const modelled = rowsOf(simulate(sc.initial, sc.ops, sc.trigger, RIGHT), sc.trigger);
		if (!sameRows(modelled, answer))
			throw new Error(`${descriptor.key}: the model disagrees with SQLite on ${input.grade}/${input.classId}`);
		const wrong: Record<string, string[] | null> = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const rows = rowsOf(simulate(sc.initial, sc.ops, sc.trigger, { ...RIGHT, ...change }), sc.trigger);
				return [id, sameRows(rows, answer) ? null : rows];
			})
		);
		if (sc.required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: STATEMENT, code: { language: 'sql', source: `${setup}\n\n${query}` } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(setup, query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, rows]) => [
						id,
						rows === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: rows } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
