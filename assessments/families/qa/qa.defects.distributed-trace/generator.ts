// A distributed trace of one request: spans with their parent, service, operation, start, duration, status and retry
// attempt. Root cause: walk down the failure from the root — a failed span is explained by a call of its own whose
// last attempt failed or was cancelled on the parent's timeout — to the span nothing below explains. Latency: the
// critical path follows the child that finished last; a service's share of it is the self time of its spans there.
// The signal to read is the essential class; services, ids and times are surface.
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

type Status = 'OK' | 'ERROR' | 'DEADLINE_EXCEEDED' | 'CANCELLED';

interface Node {
	id: string;
	service: string;
	op: string;
	status: Status;
	attempt: number | null;
	children: Node[];
	parallel: boolean;
	dur: number;
	offset: number;
	start: number;
	depth: number;
	parent: Node | null;
}

const CALLS: readonly [string, string][] = [
	['orders', 'CreateOrder'],
	['payments', 'Charge'],
	['inventory', 'Reserve'],
	['pricing', 'Quote'],
	['users', 'GetProfile'],
	['fraud', 'Score'],
	['ledger', 'Post'],
	['notifications', 'Send'],
	['catalog', 'GetItems'],
	['shipping', 'Estimate'],
	['bank-api', 'Authorize'],
	['cache', 'GET'],
	['db', 'SELECT'],
	['db', 'UPDATE'],
	['search', 'Query'],
	['coupons', 'Validate']
];

const FAILED: readonly Status[] = ['ERROR', 'DEADLINE_EXCEEDED'];

class Tree {
	readonly rng: Rng;
	readonly ids = new Set<string>();
	constructor(rng: Rng) {
		this.rng = rng;
	}

	id(): string {
		for (;;) {
			const id = this.rng.int(0x1000, 0xffff).toString(16);
			if (!this.ids.has(id)) {
				this.ids.add(id);
				return id;
			}
		}
	}

	node(parent: Node | null, status: Status = 'OK', call?: readonly [string, string]): Node {
		const used = new Set((parent?.children ?? []).map((c) => `${c.service} ${c.op}`));
		const [service, op] =
			call ?? this.rng.pick(CALLS.filter(([s, o]) => !used.has(`${s} ${o}`) && s !== parent?.service));
		const n: Node = {
			id: this.id(),
			service,
			op,
			status,
			attempt: null,
			children: [],
			parallel: this.rng.bool(0.4),
			dur: 0,
			offset: 0,
			start: 0,
			depth: parent ? parent.depth + 1 : 0,
			parent
		};
		parent?.children.push(n);
		return n;
	}

	/** OK calls below `parent`, `levels` deep at most. */
	grow(parent: Node, count: number, levels: number, density = 0.5, fanout = 2): void {
		for (let i = 0; i < count; i += 1) {
			const n = this.node(parent);
			if (levels > 1 && this.rng.bool(density)) this.grow(n, this.rng.int(1, fanout), levels - 1, density, fanout);
		}
	}
}

/** Durations bottom-up, offsets within the parent; retries of one call always run one after another. */
function layout(rng: Rng, n: Node): void {
	if (n.children.length === 0) {
		n.dur = rng.int(4, 160);
		return;
	}
	for (const c of n.children) layout(rng, c);
	const retried = n.children.some((c) => c.attempt !== null);
	if (n.parallel && !retried) {
		for (const c of n.children) c.offset = rng.int(1, 9);
	} else {
		let t = rng.int(1, 6);
		for (const c of n.children) {
			c.offset = t;
			t = c.offset + c.dur + rng.int(1, 8);
		}
	}
	n.dur = Math.max(...n.children.map((c) => c.offset + c.dur)) + rng.int(1, 12);
}

function place(n: Node, start: number): void {
	n.start = start;
	for (const c of n.children) place(c, start + c.offset);
}

/** A span that ended at `deadline`: its last call, when cancelled, is cut off right before it (a cascade goes down). */
function cut(n: Node, deadline: number): void {
	n.dur = deadline;
	const last = n.children[n.children.length - 1];
	if (last && last.status === 'CANCELLED') cut(last, deadline - last.offset - 1);
}

function all(n: Node): Node[] {
	return [n, ...n.children.flatMap(all)];
}

/** The last attempt of every call of a span. */
function finals(n: Node): Node[] {
	const last = new Map<string, Node>();
	for (const c of n.children) last.set(`${c.service} ${c.op}`, c);
	return [...last.values()];
}

/** The root cause, or `null` when a span is explained by two calls (the trace is ambiguous). */
function rootCause(n: Node): Node | null {
	const calls = finals(n);
	const explaining = FAILED.includes(n.status)
		? calls.filter((c) => c.status !== 'OK')
		: n.status === 'CANCELLED'
			? calls.filter((c) => c.status === 'CANCELLED')
			: [];
	if (explaining.length === 0) return n;
	if (explaining.length > 1) return null;
	return rootCause(explaining[0] as Node);
}

function criticalPath(n: Node, pick: (children: Node[]) => Node | null): Node[] | null {
	if (n.children.length === 0) return [n];
	const next = pick(n.children);
	if (!next) return null;
	const rest = criticalPath(next, pick);
	return rest ? [n, ...rest] : null;
}

/** The child with the unique largest value of `key`; `null` on a tie. */
const unique =
	(key: (c: Node) => number) =>
	(children: Node[]): Node | null => {
		const best = Math.max(...children.map(key));
		const top = children.filter((c) => key(c) === best);
		return top.length === 1 ? (top[0] ?? null) : null;
	};
const latestEnd = unique((c) => c.offset + c.dur);
const longest = unique((c) => c.dur);

function selfTime(path: readonly Node[], service: string): number {
	return path.reduce((sum, n, i) => {
		const next = path[i + 1];
		return n.service === service ? sum + n.dur - (next ? next.dur : 0) : sum;
	}, 0);
}

interface Built0 {
	root: Node;
	measure: 'cause' | 'path' | 'latency';
	service?: string;
	answer: string;
	wrong: Record<string, string | null>;
}

function chain(t: Tree, root: Node, depth: number): Node[] {
	const out: Node[] = [];
	let parent = root;
	for (let i = 0; i < depth; i += 1) {
		const n = t.node(parent, 'ERROR');
		if (t.rng.bool(0.5)) t.grow(n, 1, 1);
		// The failing call comes last among its siblings: the parent gives up after it.
		parent.children.push(...parent.children.splice(parent.children.indexOf(n), 1));
		out.push(n);
		parent = n;
	}
	return out;
}

function scenario(rng: Rng, level: string, classId: string): Built0 | null {
	const t = new Tree(rng);
	const senior = level === 'senior';
	const root = t.node(null, 'OK', ['gateway', rng.pick(['POST /checkout', 'POST /orders', 'GET /cart'])]);
	if (classId === 'critical-path' || classId === 'service-latency') {
		root.parallel = true;
		t.grow(root, rng.int(2, 3), senior ? 4 : 3, 0.75, senior ? 3 : 2);
		for (const n of all(root)) if (n.children.length > 0 && rng.bool(0.6)) n.parallel = true;
		layout(rng, root);
		place(root, 0);
		const right = criticalPath(root, latestEnd);
		const wrongPath = criticalPath(root, longest);
		if (!right || right.length < 3) return null;
		if (classId === 'critical-path') {
			const ids = (p: Node[] | null) => (p ? p.map((n) => n.id).join(' ') : null);
			return { root, measure: 'path', answer: ids(right) ?? '', wrong: { 'longest-child': ids(wrongPath) } };
		}
		const onPath = right.filter((n) => n !== root).map((n) => n.service);
		const service = rng.pick(onPath);
		const sum = all(root)
			.filter((n) => n.service === service)
			.reduce((s, n) => s + n.dur, 0);
		return {
			root,
			measure: 'latency',
			service,
			answer: String(selfTime(right, service)),
			wrong: {
				'all-spans': String(sum),
				'longest-child': wrongPath ? String(selfTime(wrongPath, service)) : null
			}
		};
	}
	root.status = 'ERROR';
	t.grow(root, rng.int(1, 2), 2);
	const wrong: Record<string, string | null> = { 'root-span': root.id };
	if (classId === 'timeout' || classId === 'timeout-cascade') {
		const above = senior || rng.bool() ? chain(t, root, 1) : [];
		const top = above[above.length - 1] ?? root;
		const timedOut = t.node(top, 'DEADLINE_EXCEEDED');
		timedOut.parallel = false;
		if (rng.bool(0.7)) t.node(timedOut);
		const cancelled = t.node(timedOut, 'CANCELLED');
		cancelled.parallel = false;
		let deepest = cancelled;
		if (classId === 'timeout-cascade') {
			t.node(cancelled);
			deepest = t.node(cancelled, 'CANCELLED');
			wrong['first-cancelled'] = cancelled.id;
		}
		wrong['reported-timeout'] = timedOut.id;
		wrong.shallow = (above[0] ?? timedOut).id;
		layout(rng, root);
		// A round deadline after every finished call of the chain.
		const need = cancelled.offset + (deepest === cancelled ? 0 : deepest.offset) + 60;
		const deadlines = [300, 500, 800, 1000, 1500, 2000, 3000].filter((x) => x > need + 40);
		if (deadlines.length === 0) return null;
		const deadline = rng.pick(deadlines);
		cut(timedOut, deadline);
		layout2(rng, root);
		place(root, 0);
		return { root, measure: 'cause', answer: deepest.id, wrong };
	}
	const depth = senior ? rng.int(3, 4) : rng.int(2, 3);
	const failing = chain(t, root, depth);
	const bottom = failing[failing.length - 1] as Node;
	wrong.shallow = failing[0]?.id ?? null;
	let cause = bottom;
	if (classId === 'retry-chain') {
		// The failing call is retried; every attempt fails.
		const parent = bottom.parent as Node;
		const attempts = rng.int(2, 3);
		parent.children.splice(parent.children.indexOf(bottom), 1);
		bottom.children = [];
		const tries: Node[] = [];
		for (let a = 1; a <= attempts; a += 1) {
			const n = t.node(parent, 'ERROR', [bottom.service, bottom.op]);
			n.attempt = a;
			tries.push(n);
		}
		cause = tries[tries.length - 1] as Node;
		wrong['first-attempt'] = tries[0]?.id ?? null;
		wrong.shallow = failing.length > 1 ? (failing[0]?.id ?? null) : null;
	}
	if (classId === 'retries' || (classId === 'retry-chain' && rng.bool(0.5))) {
		// A call next to the failure whose first attempt failed and the retry succeeded.
		const host = rng.pick(all(root).filter((n) => n.status !== 'OK' && n !== cause && n.attempt === null));
		const call = rng.pick(CALLS.filter(([s, o]) => !host.children.some((c) => c.service === s && c.op === o)));
		const first = t.node(host, 'ERROR', call);
		const second = t.node(host, 'OK', call);
		first.attempt = 1;
		second.attempt = 2;
		// Recovered calls come before the failing one.
		host.children = [
			...host.children.filter((c) => c.status === 'OK' || c.attempt !== null),
			...host.children.filter((c) => c.status !== 'OK' && c.attempt === null)
		];
		if (classId === 'retries') wrong['first-attempt'] = first.id;
	}
	if (classId === 'tolerated') {
		// An optional call fails deeper than the root cause; its parent tolerates it and ends OK.
		const host = t.node(root);
		let parent = host;
		for (let d = 1; d < depth; d += 1) parent = t.node(parent);
		const optional = t.node(parent, 'ERROR');
		const deepest = all(root)
			.filter((n) => n.status === 'ERROR')
			.sort((a, b) => b.depth - a.depth)[0];
		wrong['deepest-error'] = deepest && deepest.depth > cause.depth ? optional.id : null;
	}
	layout(rng, root);
	place(root, 0);
	return { root, measure: 'cause', answer: cause.id, wrong };
}

/** Re-lays out the ancestors of a cut span so that every parent still covers its children. */
function layout2(rng: Rng, n: Node): void {
	for (const c of n.children) layout2(rng, c);
	if (n.children.length === 0 || n.status === 'DEADLINE_EXCEEDED' || n.status === 'CANCELLED') return;
	const retried = n.children.some((c) => c.attempt !== null);
	if (!(n.parallel && !retried)) {
		let t = n.children[0]?.offset ?? 1;
		for (const c of n.children) {
			c.offset = t;
			t = c.offset + c.dur + rng.int(1, 8);
		}
	}
	n.dur = Math.max(...n.children.map((c) => c.offset + c.dur)) + rng.int(1, 12);
}

function table(root: Node): string[] {
	const spans = all(root).sort((a, b) => a.start - b.start || a.depth - b.depth || a.id.localeCompare(b.id));
	const retries = spans.some((s) => s.attempt !== null);
	const head = `span  parent  ${'service'.padEnd(14)}${'operation'.padEnd(16)}${'start'.padStart(6)}${'dur'.padStart(7)}  ${'status'.padEnd(18)}${retries ? 'attempt' : ''}`;
	return [
		head.trimEnd(),
		...spans.map((s) =>
			`${s.id.padEnd(6)}${(s.parent?.id ?? '-').padEnd(8)}${s.service.padEnd(14)}${s.op.padEnd(16)}${String(s.start).padStart(6)}${String(s.dur).padStart(7)}  ${s.status.padEnd(18)}${s.attempt === null ? '' : String(s.attempt)}`.trimEnd()
		)
	];
}

function describe(b: Built0): string {
	const intro =
		'Трасса одного запроса: каждый спан — вызов операции сервиса; `parent` — спан, который сделал этот вызов; `start` — начало от начала запроса, `dur` — длительность, обе в миллисекундах.';
	if (b.measure !== 'cause') {
		const rules = [
			'Критический путь строится от корня: на каждом шаге переходят к тому ребёнку текущего спана, который **закончился последним** (`start` + `dur` наибольшие); путь кончается на спане без детей.'
		];
		if (b.measure === 'latency')
			rules.push(
				'Вклад спана пути — его `dur` минус `dur` следующего спана пути; у последнего спана — весь `dur`. Вклад сервиса — сумма вкладов его спанов на пути.'
			);
		return [
			intro,
			'',
			'```',
			...table(b.root),
			'```',
			'',
			...rules.map((r) => `- ${r}`),
			'',
			b.measure === 'path'
				? 'Введите идентификаторы спанов критического пути от корня к листу через пробел. Например: `a1f3 07bc 9e2d`.'
				: `Сколько миллисекунд на критическом пути приходится на сервис \`${b.service}\`? Введите число. Например: \`245\`.`
		].join('\n');
	}
	return [
		intro,
		'',
		'```',
		...table(b.root),
		'```',
		'',
		'- Повторы вызова — отдельные спаны с тем же родителем, сервисом и операцией и номером попытки `attempt`; результат вызова — статус его последней попытки.',
		'- Спан с ошибкой (`ERROR` или `DEADLINE_EXCEEDED`) объясняется вызовом, результат которого — ошибка или `CANCELLED` (родитель не дождался ответа и по тайм-ауту отменил вызов). Отменённый спан объясняется своим вызовом, который тоже отменён.',
		'- Спан со статусом `OK` сбоем не считается, даже если какой-то его необязательный вызов завершился ошибкой.',
		'- Первопричина — спан, к которому приводит цепочка объяснений от корня и который сам ничем не объясняется.',
		'',
		'Введите идентификатор спана-первопричины. Например: `9f3c`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
spans = {s["id"]: s for s in d["spans"]}
children = {}
for s in d["spans"]:
    children.setdefault(s["parent"], []).append(s)
for kids in children.values():
    kids.sort(key=lambda s: (s["start"], s["attempt"] or 0))
root = children[None][0]


def calls(span):
    last = {}
    for c in children.get(span["id"], []):
        key = (c["service"], c["op"])
        if key not in last or (c["attempt"] or 0) > (last[key]["attempt"] or 0):
            last[key] = c
    return list(last.values())


def cause(span):
    if span["status"] in ("ERROR", "DEADLINE_EXCEEDED"):
        why = [c for c in calls(span) if c["status"] != "OK"]
    elif span["status"] == "CANCELLED":
        why = [c for c in calls(span) if c["status"] == "CANCELLED"]
    else:
        why = []
    assert len(why) <= 1
    return cause(why[0]) if why else span


def path(span):
    out = [span]
    while children.get(span["id"]):
        kids = children[span["id"]]
        end = max(c["start"] + c["dur"] for c in kids)
        top = [c for c in kids if c["start"] + c["dur"] == end]
        assert len(top) == 1
        span = top[0]
        out.append(span)
    return out


if d["measure"] == "cause":
    print(cause(root)["id"])
elif d["measure"] == "path":
    print(" ".join(s["id"] for s in path(root)))
else:
    p = path(root)
    total = 0
    for i, s in enumerate(p):
        if s["service"] == d["service"]:
            total += s["dur"] - (p[i + 1]["dur"] if i + 1 < len(p) else 0)
    print(total)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/propagated': ['root-span', 'shallow'],
	'middle/retries': ['first-attempt', 'root-span'],
	'middle/timeout': ['reported-timeout', 'root-span'],
	'middle/critical-path': ['longest-child'],
	'senior/retry-chain': ['first-attempt', 'root-span'],
	'senior/tolerated': ['deepest-error', 'root-span'],
	'senior/timeout-cascade': ['first-cancelled', 'reported-timeout'],
	'senior/service-latency': ['all-spans']
};

const WRONG_IDS = descriptor.wrongSolutions.map((w) => w.id);

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${cls.id}`;
	const required = REQUIRED[where] ?? [];
	const [minSpans, maxSpans] = input.grade === 'middle' ? [8, 13] : [12, 20];
	for (let tries = 0; tries < 500; tries += 1) {
		const b = scenario(rng, input.grade, cls.id);
		if (!b) continue;
		const spans = all(b.root);
		if (spans.length < minSpans || spans.length > maxSpans) continue;
		if (b.measure === 'cause' && rootCause(b.root)?.id !== b.answer) continue;
		const wrong = Object.fromEntries(
			WRONG_IDS.map((id) => {
				const v = b.wrong[id];
				return [id, v === undefined || v === null || v === b.answer ? null : v];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(b), code: null },
			answer: { kind: 'tokens', value: b.answer }
		});
		const stdin = JSON.stringify({
			measure: b.measure,
			service: b.service ?? null,
			spans: spans.map((s) => ({
				id: s.id,
				parent: s.parent?.id ?? null,
				service: s.service,
				op: s.op,
				start: s.start,
				dur: s.dur,
				status: s.status,
				attempt: s.attempt
			}))
		});
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
	throw new Error(`${descriptor.key}: no trace for ${where} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
