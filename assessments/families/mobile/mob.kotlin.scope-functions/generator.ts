// Scope functions in Kotlin: what `let`, `run`, `with`, `apply` and `also` return, `it` against `this`, the same
// object behind every receiver, name resolution inside the blocks (a local beats a member of the receiver, the
// innermost receiver beats the outer class, the innermost `it` beats the outer one). The mechanism that decides the
// output is the essential class; names, values and the order of the calls are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { ktList, type TraceProgram, traceBuild } from '../../_lib/mob-kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const COUNTERS = ['unread', 'badge', 'price', 'retries', 'pages', 'visits', 'likes'];
const LISTS = ['ids', 'cart', 'queue', 'history', 'pending'];
const TAGS = ['new', 'sale', 'hot', 'top', 'promo', 'gift', 'pinned', 'draft', 'local', 'synced'];

type Fn = 'let' | 'run' | 'also' | 'apply';
type Op = '+' | '-' | '*';

const applyOp = (x: number, op: Op, k: number): number => (op === '+' ? x + k : op === '-' ? x - k : x * k);
const pickOp = (rng: Rng): Op => rng.pick<Op>(['+', '-', '*']);
/** The receiver name inside a block: `it` for `let` and `also`, `this` for `run` and `apply`. */
const self = (fn: Fn): string => (fn === 'let' || fn === 'also' ? 'it' : 'this');
const returnsBlock = (fn: Fn): boolean => fn === 'let' || fn === 'run';

const main = (body: string[]): string[] => ['fun main() {', ...body.map((l) => `    ${l}`), '}'];

// Intern.

/** Four calls on one `Int`, each block computing a value: `let` and `run` return it, `also` and `apply` the receiver. */
function blockResult(rng: Rng): TraceProgram {
	const name = rng.pick(COUNTERS);
	const n = rng.int(3, 19);
	const fns = rng.shuffle<Fn>(['let', 'run', 'also', 'apply']);
	const calls = fns.map((fn) => {
		const op = pickOp(rng);
		const k = op === '*' ? rng.int(2, 5) : rng.int(2, 30);
		return { fn, op, k, value: applyOp(n, op, k) };
	});
	const vars = ['a', 'b', 'c', 'd'];
	return {
		lines: main([
			`val ${name} = ${n}`,
			...calls.map((c, i) => `val ${vars[i]} = ${name}.${c.fn} { ${self(c.fn)} ${c.op} ${c.k} }`),
			...vars.map((v) => `println(${v})`)
		]),
		answer: calls.map((c) => String(returnsBlock(c.fn) ? c.value : n)),
		wrong: {
			'returns-lambda': calls.map((c) => String(c.value)),
			'returns-receiver': calls.map(() => String(n))
		}
	};
}

/** Every block works on the same mutable list: a change inside `apply`, `also` or `let` is the change of the list. */
function sameObject(rng: Rng): TraceProgram {
	const name = rng.pick(LISTS);
	const init = [rng.int(2, 9), rng.int(10, 49), rng.int(2, 9)];
	const x = rng.int(10, 99);
	const y = rng.int(10, 99);
	const addFn = rng.pick<Fn>(['apply', 'also']);
	const removeFn = addFn === 'apply' ? 'also' : 'apply';
	const queryFn = rng.pick<Fn>(['let', 'run']);
	const call = (fn: Fn, member: string): string => (self(fn) === 'it' ? `it.${member}` : member);
	const list = [...init];
	list.push(x);
	list.push(y);
	const size = list.length;
	list.shift();
	const sum = list.reduce((s, v) => s + v, 0);
	// Under the copy misconception every block gets its own copy of the untouched list.
	const copySize = init.length + 1;
	const copySum = init.reduce((s, v) => s + v, 0);
	return {
		lines: main([
			`val ${name} = mutableListOf(${init.join(', ')})`,
			`${name}.${addFn} { ${call(addFn, `add(${x})`)} }`,
			`val n = ${name}.let { it.add(${y}); it.size }`,
			`${name}.${removeFn} { ${call(removeFn, 'removeAt(0)')} }`,
			`val total = ${name}.${queryFn} { ${call(queryFn, 'sum()')} }`,
			'println(n)',
			'println(total)',
			`println(${name})`
		]),
		answer: [String(size), String(sum), ktList(list)],
		wrong: {
			'scope-copies': [String(copySize), String(copySum), ktList(init)],
			'returns-receiver': [ktList(list), ktList(list), ktList(list)]
		}
	};
}

/** A class with mutable properties: read through `run`/`with` and `let`, written through `apply` and `also`. */
function objectState(rng: Rng): TraceProgram {
	const cls = rng.pick(['Profile', 'Player', 'Account']);
	const level = rng.int(2, 9);
	const coins = rng.int(11, 89);
	const up = rng.int(1, 5);
	const spend = rng.int(2, 10);
	const reader = rng.pick(['run', 'with']);
	const m = rng.pick([10, 100]);
	const score = (l: number, c: number): number => l * m + c;
	const before = score(level, coins);
	const after = score(level + up, coins - spend);
	return {
		lines: [
			`class ${cls}(var level: Int, var coins: Int)`,
			'',
			...main([
				`val p = ${cls}(${level}, ${coins})`,
				reader === 'run'
					? `val before = p.run { level * ${m} + coins }`
					: `val before = with(p) { level * ${m} + coins }`,
				`p.apply { level += ${up} }.also { it.coins -= ${spend} }`,
				`val after = p.let { it.level * ${m} + it.coins }`,
				'println(before)',
				'println(after)',
				'println(p.level)'
			])
		],
		answer: [String(before), String(after), String(level + up)],
		wrong: { 'scope-copies': [String(before), String(before), String(level)] }
	};
}

/** A chain: each transform gets the result of the previous step, `also`/`apply` pass the value on; the source stays. */
function chain(rng: Rng): TraceProgram {
	const name = rng.pick(COUNTERS);
	const n = rng.int(4, 25);
	const t1 = rng.pick<Fn>(['let', 'run']);
	const t2 = t1 === 'let' ? 'run' : 'let';
	const p1 = rng.pick<Fn>(['also', 'apply']);
	const op1 = pickOp(rng);
	const k1 = op1 === '*' ? rng.int(2, 4) : rng.int(3, 40);
	const op2: Op = op1 === '*' ? rng.pick<Op>(['+', '-']) : '*';
	const k2 = op2 === '*' ? rng.int(2, 4) : rng.int(3, 40);
	const v1 = applyOp(n, op1, k1);
	const v2 = applyOp(v1, op2, k2);
	const printer = p1 === 'also' ? 'println(it)' : 'println(this)';
	return {
		lines: main([
			`val ${name} = ${n}`,
			`val result = ${name}.${t1} { ${self(t1)} ${op1} ${k1} }.${p1} { ${printer} }.${t2} { ${self(t2)} ${op2} ${k2} }`,
			'println(result)',
			`println(${name})`
		]),
		answer: [String(v1), String(v2), String(n)],
		wrong: {
			'returns-receiver': [String(n), String(n), String(n)],
			'receiver-mutated': [String(v1), String(v2), String(v2)]
		}
	};
}

// Junior.

/**
 * Four calls on one mutable list in random order: `apply`/`also` return the list itself (printed later — with every
 * change made after the call), `let`/`run` return the value of the block.
 */
function receiverAlias(rng: Rng): TraceProgram {
	const name = rng.pick(LISTS);
	const words = rng.sample(TAGS, 7);
	const list: string[] = [words[0] as string, words[1] as string];
	const init = [...list];
	let next = 2;
	const fresh = (): string => words[next++] as string;
	const fns = rng.shuffle<Fn>(['apply', 'also', 'let', 'run']);
	const vars = ['a', 'b', 'c', 'd'];
	const body: string[] = [];
	type Result = { list: true; snapshot: string[]; lambda: string } | { list: false; value: string };
	const results: Result[] = [];
	for (const [i, fn] of fns.entries()) {
		const v = vars[i] as string;
		if (fn === 'apply') {
			const w = fresh();
			body.push(`val ${v} = ${name}.apply { add("${w}") }`);
			list.push(w);
			results.push({ list: true, snapshot: [...list], lambda: 'true' });
		} else if (fn === 'also') {
			const removed = rng.pick(list);
			body.push(`val ${v} = ${name}.also { it.remove("${removed}") }`);
			list.splice(list.indexOf(removed), 1);
			results.push({ list: true, snapshot: [...list], lambda: 'true' });
		} else if (fn === 'let') {
			const w = fresh();
			body.push(`val ${v} = ${name}.let { it.add("${w}"); it.size }`);
			list.push(w);
			results.push({ list: false, value: String(list.length) });
		} else {
			const w = fresh();
			body.push(`val ${v} = ${name}.run { add("${w}"); first() }`);
			list.push(w);
			results.push({ list: false, value: list[0] as string });
		}
	}
	const final = ktList(list);
	return {
		lines: main([
			`val ${name} = mutableListOf(${init.map((w) => `"${w}"`).join(', ')})`,
			...body,
			...vars.map((v) => `println(${v})`)
		]),
		answer: results.map((r) => (r.list ? final : r.value)),
		wrong: {
			'returns-lambda': results.map((r) => (r.list ? r.lambda : r.value)),
			'returns-receiver': results.map(() => final),
			'receiver-snapshot': results.map((r) => (r.list ? ktList(r.snapshot) : r.value))
		}
	};
}

/** A local variable shadows the member of the same name of the receiver inside `with`, `run` and `apply`. */
function localShadows(rng: Rng): TraceProgram {
	const cls = rng.pick(['Screen', 'Tab', 'Page']);
	const [labelName, countName] = rng.pick([
		['title', 'visits'],
		['label', 'opens'],
		['name', 'count']
	]);
	const words = rng.sample(['Home', 'Cart', 'Feed', 'Search', 'Inbox', 'Settings'], 2);
	const local = words[0] as string;
	const member = words[1] as string;
	const lc = rng.int(2, 9);
	const mc = rng.int(11, 40);
	const m = rng.int(3, 9);
	const reader = rng.pick(['with', 'run']);
	const open = reader === 'with' ? 'with(s) {' : 's.run {';
	const total = lc * m + mc;
	const wrongTotal = mc * m + mc;
	return {
		lines: [
			`class ${cls}(val ${labelName}: String, var ${countName}: Int)`,
			'',
			...main([
				`val ${labelName} = "${local}"`,
				`val ${countName} = ${lc}`,
				`val s = ${cls}("${member}", ${mc})`,
				open,
				`    println(${labelName})`,
				`    println(this.${labelName})`,
				`    println(${countName} * ${m} + this.${countName})`,
				'}',
				`s.apply { this.${countName} += ${countName} }`,
				`println(s.${countName})`
			])
		],
		answer: [local, member, String(total), String(mc + lc)],
		wrong: { 'member-wins': [member, member, String(wrongTotal), String(mc + mc)] }
	};
}

/** Nested blocks: the innermost `it` hides the outer one, and inside `let` the `this` is the outer `run` receiver. */
function nestedIt(rng: Rng): TraceProgram {
	const [aName, bName] = rng.pick([
		['page', 'size'],
		['row', 'columns'],
		['level', 'bonus'],
		['tab', 'items']
	]);
	const a = rng.int(2, 9);
	let b = rng.int(11, 40);
	if (b === a) b += 1;
	const k = rng.int(2, 6);
	const m = rng.pick([10, 100]);
	const first = b * k + a;
	const second = a * m + b;
	const k3 = rng.int(2, 4);
	return {
		lines: main([
			`val ${aName} = ${a}`,
			`val ${bName} = ${b}`,
			`val first = ${aName}.let { ${bName}.let { it * ${k} } + it }`,
			`val second = ${aName}.run { ${bName}.let { this * ${m} + it } }`,
			`val third = ${aName}.also { ${bName}.also { println(it * ${k3}) } }`,
			'println(first)',
			'println(second)',
			'println(third)'
		]),
		answer: [String(b * k3), String(first), String(second), String(a)],
		wrong: {
			'it-outer': [String(a * k3), String(a * k + a), String(second), String(a)],
			'let-this': [String(b * k3), String(first), String(b * m + b), String(a)]
		}
	};
}

/**
 * `apply` inside a method of a class: an unqualified name is the member of the `apply` receiver when it has one,
 * `this@Class` reaches the property of the class.
 */
function outerThis(rng: Rng): TraceProgram {
	const [inner, outer, prop] = rng.pick([
		['Badge', 'InboxScreen', 'count'],
		['Toast', 'CartScreen', 'shown'],
		['Banner', 'FeedScreen', 'limit']
	]);
	const s0 = rng.int(10, 30);
	const b0 = rng.int(1, 5);
	const v1 = rng.int(2, 9);
	const mul = rng.int(2, 3);
	const q = `this@${outer}.${prop}`;
	// Statements in order: 1) prop = v1; 2) prop += outer.prop; 3) outer.prop -= prop; 4) prop *= mul.
	const run = (unqualifiedIsOuter: boolean): [number, number] => {
		let b = b0;
		let s = s0;
		const get = (): number => (unqualifiedIsOuter ? s : b);
		const set = (v: number): void => {
			if (unqualifiedIsOuter) s = v;
			else b = v;
		};
		set(v1);
		set(get() + s);
		s -= get();
		set(get() * mul);
		return [b, s];
	};
	const [b, s] = run(false);
	const [wb, ws] = run(true);
	return {
		lines: [
			`class ${inner} {`,
			`    var ${prop} = ${b0}`,
			'}',
			'',
			`class ${outer} {`,
			`    var ${prop} = ${s0}`,
			'',
			`    fun refresh(): ${inner} = ${inner}().apply {`,
			`        ${prop} = ${v1}`,
			`        ${prop} += ${q}`,
			`        ${q} -= ${prop}`,
			`        ${prop} *= ${mul}`,
			'    }',
			'}',
			'',
			...main([
				`val screen = ${outer}()`,
				'val shown = screen.refresh()',
				`println(shown.${prop})`,
				`println(screen.${prop})`
			])
		],
		answer: [String(b), String(s)],
		wrong: { 'outer-this-wins': [String(wb), String(ws)] }
	};
}

function program(rng: Rng, grade: string, classId: string): TraceProgram {
	if (grade === 'intern') {
		if (classId === 'block-result') return blockResult(rng);
		if (classId === 'same-object') return sameObject(rng);
		if (classId === 'object-state') return objectState(rng);
		return chain(rng);
	}
	if (classId === 'receiver-alias') return receiverAlias(rng);
	if (classId === 'local-shadows') return localShadows(rng);
	if (classId === 'nested-it') return nestedIt(rng);
	return outerThis(rng);
}

export function build(input: GenerateInput): Built {
	return traceBuild(descriptor, input, program);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
