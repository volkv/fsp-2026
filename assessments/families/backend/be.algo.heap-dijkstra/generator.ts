// Dijkstra's algorithm with a binary heap and lazy deletion: the order in which vertices are settled, with ties broken
// by the vertex number, and how many stale heap entries the run skips.
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

interface Rules {
	fifoTies: boolean;
	noStale: boolean;
	firstDiscovery: boolean;
	relaxOnEqual: boolean;
	stopAtDiscovery: boolean;
}

const RIGHT: Rules = {
	fifoTies: false,
	noStale: false,
	firstDiscovery: false,
	relaxOnEqual: false,
	stopAtDiscovery: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'fifo-ties': { fifoTies: true },
	'no-stale': { noStale: true },
	'first-discovery': { firstDiscovery: true },
	'relax-on-equal': { relaxOnEqual: true },
	'stop-at-discovery': { stopAtDiscovery: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/ties': ['fifo-ties'],
	'middle/stale': ['no-stale', 'first-discovery'],
	'middle/equal-paths': ['relax-on-equal'],
	'middle/early-stop': ['stop-at-discovery']
};

interface Edge {
	from: number;
	to: number;
	w: number;
}

interface Params {
	n: number;
	start: number;
	edges: Edge[];
	/** The early-stop class: the run stops once this vertex is settled. */
	target: number | null;
}

/**
 * Simulates the run: settled vertices in order, then the count of skipped stale entries; with a target, the settled
 * vertices up to the target and then its distance.
 */
function simulate(p: Params, rules: Rules): string {
	const adj = new Map<number, Edge[]>();
	for (const e of p.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e]);
	const dist = new Map<number, number>([[p.start, 0]]);
	const done = new Set<number>();
	// Heap entries with their push sequence: the right order is (distance, vertex), the misconception (distance, push).
	let seq = 0;
	let heap: { d: number; v: number; seq: number }[] = [{ d: 0, v: p.start, seq: seq++ }];
	const order: number[] = [];
	let stale = 0;
	while (heap.length) {
		heap.sort((a, b) => a.d - b.d || (rules.fifoTies ? a.seq - b.seq : a.v - b.v));
		const top = heap.shift() as { d: number; v: number };
		if (done.has(top.v)) {
			stale += 1;
			continue;
		}
		done.add(top.v);
		order.push(top.v);
		if (p.target !== null && top.v === p.target) return [...order, top.d].join(' ');
		for (const e of adj.get(top.v) ?? []) {
			if (done.has(e.to)) continue;
			const nd = top.d + e.w;
			const known = dist.get(e.to);
			const better =
				known === undefined || (rules.firstDiscovery ? false : rules.relaxOnEqual ? nd <= known : nd < known);
			if (!better) continue;
			if (rules.stopAtDiscovery && e.to === p.target && known === undefined) return [...order, nd].join(' ');
			dist.set(e.to, nd);
			if (rules.noStale) heap = heap.filter((h) => h.v !== e.to);
			heap.push({ d: nd, v: e.to, seq: seq++ });
		}
	}
	return [...order, stale].join(' ');
}

function scenario(rng: Rng, classId: string): Params {
	const n = rng.int(6, 7);
	const start = 1;
	const edges: Edge[] = [];
	const has = (a: number, b: number) => edges.some((e) => e.from === a && e.to === b);
	const add = (a: number, b: number, w: number) => {
		if (a !== b && b !== start && !has(a, b)) edges.push({ from: a, to: b, w });
	};
	// A spanning path from the start so every vertex is reachable, in a random order.
	const others = rng.shuffle(Array.from({ length: n - 1 }, (_, i) => i + 2));
	let prev = start;
	for (const v of others) {
		add(rng.pick([prev, start, ...others.slice(0, others.indexOf(v))]), v, rng.int(1, 9));
		prev = v;
	}
	const edgeCount = rng.int(10, 12);
	const weights: Record<string, () => number> = {
		ties: () => rng.pick([1, 2, 2, 3, 3, 4]),
		stale: () => rng.int(1, 9),
		'equal-paths': () => rng.pick([1, 2, 3, 4, 5])
	};
	const weight = weights[classId] ?? (() => rng.int(1, 9));
	for (let i = 0; i < 100 && edges.length < edgeCount; i += 1) add(rng.int(1, n), rng.int(2, n), weight());
	const target = classId === 'early-stop' ? rng.int(2, n) : null;
	return { n, start, edges: rng.shuffle(edges).sort((a, b) => a.from - b.from), target };
}

function describe(p: Params): string {
	const bySource = new Map<number, Edge[]>();
	for (const e of p.edges) bySource.set(e.from, [...(bySource.get(e.from) ?? []), e]);
	const lines = [...bySource.keys()]
		.sort((a, b) => a - b)
		.map((v) => `- из ${v}: ${(bySource.get(v) ?? []).map((e) => `в ${e.to} (вес ${e.w})`).join(', ')}`);
	return [
		`Ориентированный граф, вершины 1–${p.n}. Рёбра перечислены для каждой вершины в том порядке, в котором алгоритм их просматривает:`,
		'',
		...lines,
		'',
		`Алгоритм Дейкстры из вершины ${p.start} с двоичной кучей и ленивым удалением:`,
		'',
		'```',
		`dist = {${p.start}: 0}`,
		'done = set()',
		`heap = [(0, ${p.start})]`,
		'while heap:',
		'    d, v = heappop(heap)          # наименьшая пара: сначала по d, при равенстве — меньший номер',
		'    if v in done:',
		'        continue                  # устаревшая запись — пропуск',
		'    done.add(v)',
		...(p.target === null ? [] : [`    if v == ${p.target}:`, '        break']),
		'    for w, cost in edges[v]:      # в порядке перечисления',
		'        if w not in done and (w not in dist or d + cost < dist[w]):',
		'            dist[w] = d + cost',
		'            heappush(heap, (d + cost, w))',
		'```',
		'',
		p.target === null
			? 'Введите через пробел номера вершин в том порядке, в котором они попадают в `done`, а последним числом — сколько раз ' +
				'сработал пропуск устаревшей записи (`continue`) за всё время работы, пока куча не опустеет. Например: `1 4 2 3 5 6 2`.'
			: 'Введите через пробел номера вершин в том порядке, в котором они попадают в `done` до остановки (включая ' +
				`вершину ${p.target}), а последним числом — \`dist[${p.target}]\` в момент остановки. Например: \`1 4 2 3 11\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
edges = {}
for e in p["edges"]:
    edges.setdefault(e["from"], []).append((e["to"], e["w"]))
start = p["start"]
best = {start: 0}
settled = []
pending = [(0, start)]
skipped = 0
while pending:
    item = min(pending)
    pending.remove(item)
    d, v = item
    if v in settled:
        skipped += 1
        continue
    settled.append(v)
    if v == p["target"]:
        break
    for w, cost in edges.get(v, []):
        if w in settled:
            continue
        if w not in best or d + cost < best[w]:
            best[w] = d + cost
            pending.append((d + cost, w))
if p["target"] is None:
    print(*settled, skipped)
else:
    print(*settled, best[p["target"]])
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Graphs are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// In the stale class the greedy misconception must also change the order, not only the count.
		const orderOf = (value: string) => value.split(' ').slice(0, -1).join(' ');
		if (input.classId === 'stale' && orderOf(wrong['first-discovery'] ?? answer) === orderOf(answer)) continue;
		// In the early-stop class the target settles late and its first tentative distance is not the final one.
		const lastOf = (value: string) => value.split(' ').pop();
		if (
			input.classId === 'early-stop' &&
			(answer.split(' ').length < 5 || lastOf(wrong['stop-at-discovery'] ?? answer) === lastOf(answer))
		)
			continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
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
	throw new Error(`${descriptor.key}: no graph for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
