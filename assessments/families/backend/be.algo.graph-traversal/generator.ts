// Graph traversal read from code: the visiting order of BFS and DFS over adjacency lists in their given order, BFS
// levels, iterative DFS with a stack, Kahn's topological sort with the smallest ready vertex, and a cycle it leaves.
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
	sortedNeighbours: boolean;
	queueAsStack: boolean;
	postIsReversedPre: boolean;
	dfsDepth: boolean;
	kahnFifo: boolean;
	cycleOnly: boolean;
	stackAsRecursion: boolean;
	oneWayEdges: boolean;
	lastParent: boolean;
}

const RIGHT: Rules = {
	sortedNeighbours: false,
	queueAsStack: false,
	postIsReversedPre: false,
	dfsDepth: false,
	kahnFifo: false,
	cycleOnly: false,
	stackAsRecursion: false,
	oneWayEdges: false,
	lastParent: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'sorted-neighbours': { sortedNeighbours: true },
	'queue-as-stack': { queueAsStack: true },
	'post-is-reversed-pre': { postIsReversedPre: true },
	'dfs-depth': { dfsDepth: true },
	'kahn-fifo': { kahnFifo: true },
	'cycle-only': { cycleOnly: true },
	'stack-as-recursion': { stackAsRecursion: true },
	'one-way-edges': { oneWayEdges: true },
	'last-parent': { lastParent: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/bfs-order': ['sorted-neighbours', 'queue-as-stack'],
	'intern/dfs-recursive': ['sorted-neighbours', 'post-is-reversed-pre'],
	'intern/bfs-levels': ['dfs-depth'],
	'junior/kahn-min': ['kahn-fifo'],
	'junior/kahn-cycle': ['cycle-only', 'kahn-fifo'],
	'junior/dfs-stack': ['stack-as-recursion'],
	'intern/components': ['one-way-edges'],
	'junior/bfs-path': ['last-parent']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

type Graph = Map<string, string[]>;

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

function graphLines(name: string, g: Graph, order: readonly string[]): string[] {
	return [
		`${name} = {`,
		...order.map((v) => `    '${v}': [${(g.get(v) ?? []).map((w) => `'${w}'`).join(', ')}],`),
		'}'
	];
}

const neighbours = (g: Graph, v: string, rules: Rules) => {
	const ws = g.get(v) ?? [];
	return rules.sortedNeighbours ? [...ws].sort() : ws;
};

/** A directed graph on n letters: every vertex has 1–3 out-edges in random order; sinks allowed. */
function randomGraph(rng: Rng, n: number, sinks: number): Graph {
	const vs = LETTERS.slice(0, n);
	const sinkSet = new Set(rng.sample(vs.slice(1), sinks));
	const g: Graph = new Map();
	for (const v of vs) {
		if (sinkSet.has(v)) {
			g.set(v, []);
			continue;
		}
		const targets = rng.sample(
			vs.filter((w) => w !== v),
			rng.int(1, 3)
		);
		g.set(v, targets);
	}
	return g;
}

function bfs(g: Graph, start: string, rules: Rules): string[] {
	const seen = new Set([start]);
	const order: string[] = [];
	const queue = [start];
	while (queue.length) {
		const v = (rules.queueAsStack ? queue.pop() : queue.shift()) as string;
		order.push(v);
		for (const w of neighbours(g, v, rules)) {
			if (!seen.has(w)) {
				seen.add(w);
				queue.push(w);
			}
		}
	}
	return order;
}

function bfsOrder(rng: Rng): Program {
	const n = rng.int(6, 7);
	const g = randomGraph(rng, n, 1);
	const [start, other] = rng.sample(
		[...g.keys()].filter((v) => (g.get(v) ?? []).length > 0),
		2
	) as [string, string];
	const name = rng.pick(['graph', 'links', 'deps', 'routes']);
	return {
		lines: [
			'from collections import deque',
			'',
			...graphLines(name, g, rng.shuffle([...g.keys()])),
			'',
			'def bfs(start):',
			'    seen = {start}',
			'    order = []',
			'    queue = deque([start])',
			'    while queue:',
			'        v = queue.popleft()',
			'        order.append(v)',
			`        for w in ${name}[v]:`,
			'            if w not in seen:',
			'                seen.add(w)',
			'                queue.append(w)',
			'    return order',
			'',
			`print(*bfs('${start}'))`,
			`print(*bfs('${other}'))`
		],
		run: (rules) => [bfs(g, start, rules).join(' '), bfs(g, other, rules).join(' ')]
	};
}

function dfsRecursive(rng: Rng): Program {
	const n = rng.int(6, 7);
	const g = randomGraph(rng, n, 1);
	const start = rng.pick([...g.keys()].filter((v) => (g.get(v) ?? []).length > 0));
	const name = rng.pick(['graph', 'links', 'deps', 'calls']);
	return {
		lines: [
			...graphLines(name, g, rng.shuffle([...g.keys()])),
			'',
			'pre, post = [], []',
			'seen = set()',
			'',
			'def dfs(v):',
			'    seen.add(v)',
			'    pre.append(v)',
			`    for w in ${name}[v]:`,
			'        if w not in seen:',
			'            dfs(w)',
			'    post.append(v)',
			'',
			`dfs('${start}')`,
			'print(*pre)',
			'print(*post)'
		],
		run: (rules) => {
			const seen = new Set<string>();
			const pre: string[] = [];
			const post: string[] = [];
			const visit = (v: string) => {
				seen.add(v);
				pre.push(v);
				for (const w of neighbours(g, v, rules)) if (!seen.has(w)) visit(w);
				post.push(v);
			};
			visit(start);
			return [pre.join(' '), (rules.postIsReversedPre ? [...pre].reverse() : post).join(' ')];
		}
	};
}

function bfsLevels(rng: Rng): Program {
	const n = rng.int(6, 7);
	const g = randomGraph(rng, n, 1);
	const start = rng.pick([...g.keys()].filter((v) => (g.get(v) ?? []).length > 0));
	const name = rng.pick(['graph', 'links', 'net', 'hops']);
	const vs = [...g.keys()].sort();
	return {
		lines: [
			'from collections import deque',
			'',
			...graphLines(name, g, rng.shuffle([...g.keys()])),
			'',
			`dist = {'${start}': 0}`,
			`queue = deque(['${start}'])`,
			'while queue:',
			'    v = queue.popleft()',
			`    for w in ${name}[v]:`,
			'        if w not in dist:',
			'            dist[w] = dist[v] + 1',
			'            queue.append(w)',
			`print(*(dist.get(v, -1) for v in sorted(${name})))`
		],
		run: (rules) => {
			const dist = new Map<string, number>([[start, 0]]);
			if (rules.dfsDepth) {
				const visit = (v: string, d: number) => {
					for (const w of neighbours(g, v, rules)) {
						if (!dist.has(w)) {
							dist.set(w, d + 1);
							visit(w, d + 1);
						}
					}
				};
				visit(start, 0);
			} else {
				const queue = [start];
				while (queue.length) {
					const v = queue.shift() as string;
					for (const w of neighbours(g, v, rules)) {
						if (!dist.has(w)) {
							dist.set(w, (dist.get(v) ?? 0) + 1);
							queue.push(w);
						}
					}
				}
			}
			return [vs.map((v) => String(dist.get(v) ?? -1)).join(' ')];
		}
	};
}

/** A DAG on n letters along a random topological order; optionally a cycle among middle vertices. */
function dag(rng: Rng, n: number): { g: Graph; topo: string[] } {
	const topo = rng.shuffle(LETTERS.slice(0, n));
	const g: Graph = new Map(topo.map((v) => [v, [] as string[]]));
	topo.forEach((v, i) => {
		const later = topo.slice(i + 1);
		const count = Math.min(later.length, rng.int(i === 0 ? 1 : 0, 2));
		(g.get(v) as string[]).push(...rng.sample(later, count));
	});
	return { g, topo };
}

/** The same graph with its vertices in a random order: the order the program lists and iterates them in. */
function relayout(rng: Rng, g: Graph): Graph {
	return new Map(rng.shuffle([...g.keys()]).map((v) => [v, g.get(v) ?? []]));
}

function kahn(g: Graph, rules: Rules): { order: string[]; left: string[] } {
	const indeg = new Map<string, number>([...g.keys()].map((v) => [v, 0]));
	for (const ws of g.values()) for (const w of ws) indeg.set(w, (indeg.get(w) ?? 0) + 1);
	const ready = [...g.keys()].filter((v) => indeg.get(v) === 0);
	const order: string[] = [];
	while (ready.length) {
		if (!rules.kahnFifo) ready.sort();
		const v = ready.shift() as string;
		order.push(v);
		for (const w of g.get(v) ?? []) {
			indeg.set(w, (indeg.get(w) ?? 0) - 1);
			if (indeg.get(w) === 0) ready.push(w);
		}
	}
	const left = [...g.keys()].filter((v) => (indeg.get(v) ?? 0) > 0).sort();
	return { order, left };
}

function kahnLines(name: string, g: Graph, layout: readonly string[], withCycleCheck: boolean): string[] {
	return [
		'import heapq',
		'',
		...graphLines(name, g, layout),
		'',
		`indeg = {v: 0 for v in ${name}}`,
		`for v in ${name}:`,
		`    for w in ${name}[v]:`,
		'        indeg[w] += 1',
		'heap = [v for v in indeg if indeg[v] == 0]',
		'heapq.heapify(heap)',
		'order = []',
		'while heap:',
		'    v = heapq.heappop(heap)',
		'    order.append(v)',
		`    for w in ${name}[v]:`,
		'        indeg[w] -= 1',
		'        if indeg[w] == 0:',
		'            heapq.heappush(heap, w)',
		'print(*order)',
		...(withCycleCheck ? [`print(len(order) == len(${name}))`, 'print(*sorted(v for v in indeg if indeg[v] > 0))'] : [])
	];
}

function kahnMin(rng: Rng): Program {
	const { g: built } = dag(rng, rng.int(7, 8));
	const g = relayout(rng, built);
	const name = rng.pick(['deps', 'tasks', 'build', 'jobs']);
	return {
		lines: kahnLines(name, g, [...g.keys()], false),
		run: (rules) => [kahn(g, rules).order.join(' ')]
	};
}

function kahnCycle(rng: Rng): Program {
	const n = rng.int(7, 8);
	const { g, topo } = dag(rng, n);
	// A back edge between two middle vertices closes a cycle; a vertex after the cycle hangs on it.
	const i = rng.int(1, n - 4);
	const j = rng.int(i + 1, n - 3);
	const [from, to] = [topo[j] as string, topo[i] as string];
	const ensure = (a: string, b: string) => {
		const ws = g.get(a) as string[];
		if (!ws.includes(b)) ws.splice(rng.int(0, ws.length), 0, b);
	};
	for (let k = i; k < j; k += 1) ensure(topo[k] as string, topo[k + 1] as string);
	ensure(from, to);
	ensure(from, topo[rng.int(j + 1, n - 1)] as string);
	const name = rng.pick(['deps', 'tasks', 'imports', 'jobs']);
	const cycle = new Set(topo.slice(i, j + 1));
	const shown = relayout(rng, g);
	return {
		lines: kahnLines(name, shown, [...shown.keys()], true),
		run: (rules) => {
			const { order, left } = kahn(shown, rules);
			const rest = rules.cycleOnly ? left.filter((v) => cycle.has(v)) : left;
			return [order.join(' '), order.length === n ? 'True' : 'False', rest.join(' ')];
		}
	};
}

function dfsStack(rng: Rng): Program {
	const n = rng.int(7, 8);
	const g = randomGraph(rng, n, 1);
	const [start, other] = rng.sample(
		[...g.keys()].filter((v) => (g.get(v) ?? []).length > 0),
		2
	) as [string, string];
	const name = rng.pick(['graph', 'links', 'refs', 'calls']);
	const walk = (s: string, rules: Rules): string[] => {
		if (rules.stackAsRecursion) {
			const seen = new Set<string>();
			const order: string[] = [];
			const visit = (v: string) => {
				seen.add(v);
				order.push(v);
				for (const w of neighbours(g, v, rules)) if (!seen.has(w)) visit(w);
			};
			visit(s);
			return order;
		}
		const seen = new Set<string>();
		const order: string[] = [];
		const stack = [s];
		while (stack.length) {
			const v = stack.pop() as string;
			if (seen.has(v)) continue;
			seen.add(v);
			order.push(v);
			for (const w of neighbours(g, v, rules)) if (!seen.has(w)) stack.push(w);
		}
		return order;
	};
	return {
		lines: [
			...graphLines(name, g, rng.shuffle([...g.keys()])),
			'',
			'def dfs(start):',
			'    seen = set()',
			'    order = []',
			'    stack = [start]',
			'    while stack:',
			'        v = stack.pop()',
			'        if v in seen:',
			'            continue',
			'        seen.add(v)',
			'        order.append(v)',
			`        for w in ${name}[v]:`,
			'            if w not in seen:',
			'                stack.append(w)',
			'    return order',
			'',
			`print(*dfs('${start}'))`,
			`print(*dfs('${other}'))`
		],
		run: (rules) => [walk(start, rules).join(' '), walk(other, rules).join(' ')]
	};
}

function components(rng: Rng): Program {
	const n = rng.int(7, 8);
	const vs = LETTERS.slice(0, n);
	const pairs: [string, string][] = [];
	const count = rng.int(5, 6);
	while (pairs.length < count) {
		const [u, v] = rng.sample(vs, 2) as [string, string];
		if (!pairs.some(([a, b]) => (a === u && b === v) || (a === v && b === u))) pairs.push([u, v]);
	}
	const name = rng.pick(['adj', 'links', 'net', 'friends']);
	return {
		lines: [
			'from collections import deque',
			'',
			`edges = [${pairs.map(([u, v]) => `('${u}', '${v}')`).join(', ')}]`,
			`${name} = {v: [] for v in '${vs.join('')}'}`,
			'for u, v in edges:',
			`    ${name}[u].append(v)`,
			`    ${name}[v].append(u)`,
			'',
			'seen = set()',
			`for start in ${name}:`,
			'    if start in seen:',
			'        continue',
			'    seen.add(start)',
			'    part = []',
			'    queue = deque([start])',
			'    while queue:',
			'        v = queue.popleft()',
			'        part.append(v)',
			`        for w in ${name}[v]:`,
			'            if w not in seen:',
			'                seen.add(w)',
			'                queue.append(w)',
			'    print(*part)'
		],
		run: (rules) => {
			const g: Graph = new Map(vs.map((v) => [v, [] as string[]]));
			for (const [u, v] of pairs) {
				(g.get(u) as string[]).push(v);
				if (!rules.oneWayEdges) (g.get(v) as string[]).push(u);
			}
			const seen = new Set<string>();
			const out: string[] = [];
			for (const start of vs) {
				if (seen.has(start)) continue;
				seen.add(start);
				const part: string[] = [];
				const queue: string[] = [start];
				while (queue.length) {
					const v = (rules.queueAsStack ? queue.pop() : queue.shift()) as string;
					part.push(v);
					for (const w of neighbours(g, v, rules)) {
						if (!seen.has(w)) {
							seen.add(w);
							queue.push(w);
						}
					}
				}
				out.push(part.join(' '));
			}
			return out;
		}
	};
}

function bfsPath(rng: Rng): Program {
	const n = rng.int(7, 8);
	const g = randomGraph(rng, n, 1);
	// A start with two or more out-edges when there is one; every graph has a vertex with at least one.
	const branching = [...g.keys()].filter((v) => (g.get(v) ?? []).length > 1);
	const start = rng.pick(branching.length ? branching : [...g.keys()].filter((v) => (g.get(v) ?? []).length > 0));
	const others = [...g.keys()].filter((v) => v !== start);
	const [t1, t2] = rng.sample(others, 2) as [string, string];
	const name = rng.pick(['graph', 'routes', 'hops', 'links']);
	return {
		lines: [
			'from collections import deque',
			'',
			...graphLines(name, g, rng.shuffle([...g.keys()])),
			'',
			`parent = {'${start}': None}`,
			`queue = deque(['${start}'])`,
			'while queue:',
			'    v = queue.popleft()',
			`    for w in ${name}[v]:`,
			'        if w not in parent:',
			'            parent[w] = v',
			'            queue.append(w)',
			'',
			'def path(t):',
			'    if t not in parent:',
			'        return ["-"]',
			'    out = []',
			'    while t is not None:',
			'        out.append(t)',
			'        t = parent[t]',
			'    return out[::-1]',
			'',
			`print(*path('${t1}'))`,
			`print(*path('${t2}'))`
		],
		run: (rules) => {
			const parent = new Map<string, string | null>([[start, null]]);
			const popped = new Set<string>();
			const queue = [start];
			while (queue.length) {
				const v = queue.shift() as string;
				popped.add(v);
				for (const w of neighbours(g, v, rules)) {
					if (!parent.has(w)) {
						parent.set(w, v);
						queue.push(w);
					} else if (rules.lastParent && w !== start && !popped.has(w)) parent.set(w, v);
				}
			}
			const path = (t: string) => {
				if (!parent.has(t)) return '-';
				const out: string[] = [];
				let cur: string | null = t;
				while (cur !== null) {
					out.push(cur);
					cur = parent.get(cur) ?? null;
				}
				return out.reverse().join(' ');
			};
			return [path(t1), path(t2)];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/bfs-order': bfsOrder,
	'intern/dfs-recursive': dfsRecursive,
	'intern/bfs-levels': bfsLevels,
	'junior/kahn-min': kahnMin,
	'junior/kahn-cycle': kahnCycle,
	'junior/dfs-stack': dfsStack,
	'intern/components': components,
	'junior/bfs-path': bfsPath
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Graphs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 300; tries += 1) {
		const program = make(rng);
		const answer = program.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = program.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = program.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
				code: { language: 'python3', source }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${slot} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
