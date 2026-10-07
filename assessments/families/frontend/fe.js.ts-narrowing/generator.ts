// Narrowing in TypeScript and what the program does at run time: `typeof`, truthiness, `in` and `instanceof`,
// discriminated unions in `switch`, user-defined type predicates the compiler trusts, `?.` and `??`, and `as`, which
// changes nothing at run time. On the middle level the mechanisms meet: an exhaustive `switch` against data cast from
// JSON, a narrowing that outlives a mutation, structural typing that lets extra fields through. The generator models
// each program and computes its output; the gate erases the types and runs the shown program with Node.
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

/** A value of the modelled programs at run time: what `+` of JavaScript does with numbers, strings and holes. */
type JsValue = number | string | null | undefined;

/** JavaScript `a + b` for the values the programs add. */
function jsAdd(a: JsValue, b: JsValue): number | string {
	if (typeof a === 'string' || typeof b === 'string') return jsString(a) + jsString(b);
	return (a ?? (a === null ? 0 : Number.NaN)) + (b === null ? 0 : (b ?? Number.NaN));
}

/** `String(v)` for the modelled values. */
function jsString(v: JsValue): string {
	if (v === null) return 'null';
	if (v === undefined) return 'undefined';
	return String(v);
}

const WORDS = ['ok', 'red', 'tea', 'map', 'sky', 'box', 'pen', 'sun', 'cat', 'jam'] as const;
const TITLES = ['lamp', 'desk', 'mug', 'cable', 'chair', 'shelf', 'board', 'mouse'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Junior.

type Field =
	| { kind: 'null' }
	| { kind: 'undefined' }
	| { kind: 'num'; n: number }
	| { kind: 'text'; s: string }
	| { kind: 'list'; items: string[] };

const fieldSource = (f: Field): string =>
	f.kind === 'null'
		? 'null'
		: f.kind === 'undefined'
			? 'undefined'
			: f.kind === 'num'
				? Number.isNaN(f.n)
					? 'NaN'
					: String(f.n)
				: f.kind === 'text'
					? `'${f.s}'`
					: `[${f.items.map((s) => `'${s}'`).join(', ')}]`;

/** `typeof null` is 'object', an empty array is truthy, 0, '' and NaN are falsy: the order of the checks decides. */
function typeofTruthy(rng: Rng): Program {
	const order = rng.pick(['object-first', 'truthy-first'] as const);
	const falsy = rng.sample<Field>(
		[
			{ kind: 'num', n: 0 },
			{ kind: 'text', s: '' },
			{ kind: 'num', n: Number.NaN }
		],
		2
	);
	const others = rng.sample<Field>(
		[
			{ kind: 'undefined' },
			{ kind: 'num', n: rng.int(2, 40) },
			{ kind: 'num', n: -rng.int(2, 40) },
			{ kind: 'text', s: rng.pick(WORDS) },
			{ kind: 'list', items: rng.sample(WORDS, rng.int(1, 3)) }
		],
		3
	);
	const values = rng.shuffle<Field>([{ kind: 'null' }, { kind: 'list', items: [] }, ...falsy, ...others]);
	const fn = rng.pick(['describe', 'label', 'show', 'render'] as const);
	const lines = [
		'type Field = string | number | string[] | null | undefined;',
		'',
		`function ${fn}(v: Field): string {`,
		...(order === 'object-first'
			? [
					"  if (typeof v === 'object') {",
					"    return v === null ? 'null' : 'list ' + v.length;",
					'  }',
					"  if (!v) return 'empty';"
				]
			: ["  if (!v) return 'empty';", "  if (typeof v === 'object') return 'list ' + v.length;"]),
		"  if (typeof v === 'number') return 'num ' + v * 2;",
		"  return 'text ' + v.toUpperCase();",
		'}',
		'',
		`const values: Field[] = [${values.map(fieldSource).join(', ')}];`,
		'for (const v of values) {',
		`  console.log(${fn}(v));`,
		'}'
	];
	interface Beliefs {
		typeofNullIsNull: boolean;
		emptyArrayFalsy: boolean;
		nanTruthy: boolean;
	}
	const describe = (f: Field, b: Beliefs): string => {
		const isObject = f.kind === 'list' || (f.kind === 'null' && !b.typeofNullIsNull);
		const falsyValue =
			f.kind === 'null' ||
			f.kind === 'undefined' ||
			(f.kind === 'num' && (f.n === 0 || (Number.isNaN(f.n) && !b.nanTruthy))) ||
			(f.kind === 'text' && f.s === '') ||
			(f.kind === 'list' && f.items.length === 0 && b.emptyArrayFalsy);
		const objectBranch = () => (f.kind === 'list' ? `list ${f.items.length}` : 'null');
		if (order === 'object-first') {
			if (isObject) return objectBranch();
			if (falsyValue) return 'empty';
		} else {
			if (falsyValue) return 'empty';
			if (isObject) return objectBranch();
		}
		if (f.kind === 'num') return `num ${String(f.n * 2)}`;
		return `text ${f.s.toUpperCase()}`;
	};
	const run = (b: Beliefs) => values.map((f) => describe(f, b));
	const right: Beliefs = { typeofNullIsNull: false, emptyArrayFalsy: false, nanTruthy: false };
	return {
		lines,
		answer: run(right),
		wrong: {
			// typeof null is 'null'.
			'typeof-null-is-null': run({ ...right, typeofNullIsNull: true }),
			// An empty array is falsy.
			'empty-array-falsy': run({ ...right, emptyArrayFalsy: true }),
			// NaN is a number, so it passes the truthiness check.
			'nan-truthy': run({ ...right, nanTruthy: true })
		}
	};
}

type ActionType = 'add' | 'sub' | 'double' | 'bonus';

/** A `case` without `break` falls into the next one; data cast from JSON reaches `default` the union says is impossible. */
function switchFallthrough(rng: Rng): Program {
	const source = rng.pick(['add', 'sub'] as const);
	const target = rng.pick(['double', 'bonus'] as const);
	const otherPayload = source === 'add' ? 'sub' : 'add';
	const otherFree = target === 'double' ? 'bonus' : 'double';
	const bonus = rng.int(10, 30);
	const unknown = rng.pick(['reset', 'clear', 'undo', 'noop'] as const);
	const caseLines: Record<ActionType, string> = {
		add: '      total += action.amount;',
		sub: '      total -= action.amount;',
		double: '      total *= 2;',
		bonus: `      total += ${bonus};`
	};
	const caseOrder: ActionType[] = rng.bool()
		? [source, target, otherPayload, otherFree]
		: [otherPayload, source, target, otherFree];
	const body = caseOrder.flatMap((type) => [
		`    case '${type}':`,
		caseLines[type],
		...(type === source ? [] : ['      break;'])
	]);
	interface Step {
		type: ActionType | typeof unknown;
		amount: number | null;
	}
	const count = rng.int(5, 6);
	const steps: Step[] = [];
	const types: ActionType[] = [source, source, target, otherPayload, otherFree];
	for (let i = 0; i < count; i += 1) {
		const type = i < types.length ? (types[i] as ActionType) : rng.pick(types);
		steps.push({ type, amount: type === 'add' || type === 'sub' ? rng.int(1, 9) : null });
	}
	const shuffled = rng.shuffle(steps);
	shuffled.splice(rng.int(1, shuffled.length), 0, { type: unknown, amount: null });
	const json = JSON.stringify(
		shuffled.map((s) => (s.amount === null ? { type: s.type } : { type: s.type, amount: s.amount }))
	);
	const t0 = rng.int(1, 9);
	const lines = [
		'type Action =',
		"  | { type: 'add'; amount: number }",
		"  | { type: 'sub'; amount: number }",
		"  | { type: 'double' }",
		"  | { type: 'bonus' };",
		'',
		'function reduce(total: number, action: Action): number {',
		'  switch (action.type) {',
		...body,
		'    default:',
		'      total = 0;',
		'  }',
		'  return total;',
		'}',
		'',
		`const actions = JSON.parse('${json}') as Action[];`,
		`let total = ${t0};`,
		'for (const action of actions) {',
		'  total = reduce(total, action);',
		'  console.log(action.type, total);',
		'}'
	];
	const effect = (type: string, amount: number, total: number): number =>
		type === 'add' ? total + amount : type === 'sub' ? total - amount : type === 'double' ? total * 2 : total + bonus;
	const run = (o: { fallthrough: boolean; defaultRuns: boolean }) => {
		let total = t0;
		return shuffled.map((s) => {
			const start = caseOrder.indexOf(s.type as ActionType);
			if (start === -1) {
				if (o.defaultRuns) total = 0;
			} else {
				for (let i = start; i < caseOrder.length; i += 1) {
					const type = caseOrder[i] as ActionType;
					total = effect(type, s.amount ?? 0, total);
					if (type !== source || !o.fallthrough) break;
				}
			}
			return `${s.type} ${total}`;
		});
	};
	return {
		lines,
		answer: run({ fallthrough: true, defaultRuns: true }),
		wrong: {
			// Every case ends where the next case begins.
			'no-fallthrough': run({ fallthrough: false, defaultRuns: true }),
			// default after cases that cover the whole union never runs, the cast action changes nothing.
			'default-unreachable': run({ fallthrough: true, defaultRuns: false })
		}
	};
}

/** A user-defined predicate checks one field; the compiler believes it, and the missing or string price flows into the sum. */
function predicate(rng: Rng): Program {
	const titles = rng.sample(TITLES, 6);
	let t = 0;
	const nextTitle = () => titles[t++] ?? 'item';
	type Row = { title?: string; price?: number | string | null } | null | string;
	const good = Array.from({ length: rng.int(3, 4) }, (): Row => ({ title: nextTitle(), price: rng.int(2, 99) }));
	const traps: Row[] = rng
		.sample<() => Row>(
			[
				() => ({ title: nextTitle() }),
				() => ({ title: nextTitle(), price: String(rng.int(10, 99)) }),
				() => ({ title: nextTitle(), price: null })
			],
			2
		)
		.map((make) => make());
	const junk = rng.sample<Row>([{ price: rng.int(2, 99) }, null, rng.pick(WORDS)], rng.int(1, 2));
	// A trap never comes first, so the sum has a number before it.
	const rest = rng.shuffle([...good.slice(1), ...traps, ...junk]);
	const rows: Row[] = [good[0] ?? null, ...rest];
	const json = JSON.stringify(rows);
	const [iface, guard] = rng.pick([
		['Product', 'isProduct'],
		['Item', 'isItem'],
		['Offer', 'isOffer']
	] as const);
	const lines = [
		`interface ${iface} {`,
		'  title: string;',
		'  price: number;',
		'}',
		'',
		`function ${guard}(x: unknown): x is ${iface} {`,
		"  return typeof x === 'object' && x !== null && 'title' in x;",
		'}',
		'',
		`const rows: unknown[] = JSON.parse('${json}');`,
		'let sum = 0;',
		'for (const row of rows) {',
		`  if (${guard}(row)) {`,
		'    sum += row.price;',
		'    console.log(row.title, sum);',
		'  } else {',
		"    console.log('skip');",
		'  }',
		'}'
	];
	const run = (o: { checksAll: boolean; stringAsNumber: boolean }) => {
		let sum: number | string = 0;
		return rows.map((row) => {
			if (row === null || typeof row === 'string' || row.title === undefined) return 'skip';
			const price = row.price;
			if (o.checksAll && typeof price !== 'number') return 'skip';
			const add = o.stringAsNumber && typeof price === 'string' ? Number(price) : price;
			sum = jsAdd(sum, add);
			return `${row.title} ${String(sum)}`;
		});
	};
	return {
		lines,
		answer: run({ checksAll: false, stringAsNumber: false }),
		wrong: {
			// The predicate is checked by the compiler against the interface: rows without a numeric price are skipped.
			'predicate-verified': run({ checksAll: true, stringAsNumber: false }),
			// A price that came as a string is added as a number.
			'string-adds-as-number': run({ checksAll: false, stringAsNumber: true })
		}
	};
}

/** `??` replaces only null and undefined, `||` every falsy value; `?.` stops at null; `as` converts nothing. */
function nullishAs(rng: Rng): Program {
	const retries = rng.pick<number | null>([0, 0, null, rng.int(1, 9)]);
	const title = rng.pick<string | null>(['', '', null, rng.pick(WORDS)]);
	const limits = rng.pick<{ max?: number } | null | 'absent'>([null, {}, { max: 0 }, { max: rng.int(1, 9) }, 'absent']);
	// At least one value where ?? and || part ways.
	const trapFree = retries !== 0 && title !== '' && !(limits !== null && limits !== 'absent' && limits.max === 0);
	const retriesValue = trapFree ? 0 : retries;
	const port = rng.int(1000, 9999);
	const [d1, d2] = [rng.int(2, 9), rng.int(10, 99)];
	const data: Record<string, unknown> = {};
	if (retriesValue !== null) data.retries = retriesValue;
	if (title !== null) data.title = title;
	if (limits !== 'absent') data.limits = limits;
	data.port = String(port);
	const name = rng.pick(['settings', 'config', 'options', 'prefs'] as const);
	const lines = [
		'interface Settings {',
		'  retries?: number;',
		'  title?: string;',
		'  limits?: { max?: number } | null;',
		'  port: number;',
		'}',
		'',
		`const ${name} = JSON.parse('${JSON.stringify(data)}') as Settings;`,
		`console.log(${name}.retries ?? ${d1}, ${name}.retries || ${d1});`,
		`console.log('[' + (${name}.title ?? 'none') + ']', '[' + (${name}.title || 'none') + ']');`,
		`console.log(${name}.limits?.max ?? ${d2});`,
		`console.log(${name}.port + 1, typeof ${name}.port);`
	];
	const run = (o: { nullishLikeOr: boolean; asConverts: boolean }) => {
		const nullish = <T>(v: T | null, d: T, falsy: boolean): T => (v === null || falsy ? d : v);
		const r = retriesValue;
		const t = title;
		const max = limits === null || limits === 'absent' ? null : (limits.max ?? null);
		const rNullish = nullish(r, d1, o.nullishLikeOr && r === 0);
		const rOr = nullish(r, d1, r === 0);
		const tNullish = nullish(t, 'none', o.nullishLikeOr && t === '');
		const tOr = nullish(t, 'none', t === '');
		const mNullish = nullish(max, d2, o.nullishLikeOr && max === 0);
		return [
			`${rNullish} ${rOr}`,
			`[${tNullish}] [${tOr}]`,
			`${mNullish}`,
			o.asConverts ? `${port + 1} number` : `${port}1 string`
		];
	};
	return {
		lines,
		answer: run({ nullishLikeOr: false, asConverts: false }),
		wrong: {
			// ?? replaces every falsy value, like ||.
			'nullish-like-or': run({ nullishLikeOr: true, asConverts: false }),
			// as Settings turns the port into a number.
			'as-converts': run({ nullishLikeOr: false, asConverts: true })
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Middle.

type ShapeRow =
	| { kind: 'circle'; r: number }
	| { kind: 'square'; side: number }
	| { kind: 'rect'; w: number; h?: number }
	| { kind: 'square-broken'; size: number }
	| { kind: 'unknown'; name: string; a: number };

/** An exhaustive switch with `never` throws for a kind the cast data smuggled in; a missing field slips through as NaN. */
function exhaustive(rng: Rng): Program {
	const tryInside = rng.bool();
	const unknownName = rng.pick(['triangle', 'oval', 'star', 'hexagon'] as const);
	const valid: ShapeRow[] = Array.from({ length: rng.int(2, 3) }, (): ShapeRow => {
		const kind = rng.pick(['circle', 'square', 'rect'] as const);
		if (kind === 'circle') return { kind, r: rng.int(1, 5) };
		if (kind === 'square') return { kind, side: rng.int(2, 9) };
		return { kind, w: rng.int(2, 9), h: rng.int(2, 9) };
	});
	const broken: ShapeRow = rng.bool()
		? { kind: 'rect', w: rng.int(2, 9) }
		: { kind: 'square-broken', size: rng.int(2, 9) };
	const unknown: ShapeRow = { kind: 'unknown', name: unknownName, a: rng.int(2, 9) };
	// The first shape is valid; the unknown one is never last, so a loop stopped by it leaves shapes unread.
	const middle = rng.shuffle([...valid.slice(1), broken]);
	const at = rng.int(0, middle.length - 1);
	const rows: ShapeRow[] = [valid[0] as ShapeRow, ...middle.slice(0, at), unknown, ...middle.slice(at)];
	const toJson = (s: ShapeRow): Record<string, unknown> =>
		s.kind === 'unknown'
			? { kind: s.name, a: s.a }
			: s.kind === 'square-broken'
				? { kind: 'square', size: s.size }
				: s.kind === 'rect' && s.h === undefined
					? { kind: 'rect', w: s.w }
					: s;
	const json = JSON.stringify(rows.map(toJson));
	const loop = (indent: string) => [
		`${indent}for (const s of shapes) {`,
		...(tryInside
			? [
					`${indent}  try {`,
					`${indent}    total += area(s);`,
					`${indent}    console.log(s.kind, total);`,
					`${indent}  } catch (e) {`,
					`${indent}    console.log('error', (e as Error).message);`,
					`${indent}  }`
				]
			: [`${indent}  total += area(s);`, `${indent}  console.log(s.kind, total);`]),
		`${indent}}`
	];
	const lines = [
		'type Shape =',
		"  | { kind: 'circle'; r: number }",
		"  | { kind: 'square'; side: number }",
		"  | { kind: 'rect'; w: number; h: number };",
		'',
		'function assertNever(x: never): never {',
		"  throw new Error('unexpected ' + JSON.stringify(x));",
		'}',
		'',
		'function area(s: Shape): number {',
		'  switch (s.kind) {',
		"    case 'circle':",
		'      return 3 * s.r * s.r;',
		"    case 'square':",
		'      return s.side * s.side;',
		"    case 'rect':",
		'      return s.w * s.h;',
		'    default:',
		'      return assertNever(s);',
		'  }',
		'}',
		'',
		`const shapes = JSON.parse('${json}') as Shape[];`,
		'let total = 0;',
		...(tryInside
			? loop('')
			: ['try {', ...loop('  '), '} catch (e) {', "  console.log('error', (e as Error).message);", '}']),
		"console.log('total', total);"
	];
	const run = (o: { neverRuns: boolean; missingIsZero: boolean; continueAfterCatch: boolean }) => {
		const out: string[] = [];
		let total = 0;
		for (const s of rows) {
			if (s.kind === 'unknown') {
				if (!o.neverRuns) continue;
				out.push(`error unexpected ${JSON.stringify(toJson(s))}`);
				if (!tryInside && !o.continueAfterCatch) break;
				continue;
			}
			const area =
				s.kind === 'circle'
					? 3 * s.r * s.r
					: s.kind === 'square'
						? s.side * s.side
						: s.kind === 'rect'
							? s.h === undefined
								? o.missingIsZero
									? 0
									: Number.NaN
								: s.w * s.h
							: o.missingIsZero
								? 0
								: Number.NaN;
			total += area;
			out.push(`${s.kind === 'square-broken' ? 'square' : s.kind} ${String(total)}`);
		}
		out.push(`total ${String(total)}`);
		return out;
	};
	const right = { neverRuns: true, missingIsZero: false, continueAfterCatch: false };
	return {
		lines,
		answer: run(right),
		wrong: {
			// The never branch cannot run: a kind outside the union is passed over silently.
			'never-unreachable': run({ ...right, neverRuns: false }),
			// A field the data lacks counts as 0, since the type promises a number.
			'missing-field-zero': run({ ...right, missingIsZero: true }),
			// After the catch around the loop the loop goes on with the next shape.
			'catch-continues-loop': run({ ...right, continueAfterCatch: true })
		}
	};
}

type FieldValue =
	{ kind: 'digits'; s: string } | { kind: 'word'; s: string } | { kind: 'empty' } | { kind: 'number'; n: number };

/** A predicate narrows `f.value` to string; a call mutates it to a number, and the compiler keeps the narrowing. */
function predicateMutation(rng: Rng): Program {
	const names = rng.sample(['age', 'zip', 'qty', 'code', 'size', 'rank', 'note', 'tag', 'pin'] as const, 6);
	const values: FieldValue[] = [
		{ kind: 'digits', s: String(rng.int(10, 99)) },
		{ kind: 'word', s: rng.pick(WORDS) },
		{ kind: 'number', n: rng.int(10, 99) },
		...rng.sample<FieldValue>(
			[
				{ kind: 'digits', s: `00${rng.int(1, 9)}` },
				{ kind: 'empty' },
				{ kind: 'digits', s: String(rng.int(100, 999)) },
				{ kind: 'word', s: rng.pick(WORDS) + String(rng.int(1, 9)) }
			],
			rng.int(1, 2)
		)
	];
	const fields = rng.shuffle(values).map((value, i) => ({ name: names[i] ?? `f${i}`, value }));
	const literal = (v: FieldValue) => (v.kind === 'number' ? String(v.n) : v.kind === 'empty' ? "''" : `'${v.s}'`);
	const lines = [
		'interface Field {',
		'  name: string;',
		'  value: string | number;',
		'}',
		'',
		'function isText(v: unknown): v is string {',
		"  return typeof v === 'string';",
		'}',
		'',
		'function parse(f: Field): void {',
		'  const n = Number(f.value);',
		'  if (!Number.isNaN(n)) f.value = n;',
		'}',
		'',
		'const fields: Field[] = [',
		...fields.map((f, i) => `  { name: '${f.name}', value: ${literal(f.value)} }${i < fields.length - 1 ? ',' : ''}`),
		'];',
		'for (const f of fields) {',
		'  if (isText(f.value)) {',
		'    parse(f);',
		'    console.log(f.name, f.value + 1, f.value.length);',
		'  } else {',
		"    console.log(f.name, 'number', f.value);",
		'  }',
		'}'
	];
	const run = (o: { narrowingFreezes: boolean; emptyIsNaN: boolean }) =>
		fields.map(({ name, value }) => {
			if (value.kind === 'number') return `${name} number ${value.n}`;
			const text = value.kind === 'empty' ? '' : value.s;
			const parsed = value.kind === 'empty' ? (o.emptyIsNaN ? Number.NaN : 0) : Number(text);
			if (Number.isNaN(parsed) || o.narrowingFreezes) return `${name} ${text}1 ${text.length}`;
			return `${name} ${parsed + 1} undefined`;
		});
	return {
		lines,
		answer: run({ narrowingFreezes: false, emptyIsNaN: false }),
		wrong: {
			// The narrowing holds at run time too: the value stays the string it was checked as.
			'narrowing-survives-mutation': run({ narrowingFreezes: true, emptyIsNaN: false }),
			// Number('') is NaN, so an empty string stays a string.
			'empty-string-nan': run({ narrowingFreezes: false, emptyIsNaN: true })
		}
	};
}

/** Structural typing lets an object with extra fields pass as Point; Object.values, keys, spread and JSON see them all. */
function structural(rng: Rng): Program {
	const [x, y, z] = distinct(rng, 3, 1, 30) as [number, number, number];
	const [x2, a, b] = distinct(rng, 3, 31, 60) as [number, number, number];
	const extraName = rng.pick(['z', 'w', 'depth', 'weight'] as const);
	const label = rng.bool(0.6) ? rng.pick(WORDS) : null;
	const labelName = rng.pick(['label', 'tag', 'name', 'unit'] as const);
	type Entry = [string, number | string];
	const entries: Entry[] = rng.shuffle<Entry>([
		['x', x],
		['y', y],
		[extraName, z],
		...(label === null ? [] : [[labelName, label] as Entry])
	]);
	const literal = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`).join(', ');
	const variable = rng.pick(['raw', 'input', 'data', 'source'] as const);
	const lines = [
		'interface Point {',
		'  x: number;',
		'  y: number;',
		'}',
		'',
		'function total(p: Point): number {',
		'  let sum = 0;',
		'  for (const v of Object.values(p)) sum += v;',
		'  return sum;',
		'}',
		'',
		`const ${variable} = { ${literal} };`,
		`const p: Point = ${variable};`,
		'console.log(total(p));',
		"console.log(Object.keys(p).join(','));",
		`const moved: Point = { ...p, x: ${x2} };`,
		'console.log(total(moved), JSON.stringify(moved));',
		`const fresh: Point = { x: ${a}, y: ${b} };`,
		'console.log(total(fresh));'
	];
	const run = (o: { stripsExtra: boolean; numbersOnly: boolean }) => {
		const kept = o.stripsExtra
			? entries.filter(([k]) => k === 'x' || k === 'y').sort(([k1], [k2]) => k1.localeCompare(k2))
			: entries;
		const sum = (list: Entry[]) =>
			String(list.reduce<number | string>((s, [, v]) => (o.numbersOnly && typeof v === 'string' ? s : jsAdd(s, v)), 0));
		const movedList: Entry[] = kept.map(([k, v]) => [k, k === 'x' ? x2 : v]);
		const json = JSON.stringify(Object.fromEntries(movedList));
		return [sum(kept), kept.map(([k]) => k).join(','), `${sum(movedList)} ${json}`, String(a + b)];
	};
	return {
		lines,
		answer: run({ stripsExtra: false, numbersOnly: false }),
		wrong: {
			// Assigning to a variable of type Point leaves only the fields of Point.
			'assignment-strips-extra': run({ stripsExtra: true, numbersOnly: false }),
			// Values of a Point are numbers, so a string field does not take part in the sum.
			'values-numbers-only': run({ stripsExtra: false, numbersOnly: true })
		}
	};
}

type Pet =
	| { kind: 'cat' }
	| { kind: 'fake'; lives: number }
	| { kind: 'ghost' }
	| { kind: 'dog'; lives: number | null | 'absent' };

/** instanceof checks the prototype chain, not the shape; `in` checks presence, not a value. */
function instanceofIn(rng: Rng): Program {
	const [l, f, k] = distinct(rng, 3, 2, 30) as [number, number, number];
	const [cls, iface] = rng.pick([
		['Cat', 'Dog'],
		['Robot', 'Drone'],
		['Card', 'Coupon'],
		['Train', 'Bus']
	] as const);
	const [method, other, lives] = rng.pick([
		['meow', 'bark', 'lives'],
		['beep', 'buzz', 'power'],
		['pay', 'scan', 'limit'],
		['ride', 'stop', 'seats']
	] as const);
	const pets: Pet[] = rng.shuffle<Pet>([
		{ kind: 'cat' },
		{ kind: 'fake', lives: f },
		{ kind: 'ghost' },
		{ kind: 'dog', lives: null },
		...rng.sample<Pet>(
			[
				{ kind: 'dog', lives: k },
				{ kind: 'dog', lives: 'absent' }
			],
			rng.int(1, 2)
		)
	]);
	const expr = (p: Pet): string =>
		p.kind === 'cat'
			? `new ${cls}()`
			: p.kind === 'fake'
				? 'fake'
				: p.kind === 'ghost'
					? 'ghost'
					: p.lives === 'absent'
						? `{ ${other}: () => 'x' }`
						: `{ ${other}: () => 'x', ${lives}: ${p.lives === null ? 'undefined' : String(p.lives)} }`;
	const lower = cls.toLowerCase();
	const otherLower = iface.toLowerCase();
	const lines = [
		`class ${cls} {`,
		`  ${lives} = ${l};`,
		`  ${method}(): string {`,
		`    return '${lower}';`,
		'  }',
		'}',
		'',
		`interface ${iface} {`,
		`  ${other}(): string;`,
		`  ${lives}?: number;`,
		'}',
		'',
		`type Item = ${cls} | ${iface};`,
		'',
		'function describe(p: Item): string {',
		`  if (p instanceof ${cls}) return '${lower} ' + p.${lives};`,
		`  if ('${lives}' in p) return '${otherLower} ' + p.${lives};`,
		`  return '${otherLower} ?';`,
		'}',
		'',
		`const fake: ${cls} = { ${lives}: ${f}, ${method}: () => 'fake' };`,
		`const ghost = Object.create(${cls}.prototype) as ${cls};`,
		`const items: Item[] = [${pets.map(expr).join(', ')}];`,
		'for (const p of items) {',
		'  console.log(describe(p));',
		'}'
	];
	const run = (o: { structural: boolean; inChecksDefined: boolean; needsConstructor: boolean }) =>
		pets.map((p) => {
			if (p.kind === 'cat') return `${lower} ${l}`;
			if (p.kind === 'fake') return o.structural ? `${lower} ${f}` : `${otherLower} ${f}`;
			if (p.kind === 'ghost') return o.needsConstructor ? `${otherLower} ?` : `${lower} undefined`;
			if (p.lives === 'absent') return `${otherLower} ?`;
			if (p.lives === null) return o.inChecksDefined ? `${otherLower} ?` : `${otherLower} undefined`;
			return `${otherLower} ${p.lives}`;
		});
	const right = { structural: false, inChecksDefined: false, needsConstructor: false };
	return {
		lines,
		answer: run(right),
		wrong: {
			// An object of the right shape is an instance of the class.
			'instanceof-structural': run({ ...right, structural: true }),
			// `in` is false for a property whose value is undefined.
			'in-checks-defined': run({ ...right, inChecksDefined: true }),
			// Only an object built by the constructor is an instance of the class.
			'instanceof-needs-constructor': run({ ...right, needsConstructor: true })
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'typeof-truthy': typeofTruthy,
	'switch-fallthrough': switchFallthrough,
	predicate,
	'nullish-as': nullishAs,
	exhaustive,
	'predicate-mutation': predicateMutation,
	structural,
	'instanceof-in': instanceofIn
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
				'Программа на TypeScript компилируется без ошибок (`strict`). Что она напечатает при запуске в Node.js? ' +
				'Введите вывод построчно, как он появится в консоли: значения из одного вызова `console.log` — в одной ' +
				'строке через пробел.',
			code: { language: 'typescript', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'typescript'),
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
