// Isolation levels of PostgreSQL on a schedule of two or three transactions: lost updates under READ COMMITTED,
// serialization failures of concurrent updates under REPEATABLE READ, write skew caught by SERIALIZABLE. The model
// is stated in full in the statement; the answer is the committed values and the transactions rolled back.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Level = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/** A sum of values the transaction read (by row name) and a constant. */
interface Expr {
	terms: string[];
	plus: number;
}

type Op =
	| { tx: number; kind: 'read'; row: string }
	| { tx: number; kind: 'set'; row: string; expr: Expr; guard: { terms: string[]; min: number } | null }
	| { tx: number; kind: 'add'; row: string; delta: number }
	| { tx: number; kind: 'commit' };

interface Params {
	level: Level;
	rows: [string, number][];
	ops: Op[];
}

interface Rules {
	rcSnapshotReads: boolean;
	incrementLost: boolean;
	rrOverwrites: boolean;
	statementRollback: boolean;
	skewUndetected: boolean;
	anyDependencyAborts: boolean;
	rrDetectsSkew: boolean;
}

const RIGHT: Rules = {
	rcSnapshotReads: false,
	incrementLost: false,
	rrOverwrites: false,
	statementRollback: false,
	skewUndetected: false,
	anyDependencyAborts: false,
	rrDetectsSkew: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'rc-snapshot-reads': { rcSnapshotReads: true },
	'increment-lost': { incrementLost: true },
	'rr-overwrites': { rrOverwrites: true },
	'statement-rollback': { statementRollback: true },
	'skew-undetected': { skewUndetected: true },
	'any-dependency-aborts': { anyDependencyAborts: true },
	'rr-detects-skew': { rrDetectsSkew: true }
};

interface Version {
	value: number;
	at: number;
	by: number;
}

interface Tx {
	start: number;
	writes: Map<string, number>;
	locals: Map<string, number>;
	read: Set<string>;
	state: 'active' | 'committed' | 'aborted';
	commitAt: number;
}

/** Runs the schedule; `blocked` reports a write to a row another active transaction has written (a lock wait). */
function run(p: Params, rules: Rules): { answer: string; blocked: boolean } {
	const versions = new Map<string, Version[]>(p.rows.map(([name, value]) => [name, [{ value, at: -1, by: 0 }]]));
	const txs = new Map<number, Tx>();
	let blocked = false;
	const latest = (row: string): Version => {
		const list = versions.get(row) ?? [];
		const last = list[list.length - 1];
		if (!last) throw new Error(`no row ${row}`);
		return last;
	};
	const asOf = (row: string, time: number): number => {
		const visible = (versions.get(row) ?? []).filter((v) => v.at < time);
		return visible[visible.length - 1]?.value ?? 0;
	};
	const snapshot = p.level !== 'READ COMMITTED';
	p.ops.forEach((op, now) => {
		let tx = txs.get(op.tx);
		if (!tx) {
			tx = { start: now, writes: new Map(), locals: new Map(), read: new Set(), state: 'active', commitAt: -1 };
			txs.set(op.tx, tx);
		}
		if (tx.state !== 'active') return;
		const t = tx;
		const visible = (row: string, forUpdate: boolean): number => {
			const own = t.writes.get(row);
			if (own !== undefined) return own;
			const fromStart = snapshot || (forUpdate ? rules.incrementLost : rules.rcSnapshotReads);
			return fromStart ? asOf(row, t.start) : latest(row).value;
		};
		const write = (row: string, value: () => number): void => {
			for (const [id, other] of txs)
				if (id !== op.tx && other.state === 'active' && other.writes.has(row)) blocked = true;
			if (snapshot && !t.writes.has(row) && latest(row).at > t.start && !rules.rrOverwrites) {
				if (rules.statementRollback) return;
				t.state = 'aborted';
				return;
			}
			t.writes.set(row, value());
		};
		const sum = (terms: readonly string[]): number => terms.reduce((s, r) => s + (t.locals.get(r) ?? 0), 0);
		switch (op.kind) {
			case 'read':
				t.locals.set(op.row, visible(op.row, false));
				t.read.add(op.row);
				break;
			case 'set':
				if (op.guard && sum(op.guard.terms) < op.guard.min) break;
				write(op.row, () => sum(op.expr.terms) + op.expr.plus);
				break;
			case 'add':
				write(op.row, () => visible(op.row, true) + op.delta);
				break;
			case 'commit': {
				if (
					(p.level === 'SERIALIZABLE' && !rules.skewUndetected) ||
					(p.level === 'REPEATABLE READ' && rules.rrDetectsSkew)
				) {
					const conflict = [...txs].some(([id, u]) => {
						if (id === op.tx || u.state !== 'committed' || u.commitAt < t.start) return false;
						const tReadsU = [...t.read].some((r) => u.writes.has(r));
						const uReadsT = [...u.read].some((r) => t.writes.has(r));
						return rules.anyDependencyAborts ? tReadsU || uReadsT : tReadsU && uReadsT;
					});
					if (conflict) {
						t.state = 'aborted';
						break;
					}
				}
				for (const [row, value] of t.writes) versions.get(row)?.push({ value, at: now, by: op.tx });
				t.state = 'committed';
				t.commitAt = now;
				break;
			}
		}
	});
	const aborted = [...txs]
		.filter(([, t]) => t.state === 'aborted')
		.map(([id]) => id)
		.sort((a, b) => a - b);
	const values = p.rows.map(([name]) => String(latest(name).value));
	return {
		answer: [...values, ...(aborted.length ? aborted.map((id) => `T${id}`) : ['-'])].join(' '),
		blocked
	};
}

const ROW_SETS = [
	['x', 'y', 'z'],
	['a', 'b', 'c'],
	['p', 'q', 'r']
] as const;

function amount(rng: Rng): number {
	return rng.int(1, 9) * 10;
}

/** Random merge of the programs keeping the order inside each. */
function interleave(rng: Rng, programs: Op[][]): Op[] {
	const queues = programs.map((p) => [...p]);
	const out: Op[] = [];
	while (queues.some((q) => q.length > 0)) {
		const q = rng.pick(queues.filter((x) => x.length > 0));
		const op = q.shift();
		if (op) out.push(op);
	}
	return out;
}

/** A program of reads and writes: application writes need a value the transaction has read. */
function program(rng: Rng, tx: number, rows: readonly string[], steps: number): Op[] {
	const ops: Op[] = [];
	const readRows: string[] = [];
	let writes = 0;
	for (let k = 0; k < steps; k += 1) {
		const last = k === steps - 1;
		const kind = last && writes === 0 ? rng.pick(['set', 'add']) : rng.pick(['read', 'read', 'set', 'add']);
		if (kind === 'read' || (kind === 'set' && readRows.length === 0)) {
			const row = rng.pick(rows);
			ops.push({ tx, kind: 'read', row });
			if (!readRows.includes(row)) readRows.push(row);
			if (kind === 'read') continue;
		}
		writes += 1;
		const row = rng.pick(rows);
		if (kind === 'set') {
			const source = readRows.includes(row) && rng.bool(0.7) ? row : rng.pick(readRows);
			ops.push({ tx, kind: 'set', row, expr: { terms: [source], plus: rng.pick([-1, 1]) * amount(rng) }, guard: null });
		} else ops.push({ tx, kind: 'add', row, delta: rng.pick([-1, 1]) * amount(rng) });
	}
	ops.push({ tx, kind: 'commit' });
	return ops;
}

function initialRows(rng: Rng, names: readonly string[]): [string, number][] {
	return names.map((name) => [name, rng.int(5, 30) * 10]);
}

function readCommitted(rng: Rng): Params {
	const names = rng.pick(ROW_SETS).slice(0, rng.int(2, 3));
	const [x, y] = rng.sample(names, 2) as [string, string];
	const sign = (): number => rng.pick([-1, 1]);
	// All three start before the first COMMIT; T1 changes x and commits; T2 reads x again and writes from it, and T3
	// updates x in the database — whether these come after that COMMIT is what the level decides.
	const heads: Op[] = [
		{ tx: 1, kind: 'read', row: x },
		{ tx: 2, kind: 'read', row: rng.pick([x, y]) },
		rng.bool()
			? { tx: 3, kind: 'read', row: rng.pick(names) }
			: { tx: 3, kind: 'add', row: y, delta: sign() * amount(rng) }
	];
	const t1: Op[] = [
		{ tx: 1, kind: 'set', row: x, expr: { terms: [x], plus: sign() * amount(rng) }, guard: null },
		{ tx: 1, kind: 'commit' }
	];
	const t2: Op[] = [
		{ tx: 2, kind: 'read', row: x },
		{ tx: 2, kind: 'set', row: rng.pick([x, y]), expr: { terms: [x], plus: sign() * amount(rng) }, guard: null },
		{ tx: 2, kind: 'commit' }
	];
	const t3: Op[] = [
		{ tx: 3, kind: 'add', row: x, delta: sign() * amount(rng) },
		{ tx: 3, kind: 'commit' }
	];
	if (rng.bool()) t3.splice(1, 0, { tx: 3, kind: 'read', row: y });
	return {
		level: 'READ COMMITTED',
		rows: initialRows(rng, names),
		ops: [...rng.shuffle(heads), ...interleave(rng, [t1, t2, t3])]
	};
}

function repeatableRead(rng: Rng): Params {
	const names = rng.pick(ROW_SETS).slice(0, 2);
	const count = rng.int(2, 3);
	const programs = Array.from({ length: count }, (_, i) => program(rng, i + 1, names, rng.int(2, 4)));
	return { level: 'REPEATABLE READ', rows: initialRows(rng, names), ops: interleave(rng, programs) };
}

function serializable(rng: Rng): Params {
	const names = rng.pick(ROW_SETS).slice(0, 2) as [string, string];
	const [x, y] = rng.bool() ? names : ([names[1], names[0]] as [string, string]);
	const rows = initialRows(rng, names);
	const total = rows.reduce((s, [, v]) => s + v, 0);
	const need = rng.int(1, Math.floor(total / 10) - 1) * 10;
	// Each transaction checks the sum of what it read and takes `need` from its own row: write skew when both read
	// both rows; a single read-write dependency when one of them reads only its own row.
	const reads2 = rng.bool(0.7) ? [x, y] : [y];
	const p1: Op[] = [
		...rng.shuffle([x, y]).map((row): Op => ({ tx: 1, kind: 'read', row })),
		{ tx: 1, kind: 'set', row: x, expr: { terms: [x], plus: -need }, guard: { terms: [x, y], min: need } },
		{ tx: 1, kind: 'commit' }
	];
	const p2: Op[] = [
		...rng.shuffle(reads2).map((row): Op => ({ tx: 2, kind: 'read', row })),
		{
			tx: 2,
			kind: 'set',
			row: y,
			expr: { terms: [y], plus: -need },
			guard: { terms: reads2, min: need }
		},
		{ tx: 2, kind: 'commit' }
	];
	return { level: 'SERIALIZABLE', rows, ops: interleave(rng, rng.shuffle([p1, p2])) };
}

function rrWriteSkew(rng: Rng): Params {
	const names = rng.pick(ROW_SETS);
	const [x, y, z] = rng.shuffle(names) as [string, string, string];
	const rows = initialRows(rng, [x, y, z].sort());
	const total = (rows.find(([n]) => n === x)?.[1] ?? 0) + (rows.find(([n]) => n === y)?.[1] ?? 0);
	const need = rng.int(1, Math.floor(total / 10) - 1) * 10;
	// Write skew under REPEATABLE READ: both read x and y in their snapshots and take from different rows — no error.
	// Sometimes both also update z, and the second of them to write it fails on the concurrent update.
	const take = (tx: number, row: string): Op[] => [
		...rng.shuffle([x, y]).map((r): Op => ({ tx, kind: 'read', row: r })),
		{ tx, kind: 'set', row, expr: { terms: [row], plus: -need }, guard: { terms: [x, y], min: need } }
	];
	const p1 = take(1, x);
	const p2 = take(2, y);
	if (rng.bool(0.4)) {
		const bump = (tx: number): Op => ({ tx, kind: 'add', row: z, delta: rng.pick([-1, 1]) * amount(rng) });
		p1.splice(rng.int(0, p1.length), 0, bump(1));
		p2.splice(rng.int(0, p2.length), 0, bump(2));
	}
	p1.push({ tx: 1, kind: 'commit' });
	p2.push({ tx: 2, kind: 'commit' });
	return { level: 'REPEATABLE READ', rows, ops: interleave(rng, rng.shuffle([p1, p2])) };
}

function exprText(tx: number, e: Expr): string {
	const terms = e.terms.map((r) => `T${tx}.${r}`).join(' + ');
	return `${terms} ${e.plus < 0 ? '−' : '+'} ${Math.abs(e.plus)}`;
}

function opText(op: Op): string {
	switch (op.kind) {
		case 'read':
			return `T${op.tx} читает ${op.row}`;
		case 'set': {
			const assign = `записывает ${op.row} := ${exprText(op.tx, op.expr)}`;
			if (!op.guard) return `T${op.tx} ${assign}`;
			return `T${op.tx}: если ${op.guard.terms.map((r) => `T${op.tx}.${r}`).join(' + ')} ≥ ${op.guard.min}, ${assign}`;
		}
		case 'add':
			return `T${op.tx} выполняет \`UPDATE … SET v = v ${op.delta < 0 ? '-' : '+'} ${Math.abs(op.delta)}\` для ${op.row}`;
		case 'commit':
			return `T${op.tx} COMMIT`;
	}
}

function describe(p: Params): string {
	const names = p.rows.map(([n]) => n);
	return [
		`Строки таблицы (столбец \`v\`) до начала расписания зафиксированы: ${p.rows.map(([n, v]) => `${n} = ${v}`).join(', ')}.`,
		`Все транзакции работают на уровне изоляции **${p.level}**. Операции выполняются строго по шагам расписания.`,
		'',
		'Модель (PostgreSQL с упрощениями):',
		'',
		'- `Tk читает r` — приложение читает значение строки r и запоминает его как `Tk.r` (повторное чтение перезаписывает). `Tk записывает r := …` — UPDATE с числом, которое приложение вычислило из запомненных значений; запись «если …» выполняется, только когда условие истинно, иначе это не запись. `UPDATE … SET v = v + d` — значение берёт сама база.',
		'- Транзакция начинается своей первой операцией и завершается своим COMMIT. Свои незафиксированные записи она видит сразу, чужие — не раньше их COMMIT.',
		'- READ COMMITTED: каждое чтение и каждый `UPDATE … SET v = v + d` видят последнее зафиксированное значение на момент операции (или свою запись). Ошибок сериализации нет.',
		'- REPEATABLE READ: при первой операции транзакция берёт снимок, и все её чтения и `UPDATE … SET v = v + d` видят значения на этот момент (или свою запись). Если транзакция пишет (любой записью) строку, которую после её снимка изменила и зафиксировала другая транзакция, — ошибка сериализации: транзакция откатывается целиком, её записи пропадают, остальные её операции не выполняются.',
		'- SERIALIZABLE: всё как в REPEATABLE READ, и ещё при COMMIT транзакции T проверяется каждая транзакция U, зафиксированная после начала T: если T читала строку, которую записала U, **и** U читала строку, которую записала T, — T откатывается с ошибкой сериализации. Одна такая зависимость без обратной не ошибка. (В PostgreSQL эта ошибка бывает и раньше COMMIT и с ложными срабатываниями; здесь проверка точная, по строкам, и только при COMMIT.)',
		'- Расписание составлено так, что ожиданий блокировок нет: никто не пишет строку, уже изменённую другой незавершённой транзакцией.',
		'',
		'Расписание:',
		'',
		...p.ops.map((op, i) => `${i + 1}. ${opText(op)}`),
		'',
		`Введите через пробел итоговые зафиксированные значения ${names.join(', ')} (в этом порядке), затем откатившиеся транзакции по возрастанию номера (\`T1\`, \`T2\`, …) или \`-\`, если откатов нет. Пример формата: \`10 20 30 T2\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
level = p["level"]
history = {name: [(-1, value)] for name, value in p["rows"]}
txs = {}


def committed_before(row, moment):
    value = None
    for at, v in history[row]:
        if at < moment:
            value = v
    return value


def current(row):
    return history[row][-1][1]


def last_commit(row):
    return history[row][-1][0]


for now, op in enumerate(p["ops"]):
    t = txs.setdefault(op["tx"], {"start": now, "mine": {}, "seen": {}, "reads": set(), "done": None, "at": None})
    if t["done"] is not None:
        continue

    def see(row):
        if row in t["mine"]:
            return t["mine"][row]
        if level == "READ COMMITTED":
            return current(row)
        return committed_before(row, t["start"])

    def put(row, value):
        if level != "READ COMMITTED" and row not in t["mine"] and last_commit(row) > t["start"]:
            t["done"] = "aborted"
            return
        t["mine"][row] = value

    kind = op["kind"]
    if kind == "read":
        t["seen"][op["row"]] = see(op["row"])
        t["reads"].add(op["row"])
    elif kind == "set":
        guard = op["guard"]
        if guard is None or sum(t["seen"][r] for r in guard["terms"]) >= guard["min"]:
            put(op["row"], sum(t["seen"][r] for r in op["expr"]["terms"]) + op["expr"]["plus"])
    elif kind == "add":
        if level == "READ COMMITTED" or op["row"] in t["mine"] or last_commit(op["row"]) <= t["start"]:
            put(op["row"], see(op["row"]) + op["delta"])
        else:
            t["done"] = "aborted"
    else:
        cycle = False
        if level == "SERIALIZABLE":
            for other in txs.values():
                if other is t or other["done"] != "committed" or other["at"] < t["start"]:
                    continue
                if (t["reads"] & set(other["mine"])) and (other["reads"] & set(t["mine"])):
                    cycle = True
        if cycle:
            t["done"] = "aborted"
        else:
            for row, value in t["mine"].items():
                history[row].append((now, value))
            t["done"] = "committed"
            t["at"] = now

out = [str(current(name)) for name, _ in p["rows"]]
rolled = sorted(k for k, t in txs.items() if t["done"] == "aborted")
out += ["T%d" % k for k in rolled] or ["-"]
print(" ".join(out))
`;

const GENERATORS: Record<string, (rng: Rng) => Params> = {
	'read-committed': readCommitted,
	'repeatable-read': repeatableRead,
	serializable,
	'rr-write-skew': rrWriteSkew
};

/** The misconceptions every instance of a class must expose; for SERIALIZABLE either of the two. */
const REQUIRED: Record<string, { all: string[]; any: string[] }> = {
	'read-committed': { all: ['rc-snapshot-reads', 'increment-lost'], any: [] },
	'repeatable-read': { all: ['rr-overwrites', 'statement-rollback'], any: [] },
	serializable: { all: [], any: ['skew-undetected', 'any-dependency-aborts'] },
	'rr-write-skew': { all: ['rr-detects-skew'], any: [] }
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const generate = GENERATORS[input.classId];
	const required = REQUIRED[input.classId];
	if (!generate || !required) throw new Error(`${descriptor.key}: no generator for ${input.classId}`);
	// Schedules are drawn until there is no lock wait and the misconceptions of the class change the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = generate(rng);
		const right = run(p, RIGHT);
		if (right.blocked) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = run(p, { ...RIGHT, ...change }).answer;
				return [id, value === right.answer ? null : value];
			})
		);
		if (required.all.some((id) => wrong[id] === null)) continue;
		if (required.any.length > 0 && required.any.every((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: right.answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no schedule for ${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
