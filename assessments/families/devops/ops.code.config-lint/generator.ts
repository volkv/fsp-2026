// Practice: a linter of a service configuration against a schema given in the input. The class sets the semantics of a
// repeated key (the last wins, an error, the first wins) and whether `${KEY}` references are substituted; Intern reads
// flat `KEY=VALUE` lines, Junior reads INI with sections (unknown sections, repeated headers, keys outside a section).
// Parametric hidden tests in five groups.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go'] as const;

const descriptor = readDescriptor(import.meta.url);

type Type = 'int' | 'bool' | 'enum' | 'str';
interface Spec {
	key: string;
	type: Type;
	required: boolean;
	min: number;
	max: number;
	values: string[];
}
interface Input {
	schema: Spec[];
	lines: string[];
}

const WRONG_IDS = [
	'validates-overridden',
	'duplicate-on-all',
	'validates-ignored',
	'range-exclusive',
	'missing-first',
	'no-trim',
	'comment-inline',
	'undefined-as-empty',
	'unknown-section-keys'
] as const;
/** The wrong solutions, and `last-undefined`: a reference error that names the last unknown reference, not the first. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'last-undefined';

const REF = /\$\{([^}]*)\}/g;

function check(spec: Spec, value: string, variant: Variant): 'type' | 'range' | null {
	switch (spec.type) {
		case 'int': {
			if (!/^-?[0-9]+$/.test(value)) return 'type';
			const v = Number(value);
			const out = variant === 'range-exclusive' ? v <= spec.min || v >= spec.max : v < spec.min || v > spec.max;
			return out ? 'range' : null;
		}
		case 'bool':
			return value === 'true' || value === 'false' ? null : 'type';
		case 'enum':
			return spec.values.includes(value) ? null : 'type';
		case 'str':
			return value === '' ? 'type' : null;
	}
}

/** The linter's output for the class; a variant other than `right` reproduces a wrong solution. */
function lint(cls: string, junior: boolean, input: Input, variant: Variant = 'right'): string {
	const schema = new Map(input.schema.map((s) => [s.key, s]));
	const sections = new Set(input.schema.map((s) => s.key.split('.')[0] ?? ''));
	const errors = new Map<number, string>();
	const seen = new Map<string, { n: number; value: string }[]>();
	let section: string | null = null;
	let skip = false;
	input.lines.forEach((raw, i) => {
		const n = i + 1;
		const line = (variant === 'comment-inline' ? (raw.split('#')[0] ?? '') : raw).trim();
		if (line === '' || line.startsWith('#')) return;
		if (junior && line.startsWith('[') && line.endsWith(']')) {
			const name = line.slice(1, -1).trim();
			if (sections.has(name)) {
				section = name;
				skip = false;
			} else {
				errors.set(n, `section ${name}`);
				skip = variant !== 'unknown-section-keys';
				section = name;
			}
			return;
		}
		if (skip) return;
		const eq = line.indexOf('=');
		const key = variant === 'no-trim' ? line.slice(0, eq) : line.slice(0, eq).trim();
		if (eq < 0 || key === '' || (junior && section === null)) {
			errors.set(n, 'syntax');
			return;
		}
		const full = junior ? `${section ?? ''}.${key}` : key;
		if (!schema.has(full)) {
			errors.set(n, `unknown ${full}`);
			return;
		}
		const value = variant === 'no-trim' ? line.slice(eq + 1) : line.slice(eq + 1).trim();
		const list = seen.get(full) ?? [];
		list.push({ n, value });
		seen.set(full, list);
	});

	const current = new Map([...seen].map(([key, list]) => [key, list[list.length - 1]?.value ?? '']));
	for (const [key, list] of seen) {
		const spec = schema.get(key) as Spec;
		let checked: { n: number; value: string }[];
		if (cls === 'duplicate-error') {
			for (const e of list.slice(1)) errors.set(e.n, `duplicate ${key}`);
			if (variant === 'duplicate-on-all' && list.length > 1) {
				errors.set(list[0]?.n ?? 0, `duplicate ${key}`);
				checked = [];
			} else checked = list.slice(0, 1);
		} else if (cls === 'first-wins') checked = variant === 'validates-ignored' ? list : list.slice(0, 1);
		else checked = variant === 'validates-overridden' ? list : list.slice(-1);
		for (const e of checked) {
			let value = e.value;
			if (cls === 'substitution') {
				const unknown = [...value.matchAll(REF)].map((m) => m[1] ?? '').filter((name) => !current.has(name));
				if (unknown.length > 0 && variant !== 'undefined-as-empty') {
					errors.set(e.n, `undefined ${variant === 'last-undefined' ? unknown[unknown.length - 1] : unknown[0]}`);
					continue;
				}
				value = value.replace(REF, (_, name: string) => current.get(name) ?? '');
			}
			const problem = check(spec, value, variant);
			if (problem) errors.set(e.n, `${problem} ${key}`);
		}
	}
	const lineErrors = [...errors].sort((a, b) => a[0] - b[0]).map(([n, text]) => `${n}: ${text}`);
	const missing = input.schema.filter((s) => s.required && !seen.has(s.key)).map((s) => `-: missing ${s.key}`);
	const out = variant === 'missing-first' ? [...missing, ...lineErrors] : [...lineErrors, ...missing];
	return `${out.length === 0 ? 'OK' : out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs.

const PREFIXES = ['server', 'db', 'cache', 'log', 'auth', 'queue', 'mail', 'search'] as const;
const UNKNOWN_SECTIONS = ['metrics', 'tracing', 'plugins', 'extra', 'debug'] as const;
const STR_VALUES = ['example.org', '10.0.0.5', '/var/lib/app', 'svc-a', 'admin', 'eu-west-1', 'a=b', 'x_1'] as const;

interface Suffix {
	name: string;
	type: Type;
	range?: [number, number][];
	values?: string[];
}
const SUFFIXES: Suffix[] = [
	{
		name: 'port',
		type: 'int',
		range: [
			[1, 65535],
			[1024, 65535],
			[1, 9999]
		]
	},
	{
		name: 'workers',
		type: 'int',
		range: [
			[1, 64],
			[1, 16],
			[2, 32]
		]
	},
	{
		name: 'timeout',
		type: 'int',
		range: [
			[1, 3600],
			[5, 300],
			[10, 600]
		]
	},
	{
		name: 'retries',
		type: 'int',
		range: [
			[0, 10],
			[0, 5],
			[1, 7]
		]
	},
	{
		name: 'max_conn',
		type: 'int',
		range: [
			[10, 5000],
			[1, 1000]
		]
	},
	{
		name: 'size_mb',
		type: 'int',
		range: [
			[0, 4096],
			[16, 2048]
		]
	},
	{ name: 'debug', type: 'bool' },
	{ name: 'enabled', type: 'bool' },
	{ name: 'tls', type: 'bool' },
	{ name: 'level', type: 'enum', values: ['debug', 'info', 'warn', 'error'] },
	{ name: 'mode', type: 'enum', values: ['dev', 'stage', 'prod'] },
	{ name: 'region', type: 'enum', values: ['eu', 'us', 'asia'] },
	{ name: 'host', type: 'str' },
	{ name: 'user', type: 'str' },
	{ name: 'dir', type: 'str' },
	{ name: 'name', type: 'str' }
];

function makeSchema(rng: Rng, junior: boolean, count: number): Spec[] {
	const specs: Spec[] = [];
	const used = new Set<string>();
	const prefixes = rng.sample(
		PREFIXES,
		junior ? Math.min(PREFIXES.length, Math.max(2, Math.ceil(count / 4))) : PREFIXES.length
	);
	while (specs.length < count) {
		const prefix = rng.pick(prefixes);
		const suffix = rng.pick(SUFFIXES);
		const key = junior ? `${prefix}.${suffix.name}` : `${prefix}_${suffix.name}`;
		if (used.has(key)) {
			if (used.size >= prefixes.length * SUFFIXES.length) break;
			continue;
		}
		used.add(key);
		const [min, max] = suffix.range ? rng.pick(suffix.range) : [0, 0];
		specs.push({ key, type: suffix.type, required: rng.bool(0.55), min, max, values: suffix.values ?? [] });
	}
	return specs;
}

function validValue(rng: Rng, spec: Spec): string {
	switch (spec.type) {
		case 'int':
			return String(rng.int(spec.min, spec.max));
		case 'bool':
			return rng.pick(['true', 'false']);
		case 'enum':
			return rng.pick(spec.values);
		case 'str':
			return rng.pick(STR_VALUES);
	}
}

function badValue(rng: Rng, spec: Spec): string {
	switch (spec.type) {
		case 'int':
			return rng.pick(['abc', '12.5', '+5', '1e3', '', '0x1F', '30s', `${rng.int(1, 99)} # default`]);
		case 'bool':
			return rng.pick(['yes', 'True', '1', 'on', '']);
		case 'enum':
			return rng.pick([(spec.values[0] ?? 'x').toUpperCase(), 'trace', 'test', '']);
		case 'str':
			return '';
	}
}

/** An int value on an edge of the range: the edge itself or one past it. */
function edgeValue(rng: Rng, spec: Spec): string {
	return String(rng.pick([spec.min, spec.max, spec.min - 1, spec.max + 1]));
}

const STYLES = [
	(k: string, v: string) => `${k}=${v}`,
	(k: string, v: string) => `${k} = ${v}`,
	(k: string, v: string) => `  ${k} =${v}`,
	(k: string, v: string) => `${k}= ${v}  `,
	(k: string, v: string) => `\t${k}  =  ${v}`
];

interface Kv {
	key: string;
	value: string;
	spaced: boolean;
}
interface Knobs {
	keys: number;
	missing: number;
	bad: number;
	edges: number;
	dups: number;
	refs: number;
	undefinedRefs: number;
	comments: number;
	blanks: number;
	garbage: number;
	unknown: number;
	hashed: number;
	spaced: number;
	/** Junior: unknown sections, a split section, a key before the first header. */
	unknownSections: number;
	splits: number;
	orphans: number;
}

/**
 * The kinds of tests. Intern `basic` and `plain` are short configurations without whitespace, comments, junk lines,
 * missing keys or range edges, with one reference and (but for substitution) one repeat: a solution wrong in a rule
 * other than the class one passes them. The other kinds pin the edges.
 */
type GroupId = 'basic' | 'plain' | 'format' | 'values' | 'sections' | 'rule' | 'scale';
const PLAIN: readonly GroupId[] = ['basic', 'plain'];

function knobs(rng: Rng, group: GroupId, cls: string, junior: boolean): Knobs {
	const base: Knobs = {
		keys: rng.int(4, 7),
		missing: rng.int(0, 1),
		bad: rng.int(1, 2),
		edges: 0,
		dups: rng.int(1, 2),
		refs: rng.int(1, 2),
		undefinedRefs: rng.int(0, 1),
		comments: rng.int(1, 2),
		blanks: rng.int(0, 1),
		garbage: 0,
		unknown: 0,
		hashed: 0,
		spaced: 0.2,
		unknownSections: 0,
		splits: 0,
		orphans: 0
	};
	const plain: Knobs = {
		...base,
		missing: 0,
		edges: 0,
		dups: cls === 'substitution' ? 0 : 1,
		refs: 1,
		undefinedRefs: 0,
		comments: 0,
		blanks: 0,
		spaced: 0
	};
	switch (group) {
		case 'basic':
			return { ...plain, keys: rng.int(3, 5), bad: rng.int(0, 1) };
		case 'plain':
			return { ...plain, keys: rng.int(5, 8), bad: rng.int(1, 3) };
		case 'format':
			return {
				...base,
				missing: rng.int(1, 2),
				comments: rng.int(2, 4),
				blanks: rng.int(1, 3),
				garbage: rng.int(1, 3),
				unknown: rng.int(1, 2),
				hashed: rng.int(1, 2),
				spaced: 0.6
			};
		case 'values':
			return { ...base, keys: rng.int(6, 9), bad: rng.int(2, 4), edges: rng.int(3, 5) };
		case 'sections':
			return { ...base, unknownSections: rng.int(1, 2), splits: 1, orphans: rng.int(0, 1), comments: rng.int(1, 3) };
		case 'rule':
			return {
				...base,
				dups: rng.int(2, 4),
				refs: rng.int(2, 3),
				undefinedRefs: cls === 'substitution' ? rng.int(1, 2) : rng.int(0, 1)
			};
		case 'scale':
			return {
				keys: junior ? rng.int(30, 45) : rng.int(40, 70),
				missing: rng.int(2, 5),
				bad: rng.int(20, 40),
				edges: rng.int(20, 40),
				dups: rng.int(300, 600),
				refs: rng.int(30, 60),
				undefinedRefs: rng.int(5, 10),
				comments: rng.int(200, 400),
				blanks: rng.int(100, 200),
				garbage: rng.int(20, 40),
				unknown: rng.int(20, 40),
				hashed: rng.int(5, 10),
				spaced: 0.4,
				unknownSections: junior ? rng.int(3, 6) : 0,
				splits: junior ? 2 : 0,
				orphans: junior ? 1 : 0
			};
	}
}

/** The ordered key-value lines before layout: one per present key, then repeats, references, oddities. */
function makeItems(rng: Rng, schema: Spec[], k: Knobs, junior: boolean): Kv[] {
	const absent = new Set(rng.sample(schema, Math.min(k.missing, schema.length - 1)).map((s) => s.key));
	const present = schema.filter((s) => !absent.has(s.key));
	const kvs: Kv[] = present.map((s) => ({ key: s.key, value: validValue(rng, s), spaced: rng.bool(k.spaced) }));
	const pickKv = (filter: (s: Spec) => boolean): Kv | null => {
		const options = kvs.filter((kv) => filter(schema.find((s) => s.key === kv.key) as Spec));
		return options.length === 0 ? null : rng.pick(options);
	};
	const specOf = (key: string): Spec => schema.find((s) => s.key === key) as Spec;
	for (let i = 0; i < k.bad; i += 1) {
		const kv = rng.pick(kvs);
		kv.value = badValue(rng, specOf(kv.key));
	}
	for (let i = 0; i < k.edges; i += 1) {
		const kv = pickKv((s) => s.type === 'int');
		if (kv) kv.value = edgeValue(rng, specOf(kv.key));
	}
	for (let i = 0; i < k.hashed; i += 1) {
		const kv = pickKv((s) => s.type === 'str' || s.type === 'int');
		if (kv)
			kv.value =
				specOf(kv.key).type === 'str'
					? rng.pick(['#00aa00', '#main', '#1'])
					: `${validValue(rng, specOf(kv.key))} # ${rng.pick(['default', 'prod', 'tuned'])}`;
	}
	// References: an int key pointing at another int key, a string with references inside, unknown references.
	const ints = present.filter((s) => s.type === 'int');
	for (let i = 0; i < k.refs; i += 1) {
		const target = rng.pick(present);
		if (rng.bool(0.6) && ints.length >= 2) {
			const [a, b] = rng.sample(ints, 2) as [Spec, Spec];
			kvs.push({ key: a.key, value: `\${${b.key}}`, spaced: rng.bool(k.spaced) });
		} else {
			const str = schema.filter((s) => s.type === 'str');
			const holder = str.length > 0 ? rng.pick(str) : rng.pick(schema);
			kvs.push({
				key: holder.key,
				value: rng.pick([
					`\${${target.key}}`,
					`http://\${${target.key}}/x`,
					`\${${target.key}}-\${${rng.pick(present).key}}`
				]),
				spaced: rng.bool(k.spaced)
			});
		}
	}
	for (let i = 0; i < k.undefinedRefs; i += 1) {
		const holder = rng.pick(schema);
		const nope = [...absent][0] ?? `${junior ? 'db.' : ''}${rng.pick(['secret', 'token', 'home'])}`;
		const other = rng.pick(['secret', 'token', 'home', 'zone']);
		kvs.push({
			key: holder.key,
			value: rng.bool() ? `\${${nope}}` : `\${${nope}}/\${${junior ? `log.${other}` : other}}`,
			spaced: rng.bool(k.spaced)
		});
	}
	// Repeats go after the first occurrence, with a value of the other validity.
	for (let i = 0; i < k.dups; i += 1) {
		const index = rng.int(0, kvs.length - 1);
		const first = kvs[index] as Kv;
		const spec = specOf(first.key);
		const firstBad = check(spec, first.value, 'right') !== null;
		const value = firstBad || rng.bool(0.3) ? validValue(rng, spec) : badValue(rng, spec);
		kvs.splice(rng.int(index + 1, kvs.length), 0, { key: first.key, value, spaced: rng.bool(k.spaced) });
	}
	return orderKeepingRepeats(rng, kvs);
}

/** A light shuffle that keeps every key's occurrences in their order. */
function orderKeepingRepeats(rng: Rng, kvs: Kv[]): Kv[] {
	const out = [...kvs];
	for (let i = 0; i + 1 < out.length; i += 1) {
		const a = out[i] as Kv;
		const b = out[i + 1] as Kv;
		if (a.key !== b.key && rng.bool(0.3)) [out[i], out[i + 1]] = [b, a];
	}
	return out;
}

function renderKv(rng: Rng, kv: Kv, junior: boolean): string {
	const key = junior ? kv.key.slice(kv.key.indexOf('.') + 1) : kv.key;
	const style = kv.spaced ? rng.pick(STYLES.slice(1)) : (STYLES[0] as (k: string, v: string) => string);
	return style(key, kv.value);
}

function comment(rng: Rng, schema: Spec[], junior: boolean): string {
	const key = rng.pick(schema).key;
	const short = junior ? key.slice(key.indexOf('.') + 1) : key;
	return rng.pick([
		`# ${rng.pick(['defaults', 'see docs', 'prod values', 'do not edit'])}`,
		`#${short}=1`,
		`  # ${short} = off`,
		'#'
	]);
}

function garbage(rng: Rng, schema: Spec[], junior: boolean): string {
	const key = rng.pick(schema).key;
	const short = junior ? key.slice(key.indexOf('.') + 1) : key;
	return rng.pick([
		`${short} ${rng.int(1, 99)}`,
		`= ${rng.int(1, 99)}`,
		'just text',
		junior ? `${short}: 5` : '[server]'
	]);
}

function unknownKv(rng: Rng, schema: Spec[], junior: boolean): string {
	const key = rng.pick(schema).key;
	const short = junior ? key.slice(key.indexOf('.') + 1) : key;
	const typo =
		short.length > 3 ? `${short.slice(0, 1)}${short.slice(2, 3)}${short.slice(1, 2)}${short.slice(3)}` : `${short}x`;
	return `${rng.pick([typo, 'colour', 'verbose', `${short}2`])}${rng.pick(['=', ' = '])}${rng.int(1, 9)}`;
}

/** Insert raw lines at random places; `after` keeps them past the first line (a Junior section header). */
function sprinkle(rng: Rng, lines: string[], extra: string[], after: number): string[] {
	const out = [...lines];
	for (const text of extra) out.splice(rng.int(Math.min(after, out.length), out.length), 0, text);
	return out;
}

function makeInput(rng: Rng, cls: string, group: GroupId, junior: boolean): Input {
	const k = knobs(rng, group, cls, junior);
	const schema = makeSchema(rng, junior, k.keys);
	const kvs = makeItems(rng, schema, k, junior);
	const extras = (): string[] => {
		const out: string[] = [];
		for (let i = 0; i < k.comments; i += 1) out.push(comment(rng, schema, junior));
		for (let i = 0; i < k.blanks; i += 1) out.push(rng.pick(['', '   ']));
		for (let i = 0; i < k.garbage; i += 1) out.push(garbage(rng, schema, junior));
		for (let i = 0; i < k.unknown; i += 1) out.push(unknownKv(rng, schema, junior));
		return out;
	};
	if (!junior)
		return {
			schema,
			lines: sprinkle(
				rng,
				kvs.map((kv) => renderKv(rng, kv, false)),
				extras(),
				0
			)
		};

	// Junior: every section's lines in order, one section split under a repeated header, unknown sections between.
	const sectionOf = (key: string): string => key.slice(0, key.indexOf('.'));
	const order = rng.shuffle([...new Set(schema.map((s) => sectionOf(s.key)))]);
	const blocks: { name: string; lines: string[] }[] = [];
	const split = new Set(rng.sample(order, Math.min(k.splits, order.length)));
	const tails: { name: string; lines: string[] }[] = [];
	for (const name of order) {
		const lines = kvs.filter((kv) => sectionOf(kv.key) === name).map((kv) => renderKv(rng, kv, true));
		if (split.has(name) && lines.length >= 2) {
			const cut = rng.int(1, lines.length - 1);
			blocks.push({ name, lines: lines.slice(0, cut) });
			tails.push({ name, lines: lines.slice(cut) });
		} else blocks.push({ name, lines });
	}
	for (const tail of tails) blocks.splice(rng.int(1, blocks.length), 0, tail);
	for (let i = 0; i < k.unknownSections; i += 1) {
		const lines = Array.from(
			{ length: rng.int(1, 3) },
			() => `${rng.pick(['enabled', 'port', 'level', 'path'])} = ${rng.int(1, 99)}`
		);
		blocks.splice(rng.int(0, blocks.length), 0, { name: rng.pick(UNKNOWN_SECTIONS), lines });
	}
	const extra = extras();
	const lines: string[] = [];
	if (k.orphans > 0) {
		const kv = rng.pick(kvs);
		lines.push(renderKv(rng, kv, true));
	}
	for (const block of blocks) {
		const header = rng.pick([`[${block.name}]`, `[ ${block.name} ]`, `  [${block.name}]`]);
		const mine = extra.splice(0, rng.int(0, Math.ceil(extra.length / 2)));
		lines.push(header, ...sprinkle(rng, block.lines, mine, 0));
	}
	lines.push(...extra);
	return { schema, lines };
}

function renderSpec(s: Spec): string {
	const args = s.type === 'int' ? ` ${s.min} ${s.max}` : s.type === 'enum' ? ` ${s.values.join(',')}` : '';
	return `${s.key} ${s.type} ${s.required ? 'required' : 'optional'}${args}`;
}

function renderInput(input: Input): string {
	return `${[String(input.schema.length), ...input.schema.map(renderSpec), String(input.lines.length), ...input.lines].join('\n')}\n`;
}

/** The wrong solutions (and edges) a group must expose on every test of the class. */
function traps(cls: string, group: GroupId): Variant[] {
	switch (group) {
		case 'format':
			return ['no-trim', 'missing-first', 'comment-inline'];
		case 'values':
			return ['range-exclusive'];
		case 'sections':
			return ['unknown-section-keys'];
		case 'rule':
			return cls === 'last-wins'
				? ['validates-overridden']
				: cls === 'duplicate-error'
					? ['duplicate-on-all']
					: cls === 'first-wins'
						? ['validates-ignored']
						: ['validates-overridden', 'undefined-as-empty', 'last-undefined'];
		default:
			return [];
	}
}

/** The groups in their order with the kinds of their tests; Intern starts with two plain groups. */
function plan(junior: boolean): { id: GroupId; kinds: GroupId[] }[] {
	const four = (kind: GroupId): GroupId[] => [kind, kind, kind, kind];
	return junior
		? [
				{ id: 'format', kinds: four('format') },
				{ id: 'values', kinds: four('values') },
				{ id: 'sections', kinds: four('sections') },
				{ id: 'rule', kinds: four('rule') },
				{ id: 'scale', kinds: ['scale', 'scale'] }
			]
		: [
				{ id: 'basic', kinds: four('basic') },
				{ id: 'plain', kinds: four('plain') },
				{ id: 'format', kinds: four('format') },
				{ id: 'values', kinds: four('values') },
				{ id: 'rule', kinds: [...four('rule'), 'scale'] }
			];
}

function groups(rng: Rng, cls: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	// A plain test gives the right output under every wrong solution that breaks a rule other than the class one.
	const outside = [...WRONG_IDS].filter((v) => applies(v, cls, junior) && !traps(cls, 'rule').includes(v));
	return plan(junior).map(({ id, kinds }) => {
		const tests: { stdin: string; expected: string }[] = [];
		for (const kind of kinds) {
			const at = tests.length;
			for (let attempt = 0; tests.length === at; attempt += 1) {
				if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${kind} test for ${cls}`);
				const input = makeInput(rng, cls, kind, junior);
				const expected = lint(cls, junior, input);
				if (others.some((other) => lint(other, junior, input) === expected)) continue;
				if (traps(cls, kind).some((v) => lint(cls, junior, input, v) === expected)) continue;
				if (PLAIN.includes(kind) && outside.some((v) => lint(cls, junior, input, v) !== expected)) continue;
				tests.push({ stdin: renderInput(input), expected });
			}
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

const RULES: Record<string, (junior: boolean) => string> = {
	'last-wins': (junior) =>
		`**Повтор ключа.** Если ключ${junior ? ' секции' : ''} встречается несколько раз, действует **последнее** значение: проверяется только оно, более ранние вхождения ничего не печатают (даже если их значения неверны).`,
	'duplicate-error': (junior) =>
		`**Повтор ключа.** Действует **первое** значение ключа${junior ? ' секции' : ''} — проверяется оно; каждое следующее вхождение — ошибка \`duplicate <ключ>\` на его строке, его значение не проверяется.`,
	substitution: (junior) =>
		`**Повтор ключа.** Действует **последнее** значение: проверяется только оно, более ранние вхождения ничего не печатают.\n\n**Подстановка.** Значение может содержать ссылки \`\${ИМЯ}\`, где ИМЯ — ${junior ? 'полное имя ключа `секция.ключ`' : 'имя ключа'}. Перед проверкой типа каждая ссылка заменяется действующим значением этого ключа **как оно записано** (ссылки внутри подставленного текста не раскрываются). Если хотя бы одна ссылка указывает на ключ, который в конфигурации не задан, строка получает ошибку \`undefined <ИМЯ>\` с именем **первой** такой ссылки слева, и тип не проверяется. Подстановка — только в проверяемых значениях; ссылаться можно и на ключ, записанный ниже.`,
	'first-wins': (junior) =>
		`**Повтор ключа.** Действует **первое** значение ключа${junior ? ' секции' : ''}: проверяется только оно, все следующие вхождения молча игнорируются — не проверяются и ошибок не дают.`
};

function statement(cls: string, junior: boolean): string {
	const key = junior ? '<секция>.<ключ>' : '<ключ>';
	return [
		`Сервис читает конфигурацию ${junior ? 'в формате INI' : 'из строк `KEY=VALUE`'}. Напишите программу-линтер: она проверяет конфигурацию по схеме и печатает ошибки.`,
		'',
		'## Вход',
		'',
		'Первая строка — число `S` правил схемы (1 ≤ S ≤ 100), далее `S` строк схемы, затем число `C` строк конфигурации (1 ≤ C ≤ 5000) и сами `C` строк. Строки конфигурации нумеруются с 1.',
		'',
		`Строка схемы — поля через пробел: \`${key} <тип> <required|optional> [параметры]\`. Типы: \`int <min> <max>\` — целое: необязательный \`-\` и цифры, от min до max включительно; \`bool\` — ровно \`true\` или \`false\`; \`enum <v1,v2,...>\` — ровно одно из перечисленных значений; \`str\` — любая непустая строка.`,
		'',
		'## Разбор конфигурации',
		'',
		'Каждая строка сначала обрезается по краям от пробелов и табуляций. Пустая строка и строка, начинающаяся с `#`, пропускаются; `#` в середине строки — обычный символ значения.',
		...(junior
			? [
					'',
					'Строка вида `[имя]` (после обрезки начинается с `[` и кончается `]`) — заголовок секции, имя — текст между скобками, обрезанный от пробелов. Секция известна, если в схеме есть ключ `имя.<что-то>`. Заголовок неизвестной секции — ошибка `section <имя>`, и все строки до следующего заголовка пропускаются без ошибок. Заголовок может повториться: ключи снова идут в ту же секцию.'
				]
			: []),
		'',
		`Остальные строки — \`ключ=значение\`: ключ — текст до первого \`=\`, значение — после него, оба обрезаны от пробелов. Строка без \`=\` или с пустым ключом — ошибка \`syntax\`${junior ? '; ключ до первого заголовка секции — тоже `syntax`. Полное имя ключа — `секция.ключ`' : ''}. Ключ, которого нет в схеме, — ошибка \`unknown <ключ>\`${junior ? ' (с полным именем)' : ''}. Строки с \`syntax\` и \`unknown\` значений не задают.`,
		'',
		RULES[cls]?.(junior) ?? '',
		'',
		'**Проверка значения.** Значение неверного вида — ошибка `type <ключ>`; целое вне диапазона — `range <ключ>`.',
		'',
		`Ключ **задан**, если для него есть хотя бы одна строка \`ключ=значение\` без ошибки \`syntax\` и \`unknown\`${junior ? ' вне пропускаемых секций' : ''} — даже если её значение неверно или она повтор. Обязательный ключ, который не задан, — ошибка \`missing <ключ>\`.`,
		'',
		'## Выход',
		'',
		`Сначала ошибки строк по возрастанию номера строки, по одной на строку: \`<номер>: <ошибка>\`; затем \`-: missing ${key}\` в порядке схемы. Если ошибок нет — одна строка \`OK\`. Пример:`,
		'',
		'```',
		'3: syntax',
		`5: unknown ${junior ? 'server.prot' : 'server_prot'}`,
		`7: type ${junior ? 'server.port' : 'server_port'}`,
		`-: missing ${junior ? 'db.host' : 'db_host'}`,
		'```',
		'',
		'Разбор входа на Python (на Go — так же построчно):',
		'',
		'```python',
		'import sys',
		'',
		"lines = sys.stdin.read().split('\\n')",
		's = int(lines[0])',
		'schema = {}',
		'for row in lines[1:s + 1]:',
		'    key, kind, need, *args = row.split()',
		"    schema[key] = (kind, need == 'required', args)",
		'c = int(lines[s + 1])',
		'config = lines[s + 2:s + 2 + c]  # строка с номером i — config[i - 1]',
		'```',
		'',
		junior
			? `Скрытые тесты — пять групп: пробелы, комментарии и мусорные строки; типы и границы диапазонов; секции; правило повторов${cls === 'substitution' ? ' и подстановок' : ''}; большой объём. Группа засчитывается, если пройдены все её тесты.`
			: `Скрытые тесты — пять групп: короткие конфигурации и конфигурации подлиннее — в обеих только строки \`ключ=значение\` без пробелов, все обязательные ключи заданы, целые не на границах диапазона, ${cls === 'substitution' ? 'есть подстановка' : 'есть повтор ключа'}; пробелы, комментарии и мусорные строки; типы и границы диапазонов; правило повторов${cls === 'substitution' ? ' и подстановок' : ''} и большой объём. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Reference programs.

function referenceSource(cls: string, junior: boolean, variant: Variant): string {
	const strip = variant === 'comment-inline' ? "raw.split('#')[0].strip()" : 'raw.strip()';
	const keyOf = variant === 'no-trim' ? 'line[:eq]' : 'line[:eq].strip()';
	const valueOf = variant === 'no-trim' ? 'line[eq + 1:]' : 'line[eq + 1:].strip()';
	const range =
		variant === 'range-exclusive'
			? "spec['min'] < int(value) < spec['max']"
			: "spec['min'] <= int(value) <= spec['max']";
	const sections = junior
		? [
				"    if line.startswith('[') and line.endswith(']'):",
				'        name = line[1:-1].strip()',
				'        if name not in sections:',
				"            errors[n] = f'section {name}'",
				`        skip = ${variant === 'unknown-section-keys' ? 'False' : 'name not in sections'}`,
				'        section = name',
				'        continue',
				'    if skip:',
				'        continue'
			]
		: [];
	const rule: Record<string, string[]> = {
		'last-wins': [
			'for key, items in seen.items():',
			`    for n, value in items${variant === 'validates-overridden' ? '' : '[-1:]'}:`,
			'        problem = check(key, value)',
			'        if problem:',
			"            errors[n] = f'{problem} {key}'"
		],
		'first-wins': [
			'for key, items in seen.items():',
			`    for n, value in items${variant === 'validates-ignored' ? '' : '[:1]'}:`,
			'        problem = check(key, value)',
			'        if problem:',
			"            errors[n] = f'{problem} {key}'"
		],
		'duplicate-error': [
			'for key, items in seen.items():',
			'    n, value = items[0]',
			'    problem = check(key, value)',
			'    if problem:',
			"        errors[n] = f'{problem} {key}'",
			...(variant === 'duplicate-on-all'
				? ['    if len(items) > 1:', '        for m, _ in items:', "            errors[m] = f'duplicate {key}'"]
				: ['    for m, _ in items[1:]:', "        errors[m] = f'duplicate {key}'"])
		],
		substitution: [
			'current = {key: items[-1][1] for key, items in seen.items()}',
			'for key, items in seen.items():',
			`    for n, value in items${variant === 'validates-overridden' ? '' : '[-1:]'}:`,
			'        unknown = [name for name in REF.findall(value) if name not in current]',
			...(variant === 'undefined-as-empty'
				? ["        value = REF.sub(lambda m: current.get(m.group(1), ''), value)"]
				: [
						'        if unknown:',
						"            errors[n] = f'undefined {unknown[0]}'",
						'            continue',
						'        value = REF.sub(lambda m: current[m.group(1)], value)'
					]),
			'        problem = check(key, value)',
			'        if problem:',
			"            errors[n] = f'{problem} {key}'"
		]
	};
	const report =
		variant === 'missing-first'
			? ['for line in missing + out:', '    print(line)']
			: ['for line in out + missing:', '    print(line)'];
	return [
		'import re',
		'import sys',
		'',
		"REF = re.compile(r'\\$\\{([^}]*)\\}')",
		"INT = re.compile(r'-?[0-9]+')",
		'',
		"lines = sys.stdin.read().split('\\n')",
		's = int(lines[0])',
		'schema = {}',
		'order = []',
		'for row in lines[1:s + 1]:',
		'    f = row.split()',
		"    spec = {'type': f[1], 'required': f[2] == 'required'}",
		"    if f[1] == 'int':",
		"        spec['min'], spec['max'] = int(f[3]), int(f[4])",
		"    elif f[1] == 'enum':",
		"        spec['values'] = f[3].split(',')",
		'    schema[f[0]] = spec',
		'    order.append(f[0])',
		...(junior ? ["sections = {key.split('.')[0] for key in order}"] : []),
		'',
		'',
		'def check(key, value):',
		'    spec = schema[key]',
		"    if spec['type'] == 'int':",
		'        if not INT.fullmatch(value):',
		"            return 'type'",
		`        if not ${range}:`,
		"            return 'range'",
		"    elif spec['type'] == 'bool':",
		"        if value not in ('true', 'false'):",
		"            return 'type'",
		"    elif spec['type'] == 'enum':",
		"        if value not in spec['values']:",
		"            return 'type'",
		'    elif not value:',
		"        return 'type'",
		'    return None',
		'',
		'',
		'c = int(lines[s + 1])',
		'errors = {}',
		'seen = {}',
		...(junior ? ['section = None', 'skip = False'] : []),
		'for n, raw in enumerate(lines[s + 2:s + 2 + c], 1):',
		`    line = ${strip}`,
		"    if not line or line.startswith('#'):",
		'        continue',
		...sections,
		"    eq = line.find('=')",
		`    key = ${keyOf}`,
		`    if eq < 0 or not key${junior ? ' or section is None' : ''}:`,
		"        errors[n] = 'syntax'",
		'        continue',
		...(junior ? ["    key = section + '.' + key"] : []),
		'    if key not in schema:',
		"        errors[n] = f'unknown {key}'",
		'        continue',
		`    seen.setdefault(key, []).append((n, ${valueOf}))`,
		...(rule[cls] ?? []),
		"out = [f'{n}: {errors[n]}' for n in sorted(errors)]",
		"missing = [f'-: missing {key}' for key in order if schema[key]['required'] and key not in seen]",
		...report,
		'if not out and not missing:',
		"    print('OK')"
	].join('\n');
}

function applies(id: Variant, cls: string, junior: boolean): boolean {
	switch (id) {
		case 'validates-overridden':
			return cls === 'last-wins' || cls === 'substitution';
		case 'duplicate-on-all':
			return cls === 'duplicate-error';
		case 'validates-ignored':
			return cls === 'first-wins';
		case 'undefined-as-empty':
			return cls === 'substitution';
		case 'unknown-section-keys':
			return junior;
		case 'range-exclusive':
		case 'missing-first':
		case 'no-trim':
		case 'comment-inline':
			return true;
		default:
			return false;
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const cls = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== cls);
	const hidden = groups(rng, cls, others, junior);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(cls, junior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(cls, junior, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, cls, junior) ? { kind: 'program' as const, source: referenceSource(cls, junior, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
