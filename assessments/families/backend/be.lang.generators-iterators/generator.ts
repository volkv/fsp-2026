// Iterators and generators: laziness, one-pass iterators, late lookup inside generator expressions, the interleaving
// of a generator's body with its consumer, send and return values, zip pulling from generators, itertools.
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
	iterRestarts: boolean;
	inNoConsume: boolean;
	eagerGenexp: boolean;
	allLate: boolean;
	runsOnCall: boolean;
	eagerBody: boolean;
	sendReturnsPrevious: boolean;
	yieldFromNone: boolean;
	stopValueLost: boolean;
	zipNoOverconsume: boolean;
	groupbyGlobal: boolean;
	groupsPersist: boolean;
	anyConsumesAll: boolean;
	allEmptyFalse: boolean;
	zipSameDuplicates: boolean;
	zipPadsTail: boolean;
}

const RIGHT: Rules = {
	iterRestarts: false,
	inNoConsume: false,
	eagerGenexp: false,
	allLate: false,
	runsOnCall: false,
	eagerBody: false,
	sendReturnsPrevious: false,
	yieldFromNone: false,
	stopValueLost: false,
	zipNoOverconsume: false,
	groupbyGlobal: false,
	groupsPersist: false,
	anyConsumesAll: false,
	allEmptyFalse: false,
	zipSameDuplicates: false,
	zipPadsTail: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'iter-restarts': { iterRestarts: true },
	'in-no-consume': { inNoConsume: true },
	'eager-genexp': { eagerGenexp: true },
	'all-late': { allLate: true },
	'runs-on-call': { runsOnCall: true },
	'eager-body': { eagerBody: true },
	'send-returns-previous': { sendReturnsPrevious: true },
	'yield-from-none': { yieldFromNone: true },
	'stop-value-lost': { stopValueLost: true },
	'zip-no-overconsume': { zipNoOverconsume: true },
	'groupby-global': { groupbyGlobal: true },
	'groups-persist': { groupsPersist: true },
	'any-consumes-all': { anyConsumesAll: true },
	'all-empty-false': { allEmptyFalse: true },
	'zip-same-duplicates': { zipSameDuplicates: true },
	'zip-pads-tail': { zipPadsTail: true }
};

const REQUIRED: Record<string, string[]> = {
	'junior/exhausted': ['iter-restarts', 'in-no-consume'],
	'junior/late-lookup': ['eager-genexp', 'all-late'],
	'junior/interleaving': ['runs-on-call', 'eager-body'],
	'middle/send-return': ['send-returns-previous', 'yield-from-none', 'stop-value-lost'],
	'middle/zip-pull': ['zip-no-overconsume'],
	'middle/groupby': ['groupby-global', 'groups-persist'],
	'junior/short-circuit': ['any-consumes-all', 'all-empty-false'],
	'middle/zip-same': ['zip-same-duplicates', 'zip-pads-tail']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const list = (items: readonly (number | string)[]) => `[${items.join(', ')}]`;

function at<T>(items: readonly T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`index ${i} of ${items.length}`);
	return item;
}

function distinct(rng: Rng, count: number, min: number, max: number): number[] {
	return rng.sample(
		Array.from({ length: max - min + 1 }, (_, i) => min + i),
		count
	);
}

function exhausted(rng: Rng): Program {
	const [data, it] = rng.pick([
		['data', 'it'],
		['values', 'stream'],
		['ids', 'cursor'],
		['sizes', 'feed']
	] as const);
	const xs = distinct(rng, rng.int(7, 8), 1, 30);
	const k = rng.int(2, 5);
	const t = rng.int(5, 12);
	const source = rng.pick([
		{ text: `(x * ${k} for x in ${data} if x % 2 == 1)`, values: xs.filter((x) => x % 2 === 1).map((x) => x * k) },
		{ text: `map(lambda x: x + ${k}, ${data})`, values: xs.map((x) => x + k) },
		{ text: `filter(lambda x: x > ${t}, ${data})`, values: xs.filter((x) => x > t) },
		{ text: `iter(${data})`, values: [...xs] }
	]);
	const produced = source.values;
	const probeAt = Math.min(produced.length - 2, rng.int(2, 3));
	const probe = produced[probeAt];
	const consumers = rng.shuffle([
		{ text: `sum(${it})`, apply: (rest: number[]) => String(rest.reduce((s, v) => s + v, 0)) },
		{ text: `list(${it})`, apply: (rest: number[]) => list(rest) },
		{ text: `max(${it}, default=-1)`, apply: (rest: number[]) => String(rest.length ? Math.max(...rest) : -1) }
	]);
	const [first, second] = consumers as [(typeof consumers)[number], (typeof consumers)[number]];
	return {
		lines: [
			`${data} = ${list(xs)}`,
			`${it} = ${source.text}`,
			`print(next(${it}))`,
			`print(${probe} in ${it})`,
			`print(${first.text})`,
			`print(${second.text})`
		],
		run: (rules) => {
			if (produced.length < 4 || probe === undefined) return ['too short'];
			let pos = 0;
			const out: string[] = [];
			out.push(String(at(produced, rules.iterRestarts ? 0 : pos)));
			pos = 1;
			const from = rules.iterRestarts ? 0 : pos;
			const found = produced.indexOf(probe, from);
			out.push(found >= 0 ? 'True' : 'False');
			if (!rules.inNoConsume && !rules.iterRestarts) pos = found >= 0 ? found + 1 : produced.length;
			for (const consumer of [first, second]) {
				out.push(consumer.apply(produced.slice(rules.iterRestarts ? 0 : pos)));
				pos = produced.length;
			}
			return out;
		}
	};
}

function lateLookup(rng: Rng): Program {
	const [xs, gen, snap] = rng.pick([
		['xs', 'gen', 'now'],
		['items', 'lazy', 'eager'],
		['nums', 'later', 'ready'],
		['ids', 'pending', 'done']
	] as const);
	const k1 = rng.int(2, 4);
	const k2 = rng.int(5, 9);
	const op = rng.pick(['+', '*'] as const);
	const f = (x: number, k: number) => (op === '+' ? x + k : x * k);
	const start = distinct(rng, 3, 1, 9);
	const appended = rng.int(10, 19);
	const fresh = distinct(rng, 2, 20, 29);
	type Step = 'append' | 'k' | 'rebind';
	const steps = rng.shuffle<Step>(['append', 'k', 'rebind']);
	const text: Record<Step, string> = {
		append: `${xs}.append(${appended})`,
		k: `k = ${k2}`,
		rebind: `${xs} = ${list(fresh)}`
	};
	return {
		lines: [
			`${xs} = ${list(start)}`,
			`k = ${k1}`,
			`${snap} = [x ${op} k for x in ${xs}]`,
			`${gen} = (x ${op} k for x in ${xs})`,
			...steps.map((s) => text[s]),
			`print(${snap})`,
			`print(list(${gen}))`
		],
		run: (rules) => {
			const original = [...start];
			let current = original;
			for (const s of steps) {
				if (s === 'append') current.push(appended);
				if (s === 'rebind') current = [...fresh];
			}
			const iterated = rules.eagerGenexp ? start : rules.allLate ? current : original;
			const k = rules.eagerGenexp ? k1 : k2;
			return [list(start.map((x) => f(x, k1))), list(iterated.map((x) => f(x, k)))];
		}
	};
}

function interleaving(rng: Rng): Program {
	const [inner, outer, it] = rng.pick([
		['pages', 'feed', 'it'],
		['rows', 'stream', 'src'],
		['chunk', 'reader', 'gen'],
		['batch', 'source', 'items']
	] as const);
	const first = rng.int(1, 9);
	const n = rng.int(3, 4);
	const base = rng.int(10, 40);
	const step = rng.int(2, 7);
	const values = Array.from({ length: n }, (_, i) => base + i * step);
	// The consumer breaks on a value inside the inner generator, or never.
	const breaks = rng.bool(0.7);
	const limit = breaks ? at(values, rng.int(0, n - 2)) + 1 : base + n * step + 5;
	type Ev = { kind: 'print'; text: string } | { kind: 'yield'; value: number };
	const events: Ev[] = [
		{ kind: 'print', text: 'outer start' },
		{ kind: 'yield', value: first },
		{ kind: 'print', text: 'inner start' },
		...values.flatMap<Ev>((v, i) => [
			{ kind: 'print', text: `inner ${i}` },
			{ kind: 'yield', value: v }
		]),
		{ kind: 'print', text: 'inner end' },
		{ kind: 'print', text: 'outer end' }
	];
	return {
		lines: [
			`def ${inner}(n):`,
			"    print('inner start')",
			'    for i in range(n):',
			"        print('inner', i)",
			`        yield ${base} + i * ${step}`,
			"    print('inner end')",
			'',
			`def ${outer}():`,
			"    print('outer start')",
			`    yield ${first}`,
			`    yield from ${inner}(${n})`,
			"    print('outer end')",
			'',
			`${it} = ${outer}()`,
			"print('created')",
			`for v in ${it}:`,
			"    print('got', v)",
			`    if v > ${limit}:`,
			'        break',
			"print('after')"
		],
		run: (rules) => {
			const out: string[] = [];
			let queue = [...events];
			if (rules.runsOnCall) {
				while (queue[0]?.kind === 'print') out.push((queue.shift() as { text: string }).text);
			}
			out.push('created');
			if (rules.eagerBody) {
				for (const e of queue) if (e.kind === 'print') out.push(e.text);
				queue = queue.filter((e) => e.kind === 'yield');
			}
			for (const e of queue) {
				if (e.kind === 'print') {
					out.push(e.text);
					continue;
				}
				out.push(`got ${e.value}`);
				if (e.value > limit) break;
			}
			out.push('after');
			return out;
		}
	};
}

function sendReturn(rng: Rng): Program {
	const [acc, outer, g] = rng.pick([
		['acc', 'session', 'g'],
		['budget', 'order', 'gen'],
		['collect', 'batch', 'it'],
		['summer', 'job', 'co']
	] as const);
	const limit = rng.int(15, 30);
	// Sends before the inner generator returns: by overflowing the limit or by None; then one more send.
	const byNone = rng.bool(0.4);
	const accepted: number[] = [];
	let total = 0;
	const count = rng.int(2, 3);
	while (accepted.length < count) {
		const v = rng.int(2, 9);
		if (total + v > limit) break;
		accepted.push(v);
		total += v;
	}
	const stopper: number | null = byNone ? null : limit - total + rng.int(1, 5);
	const last = rng.int(1, 9);
	const tail = rng.bool() ? [rng.int(1, 9)] : [];
	const sends: (number | null)[] = [...accepted, stopper, last, ...tail];
	const show = (v: number | null) => (v === null ? 'None' : String(v));
	return {
		lines: [
			`def ${acc}(limit):`,
			'    total = 0',
			'    while True:',
			'        x = yield total',
			'        if x is None or total + x > limit:',
			'            return total',
			'        total += x',
			'',
			`def ${outer}(limit):`,
			`    got = yield from ${acc}(limit)`,
			"    print('inner returned', got)",
			"    extra = yield 'limit'",
			'    return (got, extra)',
			'',
			`${g} = ${outer}(${limit})`,
			`print(next(${g}))`,
			`for v in ${list(sends.map(show))}:`,
			'    try:',
			`        print(${g}.send(v))`,
			'    except StopIteration as e:',
			"        print('stop', e.value)",
			'        break'
		],
		run: (rules) => {
			const out: string[] = [];
			let sum = 0;
			let phase: 'acc' | 'after' = 'acc';
			let got: number | null = 0;
			let previous = '0';
			out.push('0');
			for (const v of sends) {
				if (phase === 'after') {
					out.push(rules.stopValueLost ? 'stop None' : `stop (${got === null ? 'None' : got}, ${show(v)})`);
					break;
				}
				let yielded: string;
				if (v === null || sum + v > limit) {
					got = rules.yieldFromNone ? null : sum;
					out.push(`inner returned ${got === null ? 'None' : got}`);
					yielded = 'limit';
					phase = 'after';
				} else {
					sum += v;
					yielded = String(sum);
				}
				out.push(rules.sendReturnsPrevious ? previous : yielded);
				previous = yielded;
			}
			return out;
		}
	};
}

function zipPull(rng: Rng): Program {
	const [fn, head] = rng.pick([
		['source', 'head'],
		['numbers', 'first'],
		['counter', 'top'],
		['feed', 'prefix']
	] as const);
	const three = rng.bool();
	const names = three ? ['a', 'b', 'c'] : ['a', 'b'];
	const starts = rng.sample([10, 20, 30, 40, 50, 60, 70, 80], names.length);
	const sliced = rng.int(1, 2);
	const lengths = names.map(() => rng.int(3, 6));
	// The zipped order: the shortest effective iterator is not first, so others lose a pulled element.
	const order = rng.shuffle(names.map((_, i) => i));
	const effective = lengths.map((n, i) => (i === 0 ? n - sliced : n));
	const shortest = Math.min(...effective);
	const iters = names.map((name, i) => ({ name, start: at(starts, i), n: at(lengths, i) }));
	return {
		lines: [
			'from itertools import islice',
			'',
			`def ${fn}(start, n):`,
			'    for i in range(n):',
			'        yield start + i',
			'',
			...iters.map((x) => `${x.name} = ${fn}(${x.start}, ${x.n})`),
			`${head} = list(islice(a, ${sliced}))`,
			`print(${head})`,
			`print(list(zip(${order.map((i) => at(names, i)).join(', ')})))`,
			...names.map((name) => `print(list(${name}))`)
		],
		run: (rules) => {
			if (effective.filter((n) => n === shortest).length === effective.length) return ['all equal'];
			const pos = iters.map(() => 0);
			const take = (i: number): number | null => {
				const x = at(iters, i);
				const p = at(pos, i);
				if (p >= x.n) return null;
				pos[i] = p + 1;
				return x.start + p;
			};
			const out: string[] = [];
			const headValues = Array.from({ length: sliced }, () => take(0) as number);
			out.push(list(headValues));
			const tuples: string[] = [];
			for (;;) {
				const row: number[] = [];
				let ended = false;
				for (const i of order) {
					const v = take(i);
					if (v === null) {
						ended = true;
						break;
					}
					row.push(v);
				}
				if (ended) {
					if (rules.zipNoOverconsume) row.forEach((_, j) => (pos[at(order, j)] = at(pos, at(order, j)) - 1));
					break;
				}
				tuples.push(`(${row.join(', ')})`);
			}
			out.push(list(tuples));
			iters.forEach((x, i) => {
				out.push(list(Array.from({ length: x.n - at(pos, i) }, (_, j) => x.start + at(pos, i) + j)));
			});
			return out;
		}
	};
}

function groupbyProgram(rng: Rng): Program {
	const byLen = rng.bool();
	const m = rng.int(2, 3);
	const data: (number | string)[] = byLen
		? Array.from({ length: rng.int(7, 9) }, () => rng.pick(['ab', 'cd', 'xyz', 'abc', 'q', 'tea', 'go', 'k']))
		: Array.from({ length: rng.int(7, 9) }, () => rng.int(1, 20));
	const keyText = byLen ? 'len' : `lambda x: x % ${m}`;
	const keyOf = (x: number | string) => (typeof x === 'string' ? x.length : x % m);
	const shown = (x: number | string) => (typeof x === 'string' ? `'${x}'` : String(x));
	const name = rng.pick(['data', 'events', 'log', 'stream']);
	return {
		lines: [
			'from itertools import groupby',
			'',
			`${name} = ${list(data.map(shown))}`,
			`key = ${keyText}`,
			`print([(k, len(list(g))) for k, g in groupby(${name}, key=key)])`,
			`print([(k, len(list(g))) for k, g in groupby(sorted(${name}, key=key), key=key)])`,
			`groups = list(groupby(${name}, key=key))`,
			'print([(k, list(g)) for k, g in groups])'
		],
		run: (rules) => {
			const runs = (items: readonly (number | string)[], global: boolean) => {
				const out: { key: number; items: (number | string)[] }[] = [];
				for (const x of items) {
					const k = keyOf(x);
					const target = global ? out.find((r) => r.key === k) : out[out.length - 1];
					if (target && target.key === k) target.items.push(x);
					else out.push({ key: k, items: [x] });
				}
				return out;
			};
			const sorted = [...data].sort((x, y) => keyOf(x) - keyOf(y));
			const plain = runs(data, rules.groupbyGlobal);
			return [
				list(plain.map((r) => `(${r.key}, ${r.items.length})`)),
				list(runs(sorted, false).map((r) => `(${r.key}, ${r.items.length})`)),
				list(plain.map((r) => `(${r.key}, ${rules.groupsPersist ? list(r.items.map(shown)) : '[]'})`))
			];
		}
	};
}

function shortCircuit(rng: Rng): Program {
	const [check, data] = rng.pick([
		['check', 'data'],
		['is_big', 'sizes'],
		['over', 'loads'],
		['hot', 'temps']
	] as const);
	const t = rng.int(30, 60);
	// The first value over the threshold sits in the middle: any() stops there.
	const below = () => rng.int(1, t);
	const head = Array.from({ length: rng.int(1, 3) }, below);
	const tail = Array.from({ length: rng.int(2, 3) }, () => rng.int(1, 99));
	const xs = [...head, rng.int(t + 1, 99), ...tail];
	return {
		lines: [
			`def ${check}(x):`,
			"    print('check', x)",
			`    return x > ${t}`,
			'',
			`${data} = ${list(xs)}`,
			`it = iter(${data})`,
			`print(any(${check}(x) for x in it))`,
			'print(list(it))',
			`print(all(${check}(x) for x in it))`
		],
		run: (rules) => {
			const hit = xs.findIndex((x) => x > t);
			const checked = rules.anyConsumesAll ? xs : xs.slice(0, hit + 1);
			const rest = rules.anyConsumesAll ? [] : xs.slice(hit + 1);
			return [...checked.map((x) => `check ${x}`), 'True', list(rest), rules.allEmptyFalse ? 'False' : 'True'];
		}
	};
}

function zipSame(rng: Rng): Program {
	const name = rng.pick(['data', 'cells', 'stream', 'bytes_']);
	const xs = distinct(rng, rng.pick([7, 8]), 10, 99);
	const tuple = (items: readonly number[]) => (items.length === 1 ? `(${items[0]},)` : `(${items.join(', ')})`);
	const chunks = (size: number, rules: Rules): string => {
		const out: string[] = [];
		for (let i = 0; i < xs.length; i += size) {
			const part = xs.slice(i, i + size);
			if (part.length < size && !rules.zipPadsTail) break;
			out.push(tuple(part));
		}
		return list(out);
	};
	return {
		lines: [
			`${name} = ${list(xs)}`,
			`it = iter(${name})`,
			'print(list(zip(it, it)))',
			`print(list(zip(*[iter(${name})] * 3)))`,
			`print(list(zip(iter(${name}), iter(${name})))[:2])`
		],
		run: (rules) => {
			const pairsOfSame = list(xs.slice(0, 2).map((x) => tuple([x, x])));
			if (rules.zipSameDuplicates) {
				const same = (size: number) => {
					const n = rules.zipPadsTail ? Math.ceil(xs.length / size) : Math.floor(xs.length / size);
					return list(Array.from({ length: n }, (_, i) => tuple(Array.from({ length: size }, () => at(xs, i)))));
				};
				return [same(2), same(3), pairsOfSame];
			}
			return [chunks(2, rules), chunks(3, rules), pairsOfSame];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'junior/exhausted': exhausted,
	'junior/late-lookup': lateLookup,
	'junior/interleaving': interleaving,
	'middle/send-return': sendReturn,
	'middle/zip-pull': zipPull,
	'middle/groupby': groupbyProgram,
	'junior/short-circuit': shortCircuit,
	'middle/zip-same': zipSame
};

/** Programs a model rejects as degenerate print one of these instead of an output. */
const DEGENERATE = new Set(['too short', 'all equal']);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 200; tries += 1) {
		const program = make(rng);
		const answer = program.run(RIGHT);
		if (answer.length === 1 && DEGENERATE.has(answer[0] ?? '')) continue;
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
