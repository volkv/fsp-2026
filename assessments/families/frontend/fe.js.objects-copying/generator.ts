// References and copies in JavaScript: a shared array or object, spread as a shallow copy, the methods that change
// an array in place (sort, reverse, splice) against those that return a new one (toSorted, slice), structuredClone
// and the JSON round trip, Object.freeze as a shallow freeze, and the order of keys of an object.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Out = string | number | boolean;

interface Program {
	lines: string[];
	answer: Out[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, Out[]>;
}

/** Distinct integers in [from, to]. */
const distinct = (rng: Rng, from: number, to: number, count: number): number[] =>
	rng.sample(
		Array.from({ length: to - from + 1 }, (_, i) => from + i),
		count
	);

/** Five distinct numbers in an order that is neither ascending nor descending. */
function unsortedFive(rng: Rng): number[] {
	const nums = distinct(rng, 1, 99, 5);
	const ordered = (sign: number): boolean => nums.every((x, i) => i === 0 || sign * (x - (nums[i - 1] ?? 0)) > 0);
	if (ordered(1) || ordered(-1)) [nums[0], nums[1]] = [nums[1] ?? 0, nums[0] ?? 0];
	return nums;
}

const ARRAY_NAMES = ['scores', 'prices', 'sizes', 'ratings', 'weights'] as const;
const WORD_KEYS = ['pear', 'plum', 'kiwi', 'lime', 'fig', 'date'] as const;

function sharedReference(rng: Rng): Program {
	const name = rng.pick(ARRAY_NAMES);
	const initial = distinct(rng, 10, 60, rng.int(2, 4));
	const added = rng.int(61, 99);
	const fresh = rng.int(1, 9);
	const d = rng.int(100, 200);
	const [person] = rng.sample(PERSON_NAMES, 1) as [string];
	const [l1, l2] = distinct(rng, 1, 20, 2) as [number, number];
	const all = [...initial, added];
	const first = initial[0] ?? 0;
	return {
		lines: [
			`const ${name} = [${initial.join(', ')}];`,
			`const alias = ${name};`,
			`alias.push(${added});`,
			`console.log(${name}.length);`,
			'function reset(list) {',
			'  list = [];',
			`  list.push(${fresh});`,
			'}',
			`reset(${name});`,
			`console.log(${name}.join(','));`,
			'function bump(list) {',
			`  list[0] += ${d};`,
			'}',
			'bump(alias);',
			`console.log(${name}[0]);`,
			`const user = { name: '${person}', level: ${l1} };`,
			'const same = user;',
			`same.level = ${l2};`,
			'console.log(user.level);'
		],
		answer: [all.length, all.join(','), first + d, l2],
		wrong: {
			'assign-copies': [initial.length, initial.join(','), first, l1],
			'param-reassign-leaks': [all.length, String(fresh), fresh + d, l2]
		}
	};
}

function spreadShallow(rng: Rng): Program {
	const [n1, n2] = rng.sample(PERSON_NAMES, 2) as [string, string];
	const [m1, m2] = distinct(rng, 10, 99, 2) as [number, number];
	const tags = rng.sample(['new', 'hot', 'sale', 'eco', 'top'], rng.int(1, 3));
	const push = rng.bool();
	const list = distinct(rng, 1, 50, 3);
	const w = rng.int(51, 99);
	const t = tags.length;
	const tagLine = push ? "copy.tags.push('extra');" : "copy.tags = [...copy.tags, 'extra'];";
	const answer: Out[] = [n1, m2, push ? t + 1 : t, list[0] ?? 0];
	return {
		lines: [
			`const base = { name: '${n1}', limits: { max: ${m1} }, tags: [${tags.map((x) => `'${x}'`).join(', ')}] };`,
			`const copy = { ...base, name: '${n2}' };`,
			`copy.limits.max = ${m2};`,
			tagLine,
			'console.log(base.name);',
			'console.log(base.limits.max);',
			'console.log(base.tags.length);',
			`const list = [${list.join(', ')}];`,
			'const clone = [...list];',
			`clone[0] = ${w};`,
			'console.log(list[0]);'
		],
		answer,
		wrong: {
			'spread-deep': [n1, m1, t, list[0] ?? 0],
			'spread-reference': [n2, m2, t + 1, w]
		}
	};
}

function mutatingMethods(rng: Rng): Program {
	const name = rng.pick(ARRAY_NAMES);
	const nums = unsortedFive(rng);
	const start = rng.int(1, 2);
	const count = rng.int(2, 3);
	const asc = [...nums].sort((a, b) => a - b);
	const json = (xs: number[]): string => `[${xs.join(',')}]`;
	// Every model runs the same steps on its own idea of the array.
	const run = (model: 'right' | 'tosorted-mutates' | 'reverse-returns-copy' | 'splice-like-slice'): Out[] => {
		let arr = [...nums];
		if (model === 'tosorted-mutates') arr = [...asc];
		const out: Out[] = [arr.join(',')];
		const reversed = [...arr].reverse();
		if (model === 'reverse-returns-copy') out.push(false);
		else {
			arr = reversed;
			out.push(true);
		}
		out.push(arr.join(','));
		if (model === 'splice-like-slice') {
			out.push(json(arr.slice(start, count)));
		} else {
			out.push(json(arr.splice(start, count)));
		}
		out.push(arr.join(','), asc.join(','));
		return out;
	};
	return {
		lines: [
			`const ${name} = [${nums.join(', ')}];`,
			`const sorted = ${name}.toSorted((a, b) => a - b);`,
			`console.log(${name}.join(','));`,
			`const reversed = ${name}.reverse();`,
			`console.log(reversed === ${name});`,
			`console.log(${name}.join(','));`,
			`const removed = ${name}.splice(${start}, ${count});`,
			'console.log(JSON.stringify(removed));',
			`console.log(${name}.join(','));`,
			"console.log(sorted.join(','));"
		],
		answer: run('right'),
		wrong: {
			'tosorted-mutates': run('tosorted-mutates'),
			'reverse-returns-copy': run('reverse-returns-copy'),
			'splice-like-slice': run('splice-like-slice')
		}
	};
}

function freezeShallow(rng: Rng): Program {
	const [r1, r2] = distinct(rng, 1, 9, 2) as [number, number];
	const hosts = rng.sample(['alpha', 'beta', 'gamma', 'delta', 'omega'], rng.int(1, 3));
	const pushes = rng.int(1, 2);
	const [c1, c2] = distinct(rng, 10, 99, 2) as [number, number];
	const h = hosts.length;
	return {
		lines: [
			"'use strict';",
			`const config = Object.freeze({ retries: ${r1}, hosts: [${hosts.map((x) => `'${x}'`).join(', ')}] });`,
			'try {',
			`  config.retries = ${r2};`,
			'} catch (e) {',
			'  console.log(e.name);',
			'}',
			...Array.from({ length: pushes }, (_, i) => `config.hosts.push('node${i + 1}');`),
			'console.log(config.retries);',
			'console.log(config.hosts.length);',
			'console.log(Object.isFrozen(config.hosts));',
			`const limits = { max: ${c1} };`,
			`limits.max = ${c2};`,
			'console.log(limits.max);'
		],
		answer: ['TypeError', r1, h + pushes, false, c2],
		wrong: {
			'freeze-deep': ['TypeError', r1, h, true, c2],
			'freeze-silent': [r1, h + pushes, false, c2],
			'const-freezes': ['TypeError', r1, h + pushes, false, c1]
		}
	};
}

const isIndex = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

/** Own keys of an object made by inserting keys in this order: integer indices ascending, then the rest as inserted. */
function ownKeys(inserted: readonly string[]): string[] {
	const ints = inserted.filter(isIndex).sort((a, b) => Number(a) - Number(b));
	return [...ints, ...inserted.filter((key) => !isIndex(key))];
}

function keysOrder(rng: Rng): Program {
	const [moved, overridden, other] = rng.sample(WORD_KEYS, 3) as [string, string, string];
	const ints = [String(rng.int(10, 99)), String(rng.int(0, 9))];
	// A string that only looks like an integer: negative or with a leading zero, below the larger integer key.
	const special = rng.bool() ? `-${rng.int(1, 9)}` : `0${rng.int(1, 9)}`;
	const values = distinct(rng, 1, 99, 9);
	// The moved word is inserted first, then deleted and set again: it becomes the last string key.
	const inserted = [moved, ...rng.shuffle([overridden, other, special, ...ints])];
	const [reinserted, mergedValue, extraValue] = [values[6] ?? 0, values[7] ?? 0, values[8] ?? 0];
	const newInt = String(rng.int(101, 109));
	const valueOf = new Map(inserted.map((key, i) => [key, values[i] ?? 0]));
	const assign = (key: string): string => {
		const target = isIndex(key) ? `[${key}]` : /^[a-z]+$/.test(key) ? `.${key}` : `['${key}']`;
		return `stock${target} = ${valueOf.get(key) ?? 0};`;
	};
	const afterDelete = [...inserted.filter((k) => k !== moved), moved];
	const right = ownKeys(afterDelete);
	const keepPosition = ownKeys(inserted);
	const mergedKeys = (base: readonly string[], moveOverride: boolean): string[] =>
		ownKeys([...(moveOverride ? [...base.filter((k) => k !== overridden), overridden] : base), newInt]);
	const current = (key: string): number =>
		key === overridden
			? mergedValue
			: key === newInt
				? extraValue
				: key === moved
					? reinserted
					: (valueOf.get(key) ?? 0);
	const numericLike = (key: string): boolean => /^-?\d+$/.test(key);
	const numericOrder = (keys: readonly string[]): string[] => [
		...keys.filter(numericLike).sort((a, b) => Number(a) - Number(b)),
		...keys.filter((k) => !numericLike(k))
	];
	const outputs = (keys: readonly string[], merged: readonly string[]): Out[] => [
		keys.join(' '),
		merged.join(' '),
		merged.map(current).join(' ')
	];
	return {
		lines: [
			'const stock = {};',
			...inserted.map(assign),
			`delete stock.${moved};`,
			`stock.${moved} = ${reinserted};`,
			"console.log(Object.keys(stock).join(' '));",
			`const merged = { ...stock, ${overridden}: ${mergedValue}, ${newInt}: ${extraValue} };`,
			"console.log(Object.keys(merged).join(' '));",
			"console.log(Object.values(merged).join(' '));"
		],
		answer: outputs(right, mergedKeys(right, false)),
		wrong: {
			'insertion-order-only': outputs(afterDelete, [...afterDelete, newInt]),
			'numeric-like-strings': outputs(numericOrder(afterDelete), numericOrder([...afterDelete, newInt])),
			'reinsert-keeps-position': outputs(keepPosition, mergedKeys(keepPosition, false)),
			'spread-moves-key': outputs(right, mergedKeys(right, true))
		}
	};
}

function deepCopy(rng: Rng): Program {
	const [id1, id2] = distinct(rng, 100, 999, 2) as [number, number];
	const [q, k] = [rng.int(1, 40), rng.int(1, 40)];
	const day = rng.int(1, 28);
	const sku = rng.pick(['tea', 'mug', 'pen', 'cap', 'bag']);
	type Probe = { code: string; right: Out; wrong: Record<string, Out> };
	const probes: Probe[] = [
		{ code: 'shallow.items[0].qty', right: q + k, wrong: { 'spread-deep': q } },
		{ code: 'shallow.id', right: id1, wrong: { 'spread-reference': id2 } },
		{ code: 'viaJson.items[0].qty', right: q, wrong: {} },
		{ code: 'deep.items[0].qty', right: q, wrong: { 'clone-shallow': q + k } },
		{ code: "'note' in viaJson", right: false, wrong: { 'json-keeps-undefined': true } },
		{ code: "'note' in deep", right: true, wrong: {} },
		{ code: 'typeof viaJson.created', right: 'string', wrong: { 'json-keeps-date': 'object' } },
		{ code: 'deep.created.getUTCDate()', right: day, wrong: {} }
	];
	const shown = rng.shuffle(probes);
	const tail = { right: 'DataCloneError', wrong: { 'clone-functions': 'cloned' } as Record<string, Out> };
	const ids = [
		'spread-deep',
		'spread-reference',
		'clone-shallow',
		'json-keeps-undefined',
		'json-keeps-date',
		'clone-functions'
	];
	const answerOf = (id: string | null): Out[] => [
		...shown.map((p) => (id !== null && id in p.wrong ? (p.wrong[id] ?? p.right) : p.right)),
		id !== null && id in tail.wrong ? (tail.wrong[id] ?? tail.right) : tail.right
	];
	return {
		lines: [
			'const order = {',
			`  id: ${id1},`,
			`  items: [{ sku: '${sku}', qty: ${q} }],`,
			'  note: undefined,',
			`  created: new Date(Date.UTC(2026, 0, ${day})),`,
			'};',
			'const shallow = { ...order };',
			'const viaJson = JSON.parse(JSON.stringify(order));',
			'const deep = structuredClone(order);',
			`order.items[0].qty += ${k};`,
			`order.id = ${id2};`,
			...shown.map((p) => `console.log(${p.code});`),
			'try {',
			`  structuredClone({ id: ${id1}, total() {} });`,
			"  console.log('cloned');",
			'} catch (e) {',
			'  console.log(e.name);',
			'}'
		],
		answer: answerOf(null),
		wrong: Object.fromEntries(ids.map((id) => [id, answerOf(id)]))
	};
}

function arrayMutationChain(rng: Rng): Program {
	const name = rng.pick(ARRAY_NAMES);
	const nums = unsortedFive(rng);
	const n = rng.int(2, 3);
	const x = rng.int(100, 199);
	const desc = (xs: number[]): number[] => [...xs].sort((a, b) => b - a);
	const asc = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
	type Model = 'right' | 'sort-returns-copy' | 'alias-copies' | 'tosorted-live' | 'spread-reference';
	const run = (model: Model): Out[] => {
		let prices = [...nums];
		const best = desc(prices).slice(0, n);
		if (model !== 'sort-returns-copy') prices = desc(prices);
		const out: Out[] = [best.join(','), prices.join(',')];
		const view = model === 'alias-copies' ? [...prices] : prices;
		let safe = asc(view);
		view.splice(1, 1, x);
		if (model === 'tosorted-live') safe = asc(view);
		out.push(prices.join(','), safe.join(','));
		const last = prices[prices.length - 1] ?? 0;
		out.push(model === 'spread-reference' ? 0 : (prices[0] ?? 0) - last);
		return out;
	};
	return {
		lines: [
			'function top(list, n) {',
			'  return list.sort((a, b) => b - a).slice(0, n);',
			'}',
			`const ${name} = [${nums.join(', ')}];`,
			`const view = ${name};`,
			`console.log(top(${name}, ${n}).join(','));`,
			`console.log(${name}.join(','));`,
			'const safe = view.toSorted((a, b) => a - b);',
			`view.splice(1, 1, ${x});`,
			`console.log(${name}.join(','));`,
			"console.log(safe.join(','));",
			`const backwards = [...${name}].reverse();`,
			`console.log(${name}[0] - backwards[0]);`
		],
		answer: run('right'),
		wrong: {
			'sort-returns-copy': run('sort-returns-copy'),
			'alias-copies': run('alias-copies'),
			'tosorted-live': run('tosorted-live'),
			'spread-reference': run('spread-reference')
		}
	};
}

function freezeAndSpread(rng: Rng): Program {
	const [m1, m2, m3] = distinct(rng, 10, 99, 3) as [number, number, number];
	const [n1, n2] = distinct(rng, 1, 9, 2) as [number, number];
	const list = distinct(rng, 1, 30, 3);
	const extra = rng.int(31, 60);
	type Attempt = { code: string; right: Out; wrong: Record<string, Out> };
	const attempts: Attempt[] = [
		{ code: `() => { copy.max = ${m2}; }`, right: 'ok', wrong: { 'spread-keeps-freeze': 'TypeError' } },
		{ code: `() => { limits.nested.min = ${n2}; }`, right: 'ok', wrong: { 'freeze-deep': 'TypeError' } },
		{ code: `() => { limits.max = ${m3}; }`, right: 'TypeError', wrong: { 'freeze-silent': 'ok' } },
		{ code: `() => list.push(${extra})`, right: 'TypeError', wrong: { 'freeze-silent': 'ok' } },
		{ code: '() => list.toSorted((a, b) => b - a)', right: 'ok', wrong: { 'tosorted-throws': 'TypeError' } }
	];
	const shown = rng.shuffle(attempts);
	const ids = ['spread-keeps-freeze', 'freeze-deep', 'freeze-silent', 'tosorted-throws'];
	const values = (id: string | null): Out[] => [
		id === 'spread-keeps-freeze' ? m1 : m2,
		m1,
		id === 'freeze-deep' ? n1 : n2,
		list.join(',')
	];
	const answerOf = (id: string | null): Out[] => [
		...shown.map((a) => (id !== null && id in a.wrong ? (a.wrong[id] ?? a.right) : a.right)),
		...values(id)
	];
	return {
		lines: [
			"'use strict';",
			'function attempt(change) {',
			'  try {',
			'    change();',
			"    return 'ok';",
			'  } catch (e) {',
			'    return e.name;',
			'  }',
			'}',
			`const limits = Object.freeze({ max: ${m1}, nested: { min: ${n1} } });`,
			'const copy = { ...limits };',
			`const list = Object.freeze([${list.join(', ')}]);`,
			...shown.map((a) => `console.log(attempt(${a.code}));`),
			'console.log(copy.max);',
			'console.log(limits.max);',
			'console.log(limits.nested.min);',
			"console.log(list.join(','));"
		],
		answer: answerOf(null),
		wrong: Object.fromEntries(ids.map((id) => [id, answerOf(id)]))
	};
}

const INTERN: Record<string, (rng: Rng) => Program> = {
	'shared-reference': sharedReference,
	'spread-shallow': spreadShallow,
	'mutating-methods': mutatingMethods,
	'freeze-shallow': freezeShallow
};
const JUNIOR: Record<string, (rng: Rng) => Program> = {
	'keys-order': keysOrder,
	'deep-copy': deepCopy,
	'mutation-chain': arrayMutationChain,
	'freeze-spread': freezeAndSpread
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = (input.grade === 'intern' ? INTERN : JUNIOR)[input.classId];
	if (!make) throw new Error(`${descriptor.key}@${input.grade} has no generator for ${input.classId}`);
	const program = make(rng);
	const source = program.lines.join('\n');
	const toAnswer = (values: Out[]) => ({ kind: 'sequence' as const, value: values.map(String) });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js 24, обычный скрипт)? Введите вывод построчно, как он появится в консоли.',
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
					const values = program.wrong[id];
					return [id, values === undefined ? null : { kind: 'answer' as const, answer: toAnswer(values) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
