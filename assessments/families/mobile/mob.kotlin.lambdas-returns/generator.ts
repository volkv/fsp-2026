// Returns from lambdas in Kotlin: a bare `return` in the lambda of an inline function leaves the enclosing function, a
// `return@label` leaves only the lambda (a `continue` of `forEach`, a `break` of an enclosing `run`), `return` in an
// anonymous function leaves only that function, lambdas capture variables (not values), `fold` and `run` with an early
// exit, `any`/`all`/`none` and `&&`/`||` stop at the first decisive element, an elvis after `let` with an early exit.
// The model executes the shown program step by step. The mechanism that decides the output is the essential class;
// values, names and constants are surface.
import {
	instanceRng,
	levelAndClass,
	readDescriptor,
	type Built,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { traceBuilt, type TraceProgram } from '../../_lib/kotlin-items.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const LIST_NAMES = ['ids', 'messages', 'orders', 'items', 'events'];

function values(rng: Rng, count: number, min = 1, max = 30): number[] {
	return rng.sample(
		Array.from({ length: max - min + 1 }, (_, i) => i + min),
		count
	);
}

// Middle.

/** A bare `return` in the lambda of an inline function leaves the enclosing function, not only the loop. */
function nonlocalReturn(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 5);
		const fn = rng.pick(['scan', 'render', 'sync', 'deliver']);
		const okWord = rng.pick(['ok', 'show', 'sent']);
		const loop = rng.pick(['forEach', 'repeat', 'custom'] as const);
		const each = rng.pick(['eachItem', 'withEach', 'visit']);
		const sorted = [...xs].sort((a, b) => a - b);
		// Three calls: a stop in the middle, no stop at all, and a stop at another place.
		const limits = rng.shuffle([
			sorted[rng.int(1, 3)] as number,
			sorted[4] as number,
			(sorted[rng.int(0, 1)] as number) + 0
		]);
		if (new Set(limits).size < 3) continue;
		const stopAt = (limit: number): number => xs.findIndex((x) => x > limit);
		if (limits.every((l) => stopAt(l) === -1)) continue;
		const list = rng.pick(LIST_NAMES);
		const body =
			loop === 'repeat'
				? [
						`    repeat(${list}.size) { i ->`,
						`        if (${list}[i] > limit) return`,
						`        println("${okWord} \${${list}[i]}")`,
						'    }'
					]
				: [
						loop === 'forEach' ? `    ${list}.forEach {` : `    ${each}(${list}) {`,
						'        if (it > limit) return',
						`        println("${okWord} $it")`,
						'    }'
					];
		const lines = [
			...(loop === 'custom'
				? [
						`inline fun ${each}(items: List<Int>, action: (Int) -> Unit) {`,
						'    for (x in items) action(x)',
						`    println("${each} end")`,
						'}',
						''
					]
				: []),
			`fun ${fn}(${list}: List<Int>, limit: Int) {`,
			`    println("${fn} $limit")`,
			...body,
			`    println("${fn} end")`,
			'}',
			'',
			'fun main() {',
			`    val ${list} = listOf(${xs.join(', ')})`,
			...limits.map((l) => `    ${fn}(${list}, ${l})`),
			'    println("main end")',
			'}'
		];
		const run = (mode: 'kotlin' | 'continue' | 'break'): string[] => {
			const out: string[] = [];
			for (const limit of limits) {
				out.push(`${fn} ${limit}`);
				let returned = false;
				for (const x of xs) {
					if (x > limit) {
						if (mode === 'continue') continue;
						returned = mode === 'kotlin';
						break;
					}
					out.push(`${okWord} ${x}`);
				}
				if (returned) continue;
				// The break misconception leaves the call of the inline function: its own last line is skipped too.
				if (loop === 'custom' && !(mode === 'break' && stopAt(limit) !== -1)) out.push(`${each} end`);
				out.push(`${fn} end`);
			}
			out.push('main end');
			return out;
		};
		return {
			lines,
			answer: run('kotlin'),
			wrong: { 'return-as-continue': run('continue'), 'return-as-break': run('break') }
		};
	}
}

/** `return@forEach` is a `continue`; `return@label` of an enclosing `run` is a `break`. */
function labeledReturn(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 5);
		const list = rng.pick(LIST_NAMES);
		const k = rng.int(2, 3);
		const sorted = [...xs].sort((a, b) => a - b);
		const t = sorted[rng.int(1, 3)] as number;
		const runLabel = rng.pick(['loop', 'search', 'scan']);
		const itemLabel = rng.pick(['item', 'row', 'entry']);
		const [w1, w2, w3] = rng.sample(['odd', 'small', 'kept', 'seen', 'next', 'shown'], 3) as [string, string, string];
		const after = rng.pick(['after', 'then', 'next']);
		const doneWord = rng.pick(['loop done', 'all checked', 'no stop']);
		const blocks = rng.shuffle(['each', 'run', 'custom'] as const).slice(0, rng.int(2, 3));
		if (!blocks.includes('run')) continue;
		const skip = (x: number): boolean => x % k === 0;
		if (!xs.some(skip) || xs.every(skip)) continue;
		const stop = xs.findIndex((x) => x > t);
		if (stop <= 0) continue;
		const lines = ['fun main() {', `    val ${list} = listOf(${xs.join(', ')})`];
		blocks.forEach((b, i) => {
			if (b === 'each')
				lines.push(
					`    ${list}.forEach {`,
					`        if (it % ${k} == 0) return@forEach`,
					`        println("${w1} $it")`,
					'    }'
				);
			else if (b === 'custom')
				lines.push(
					`    ${list}.forEachIndexed ${itemLabel}@{ i, x ->`,
					`        if (x % ${k} == 0) return@${itemLabel}`,
					`        println("${w3} $i $x")`,
					'    }'
				);
			else
				lines.push(
					`    run ${runLabel}@{`,
					`        ${list}.forEach {`,
					`            if (it > ${t}) return@${runLabel}`,
					`            println("${w2} $it")`,
					'        }',
					`        println("${doneWord}")`,
					'    }'
				);
			lines.push(`    println("${after} ${i + 1}")`);
		});
		lines.push('}');
		const run = (labelBreaks: boolean, runContinues: boolean): string[] => {
			const out: string[] = [];
			blocks.forEach((b, i) => {
				if (b === 'each' || b === 'custom') {
					for (const [j, x] of xs.entries()) {
						if (skip(x)) {
							if (labelBreaks) break;
							continue;
						}
						out.push(b === 'each' ? `${w1} ${x}` : `${w3} ${j} ${x}`);
					}
				} else {
					let broke = false;
					for (const x of xs) {
						if (x > t) {
							if (runContinues) continue;
							broke = true;
							break;
						}
						out.push(`${w2} ${x}`);
					}
					if (!broke) out.push(doneWord);
				}
				out.push(`${after} ${i + 1}`);
			});
			return out;
		};
		const answer = run(false, false);
		const breaks = run(true, false);
		if (breaks.join() === answer.join()) continue;
		return {
			lines,
			answer,
			wrong: { 'label-breaks': breaks, 'run-label-continues': run(false, true) }
		};
	}
}

/**
 * `return` in an anonymous function leaves only that function, as `return@forEach` leaves only the lambda; a bare
 * `return` in a lambda leaves the enclosing function.
 */
function anonymousFunction(rng: Rng): TraceProgram {
	for (;;) {
		const k = rng.int(2, 4);
		const skip = (x: number): boolean => x % k === 0;
		const xs = values(rng, 5);
		const at = xs.findIndex(skip);
		if (at <= 0 || at === xs.length - 1) continue;
		const clean = values(rng, 12)
			.filter((x) => !skip(x))
			.slice(0, 3);
		if (clean.length < 3) continue;
		const fn = rng.pick(['process', 'publish', 'refresh']);
		const [anonWord, labelWord, lambdaWord] = rng.sample(['anon', 'fun', 'lambda', 'block', 'step', 'label'], 3) as [
			string,
			string,
			string
		];
		const between = rng.pick(['between', 'half', 'middle']);
		const anonFirst = rng.bool();
		const list = rng.pick(LIST_NAMES);
		const anon = [
			`    ${list}.forEach(fun(id) {`,
			`        if (id % ${k} == 0) return`,
			`        println("${anonWord} $id")`,
			'    })'
		];
		const labeled = [
			`    ${list}.forEach {`,
			`        if (it % ${k} == 0) return@forEach`,
			`        println("${labelWord} $it")`,
			'    }'
		];
		const lines = [
			`fun ${fn}(${list}: List<Int>) {`,
			...(anonFirst ? [...anon, ...labeled] : [...labeled, ...anon]),
			`    println("${between}")`,
			`    ${list}.forEach {`,
			`        if (it % ${k} == 0) return`,
			`        println("${lambdaWord} $it")`,
			'    }',
			`    println("${fn} end")`,
			'}',
			'',
			'fun main() {',
			`    ${fn}(listOf(${xs.join(', ')}))`,
			`    ${fn}(listOf(${clean.join(', ')}))`,
			'    println("main end")',
			'}'
		];
		type Block = 'anon' | 'labeled' | 'bare';
		const run = (exits: Readonly<Record<Block, 'exit' | 'break' | 'continue'>>): string[] => {
			const out: string[] = [];
			const word: Record<Block, string> = { anon: anonWord, labeled: labelWord, bare: lambdaWord };
			const block = (b: Block, items: readonly number[]): boolean => {
				for (const x of items) {
					if (skip(x)) {
						if (exits[b] === 'exit') return true;
						if (exits[b] === 'break') return false;
						continue;
					}
					out.push(`${word[b]} ${x}`);
				}
				return false;
			};
			for (const items of [xs, clean]) {
				const order: Block[] = anonFirst ? ['anon', 'labeled'] : ['labeled', 'anon'];
				const exited =
					block(order[0] as Block, items) ||
					block(order[1] as Block, items) ||
					(out.push(between), block('bare', items));
				if (!exited) out.push(`${fn} end`);
			}
			out.push('main end');
			return out;
		};
		return {
			lines,
			answer: run({ anon: 'continue', labeled: 'continue', bare: 'exit' }),
			wrong: {
				'anon-returns-outer': run({ anon: 'exit', labeled: 'continue', bare: 'exit' }),
				'return-as-continue': run({ anon: 'continue', labeled: 'continue', bare: 'continue' }),
				'label-breaks': run({ anon: 'continue', labeled: 'break', bare: 'exit' })
			}
		};
	}
}

/** A lambda captures the variable itself: it sees later assignments and its writes are seen outside. */
function capturedVar(rng: Rng): TraceProgram {
	const n = rng.int(2, 4);
	const start = rng.int(0, 5);
	const reassigned = rng.int(10, 40);
	const m = rng.int(2, 5);
	const doubling = rng.bool();
	const name = rng.pick(['badge', 'unread', 'total', 'clicks']);
	const word = rng.pick(['tap', 'open', 'hit']);
	const again = rng.int(0, n - 1);
	const reset = rng.bool() ? rng.int(1, 9) : null;
	const step = (v: number, i: number): number => (doubling ? v * 2 + i : v + i * m);
	const lines = [
		'fun main() {',
		`    var ${name} = ${start}`,
		'    val actions = mutableListOf<() -> Unit>()',
		`    for (i in 1..${n}) {`,
		'        actions.add {',
		doubling ? `            ${name} = ${name} * 2 + i` : `            ${name} += i * ${m}`,
		`            println("${word} $i $${name}")`,
		'        }',
		'    }',
		`    println("before $${name}")`,
		`    ${name} = ${reassigned}`,
		'    actions.forEach { it() }',
		...(reset !== null ? [`    val reset = { ${name} = ${reset} }`, '    reset()'] : []),
		`    actions[${again}]()`,
		`    println("final $${name}")`,
		'}'
	];
	const run = (mode: 'kotlin' | 'snapshot' | 'shared-loop'): string[] => {
		const out: string[] = [`before ${start}`];
		let outer = reassigned;
		const own = Array.from({ length: n }, () => start);
		const call = (j: number): void => {
			const i = mode === 'shared-loop' ? n : j + 1;
			if (mode === 'snapshot') {
				own[j] = step(own[j] as number, i);
				out.push(`${word} ${i} ${own[j]}`);
			} else {
				outer = step(outer, i);
				out.push(`${word} ${i} ${outer}`);
			}
		};
		for (let j = 0; j < n; j += 1) call(j);
		// The snapshot misconception: `reset` writes its own copy, the outer variable stays.
		if (reset !== null && mode !== 'snapshot') outer = reset;
		call(again);
		out.push(`final ${outer}`);
		return out;
	};
	return {
		lines,
		answer: run('kotlin'),
		wrong: { 'capture-snapshot': run('snapshot'), 'loop-var-shared': run('shared-loop') }
	};
}

// Senior.

/** Nested labels: `return@outer` skips the rest of a row, `return@inner` one cell, a bare `return` leaves the function. */
function nestedLabels(rng: Rng): TraceProgram {
	for (;;) {
		const rows = Array.from({ length: 3 }, () =>
			Array.from({ length: rng.int(2, 4) }, () =>
				rng.bool(0.2) ? 0 : rng.bool(0.15) ? -rng.int(1, 9) : rng.int(1, 40)
			)
		);
		const limit = rng.int(20, 35);
		const fn = rng.pick(['scanGrid', 'layout', 'measure']);
		const cell = rng.pick(['cell', 'tile', 'slot']);
		const rowWord = rng.pick(['row', 'line', 'band']);
		const stopWord = rng.pick(['stop', 'overflow', 'break']);
		const allWord = rng.pick(['all', 'fits', 'complete']);
		const [outer, inner] = rng.sample(['outer', 'rows', 'grid', 'inner', 'cells', 'line'], 2) as [string, string];
		const lines = [
			`fun ${fn}(rows: List<List<Int>>): String {`,
			`    rows.forEachIndexed ${outer}@{ r, row ->`,
			`        row.forEach ${inner}@{ x ->`,
			`            if (x < 0) return@${outer}`,
			`            if (x == 0) return@${inner}`,
			`            if (x > ${limit}) return "${stopWord} $r $x"`,
			`            println("${cell} $r $x")`,
			'        }',
			`        println("${rowWord} $r done")`,
			'    }',
			`    return "${allWord}"`,
			'}',
			'',
			'fun main() {',
			`    val grid = listOf(${rows.map((r) => `listOf(${r.join(', ')})`).join(', ')})`,
			`    println(${fn}(grid))`,
			`    println(${fn}(grid.drop(1)))`,
			'}'
		];
		type Mode = 'kotlin' | 'outer-breaks' | 'inner-breaks' | 'return-as-break';
		const call = (rs: number[][], mode: Mode, out: string[]): void => {
			for (const [r, row] of rs.entries()) {
				let skipRow = false;
				for (const x of row) {
					if (x < 0) {
						if (mode === 'outer-breaks') {
							out.push(allWord);
							return;
						}
						skipRow = true;
						break;
					}
					if (x === 0) {
						if (mode === 'inner-breaks') break;
						continue;
					}
					if (x > limit) {
						if (mode === 'return-as-break') break;
						out.push(`${stopWord} ${r} ${x}`);
						return;
					}
					out.push(`${cell} ${r} ${x}`);
				}
				if (!skipRow) out.push(`${rowWord} ${r} done`);
			}
			out.push(allWord);
		};
		const run = (mode: Mode): string[] => {
			const out: string[] = [];
			call(rows, mode, out);
			call(rows.slice(1), mode, out);
			return out;
		};
		const answer = run('kotlin');
		// An overflow in the first cells ends both calls at once; such a log is too short for the class.
		if (answer.length < 6) continue;
		const flat = rows.flat();
		// Every mechanism must be on the path: a negative, a zero and an overflow, and the overflow must matter.
		if (!flat.some((x) => x < 0) || !flat.some((x) => x === 0) || !flat.some((x) => x > limit)) continue;
		const wrong = {
			'label-breaks': run('inner-breaks'),
			'outer-label-breaks': run('outer-breaks'),
			'return-as-break': run('return-as-break')
		};
		if (Object.values(wrong).some((w) => w.join() === answer.join())) continue;
		return { lines, answer, wrong };
	}
}

/** `return` from the lambda of `fold` leaves the whole function; `return@label` of `run` gives the value of `run`. */
function foldEarlyExit(rng: Rng): TraceProgram {
	for (;;) {
		const prices = values(rng, 5, 5, 40);
		const total = prices.reduce((a, b) => a + b, 0);
		const limitStop = rng.int(Math.floor(total / 3), Math.floor((total * 2) / 3));
		const limitFull = total + rng.int(0, 10);
		const limits = rng.shuffle([limitStop, limitFull]);
		const fn = rng.pick(['budget', 'checkout', 'fill']);
		const add = rng.pick(['add', 'take', 'plus']);
		const pivot = rng.int(15, 30);
		const label = rng.pick(['search', 'find', 'lookup']);
		const missing = -rng.int(1, 9);
		const lines = [
			`fun ${fn}(prices: List<Int>, limit: Int): Int {`,
			'    val total = prices.fold(0) { acc, p ->',
			`        println("${add} $p")`,
			'        if (acc + p > limit) return acc',
			'        acc + p',
			'    }',
			'    println("total $total")',
			'    return total',
			'}',
			'',
			'fun main() {',
			`    val prices = listOf(${prices.join(', ')})`,
			...limits.map((l) => `    println("result \${${fn}(prices, ${l})}")`),
			`    val big = run ${label}@{`,
			`        prices.forEach { if (it > ${pivot}) return@${label} it }`,
			`        ${missing}`,
			'    }',
			'    println("big $big")',
			'}'
		];
		const firstBig = prices.find((p) => p > pivot);
		type Mode = 'kotlin' | 'fold-continues' | 'return-as-break' | 'run-label-continues';
		const run = (mode: Mode): string[] => {
			const out: string[] = [];
			for (const limit of limits) {
				let acc = 0;
				let returned: number | null = null;
				for (const p of prices) {
					out.push(`${add} ${p}`);
					if (acc + p > limit) {
						if (mode === 'fold-continues') continue;
						if (mode === 'return-as-break') break;
						returned = acc;
						break;
					}
					acc += p;
				}
				if (returned === null) out.push(`total ${acc}`);
				out.push(`result ${returned ?? acc}`);
			}
			out.push(`big ${mode === 'run-label-continues' || firstBig === undefined ? missing : firstBig}`);
			return out;
		};
		if (firstBig === undefined) continue;
		return {
			lines,
			answer: run('kotlin'),
			wrong: {
				'fold-continues': run('fold-continues'),
				'return-as-break': run('return-as-break'),
				'run-label-continues': run('run-label-continues')
			}
		};
	}
}

/** `all`, `any` and `none` stop at the first decisive element; `&&` and `||` skip their right side. */
function shortCircuit(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 5);
		const [f, g] = rng.sample(['ready', 'cached', 'visible', 'synced'], 2) as [string, string];
		const k = rng.int(2, 4);
		const t = [...xs].sort((a, b) => a - b)[2] as number;
		const fp = (x: number): boolean => x % k !== 0;
		const gp = (x: number): boolean => x > t;
		const list = rng.pick(LIST_NAMES);
		type Op = {
			word: 'all' | 'any' | 'none' | 'count';
			expr: string;
			left: 'f' | 'g';
			join: '&&' | '||' | null;
			neg: boolean;
		};
		const pool: Op[] = [
			{ word: 'count', expr: `${f}(it) || ${g}(it)`, left: 'f', join: '||', neg: false },
			{ word: 'all', expr: `${f}(it)`, left: 'f', join: null, neg: false },
			{ word: 'any', expr: `${g}(it) && ${f}(it)`, left: 'g', join: '&&', neg: false },
			{ word: 'none', expr: `!${f}(it) || ${g}(it)`, left: 'f', join: '||', neg: true },
			{ word: 'all', expr: `${g}(it) || ${f}(it)`, left: 'g', join: '||', neg: false },
			{ word: 'any', expr: `!${g}(it) && !${f}(it)`, left: 'g', join: '&&', neg: true }
		];
		const ops = rng.sample(pool, 3);
		const lines = [
			`fun ${f}(id: Int): Boolean {`,
			`    println("${f} $id")`,
			`    return id % ${k} != 0`,
			'}',
			'',
			`fun ${g}(id: Int): Boolean {`,
			`    println("${g} $id")`,
			`    return id > ${t}`,
			'}',
			'',
			'fun main() {',
			`    val ${list} = listOf(${xs.join(', ')})`,
			...ops.map((op) => `    println("${op.word} \${${list}.${op.word} { ${op.expr} }}")`),
			'}'
		];
		const run = (elements: boolean, operators: boolean): string[] => {
			const out: string[] = [];
			for (const op of ops) {
				const eval1 = (x: number): boolean => {
					const call = (which: 'f' | 'g'): boolean => {
						out.push(`${which === 'f' ? f : g} ${x}`);
						return which === 'f' ? fp(x) : gp(x);
					};
					if (op.join === null) return call(op.left);
					const right = op.left === 'f' ? 'g' : 'f';
					const a = op.neg ? !call(op.left) : call(op.left);
					const skipRight = op.join === '&&' ? !a : a;
					if (skipRight && operators) return op.join === '||';
					// `!f || g` negates only the left side; `!g && !f` negates both.
					const bRaw = call(right);
					const b = op.neg && op.join === '&&' ? !bRaw : bRaw;
					return op.join === '&&' ? a && b : a || b;
				};
				if (op.word === 'count') {
					// count is not a search: it evaluates every element.
					out.push(`count ${xs.filter(eval1).length}`);
					continue;
				}
				let result = op.word === 'all' || op.word === 'none';
				for (const x of xs) {
					const v = eval1(x);
					if (op.word === 'all' ? !v : v) {
						result = op.word === 'any';
						if (elements) break;
					}
				}
				out.push(`${op.word} ${result}`);
			}
			return out;
		};
		const answer = run(true, true);
		// The log stays within the length of the other senior classes: the mechanism, not the volume, is the work.
		if (answer.length > 16) continue;
		const wrong = { 'no-short-circuit': run(false, true), 'operators-evaluate-both': run(true, false) };
		if (wrong['no-short-circuit'].join() === answer.join() || wrong['operators-evaluate-both'].join() === answer.join())
			continue;
		return { lines, answer, wrong };
	}
}

/** `?.let { … return@let null } ?: run { … return … }`: the elvis takes a null result of the block, `return` in `run` leaves the function. */
function letChain(rng: Rng): TraceProgram {
	for (;;) {
		const ids: (number | null)[] = rng.shuffle([null, ...values(rng, 3, 1, 30)]);
		const k = rng.int(2, 3);
		const fn = rng.pick(['title', 'label', 'caption']);
		const load = rng.pick(['load', 'read', 'query']);
		const fallback = rng.pick(['fallback', 'default', 'stub']);
		const none = rng.pick(['none', 'empty', 'missing']);
		const prefix = rng.pick(['item', 'chat', 'card']);
		const def = rng.pick(['guest', 'draft', 'blank']);
		const lines = [
			`fun ${fn}(id: Int?): String {`,
			'    val name = id?.let {',
			`        println("${load} $it")`,
			`        if (it % ${k} == 0) return@let null`,
			`        "${prefix}$it"`,
			'    } ?: run {',
			`        println("${fallback} $id")`,
			`        if (id == null) return "${none}"`,
			`        "${def}"`,
			'    }',
			'    println("got $name")',
			'    return name.uppercase()',
			'}',
			'',
			'fun main() {',
			`    for (id in listOf<Int?>(${ids.map(String).join(', ')})) {`,
			`        println(${fn}(id))`,
			'    }',
			'}'
		];
		type Mode = 'kotlin' | 'elvis-receiver-only' | 'run-return-local';
		const run = (mode: Mode): string[] => {
			const out: string[] = [];
			for (const id of ids) {
				let name: string | null;
				if (id !== null) {
					out.push(`${load} ${id}`);
					name = id % k === 0 ? null : `${prefix}${id}`;
					if (name === null && mode === 'elvis-receiver-only') {
						out.push('got null', 'NULL');
						continue;
					}
				} else name = null;
				if (name === null) {
					out.push(`${fallback} ${id === null ? 'null' : id}`);
					if (id === null) {
						if (mode === 'run-return-local') name = none;
						else {
							out.push(none);
							continue;
						}
					} else name = def;
				}
				out.push(`got ${name}`, name.toUpperCase());
			}
			return out;
		};
		if (!ids.some((x) => x !== null && x % k === 0) || !ids.some((x) => x !== null && x % k !== 0)) continue;
		return {
			lines,
			answer: run('kotlin'),
			wrong: { 'elvis-receiver-only': run('elvis-receiver-only'), 'run-return-local': run('run-return-local') }
		};
	}
}

const PROGRAMS: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	'nonlocal-return': nonlocalReturn,
	'labeled-return': labeledReturn,
	'anonymous-function': anonymousFunction,
	'captured-var': capturedVar,
	'nested-labels': nestedLabels,
	'fold-early-exit': foldEarlyExit,
	'short-circuit': shortCircuit,
	'let-chain': letChain
};

// The statement names the runtime the gate proves the output on.
const STATEMENT =
	'Что напечатает программа на Kotlin 2.4 (Kotlin/JVM, JVM 21)? Введите вывод построчно, как он появится на экране.';

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`no program for ${input.classId}`);
	const built = traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
	const { instance } = built;
	return { ...built, instance: { ...instance, statement: { ...instance.statement, markdown: STATEMENT } } };
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
