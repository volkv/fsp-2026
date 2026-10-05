// An interleaved log of two or three handlers over one shared value (a balance, a stock, a counter): reads into a
// handler's local value, writes computed from it, atomic increments, transactions with an isolation level and
// rollbacks. The tester executes the log step by step: the final value and a second number — lost updates, units sold
// over the stock, or the record of a dirty read. The anomaly is the essential class; the amounts and the interleaving
// are surface.
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

type OpKind = 'begin' | 'read' | 'write' | 'commit' | 'rollback' | 'add' | 'check';
interface Op {
	w: string;
	op: OpKind;
	/** `write`: the change to the value read; `add`: the atomic increment. */
	d?: number;
	/** `check`: the reserved quantity. */
	q?: number;
}
type Isolation = 'none' | 'read-committed' | 'read-uncommitted';

interface Outcome {
	final: number;
	lost: number;
	overwrites: number;
	/** 1-based record of the first read of a value that was later rolled back. */
	dirty: number | null;
	/** The sum of the committed changes, as if every change applied to the current value. */
	sequential: number;
	reserved: number;
	added: number;
	/** A handler wrote while another one held an uncommitted write, or a check failed: the log is impossible. */
	invalid: boolean;
}

function simulate(ops: readonly Op[], initial: number, iso: Isolation): Outcome {
	let committed = initial;
	let latest = initial;
	let dirtyWriter: string | null = null;
	const local = new Map<string, number>();
	const readAt = new Map<string, number>();
	const inTx = new Set<string>();
	const pending = new Map<string, { value: number; d: number }>();
	const events: { time: number; read: number; w: string }[] = [];
	const dirtyReads: { time: number; writer: string }[] = [];
	const rolledBack = new Set<string>();
	let sequential = initial;
	let reserved = 0;
	let added = 0;
	let invalid = false;
	ops.forEach((o, i) => {
		const d = o.d ?? 0;
		switch (o.op) {
			case 'begin':
				inTx.add(o.w);
				break;
			case 'read':
				if (iso === 'read-uncommitted' && dirtyWriter !== null && dirtyWriter !== o.w)
					dirtyReads.push({ time: i, writer: dirtyWriter });
				local.set(o.w, iso === 'read-committed' ? committed : latest);
				readAt.set(o.w, i);
				break;
			case 'check':
				reserved += o.q ?? 0;
				if ((local.get(o.w) ?? 0) < (o.q ?? 0)) invalid = true;
				break;
			case 'write': {
				const value = (local.get(o.w) ?? 0) + d;
				if (inTx.has(o.w)) {
					if ([...pending.keys()].some((w) => w !== o.w)) invalid = true;
					pending.set(o.w, { value, d });
					if (iso === 'read-uncommitted') {
						latest = value;
						dirtyWriter = o.w;
					}
				} else {
					committed = value;
					latest = value;
					sequential += d;
					events.push({ time: i, read: readAt.get(o.w) ?? -1, w: o.w });
				}
				break;
			}
			case 'commit': {
				const p = pending.get(o.w);
				if (p) {
					committed = p.value;
					sequential += p.d;
					events.push({ time: i, read: readAt.get(o.w) ?? -1, w: o.w });
				}
				latest = committed;
				if (dirtyWriter === o.w) dirtyWriter = null;
				pending.delete(o.w);
				inTx.delete(o.w);
				break;
			}
			case 'rollback':
				latest = committed;
				if (dirtyWriter === o.w) dirtyWriter = null;
				pending.delete(o.w);
				inTx.delete(o.w);
				rolledBack.add(o.w);
				break;
			case 'add':
				committed += d;
				latest += d;
				sequential += d;
				added += d;
				events.push({ time: i, read: i, w: o.w });
				break;
		}
	});
	let lost = 0;
	let overwrites = 0;
	for (let k = 0; k + 1 < events.length; k += 1) {
		const [a, b] = [events[k], events[k + 1]];
		if (!a || !b) continue;
		if (b.read < a.time) lost += 1;
		if (b.w !== a.w) overwrites += 1;
	}
	const dirty = dirtyReads.find((r) => rolledBack.has(r.writer));
	return {
		final: committed,
		lost,
		overwrites,
		dirty: dirty ? dirty.time + 1 : null,
		sequential,
		reserved,
		added,
		invalid
	};
}

function interleave(rng: Rng, scripts: readonly Op[][]): Op[] {
	const queues = scripts.map((s) => [...s]);
	const out: Op[] = [];
	for (;;) {
		const open = queues.filter((q) => q.length > 0);
		if (open.length === 0) return out;
		const op = rng.pick(open).shift();
		if (op) out.push(op);
	}
}

const delta = (rng: Rng, sign: 1 | -1 | 0 = 0): number => {
	const s = sign === 0 ? (rng.bool() ? 1 : -1) : sign;
	return s * rng.int(1, 40) * 10;
};

interface Plan {
	resource: string;
	title: string;
	initial: number;
	iso: Isolation;
	scripts: Op[][];
	measure: 'lost' | 'oversold' | 'dirty';
}

function plan(rng: Rng, level: string, classId: string): Plan {
	const senior = level === 'senior';
	const rmw = (w: string, d: number): Op[] => [
		{ w, op: 'read' },
		{ w, op: 'write', d }
	];
	const tx = (w: string, d: number, end: 'commit' | 'rollback'): Op[] => [
		{ w, op: 'begin' },
		{ w, op: 'read' },
		{ w, op: 'write', d },
		{ w, op: end }
	];
	switch (classId) {
		case 'lost-update': {
			if (!senior)
				return {
					resource: 'balance',
					title: 'баланс счёта',
					initial: rng.int(50, 500) * 10,
					iso: 'none',
					scripts: ['w1', 'w2'].map((w) => [...rmw(w, delta(rng)), ...rmw(w, delta(rng))]),
					measure: 'lost'
				};
			const rollbackW = rng.pick(['w1', 'w2', 'w3']);
			const twice = rng.pick(['w1', 'w2', 'w3']);
			return {
				resource: 'balance',
				title: 'баланс счёта',
				initial: rng.int(50, 500) * 10,
				iso: 'read-committed',
				scripts: ['w1', 'w2', 'w3'].map((w) => [
					...tx(w, delta(rng), w === rollbackW ? 'rollback' : 'commit'),
					...(w === twice ? tx(w, delta(rng), 'commit') : [])
				]),
				measure: 'lost'
			};
		}
		case 'check-then-act': {
			const initial = rng.int(12, 60);
			const reserve = (w: string): Op[] => {
				const q = rng.int(3, Math.floor(initial * 0.7));
				return [
					{ w, op: 'read' },
					{ w, op: 'check', q },
					{ w, op: 'write', d: -q }
				];
			};
			if (!senior)
				return {
					resource: 'stock',
					title: 'остаток товара на складе',
					initial,
					iso: 'none',
					scripts: (rng.bool() ? ['w1', 'w2'] : ['w1', 'w2', 'w3']).map((w) => reserve(w)),
					measure: 'oversold'
				};
			return {
				resource: 'stock',
				title: 'остаток товара на складе',
				initial,
				iso: 'none',
				scripts: [
					[...reserve('w1'), ...reserve('w1')],
					reserve('w2'),
					Array.from({ length: rng.int(1, 2) }, () => ({ w: 'w3', op: 'add' as const, d: rng.int(2, 12) }))
				],
				measure: 'oversold'
			};
		}
		case 'dirty-read': {
			const scripts = [tx('w1', delta(rng, -1), 'rollback'), tx('w2', delta(rng, 1), 'commit')];
			if (senior) scripts.push(tx('w3', delta(rng), 'commit'));
			return {
				resource: 'balance',
				title: 'баланс счёта',
				initial: rng.int(50, 500) * 10,
				iso: 'read-uncommitted',
				scripts,
				measure: 'dirty'
			};
		}
		default: {
			const adds = (w: string, n: number): Op[] =>
				Array.from({ length: n }, () => ({ w, op: 'add' as const, d: rng.int(1, 9) }));
			const up = () => rng.int(1, 9);
			const scripts = senior
				? [[...rmw('w1', up()), ...rmw('w1', up())], rmw('w2', up()), adds('w3', rng.int(2, 3))]
				: [[...rmw('w1', up()), ...rmw('w1', up())], adds('w2', rng.int(2, 3))];
			return {
				resource: 'views',
				title: 'счётчик просмотров',
				initial: rng.int(100, 999),
				iso: 'none',
				scripts,
				measure: 'lost'
			};
		}
	}
}

function render(p: Plan, ops: readonly Op[]): string[] {
	const sign = (d: number) => (d < 0 ? `− ${-d}` : `+ ${d}`);
	return ops.map((o, i) => {
		const n = String(i + 1).padStart(2, '0');
		let text: string;
		switch (o.op) {
			case 'begin':
				text = 'BEGIN';
				break;
			case 'read':
				text = `READ ${p.resource}`;
				break;
			case 'check':
				text = `CHECK прочитанное ≥ ${o.q ?? 0} — резерв ${o.q ?? 0} шт. подтверждён`;
				break;
			case 'write':
				text = `WRITE ${p.resource} = прочитанное ${sign(o.d ?? 0)}`;
				break;
			case 'commit':
				text = 'COMMIT';
				break;
			case 'rollback':
				text = 'ROLLBACK';
				break;
			case 'add':
				text = `ADD ${p.resource} ${sign(o.d ?? 0)} (атомарно)`;
				break;
		}
		return `${n}  ${o.w}  ${text}`;
	});
}

function describe(p: Plan, ops: readonly Op[], level: string): string {
	const rules: string[] = [
		`\`READ\` — обработчик читает ${p.title} в своё «прочитанное»; \`WRITE\` — записывает значение, посчитанное от своего последнего прочитанного.`
	];
	if (ops.some((o) => o.op === 'add'))
		rules.push('`ADD` — атомарное приращение: к текущему значению в базе, без чтения в обработчик.');
	if (ops.some((o) => o.op === 'check'))
		rules.push('`CHECK` — обработчик проверяет своё прочитанное значение; все проверки в журнале прошли.');
	if (p.iso === 'read-committed')
		rules.push(
			'Транзакции (`BEGIN` … `COMMIT` или `ROLLBACK`) с уровнем изоляции READ COMMITTED: чтение видит только зафиксированное значение; запись транзакции попадает в базу при `COMMIT`; `ROLLBACK` её отменяет.'
		);
	if (p.iso === 'read-uncommitted')
		rules.push(
			'Транзакции (`BEGIN` … `COMMIT` или `ROLLBACK`) с уровнем изоляции READ UNCOMMITTED: чтение видит последнее записанное значение, даже незафиксированное; `COMMIT` фиксирует запись транзакции; `ROLLBACK` возвращает значение, которое было до записи этой транзакции.'
		);
	const question =
		p.measure === 'lost'
			? [
					`Обновление — ${p.iso === 'read-committed' ? '`COMMIT` транзакции с записью' : '`WRITE` или `ADD`'}. Обновление потеряно, если следующее за ним обновление сделано по значению, прочитанному **до** него${ops.some((o) => o.op === 'add') ? ' (у `ADD` чтение — в момент самого `ADD`)' : ''}.`,
					'',
					`Введите итоговое значение \`${p.resource}\` в базе и число потерянных обновлений через пробел. Например: \`1250 1\`.`
				]
			: p.measure === 'oversold'
				? [
						`Продано сверх остатка — сумма подтверждённых резервов минус начальный остаток и поступления (\`ADD\`); если разность не больше 0 — 0.`,
						'',
						`Введите итоговое значение \`${p.resource}\` в базе и число единиц, проданных сверх остатка, через пробел. Например: \`3 2\`.`
					]
				: [
						`Введите итоговое значение \`${p.resource}\` в базе и номер записи журнала, где транзакция впервые прочитала незафиксированное значение, которое потом откатили, через пробел. Например: \`1250 4\`.`
					];
	return [
		`Обработчики ${level === 'senior' ? 'w1, w2 и w3' : 'параллельно'} работают с одним значением — ${p.title} \`${p.resource}\`; в начале оно равно ${p.initial}. Журнал — в порядке фактического выполнения операций:`,
		'',
		'```',
		...render(p, ops),
		'```',
		'',
		...rules.map((r) => `- ${r}`),
		'',
		...question
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
iso = d["isolation"]
committed = latest = d["initial"]
local, read_at, pending = {}, {}, {}
dirty_writer = None
updates = []
dirty_reads = []
rolled_back = set()
reserved = added = 0
for i, o in enumerate(d["ops"]):
    w, op = o["w"], o["op"]
    if op == "read":
        if iso == "read-uncommitted" and dirty_writer not in (None, w):
            dirty_reads.append((i, dirty_writer))
        local[w] = committed if iso == "read-committed" else latest
        read_at[w] = i
    elif op == "check":
        reserved += o["q"]
    elif op == "write":
        value = local[w] + o["d"]
        if iso == "none":
            committed = latest = value
            updates.append((i, read_at[w]))
        else:
            pending[w] = value
            if iso == "read-uncommitted":
                latest = value
                dirty_writer = w
    elif op == "commit":
        if w in pending:
            committed = pending.pop(w)
            updates.append((i, read_at[w]))
        latest = committed
        if dirty_writer == w:
            dirty_writer = None
    elif op == "rollback":
        pending.pop(w, None)
        latest = committed
        if dirty_writer == w:
            dirty_writer = None
        rolled_back.add(w)
    elif op == "add":
        committed += o["d"]
        latest += o["d"]
        added += o["d"]
        updates.append((i, i))
if d["measure"] == "lost":
    lost = sum(1 for a, b in zip(updates, updates[1:]) if b[1] < a[0])
    print(committed, lost)
elif d["measure"] == "oversold":
    print(committed, max(0, reserved - d["initial"] - added))
else:
    first = min(t for t, writer in dirty_reads if writer in rolled_back)
    print(committed, first + 1)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'lost-update': ['sequential', 'counts-overwrites'],
	'check-then-act': ['sequential', 'negative-stock'],
	'dirty-read': ['sequential'],
	'mixed-atomic': ['sequential', 'counts-overwrites']
};

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[cls.id] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = plan(rng, input.grade, cls.id);
		const ops = interleave(rng, p.scripts);
		const o = simulate(ops, p.initial, p.iso);
		if (o.invalid) continue;
		const second =
			p.measure === 'lost'
				? o.lost
				: p.measure === 'oversold'
					? Math.max(0, o.reserved - p.initial - o.added)
					: o.dirty;
		if (second === null || second === 0) continue;
		const answer = `${o.final} ${second}`;
		const candidates: Record<string, string | null> = {
			sequential: p.measure === 'oversold' ? `${p.initial + o.added - o.reserved} ${second}` : `${o.sequential} 0`,
			'counts-overwrites': p.measure === 'lost' ? `${o.final} ${o.overwrites}` : null,
			'negative-stock': p.measure === 'oversold' ? `${o.final} ${Math.max(0, -o.final)}` : null
		};
		const wrong = Object.fromEntries(
			Object.entries(candidates).map(([id, v]) => [id, v === null || v === answer ? null : v])
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, ops, input.grade), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({ initial: p.initial, isolation: p.iso, measure: p.measure, ops });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, v]) => [
						id,
						v === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value: v } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no log for ${input.grade}/${cls.id} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
