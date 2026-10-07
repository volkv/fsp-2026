// Generators and the iterator protocol in JavaScript: laziness, `yield*` and its value, `next(v)`, closing an
// iterator early (`return()` and the generator's `finally`), and collections changed while they are iterated. On the
// senior level several mechanisms meet: a pipeline of generators closed from its end, a one-shot iterator reused,
// `throw()` and `return()` against a `finally` that yields. The generator models each program and computes its
// output; the gate runs the shown program with Node.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Program {
	lines: string[];
	answer: string[];
	/** Outputs of the wrong solutions; a missing one, or one equal to the answer, does not apply to the instance. */
	wrong: Record<string, string[]>;
}

/** `count` distinct integers in [min, max]. */
function distinct(rng: Rng, count: number, min: number, max: number): number[] {
	const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
	return rng.sample(values, count);
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------------------------------------------
// Middle.

/** The body runs only when a value is pulled; `yield*` passes values through and evaluates to the inner `return`. */
function lazyDelegation(rng: Rng): Program {
	const innerValues = distinct(rng, rng.int(2, 3), 1, 49);
	const tail = distinct(rng, rng.int(1, 3), 50, 99);
	const ret = rng.int(100, 999);
	const consumer = rng.pick(['for', 'spread'] as const);
	const manualFirst = rng.bool();
	const [outerName, innerName] = rng.pick([
		['outer', 'inner'],
		['all', 'head'],
		['report', 'section'],
		['feed', 'page']
	] as const);
	const lines = [
		`function* ${innerName}() {`,
		`  console.log('${innerName} start');`,
		...innerValues.map((v) => `  yield ${v};`),
		`  console.log('${innerName} end');`,
		`  return ${ret};`,
		'}',
		`function* ${outerName}() {`,
		`  console.log('${outerName} start');`,
		`  const r = yield* ${innerName}();`,
		"  console.log('got', r);",
		`  yield* [${tail.join(', ')}];`,
		`  console.log('${outerName} end');`,
		'}',
		`const it = ${outerName}();`,
		"console.log('created');",
		...(manualFirst ? ["console.log('first', it.next().value);"] : []),
		...(consumer === 'for'
			? ['for (const v of it) {', "  console.log('value', v);", '}']
			: ['const rest = [...it];', "console.log('rest', rest.join(','));"])
	];
	type Event = { log: string } | { yield: number };
	const events = (gotValue: string, extraYield: boolean): Event[] => [
		{ log: `${outerName} start` },
		{ log: `${innerName} start` },
		...innerValues.map((v) => ({ yield: v })),
		{ log: `${innerName} end` },
		...(extraYield ? [{ yield: ret }] : []),
		{ log: `got ${gotValue}` },
		...tail.map((v) => ({ yield: v })),
		{ log: `${outerName} end` }
	];
	/** The output when the body runs lazily (`eager` — all of it runs at the call, before `created`). */
	const trace = (list: Event[], eager: boolean): string[] => {
		const out: string[] = [];
		const logs = list.filter((e): e is { log: string } => 'log' in e).map((e) => e.log);
		const yields = list.filter((e): e is { yield: number } => 'yield' in e).map((e) => e.yield);
		if (eager) {
			out.push(...logs, 'created');
			let rest = yields;
			if (manualFirst) {
				out.push(`first ${yields[0] ?? ''}`);
				rest = yields.slice(1);
			}
			if (consumer === 'for') out.push(...rest.map((v) => `value ${v}`));
			else out.push(`rest ${rest.join(',')}`);
			return out;
		}
		out.push('created');
		let i = 0;
		const runToYield = (): number | null => {
			while (i < list.length) {
				const e = list[i++] as Event;
				if ('log' in e) out.push(e.log);
				else return e.yield;
			}
			return null;
		};
		if (manualFirst) {
			const first = runToYield();
			out.push(`first ${first ?? ''}`);
		}
		if (consumer === 'for') {
			for (let v = runToYield(); v !== null; v = runToYield()) out.push(`value ${v}`);
		} else {
			const rest: number[] = [];
			for (let v = runToYield(); v !== null; v = runToYield()) rest.push(v);
			out.push(`rest ${rest.join(',')}`);
		}
		return out;
	};
	return {
		lines,
		answer: trace(events(String(ret), false), false),
		wrong: {
			// The body of a generator runs when it is called.
			'eager-body': trace(events(String(ret), false), true),
			// The `return` of the delegated generator is one more value of the sequence.
			'return-is-yielded': trace(events(String(ret), true), false),
			// `yield*` evaluates to undefined.
			'yield-star-undefined': trace(events('undefined', false), false)
		}
	};
}

/** Leaving `for…of` early calls `return()`, which runs `finally`; a generator abandoned without it never cleans up. */
function earlyExit(rng: Rng): Program {
	const start = rng.int(1, 9);
	const step = rng.int(2, 7);
	const uses = rng.int(2, 4);
	const limit = start + (uses - 1) * step + rng.int(0, step - 1);
	const over = start + uses * step;
	const z = rng.int(100, 999);
	const exit = rng.pick(['break', 'return'] as const);
	const name = rng.pick(['numbers', 'ids', 'ticks', 'serial'] as const);
	const lines = [
		`function* ${name}(label) {`,
		'  try {',
		`    for (let i = ${start}; ; i += ${step}) {`,
		"      console.log(label, 'make', i);",
		'      yield i;',
		'    }',
		'  } finally {',
		"    console.log(label, 'cleanup');",
		'  }',
		'}',
		...(exit === 'break'
			? [`for (const n of ${name}('loop')) {`, `  if (n > ${limit}) break;`, "  console.log('use', n);", '}']
			: [
					'function firstOver(limit) {',
					`  for (const n of ${name}('loop')) {`,
					'    if (n > limit) return n;',
					"    console.log('use', n);",
					'  }',
					'}',
					`console.log('first over', firstOver(${limit}));`
				]),
		`const it = ${name}('manual');`,
		'console.log(it.next().value, it.next().value);',
		`const r = it.return(${z});`,
		'console.log(r.value, r.done);',
		'console.log(it.next().done);'
	];
	const trace = (o: { loopCleanup: boolean; makeOver: boolean; manualCleanup: boolean; returnValue: boolean }) => {
		const out: string[] = [];
		for (let k = 0; k < uses; k += 1) out.push(`loop make ${start + k * step}`, `use ${start + k * step}`);
		if (o.makeOver) out.push(`loop make ${over}`);
		if (o.loopCleanup) out.push('loop cleanup');
		if (exit === 'return') out.push(`first over ${over}`);
		out.push(`manual make ${start}`, `manual make ${start + step}`, `${start} ${start + step}`);
		if (o.manualCleanup) out.push('manual cleanup');
		out.push(`${o.returnValue ? z : 'undefined'} true`, 'true');
		return out;
	};
	const right = { loopCleanup: true, makeOver: true, manualCleanup: true, returnValue: true };
	return {
		lines,
		answer: trace(right),
		wrong: {
			// Leaving the loop early does not reach the generator's finally.
			'no-cleanup-on-exit': trace({ ...right, loopCleanup: false }),
			// The generator makes only the values the loop goes on to use.
			'only-used-values-made': trace({ ...right, makeOver: false }),
			// return() ends the generator without running finally.
			'return-skips-finally': trace({ ...right, manualCleanup: false }),
			// return(v) gives back undefined, not v.
			'return-value-lost': trace({ ...right, returnValue: false })
		}
	};
}

/** `next(v)` resumes the paused `yield` with v: the argument of the first call is lost; `return` is the final value. */
function nextValue(rng: Rng): Program {
	const t0 = rng.int(1, 20);
	const [v0, a, b, c] = distinct(rng, 4, 2, 60) as [number, number, number, number];
	const k = rng.int(2, 4);
	const name = rng.pick(['accumulator', 'summer', 'tally', 'counter'] as const);
	const lines = [
		`function* ${name}(start) {`,
		'  let total = start;',
		"  console.log('start', total);",
		'  while (true) {',
		'    const x = yield total;',
		"    console.log('got', x);",
		'    if (x === undefined) break;',
		'    total += x;',
		'  }',
		`  return total * ${k};`,
		'}',
		`const acc = ${name}(${t0});`,
		"console.log('created');",
		`console.log(acc.next(${v0}).value);`,
		`console.log(acc.next(${a}).value);`,
		`console.log(acc.next(${b}).value);`,
		'const last = acc.next();',
		'console.log(last.value, last.done);',
		`const after = acc.next(${c});`,
		'console.log(after.value, after.done);'
	];
	const sum = t0 + a + b;
	const answer = [
		'created',
		`start ${t0}`,
		`${t0}`,
		`got ${a}`,
		`${t0 + a}`,
		`got ${b}`,
		`${sum}`,
		'got undefined',
		`${sum * k} true`,
		'undefined true'
	];
	const sum0 = t0 + v0 + a + b;
	return {
		lines,
		answer,
		wrong: {
			// The argument of the first next() reaches the generator too.
			'first-next-delivers': [
				'created',
				`start ${t0}`,
				`got ${v0}`,
				`${t0 + v0}`,
				`got ${a}`,
				`${t0 + v0 + a}`,
				`got ${b}`,
				`${sum0}`,
				'got undefined',
				`${sum0 * k} true`,
				'undefined true'
			],
			// The value of `return` is not seen by next(): a finished generator always gives undefined.
			'return-not-delivered': [...answer.slice(0, 8), 'undefined true', 'undefined true'],
			// A finished generator starts over on the next call.
			'restart-after-done': [...answer.slice(0, 9), `start ${t0}`, `${t0} false`]
		}
	};
}

const MAP_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

type MapAction =
	{ kind: 'delete'; key: string } | { kind: 'set'; key: string; value: number } | { kind: 'move' } | { kind: 'none' };

/** Map iteration is live: deleted entries not reached yet are skipped, new keys are visited, an existing key keeps its place. */
function mapMutation(rng: Rng): Program {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const program = mapMutationDraw(rng);
		if (program) return program;
	}
	return mapMutationFixed();
}

interface MapPlan {
	keys: string[];
	values: number[];
	actions: MapAction[];
	fresh: string[];
}

function mapMutationDraw(rng: Rng): Program | null {
	const n = rng.int(4, 5);
	const all = rng.sample(MAP_KEYS, n + 2);
	const keys = all.slice(0, n);
	const fresh = all.slice(n);
	const values = distinct(rng, n, 1, 9);
	const actions: MapAction[] = keys.map((key, i) => {
		const roll = rng.int(0, 5);
		const others = keys.filter((k) => k !== key);
		if (roll === 0) return { kind: 'none' };
		if (roll === 1 || roll === 2) return { kind: 'delete', key: rng.pick(i < n - 1 ? keys.slice(i + 1) : others) };
		if (roll === 3) return { kind: 'set', key: rng.pick(others), value: rng.int(10, 99) };
		if (roll === 4) return { kind: 'set', key: rng.pick(fresh), value: rng.int(10, 99) };
		return { kind: 'move' };
	});
	const plan: MapPlan = { keys, values, actions, fresh };
	const program = mapProgram(plan);
	// Every instance needs a deletion ahead of the iterator and an entry added during the loop.
	const right = simulateMap(plan, 'live');
	const snapshot = simulateMap(plan, 'snapshot');
	const noAdditions = simulateMap(plan, 'no-additions');
	if (same(right.visits, snapshot.visits) || same(right.visits, noAdditions.visits)) return null;
	return program;
}

function mapMutationFixed(): Program {
	return mapProgram({
		keys: ['a', 'b', 'c', 'd'],
		values: [1, 2, 3, 4],
		actions: [{ kind: 'delete', key: 'c' }, { kind: 'set', key: 'e', value: 50 }, { kind: 'none' }, { kind: 'move' }],
		fresh: ['e', 'f']
	});
}

/** The visits and the final entries of the shown loop: live (the language), or as a misconception sees it. */
function simulateMap(plan: MapPlan, mode: 'live' | 'snapshot' | 'no-additions'): { visits: string[]; final: string } {
	const entries: { key: string; value: number; alive: boolean }[] = plan.keys.map((key, i) => ({
		key,
		value: plan.values[i] ?? 0,
		alive: true
	}));
	const find = (key: string) => entries.find((e) => e.alive && e.key === key);
	const actionOf = (key: string): MapAction => plan.actions[plan.keys.indexOf(key)] ?? { kind: 'none' };
	const apply = (key: string, value: number) => {
		const action = actionOf(key);
		if (value >= 10 || action.kind === 'none') return;
		if (action.kind === 'delete') {
			const e = find(action.key);
			if (e) e.alive = false;
		} else if (action.kind === 'set') {
			const e = find(action.key);
			if (e) e.value = action.value;
			else entries.push({ key: action.key, value: action.value, alive: true });
		} else {
			const e = find(key);
			if (e) e.alive = false;
			entries.push({ key, value: value + 10, alive: true });
		}
	};
	const visits: string[] = [];
	if (mode === 'snapshot') {
		const initial = entries.map((e) => ({ key: e.key, value: e.value }));
		for (const e of initial) {
			visits.push(`${e.key} ${e.value}`);
			apply(e.key, e.value);
		}
	} else {
		const bound = entries.length;
		for (let i = 0; i < entries.length && (mode === 'live' || i < bound); i += 1) {
			const e = entries[i];
			if (!e?.alive) continue;
			visits.push(`${e.key} ${e.value}`);
			apply(e.key, e.value);
		}
	}
	const final = entries
		.filter((e) => e.alive)
		.map((e) => `${e.key}=${e.value}`)
		.join(' ');
	return { visits, final };
}

function mapProgram(plan: MapPlan): Program {
	const entries = plan.keys.map((k, i) => `['${k}', ${plan.values[i] ?? 0}]`).join(', ');
	const body = plan.keys.flatMap((key) => {
		const action = plan.actions[plan.keys.indexOf(key)] ?? { kind: 'none' as const };
		const guard = `  if (key === '${key}' && value < 10)`;
		if (action.kind === 'delete') return [`${guard} m.delete('${action.key}');`];
		if (action.kind === 'set') return [`${guard} m.set('${action.key}', ${action.value});`];
		if (action.kind === 'move') return [`${guard} {`, '    m.delete(key);', '    m.set(key, value + 10);', '  }'];
		return [];
	});
	const lines = [
		`const m = new Map([${entries}]);`,
		'for (const [key, value] of m) {',
		'  console.log(key, value);',
		...body,
		'}',
		"console.log([...m].map(([k, v]) => k + '=' + v).join(' '));"
	];
	const result = (mode: 'live' | 'snapshot' | 'no-additions') => {
		const r = simulateMap(plan, mode);
		return [...r.visits, r.final];
	};
	return {
		lines,
		answer: result('live'),
		wrong: {
			// for…of walks a snapshot of the entries taken when the loop starts.
			'snapshot-iteration': result('snapshot'),
			// Entries added during the loop are not visited.
			'added-not-visited': result('no-additions')
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Senior.

/** A pipeline of generators closed from its end: `return()` travels down every `for…of`, the innermost `finally` first. */
function pipeline(rng: Rng): Program {
	const start = rng.int(1, 9);
	const step = rng.int(1, 4);
	const factor = rng.int(2, 9);
	const divisor = rng.int(2, 4);
	// A step that is a multiple of the divisor would let the filter pass all values or none.
	const useFilter = step % divisor !== 0 && rng.bool();
	const n = rng.int(2, 4);
	const mode = rng.pick(['after', 'before'] as const);
	const consumerBreak = rng.bool(0.4);
	// The source values a run pulls, in order, and the mapped values that pass the filter.
	const sourceAt = (j: number) => start + j * step;
	const passes = (x: number) => !useFilter || x % divisor !== 0;
	const passing: { pulls: number; value: number }[] = [];
	for (let j = 0; passing.length < n + 2; j += 1) {
		const x = sourceAt(j);
		if (passes(x)) passing.push({ pulls: j + 1, value: x * factor });
	}
	const breakAt = consumerBreak ? rng.int(1, n - 1) : null;
	const limit = breakAt === null ? null : (passing[breakAt - 1]?.value ?? 0);
	const lines = [
		'function* source() {',
		'  try {',
		`    for (let i = ${start}; ; i += ${step}) {`,
		"      console.log('pull', i);",
		'      yield i;',
		'    }',
		'  } finally {',
		"    console.log('source done');",
		'  }',
		'}',
		...(useFilter
			? [
					'function* filter(src, pred) {',
					'  try {',
					'    for (const x of src) if (pred(x)) yield x;',
					'  } finally {',
					"    console.log('filter done');",
					'  }',
					'}'
				]
			: []),
		'function* map(src, fn) {',
		'  try {',
		'    for (const x of src) yield fn(x);',
		'  } finally {',
		"    console.log('map done');",
		'  }',
		'}',
		'function* take(src, n) {',
		'  let count = 0;',
		'  try {',
		'    for (const x of src) {',
		...(mode === 'after'
			? ['      yield x;', '      count += 1;', '      if (count >= n) return;']
			: ['      if (count >= n) return;', '      count += 1;', '      yield x;']),
		'    }',
		'  } finally {',
		"    console.log('take done');",
		'  }',
		'}',
		useFilter
			? `const values = take(map(filter(source(), (x) => x % ${divisor} !== 0), (x) => x * ${factor}), ${n});`
			: `const values = take(map(source(), (x) => x * ${factor}), ${n});`,
		"console.log('built');",
		'for (const v of values) {',
		"  console.log('use', v);",
		...(limit === null ? [] : [`  if (v >= ${limit}) break;`]),
		'}',
		"console.log('end');"
	];
	const closing = ['source done', ...(useFilter ? ['filter done'] : []), 'map done', 'take done'];
	const trace = (close: string[], extraPull: boolean): string[] => {
		const out = ['built'];
		let pulled = 0;
		const pullTo = (pulls: number) => {
			for (; pulled < pulls; pulled += 1) out.push(`pull ${sourceAt(pulled)}`);
		};
		const used = breakAt ?? n;
		for (let k = 0; k < used; k += 1) {
			const item = passing[k];
			if (!item) break;
			pullTo(item.pulls);
			out.push(`use ${item.value}`);
		}
		// The generator closes when the consumer breaks, or when take sees its count reached: after the last
		// yield (mode `after`), or only on the next value it pulls (mode `before`).
		if (breakAt === null && mode === 'before' && extraPull) pullTo(passing[n]?.pulls ?? pulled);
		out.push(...close, 'end');
		return out;
	};
	return {
		lines,
		answer: trace(closing, true),
		wrong: {
			// The outer generator's finally runs first, the source's last.
			'outer-finally-first': trace([...closing].reverse(), true),
			// Only the generator the loop holds is closed; the inner ones stay suspended.
			'inner-left-suspended': trace(['take done'], true),
			// take returns as soon as its count is reached, without pulling one more value.
			'no-extra-pull': trace(closing, false)
		}
	};
}

/** Destructuring and `break` close a generator for good; an array iterator has no `return()` and goes on. */
function oneShot(rng: Rng): Program {
	const values = distinct(rng, 5, 1, 99);
	const k = rng.int(1, 3);
	const breakIndex = rng.int(0, 2);
	const manual = rng.int(1, 2);
	const name = rng.pick(['ids', 'scores', 'pages', 'rows'] as const);
	const vars = ['a', 'b', 'c'].slice(0, k);
	const breakValue = values[breakIndex] ?? 0;
	const lines = [
		`function* ${name}() {`,
		`  yield* [${values.join(', ')}];`,
		'}',
		`const it = ${name}();`,
		`const [${vars.join(', ')}] = it;`,
		`console.log(${vars.join(', ')});`,
		'console.log(JSON.stringify([...it]));',
		`const gen = ${name}();`,
		'for (const x of gen) {',
		`  if (x === ${breakValue}) break;`,
		'}',
		'console.log(JSON.stringify([...gen]));',
		`const list = [${values.join(', ')}];`,
		'const li = list[Symbol.iterator]();',
		'for (const x of li) {',
		`  if (x === ${breakValue}) break;`,
		'}',
		'console.log(JSON.stringify([...li]));',
		`const g = ${name}();`,
		...Array.from({ length: manual }, () => 'g.next();'),
		'console.log(JSON.stringify(Array.from(g)));',
		'console.log(JSON.stringify(Array.from(g)));',
		`const again = ${name}();`,
		'console.log(Math.max(...again), Math.min(...again));'
	];
	const json = (list: readonly number[]) => JSON.stringify(list);
	const firstK = values.slice(0, k).join(' ');
	const afterBreak = json(values.slice(breakIndex + 1));
	const afterManual = json(values.slice(manual));
	const max = Math.max(...values);
	const min = Math.min(...values);
	return {
		lines,
		answer: [firstK, '[]', '[]', afterBreak, afterManual, '[]', `${max} Infinity`],
		wrong: {
			// Destructuring takes what it needs and leaves the generator open.
			'destructuring-leaves-open': [
				firstK,
				json(values.slice(k)),
				'[]',
				afterBreak,
				afterManual,
				'[]',
				`${max} Infinity`
			],
			// break leaves the generator open; the rest can still be read.
			'break-leaves-open': [firstK, '[]', afterBreak, afterBreak, afterManual, '[]', `${max} Infinity`],
			// break closes an array iterator just like a generator.
			'array-iterator-closed': [firstK, '[]', '[]', '[]', afterManual, '[]', `${max} Infinity`],
			// Every spread or Array.from of a generator object starts it over.
			'generator-restarts': [
				firstK,
				json(values),
				json(values),
				afterBreak,
				json(values),
				json(values),
				`${max} ${min}`
			]
		}
	};
}

type JobOp =
	{ kind: 'next'; arg: number | null } | { kind: 'throw'; message: string } | { kind: 'return'; value: number };

interface JobFlags {
	/** return() inside try/catch completes at once, without the yield of finally. */
	returnSkipsFinallyYield: boolean;
	/** After the yield of finally the pending return is forgotten: the generator runs on to its own return. */
	pendingReturnLost: boolean;
}

/**
 * The shown job generator under a sequence of calls: `try { a = yield Y1; log a; b = yield Y2; log b } catch { log;
 * yield Y3 } finally { log cleanup; yield Y4 } return Y5`. Each call prints `label value done` or `label error m`.
 */
function simulateJob(ops: readonly JobOp[], y: readonly number[], flags: JobFlags): string[] {
	type State = 'init' | 'A' | 'B' | 'C' | 'D' | 'done';
	type Pending = { kind: 'normal' } | { kind: 'return'; value: number } | { kind: 'throw'; message: string };
	let state: State = 'init';
	let pending: Pending = { kind: 'normal' };
	const out: string[] = [];
	const [y1, y2, y3, y4, y5] = y as [number, number, number, number, number];
	ops.forEach((op, i) => {
		const label = String(i + 1);
		const result = (value: number | string, done: boolean) => out.push(`${label} ${value} ${done}`);
		const error = (message: string) => out.push(`${label} error ${message}`);
		// Entering finally with a completion: log, then yield Y4 (or, under the misconception, finish a return at once).
		const enterFinally = (p: Pending) => {
			out.push('cleanup');
			if (p.kind === 'return' && flags.returnSkipsFinallyYield) {
				state = 'done';
				result(p.value, true);
				return;
			}
			pending = p;
			state = 'D';
			result(y4, false);
		};
		const enterCatch = (message: string) => {
			out.push(`caught ${message}`);
			state = 'C';
			result(y3, false);
		};
		switch (state) {
			case 'init':
				if (op.kind === 'next') {
					state = 'A';
					result(y1, false);
				} else if (op.kind === 'return') {
					state = 'done';
					result(op.value, true);
				} else {
					state = 'done';
					error(op.message);
				}
				return;
			case 'A':
			case 'B':
				if (op.kind === 'next') {
					out.push(`${state === 'A' ? 'a' : 'b'} ${op.arg ?? 'undefined'}`);
					if (state === 'A') {
						state = 'B';
						result(y2, false);
					} else enterFinally({ kind: 'normal' });
				} else if (op.kind === 'throw') enterCatch(op.message);
				else enterFinally({ kind: 'return', value: op.value });
				return;
			case 'C':
				if (op.kind === 'next') enterFinally({ kind: 'normal' });
				else if (op.kind === 'throw') enterFinally({ kind: 'throw', message: op.message });
				else enterFinally({ kind: 'return', value: op.value });
				return;
			case 'D': {
				state = 'done';
				if (op.kind === 'return') return result(op.value, true);
				if (op.kind === 'throw') return error(op.message);
				const p: Pending = pending.kind === 'return' && flags.pendingReturnLost ? { kind: 'normal' } : pending;
				if (p.kind === 'normal') return result(y5, true);
				if (p.kind === 'return') return result(p.value, true);
				return error(p.message);
			}
			case 'done':
				if (op.kind === 'next') return result('undefined', true);
				if (op.kind === 'return') return result(op.value, true);
				return error(op.message);
		}
	});
	return out;
}

const MESSAGES = ['timeout', 'offline', 'denied', 'busy', 'stale'] as const;

/** throw() and return() against try/catch/finally: a `yield` in finally suspends a return, the next call completes it. */
function throwReturn(rng: Rng): Program {
	const y = distinct(rng, 5, 10, 99);
	const right: JobFlags = { returnSkipsFinallyYield: false, pendingReturnLost: false };
	const drawOps = (): JobOp[] => {
		const length = rng.int(5, 6);
		return Array.from({ length }, (_, i): JobOp => {
			const roll = i === 0 ? 0 : rng.int(0, 5);
			if (roll <= 2) return { kind: 'next', arg: rng.bool(0.8) ? rng.int(1, 9) : null };
			if (roll === 3) return { kind: 'throw', message: rng.pick(MESSAGES) };
			return { kind: 'return', value: rng.int(100, 999) };
		});
	};
	// The calls must reach a return suspended by the yield of finally and then complete it.
	const relevant = (ops: JobOp[]) => {
		const answer = simulateJob(ops, y, right);
		return (
			!same(answer, simulateJob(ops, y, { ...right, returnSkipsFinallyYield: true })) &&
			!same(answer, simulateJob(ops, y, { ...right, pendingReturnLost: true }))
		);
	};
	let ops: JobOp[] = [];
	for (let attempt = 0; attempt < 60 && ops.length === 0; attempt += 1) {
		const draw = drawOps();
		if (relevant(draw)) ops = draw;
	}
	if (ops.length === 0) {
		ops = [
			{ kind: 'next', arg: null },
			{ kind: 'next', arg: rng.int(1, 9) },
			{ kind: 'return', value: rng.int(100, 999) },
			{ kind: 'next', arg: rng.int(1, 9) },
			{ kind: 'next', arg: null }
		];
	}
	const [y1, y2, y3, y4, y5] = y as [number, number, number, number, number];
	const call = (op: JobOp): string =>
		op.kind === 'next'
			? `it.next(${op.arg ?? ''})`
			: op.kind === 'throw'
				? `it.throw(new Error('${op.message}'))`
				: `it.return(${op.value})`;
	const name = rng.pick(['job', 'task', 'upload', 'sync'] as const);
	const lines = [
		`function* ${name}() {`,
		'  try {',
		`    const a = yield ${y1};`,
		"    console.log('a', a);",
		`    const b = yield ${y2};`,
		"    console.log('b', b);",
		'  } catch (e) {',
		"    console.log('caught', e.message);",
		`    yield ${y3};`,
		'  } finally {',
		"    console.log('cleanup');",
		`    yield ${y4};`,
		'  }',
		`  return ${y5};`,
		'}',
		'function step(label, call) {',
		'  try {',
		'    const r = call();',
		'    console.log(label, r.value, r.done);',
		'  } catch (e) {',
		"    console.log(label, 'error', e.message);",
		'  }',
		'}',
		`const it = ${name}();`,
		...ops.map((op, i) => `step(${i + 1}, () => ${call(op)});`)
	];
	return {
		lines,
		answer: simulateJob(ops, y, right),
		wrong: {
			// return() completes at once: finally runs its log, but its yield is skipped.
			'return-skips-finally-yield': simulateJob(ops, y, { ...right, returnSkipsFinallyYield: true }),
			// After the yield of finally the generator forgets the pending return and runs on to its own return.
			'pending-return-lost': simulateJob(ops, y, { ...right, pendingReturnLost: true })
		}
	};
}

/** An array iterator walks by index (a removal skips the next element, a push is reached); a Set re-added value is visited again. */
function collections(rng: Rng): Program {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const program = collectionsDraw(rng);
		if (program) return program;
	}
	return collectionsProgram([3, 4, 6, 7, 9, 10], 7, 13, [5, 8, 2, 11], 5, 2, 11);
}

function collectionsDraw(rng: Rng): Program | null {
	const queue = distinct(rng, 6, 1, 40);
	const odd = queue.filter((x) => x % 2 === 1);
	const trigger = odd[rng.int(0, Math.max(odd.length - 1, 0))];
	if (trigger === undefined) return null;
	const pushed = rng.pick([41, 43, 45, 47, 49, 51]);
	const tags = distinct(rng, 4, 1, 9);
	const [first, second, third] = rng.sample([0, 1, 2, 3], 3) as [number, number, number];
	// One value deletes another (ahead of the iterator or behind it), one value is deleted and added again.
	const deleter = tags[Math.min(first, second)] ?? 0;
	const deleted = tags[Math.max(first, second)] ?? 0;
	const mover = tags[third] ?? 0;
	if (mover === deleted) return null;
	const program = collectionsProgram(queue, trigger, pushed, tags, deleter, deleted, mover);
	return same(program.answer, program.wrong['array-snapshot'] ?? []) ? null : program;
}

function simulateQueue(queue: readonly number[], trigger: number, pushed: number, mode: 'index' | 'all' | 'snapshot') {
	const arr = [...queue];
	const visits: string[] = [];
	const act = (x: number) => {
		if (x % 2 === 0) arr.splice(arr.indexOf(x), 1);
		else if (x === trigger) arr.push(pushed);
	};
	if (mode === 'index') {
		for (let i = 0; i < arr.length; i += 1) {
			const x = arr[i] ?? 0;
			visits.push(`visit ${x}`);
			act(x);
		}
	} else {
		const seen = mode === 'snapshot' ? [...queue] : [...queue, ...(queue.includes(trigger) ? [pushed] : [])];
		for (const x of seen) {
			visits.push(`visit ${x}`);
			act(x);
		}
	}
	return [...visits, arr.join(',')];
}

function simulateTags(
	tags: readonly number[],
	deleter: number,
	deleted: number,
	mover: number,
	mode: 'live' | 'no-revisit' | 'deleted-visited'
) {
	const entries = tags.map((value) => ({ value, alive: true }));
	const visits: string[] = [];
	let moved = false;
	const remove = (value: number) => {
		const e = entries.find((x) => x.alive && x.value === value);
		if (e) e.alive = false;
	};
	for (let i = 0; i < entries.length; i += 1) {
		const e = entries[i];
		if (!e) break;
		if (!e.alive && !(mode === 'deleted-visited' && e.value === deleted && i < tags.length)) continue;
		visits.push(`tag ${e.value}`);
		if (e.value === deleter) remove(deleted);
		if (e.value === mover && !moved) {
			moved = true;
			remove(mover);
			if (mode === 'no-revisit') {
				e.alive = true;
			} else entries.push({ value: mover, alive: true });
		}
	}
	return [
		...visits,
		entries
			.filter((x) => x.alive)
			.map((x) => x.value)
			.join(',')
	];
}

function collectionsProgram(
	queue: readonly number[],
	trigger: number,
	pushed: number,
	tags: readonly number[],
	deleter: number,
	deleted: number,
	mover: number
): Program {
	const lines = [
		`const queue = [${queue.join(', ')}];`,
		'for (const x of queue) {',
		"  console.log('visit', x);",
		'  if (x % 2 === 0) queue.splice(queue.indexOf(x), 1);',
		`  else if (x === ${trigger}) queue.push(${pushed});`,
		'}',
		"console.log(queue.join(','));",
		`const tags = new Set([${tags.join(', ')}]);`,
		'let moved = false;',
		'for (const t of tags) {',
		"  console.log('tag', t);",
		`  if (t === ${deleter}) tags.delete(${deleted});`,
		`  if (t === ${mover} && !moved) {`,
		'    moved = true;',
		'    tags.delete(t);',
		'    tags.add(t);',
		'  }',
		'}',
		"console.log([...tags].join(','));"
	];
	const right = [
		...simulateQueue(queue, trigger, pushed, 'index'),
		...simulateTags(tags, deleter, deleted, mover, 'live')
	];
	const tagsRight = simulateTags(tags, deleter, deleted, mover, 'live');
	const queueRight = simulateQueue(queue, trigger, pushed, 'index');
	return {
		lines,
		answer: right,
		wrong: {
			// Removing the current element does not shift the iteration: every element is visited.
			'splice-no-skip': [...simulateQueue(queue, trigger, pushed, 'all'), ...tagsRight],
			// for…of walks the array as it was when the loop started.
			'array-snapshot': [...simulateQueue(queue, trigger, pushed, 'snapshot'), ...tagsRight],
			// A value deleted and added again keeps its place and is not visited twice.
			'set-readd-no-revisit': [...queueRight, ...simulateTags(tags, deleter, deleted, mover, 'no-revisit')],
			// A value deleted before the iterator reaches it is still visited.
			'set-deleted-visited': [...queueRight, ...simulateTags(tags, deleter, deleted, mover, 'deleted-visited')]
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'lazy-delegation': lazyDelegation,
	'early-exit': earlyExit,
	'next-value': nextValue,
	'map-mutation': mapMutation,
	pipeline,
	'one-shot': oneShot,
	'throw-return': throwReturn,
	collections
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	const program = make(rng);
	const source = program.lines.join('\n');
	const toAnswer = (lines: readonly string[]) => ({ kind: 'sequence' as const, value: [...lines] });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js)? Введите вывод построчно, как он появится в консоли: ' +
				'значения из одного вызова `console.log` — в одной строке через пробел.',
			code: { language: 'javascript', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const lines = program.wrong[id];
					// A misconception that gives the right output on this instance does not apply to it.
					const applies = lines !== undefined && !same(lines, program.answer);
					return [id, applies ? { kind: 'answer' as const, answer: toAnswer(lines) } : null];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
