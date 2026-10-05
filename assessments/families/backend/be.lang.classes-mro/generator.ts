// Classes in Python: class attributes against instance attributes, super() along the MRO of a diamond, and equality
// with hashing of objects used as dictionary keys and set members.
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
	classAttrPerInstance: boolean;
	iaddUpdatesClass: boolean;
	dfsMro: boolean;
	superIsParent: boolean;
	identityOnly: boolean;
	keyReplaced: boolean;
	eqOnlyHashable: boolean;
	setterBypassed: boolean;
	getattrAlways: boolean;
}

const RIGHT: Rules = {
	classAttrPerInstance: false,
	iaddUpdatesClass: false,
	dfsMro: false,
	superIsParent: false,
	identityOnly: false,
	keyReplaced: false,
	eqOnlyHashable: false,
	setterBypassed: false,
	getattrAlways: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'class-attr-per-instance': { classAttrPerInstance: true },
	'iadd-updates-class': { iaddUpdatesClass: true },
	'dfs-mro': { dfsMro: true },
	'super-is-parent': { superIsParent: true },
	'identity-only': { identityOnly: true },
	'key-replaced': { keyReplaced: true },
	'eq-only-hashable': { eqOnlyHashable: true },
	'setter-bypassed': { setterBypassed: true },
	'getattr-always': { getattrAlways: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/class-attrs': ['class-attr-per-instance', 'iadd-updates-class'],
	'middle/mro-super': ['dfs-mro', 'super-is-parent'],
	'middle/eq-hash': ['identity-only', 'key-replaced', 'eq-only-hashable'],
	'middle/attribute-lookup': ['setter-bypassed', 'getattr-always', 'class-attr-per-instance']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const list = (items: readonly (number | string)[]) => `[${items.join(', ')}]`;

type Attr = number | number[];

function classAttrs(rng: Rng): Program {
	const [cls, items, count, limit, add] = rng.pick([
		['Cart', 'items', 'count', 'limit', 'add'],
		['Queue', 'jobs', 'size', 'cap', 'push'],
		['Session', 'events', 'hits', 'ttl', 'track'],
		['Batch', 'rows', 'total', 'quota', 'put']
	] as const);
	const [a, b] = rng.pick([
		['a', 'b'],
		['first', 'second'],
		['x', 'y'],
		['left', 'right']
	] as const);
	const limit1 = rng.int(3, 9);
	const [limit2, limit3] = rng.sample([10, 20, 30, 40, 50, 60], 2) as [number, number];
	const values = rng.sample(
		Array.from({ length: 89 }, (_, i) => i + 11),
		6
	);
	type Op =
		| { kind: 'add'; who: string; value: number }
		| { kind: 'shadow'; who: string; value: number }
		| { kind: 'class-limit' }
		| { kind: 'inst-limit'; who: string };
	const ops: Op[] = [];
	let v = 0;
	const next = () => values[v++] ?? 0;
	const adds = rng.int(3, 4);
	for (let i = 0; i < adds; i += 1)
		ops.push({ kind: 'add', who: i === 0 ? a : i === 1 ? b : rng.pick([a, b]), value: next() });
	// Shadowing the list for one instance, then one more add through it; limit set on the class and on an instance.
	const shadowWho = rng.pick([a, b]);
	ops.splice(rng.int(2, ops.length), 0, { kind: 'shadow', who: shadowWho, value: next() });
	ops.push({ kind: 'add', who: shadowWho, value: next() });
	const instLimitWho = rng.pick([a, b]);
	ops.splice(rng.int(0, ops.length), 0, { kind: 'inst-limit', who: instLimitWho });
	ops.splice(rng.int(0, ops.length), 0, { kind: 'class-limit' });
	const opText = (op: Op) => {
		switch (op.kind) {
			case 'add':
				return `${op.who}.${add}(${op.value})`;
			case 'shadow':
				return `${op.who}.${items} = [${op.value}]`;
			case 'class-limit':
				return `${cls}.${limit} = ${limit2}`;
			case 'inst-limit':
				return `${op.who}.${limit} = ${limit3}`;
		}
	};
	return {
		lines: [
			`class ${cls}:`,
			`    ${items} = []`,
			`    ${count} = 0`,
			`    ${limit} = ${limit1}`,
			'',
			`    def ${add}(self, value):`,
			`        self.${items}.append(value)`,
			`        self.${count} += 1`,
			'',
			`${a} = ${cls}()`,
			`${b} = ${cls}()`,
			...ops.map(opText),
			`print(${a}.${items}, ${a}.${count}, ${a}.${limit})`,
			`print(${b}.${items}, ${b}.${count}, ${b}.${limit})`,
			`print(${cls}.${items}, ${cls}.${count}, ${cls}.${limit})`
		],
		run: (rules) => {
			const klass = new Map<string, Attr>([
				['items', []],
				['count', 0],
				['limit', limit1]
			]);
			const fresh = () =>
				rules.classAttrPerInstance
					? new Map<string, Attr>([...klass].map(([k, x]) => [k, typeof x === 'number' ? x : [...x]]))
					: new Map<string, Attr>();
			const objs = new Map<string, Map<string, Attr>>([
				[a, fresh()],
				[b, fresh()]
			]);
			const get = (who: string, name: string): Attr => {
				const own = objs.get(who)?.get(name);
				return own ?? (klass.get(name) as Attr);
			};
			for (const op of ops) {
				if (op.kind === 'add') {
					(get(op.who, 'items') as number[]).push(op.value);
					const own = objs.get(op.who) as Map<string, Attr>;
					if (rules.iaddUpdatesClass && !own.has('count')) klass.set('count', (klass.get('count') as number) + 1);
					else own.set('count', (get(op.who, 'count') as number) + 1);
				} else if (op.kind === 'shadow') (objs.get(op.who) as Map<string, Attr>).set('items', [op.value]);
				else if (op.kind === 'class-limit') klass.set('limit', limit2);
				else (objs.get(op.who) as Map<string, Attr>).set('limit', limit3);
			}
			const show = (x: Attr) => (typeof x === 'number' ? String(x) : list(x));
			const line = (get3: (name: string) => Attr) => ['items', 'count', 'limit'].map((n) => show(get3(n))).join(' ');
			return [line((n) => get(a, n)), line((n) => get(b, n)), line((n) => klass.get(n) as Attr)];
		}
	};
}

/** A class of the hierarchy: its bases and how its method behaves. */
interface Klass {
	name: string;
	bases: string[];
	method: 'super' | 'stop' | 'none';
}

/** C3 linearization; null when no consistent order exists. */
function c3(name: string, classes: ReadonlyMap<string, Klass>): string[] | null {
	const k = classes.get(name);
	if (!k) return null;
	if (k.bases.length === 0) return [name];
	const seqs: string[][] = [];
	for (const base of k.bases) {
		const lin = c3(base, classes);
		if (lin === null) return null;
		seqs.push([...lin]);
	}
	seqs.push([...k.bases]);
	const out = [name];
	for (;;) {
		const live = seqs.filter((s) => s.length > 0);
		if (live.length === 0) return out;
		const head = live.map((s) => s[0] as string).find((h) => live.every((s) => !s.slice(1).includes(h)));
		if (head === undefined) return null;
		out.push(head);
		for (const s of live) if (s[0] === head) s.shift();
	}
}

/** The old depth-first, left-to-right order with repeats dropped. */
function dfs(name: string, classes: ReadonlyMap<string, Klass>): string[] {
	const out: string[] = [];
	const visit = (n: string) => {
		if (!out.includes(n)) out.push(n);
		for (const b of classes.get(n)?.bases ?? []) visit(b);
	};
	visit(name);
	return out;
}

function callHello(leaf: string, classes: ReadonlyMap<string, Klass>, rules: Rules): string[] {
	const out: string[] = [];
	// Walks an order from a position; super() continues after the defining class in the same order, or, under the
	// misconception, from the start of the first declared base's own order.
	const walk = (order: readonly string[], from: number, depth: number): void => {
		if (depth > 20) throw new Error('super chain does not end');
		for (let i = from; i < order.length; i += 1) {
			const k = classes.get(order[i] as string) as Klass;
			if (k.method === 'none') continue;
			out.push(k.name);
			if (k.method === 'super') {
				if (rules.superIsParent) walk(c3(k.bases[0] as string, classes) ?? [], 0, depth + 1);
				else walk(order, i + 1, depth + 1);
			}
			return;
		}
	};
	walk(rules.dfsMro ? dfs(leaf, classes) : (c3(leaf, classes) ?? []), 0, 0);
	return out;
}

const HIERARCHIES = [
	{ base: 'Base', mids: ['Left', 'Right', 'Extra'], leaves: ['Child', 'Other'] },
	{ base: 'Handler', mids: ['Auth', 'Cache', 'Audit'], leaves: ['Api', 'Admin'] },
	{ base: 'Plugin', mids: ['Json', 'Gzip', 'Trace'], leaves: ['Service', 'Worker'] },
	{ base: 'Model', mids: ['Timestamps', 'SoftDelete', 'Versioned'], leaves: ['Order', 'Invoice'] }
] as const;

function mroSuper(rng: Rng): Program {
	const h = rng.pick(HIERARCHIES);
	const method = rng.pick(['describe', 'chain', 'parts', 'trail']);
	const [m1, m2, m3] = h.mids;
	const [x, y] = h.leaves;
	const classes = new Map<string, Klass>();
	classes.set(h.base, { name: h.base, bases: [], method: 'stop' });
	const midMethod = (): Klass['method'] => rng.pick(['super', 'super', 'super', 'super', 'stop', 'none']);
	// m3 derives from m1 or from the base: a deeper chain on one side of the diamond.
	const m3Base = rng.pick([m1, h.base]);
	classes.set(m1, { name: m1, bases: [h.base], method: midMethod() });
	classes.set(m2, { name: m2, bases: [h.base], method: midMethod() });
	classes.set(m3, { name: m3, bases: [m3Base], method: midMethod() });
	const leafBases = () => rng.sample([m1, m2, m3], 2);
	classes.set(x, { name: x, bases: leafBases(), method: rng.pick(['super', 'super', 'none']) });
	classes.set(y, { name: y, bases: leafBases(), method: rng.pick(['super', 'none']) });
	const order = [h.base, m1, m2, m3, x, y];
	const lines: string[] = [];
	for (const name of order) {
		const k = classes.get(name) as Klass;
		lines.push(`class ${name}${k.bases.length ? `(${k.bases.join(', ')})` : ''}:`);
		if (k.method === 'none') lines.push('    pass');
		else {
			lines.push(`    def ${method}(self):`);
			lines.push(
				k.method === 'super' ? `        return ['${name}'] + super().${method}()` : `        return ['${name}']`
			);
		}
		lines.push('');
	}
	lines.push(`print(*${x}().${method}())`, `print(*${y}().${method}())`);
	return {
		lines,
		run: (rules) => {
			if (c3(x, classes) === null || c3(y, classes) === null) return ['inconsistent'];
			return [callHello(x, classes, rules).join(' '), callHello(y, classes, rules).join(' ')];
		}
	};
}

const KEY_WORDS = ['tea', 'jam', 'pie', 'cake', 'soup', 'rice', 'milk'] as const;

function variant(rng: Rng, word: string): string {
	const cased = rng.pick([word, word.toUpperCase(), word.charAt(0).toUpperCase() + word.slice(1)]);
	return rng.pick(['', ' ']) + cased + rng.pick(['', ' ']);
}

function eqHash(rng: Rng): Program {
	const [key, plain, point] = rng.pick([
		['Key', 'Tag', 'Point'],
		['Sku', 'Label', 'Pair'],
		['Email', 'Token', 'Coord'],
		['Code', 'Handle', 'Cell']
	] as const);
	const words = rng.sample(KEY_WORDS, 3);
	// Raw strings: three spellings of one word, two of another, one of a third; shuffled.
	const raws = rng.shuffle([
		variant(rng, words[0] as string),
		variant(rng, words[0] as string),
		variant(rng, words[0] as string),
		variant(rng, words[1] as string),
		variant(rng, words[1] as string),
		variant(rng, words[2] as string)
	]);
	const norm = (s: string) => s.trim().toLowerCase();
	const probe = variant(rng, rng.pick(words));
	const tagWord = rng.pick(words);
	const px = rng.int(1, 9);
	return {
		lines: [
			`class ${key}:`,
			'    def __init__(self, raw):',
			'        self.raw = raw',
			'',
			'    @property',
			'    def norm(self):',
			'        return self.raw.strip().lower()',
			'',
			'    def __eq__(self, other):',
			`        return isinstance(other, ${key}) and self.norm == other.norm`,
			'',
			'    def __hash__(self):',
			'        return hash(self.norm)',
			'',
			`class ${plain}:`,
			'    def __init__(self, raw):',
			'        self.raw = raw',
			'',
			`class ${point}:`,
			'    def __init__(self, x):',
			'        self.x = x',
			'',
			'    def __eq__(self, other):',
			'        return self.x == other.x',
			'',
			`keys = [${raws.map((r) => `${key}('${r}')`).join(', ')}]`,
			'print(len(set(keys)))',
			'index = {}',
			'for i, k in enumerate(keys):',
			'    index[k] = i',
			'print([(k.raw, v) for k, v in index.items()])',
			`print(${key}('${probe}') in index, len({${plain}('${tagWord}'), ${plain}('${tagWord}')}))`,
			'try:',
			`    print(len({${point}(${px}), ${point}(${px})}))`,
			'except TypeError:',
			"    print('unhashable')"
		],
		run: (rules) => {
			const index: { raw: string; norm: string; value: number }[] = [];
			raws.forEach((raw, i) => {
				const found = rules.identityOnly ? undefined : index.find((e) => e.norm === norm(raw));
				if (found) {
					found.value = i;
					if (rules.keyReplaced) found.raw = raw;
				} else index.push({ raw, norm: norm(raw), value: i });
			});
			const distinctCount = rules.identityOnly ? raws.length : new Set(raws.map(norm)).size;
			const has = rules.identityOnly ? false : raws.some((r) => norm(r) === norm(probe));
			return [
				String(distinctCount),
				list(index.map((e) => `('${e.raw}', ${e.value})`)),
				`${has ? 'True' : 'False'} 2`,
				rules.eqOnlyHashable ? '2' : 'unhashable'
			];
		}
	};
}

function attributeLookup(rng: Rng): Program {
	const [cls, prop, missing] = rng.pick([
		['Account', 'amount', 'owner'],
		['Price', 'value', 'currency'],
		['Meter', 'reading', 'unit'],
		['Budget', 'limit', 'team']
	] as const);
	const [a, b] = rng.pick([
		['a', 'b'],
		['first', 'second'],
		['x', 'y']
	] as const);
	const [r1, r2, r3] = rng.sample([2, 3, 4, 5, 6, 7], 3) as [number, number, number];
	const bonus = rng.int(1, 9);
	const [a0, b0, v] = [rng.int(10, 40), rng.int(10, 40), rng.int(41, 90)];
	return {
		lines: [
			`class ${cls}:`,
			`    rate = ${r1}`,
			'',
			'    def __init__(self, base):',
			'        self._base = base',
			'',
			'    @property',
			`    def ${prop}(self):`,
			'        return self._base * self.rate',
			'',
			`    @${prop}.setter`,
			`    def ${prop}(self, new):`,
			`        self._base = new + ${bonus}`,
			'',
			'    def __getattr__(self, name):',
			'        return name.upper()',
			'',
			`${a} = ${cls}(${a0})`,
			`${b} = ${cls}(${b0})`,
			`${a}.${prop} = ${v}`,
			`${b}.rate = ${r2}`,
			`${cls}.rate = ${r3}`,
			`print(${a}.${prop}, ${b}.${prop})`,
			`print(${a}.rate, ${b}.rate, ${a}.${missing})`,
			`print(${a}.__dict__)`
		],
		run: (rules) => {
			// The rate each instance sees: b's own after the assignment; a reads the class (or a copy made at creation).
			const aRate = rules.classAttrPerInstance ? r1 : r3;
			const aBase = rules.setterBypassed ? a0 : v + bonus;
			const plain = (text: string, name: string) => (rules.getattrAlways ? name.toUpperCase() : text);
			const amountA = rules.setterBypassed ? String(v) : String(aBase * aRate);
			const dict = rules.setterBypassed ? `{'_base': ${a0}, '${prop}': ${v}}` : `{'_base': ${aBase}}`;
			return [
				`${plain(amountA, prop)} ${plain(String(b0 * r2), prop)}`,
				`${plain(String(aRate), 'rate')} ${plain(String(r2), 'rate')} ${missing.toUpperCase()}`,
				dict
			];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'middle/class-attrs': classAttrs,
	'middle/mro-super': mroSuper,
	'middle/eq-hash': eqHash,
	'middle/attribute-lookup': attributeLookup
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 400; tries += 1) {
		const program = make(rng);
		const answer = program.run(RIGHT);
		if (answer.length === 1 && answer[0] === 'inconsistent') continue;
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
