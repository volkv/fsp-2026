// References and copies of lists: which names share one list object after assignment, slicing, copying, `+=`,
// list multiplication, default arguments and calls, and so what every name shows at the end.
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

/** A Python value of the programs: an int or a list; JS arrays keep the identity of Python lists. */
type PyVal = number | PyList;
type PyList = PyVal[];

/** The misconceptions as switches of the model; all off is the language. */
interface Rules {
	assignCopies: boolean;
	copyAliases: boolean;
	iaddRebinds: boolean;
	plusMutates: boolean;
	rowsIndependent: boolean;
	shallowIsDeep: boolean;
	shallowIsAlias: boolean;
	defaultFresh: boolean;
	snapshotAtReturn: boolean;
	passByValue: boolean;
	rebindVisible: boolean;
	loopVarWritesBack: boolean;
	fromkeysCopies: boolean;
}

const RIGHT: Rules = {
	assignCopies: false,
	copyAliases: false,
	iaddRebinds: false,
	plusMutates: false,
	rowsIndependent: false,
	shallowIsDeep: false,
	shallowIsAlias: false,
	defaultFresh: false,
	snapshotAtReturn: false,
	passByValue: false,
	rebindVisible: false,
	loopVarWritesBack: false,
	fromkeysCopies: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'assign-copies': { assignCopies: true },
	'copy-aliases': { copyAliases: true },
	'iadd-rebinds': { iaddRebinds: true },
	'plus-mutates': { plusMutates: true },
	'rows-independent': { rowsIndependent: true },
	'shallow-is-deep': { shallowIsDeep: true },
	'shallow-is-alias': { shallowIsAlias: true },
	'default-fresh': { defaultFresh: true },
	'snapshot-at-return': { snapshotAtReturn: true },
	'pass-by-value': { passByValue: true },
	'rebind-visible': { rebindVisible: true },
	'loop-var-writes-back': { loopVarWritesBack: true },
	'fromkeys-copies': { fromkeysCopies: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/alias-copy': ['assign-copies', 'copy-aliases'],
	'intern/plus-equals': ['iadd-rebinds', 'plus-mutates'],
	'intern/nested-grid': ['rows-independent'],
	'junior/shallow-deep': ['shallow-is-deep', 'shallow-is-alias'],
	'junior/default-arg': ['default-fresh', 'snapshot-at-return'],
	'junior/call-mutation': ['pass-by-value', 'rebind-visible'],
	'intern/loop-var': ['loop-var-writes-back'],
	'junior/dict-fromkeys': ['fromkeys-copies', 'plus-mutates']
};

function repr(value: PyVal): string {
	return typeof value === 'number' ? String(value) : `[${value.map(repr).join(', ')}]`;
}

function deepCopy(list: PyList): PyList {
	return list.map((v) => (typeof v === 'number' ? v : deepCopy(v)));
}

function at<T>(items: readonly T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`index ${i} of ${items.length}`);
	return item;
}

function listAt(list: PyList, i: number): PyList {
	const item = at(list, i);
	if (typeof item === 'number') throw new Error('an int where a list was expected');
	return item;
}

/** A program: its lines and how it runs under a set of rules, giving the printed lines. */
interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const NAMES = ['items', 'queue', 'batch', 'saved', 'view', 'backup', 'cart', 'pending', 'buffer', 'tail'] as const;

/** Distinct small numbers that never appear in the lists before, so every change is visible. */
function freshValues(rng: Rng, count: number, used: Set<number>): number[] {
	const values: number[] = [];
	while (values.length < count) {
		const v = rng.int(10, 99);
		if (used.has(v)) continue;
		used.add(v);
		values.push(v);
	}
	return values;
}

function initialList(rng: Rng, length: number, used: Set<number>): number[] {
	const values = Array.from({ length }, () => rng.int(1, 9));
	values.forEach((v) => used.add(v));
	return values;
}

function aliasCopy(rng: Rng): Program {
	const [a, b, c] = rng.sample(NAMES, 3) as [string, string, string];
	const used = new Set<number>();
	const start = initialList(rng, rng.int(3, 4), used);
	const copyForm = rng.pick([`${a}[:]`, `list(${a})`, `${a}.copy()`]);
	// Three or four changes: at least one through the alias and one through the copy.
	const targets = rng.shuffle([b, c, ...Array.from({ length: rng.int(1, 2) }, () => rng.pick([a, b, c]))]);
	const values = freshValues(rng, targets.length, used);
	const ops = targets.map((target, i) => {
		const kind = rng.pick(['append', 'set'] as const);
		const index = rng.int(0, start.length - 1);
		const value = at(values, i);
		return { target, kind, index, value };
	});
	return {
		lines: [
			`${a} = [${start.join(', ')}]`,
			`${b} = ${a}`,
			`${c} = ${copyForm}`,
			...ops.map((op) =>
				op.kind === 'append' ? `${op.target}.append(${op.value})` : `${op.target}[${op.index}] = ${op.value}`
			),
			`print(${a})`,
			`print(${b})`,
			`print(${c})`
		],
		run: (rules) => {
			const env = new Map<string, PyList>();
			env.set(a, [...start]);
			const original = env.get(a) as PyList;
			env.set(b, rules.assignCopies ? [...original] : original);
			env.set(c, rules.copyAliases ? original : [...original]);
			for (const op of ops) {
				const list = env.get(op.target) as PyList;
				if (op.kind === 'append') list.push(op.value);
				else list[op.index] = op.value;
			}
			return [a, b, c].map((name) => repr(env.get(name) as PyList));
		}
	};
}

function plusEquals(rng: Rng): Program {
	const [a, b, c] = rng.sample(NAMES, 3) as [string, string, string];
	const used = new Set<number>();
	const start = initialList(rng, rng.int(2, 3), used);
	const [v1, v2, v3, v4] = freshValues(rng, 4, used) as [number, number, number, number];
	const iaddFirst = rng.bool();
	const iadd = [`${b} = ${a}`, `${b} += [${v1}]`];
	const plus = [`${c} = ${a}`, `${c} = ${c} + [${v2}]`];
	const tail = rng.pick([`${a}.append(${v3})`, `${a}[0] = ${v3}`]);
	const last = rng.pick([`${c}.append(${v4})`, `${b}.append(${v4})`]);
	return {
		lines: [
			`${a} = [${start.join(', ')}]`,
			...(iaddFirst ? [...iadd, ...plus] : [...plus, ...iadd]),
			tail,
			last,
			`print(${a})`,
			`print(${b})`,
			`print(${c})`
		],
		run: (rules) => {
			const env = new Map<string, PyList>();
			const original: PyList = [...start];
			env.set(a, original);
			const doIadd = () => {
				const alias = rules.assignCopies ? [...original] : original;
				if (rules.iaddRebinds) env.set(b, [...alias, v1]);
				else {
					alias.push(v1);
					env.set(b, alias);
				}
			};
			const doPlus = () => {
				const alias = rules.assignCopies ? [...original] : original;
				if (rules.plusMutates) {
					alias.push(v2);
					env.set(c, alias);
				} else env.set(c, [...alias, v2]);
			};
			if (iaddFirst) {
				doIadd();
				doPlus();
			} else {
				doPlus();
				doIadd();
			}
			if (tail.endsWith(`.append(${v3})`)) original.push(v3);
			else original[0] = v3;
			const lastTarget = last.startsWith(`${c}.`) ? c : b;
			(env.get(lastTarget) as PyList).push(v4);
			return [a, b, c].map((name) => repr(env.get(name) as PyList));
		}
	};
}

function nestedGrid(rng: Rng): Program {
	const name = rng.pick(['grid', 'board', 'table', 'matrix', 'cells']);
	const n = rng.int(2, 3);
	const m = rng.int(3, 4);
	const fill = rng.int(0, 1);
	const rows = rng.sample(
		Array.from({ length: m }, (_, i) => i),
		3
	);
	const [r1, r2, r3] = rows as [number, number, number];
	const [c1, c3] = [rng.int(0, n - 1), rng.int(0, n - 1)];
	const used = new Set<number>([fill]);
	const [v1, v2, v3] = freshValues(rng, 3, used) as [number, number, number];
	const replaceFirst = rng.bool();
	const set1 = `${name}[${r1}][${c1}] = ${v1}`;
	const replace = `${name}[${r2}] = [${v2}] * ${n}`;
	const set3 = `${name}[${r3}][${c3}] = ${v3}`;
	return {
		lines: [
			`${name} = [[${fill}] * ${n}] * ${m}`,
			...(replaceFirst ? [replace, set1] : [set1, replace]),
			set3,
			`print(${name})`,
			`print(${name}[${r2}] is ${name}[${r1}], ${name}[${r1}] is ${name}[${r3}])`
		],
		run: (rules) => {
			const shared: PyList = Array.from({ length: n }, () => fill);
			const grid: PyList = Array.from({ length: m }, () =>
				rules.rowsIndependent ? Array.from({ length: n }, () => fill) : shared
			);
			const doSet1 = () => {
				listAt(grid, r1)[c1] = v1;
			};
			const doReplace = () => {
				grid[r2] = Array.from({ length: n }, () => v2);
			};
			if (replaceFirst) {
				doReplace();
				doSet1();
			} else {
				doSet1();
				doReplace();
			}
			listAt(grid, r3)[c3] = v3;
			const same = (x: number, y: number) => (listAt(grid, x) === listAt(grid, y) ? 'True' : 'False');
			return [repr(grid), `${same(r2, r1)} ${same(r1, r3)}`];
		}
	};
}

function shallowDeep(rng: Rng): Program {
	const [orig, shallow, deep] = rng.sample(NAMES, 3) as [string, string, string];
	const used = new Set<number>();
	const start = Array.from({ length: 3 }, () => initialList(rng, rng.int(1, 2), used));
	const copyForm = rng.pick([`copy.copy(${orig})`, `${orig}[:]`, `list(${orig})`]);
	type Op = { text: string; apply: (env: Map<string, PyList>) => void };
	const values = freshValues(rng, 4, used);
	let next = 0;
	const value = () => at(values, next++);
	// One change of an inner list shared by the shallow copy, one change of the outer list, then two of any kind.
	const innerChange = (target: string): Op => {
		const i = rng.int(0, 2);
		const v = value();
		return rng.bool()
			? { text: `${target}[${i}].append(${v})`, apply: (env) => listAt(env.get(target) as PyList, i).push(v) }
			: { text: `${target}[${i}][0] = ${v}`, apply: (env) => (listAt(env.get(target) as PyList, i)[0] = v) };
	};
	const outerChange = (target: string): Op => {
		const v = value();
		if (rng.bool()) return { text: `${target}.append([${v}])`, apply: (env) => (env.get(target) as PyList).push([v]) };
		const i = rng.int(0, 2);
		return { text: `${target}[${i}] = [${v}]`, apply: (env) => ((env.get(target) as PyList)[i] = [v]) };
	};
	const head: Op[] = rng.shuffle([innerChange(rng.pick([orig, shallow])), outerChange(rng.pick([orig, shallow]))]);
	const extra: Op[] = [rng.pick([innerChange, outerChange])(rng.pick([orig, shallow, deep]))];
	const ops = [...head, ...extra];
	return {
		lines: [
			'import copy',
			'',
			`${orig} = [${start.map((xs) => `[${xs.join(', ')}]`).join(', ')}]`,
			`${shallow} = ${copyForm}`,
			`${deep} = copy.deepcopy(${orig})`,
			...ops.map((op) => op.text),
			`print(${orig})`,
			`print(${shallow})`,
			`print(${deep})`
		],
		run: (rules) => {
			const original: PyList = start.map((xs) => [...xs]);
			const env = new Map<string, PyList>([[orig, original]]);
			env.set(shallow, rules.shallowIsAlias ? original : rules.shallowIsDeep ? deepCopy(original) : [...original]);
			env.set(deep, deepCopy(original));
			for (const op of ops) op.apply(env);
			return [orig, shallow, deep].map((name) => repr(env.get(name) as PyList));
		}
	};
}

function defaultArg(rng: Rng): Program {
	const fn = rng.pick(['add', 'collect', 'remember', 'track', 'push']);
	const param = rng.pick(['bucket', 'acc', 'seen', 'store', 'log']);
	const vars = rng.sample(['a', 'b', 'c', 'd', 'e', 'f'], 4) as [string, string, string, string];
	const used = new Set<number>();
	const items = freshValues(rng, 5, used);
	// Calls: three with the default, one with a new list, one into the list a previous call returned.
	type Arg = { kind: 'default' } | { kind: 'new' } | { kind: 'into'; name: string };
	type Call = { target: string | null; arg: Arg; item: number };
	const into: Arg = { kind: 'into', name: at(vars, rng.int(0, 1)) };
	const shapes = rng.shuffle<Arg>([{ kind: 'default' }, { kind: 'new' }, { kind: 'default' }]);
	const calls: Call[] = [
		{ target: at(vars, 0), arg: { kind: 'default' }, item: at(items, 0) },
		{ target: at(vars, 1), arg: at(shapes, 0), item: at(items, 1) },
		{ target: at(vars, 2), arg: at(shapes, 1), item: at(items, 2) },
		{ target: null, arg: into, item: at(items, 3) },
		{ target: at(vars, 3), arg: at(shapes, 2), item: at(items, 4) }
	];
	const printed = rng.shuffle(vars.slice(0, 4));
	return {
		lines: [
			`def ${fn}(item, ${param}=[]):`,
			`    ${param}.append(item)`,
			`    return ${param}`,
			'',
			...calls.map((call) => {
				const args =
					call.arg.kind === 'default'
						? `${call.item}`
						: call.arg.kind === 'new'
							? `${call.item}, []`
							: `${call.item}, ${call.arg.name}`;
				return call.target === null ? `${fn}(${args})` : `${call.target} = ${fn}(${args})`;
			}),
			...printed.map((name) => `print(${name})`)
		],
		run: (rules) => {
			const shared: PyList = [];
			const env = new Map<string, PyList>();
			const snapshots = new Map<string, string>();
			for (const call of calls) {
				const list =
					call.arg.kind === 'default'
						? rules.defaultFresh
							? []
							: shared
						: call.arg.kind === 'new'
							? []
							: (env.get(call.arg.name) as PyList);
				list.push(call.item);
				if (call.target !== null) {
					env.set(call.target, list);
					snapshots.set(call.target, repr(list));
				}
			}
			return printed.map((name) =>
				rules.snapshotAtReturn ? (snapshots.get(name) as string) : repr(env.get(name) as PyList)
			);
		}
	};
}

function callMutation(rng: Rng): Program {
	const fn = rng.pick(['update', 'normalize', 'enrich', 'prepare', 'patch']);
	const [data, result] = rng.sample(NAMES, 2) as [string, string];
	const param = rng.pick(['xs', 'values', 'row', 'buf']);
	const used = new Set<number>();
	const start = initialList(rng, rng.int(2, 3), used);
	const [v1, v2, v3, v4] = freshValues(rng, 4, used) as [number, number, number, number];
	// Body: a change on the caller's list, a rebinding to a new list, a change of the new list.
	const before = rng.pick([
		{ text: `    ${param}.append(${v1})`, apply: (xs: PyList) => void xs.push(v1) },
		{ text: `    ${param}[0] = ${v1}`, apply: (xs: PyList) => void (xs[0] = v1) },
		{ text: `    ${param} += [${v1}]`, apply: (xs: PyList) => void xs.push(v1) }
	]);
	const rebind = rng.pick([
		{ text: `    ${param} = ${param} + [${v2}]`, make: (xs: PyList) => [...xs, v2] },
		{ text: `    ${param} = [${v2}] + ${param}`, make: (xs: PyList) => [v2, ...xs] },
		{ text: `    ${param} = ${param}[:] + [${v2}]`, make: (xs: PyList) => [...xs, v2] }
	]);
	const after = rng.pick([
		{ text: `    ${param}.append(${v3})`, apply: (xs: PyList) => void xs.push(v3) },
		{ text: `    ${param} += [${v3}]`, apply: (xs: PyList) => void xs.push(v3) },
		{ text: `    ${param}[-1] = ${v3}`, apply: (xs: PyList) => void (xs[xs.length - 1] = v3) }
	]);
	const callerChange = rng.bool();
	return {
		lines: [
			`def ${fn}(${param}):`,
			before.text,
			rebind.text,
			after.text,
			`    return ${param}`,
			'',
			`${data} = [${start.join(', ')}]`,
			`${result} = ${fn}(${data})`,
			...(callerChange ? [`${data}.append(${v4})`] : [`${result}.append(${v4})`]),
			`print(${data})`,
			`print(${result})`
		],
		run: (rules) => {
			const caller: PyList = [...start];
			let local: PyList = rules.passByValue ? [...caller] : caller;
			before.apply(local);
			const fresh = rebind.make(local);
			if (rules.rebindVisible) {
				local.splice(0, local.length, ...fresh);
			} else local = fresh;
			after.apply(local);
			const returned = local;
			if (callerChange) caller.push(v4);
			else returned.push(v4);
			return [repr(caller), repr(returned)];
		}
	};
}

function loopVar(rng: Rng): Program {
	const [nums, rows] = rng.pick([
		['nums', 'rows'],
		['prices', 'baskets'],
		['scores', 'groups'],
		['sizes', 'batches']
	] as const);
	const used = new Set<number>();
	const start = initialList(rng, rng.int(3, 4), used);
	const rowStart = Array.from({ length: rng.int(2, 3) }, () => initialList(rng, rng.int(1, 2), used));
	const k = rng.int(2, 5);
	const [v, w] = freshValues(rng, 2, used) as [number, number];
	const numberOp = rng.pick([
		{ text: `x += ${k}`, f: (x: number) => x + k },
		{ text: `x = x * ${k}`, f: (x: number) => x * k }
	]);
	// A change of each row through the loop variable, then a rebinding of the loop variable.
	const rowChange = rng.pick([
		{ text: `row.append(${v})`, kind: 'append' as const },
		{ text: `row += [${v}]`, kind: 'iadd' as const },
		{ text: `row = row + [${v}]`, kind: 'plus' as const }
	]);
	return {
		lines: [
			`${nums} = [${start.join(', ')}]`,
			`${rows} = [${rowStart.map((r) => `[${r.join(', ')}]`).join(', ')}]`,
			`for x in ${nums}:`,
			`    ${numberOp.text}`,
			`for row in ${rows}:`,
			`    ${rowChange.text}`,
			`for row in ${rows}:`,
			`    row = [${w}]`,
			`print(${nums})`,
			`print(${rows})`
		],
		run: (rules) => {
			if (rules.loopVarWritesBack) return [repr(start.map(numberOp.f)), repr(rowStart.map(() => [w]))];
			const appended =
				rowChange.kind === 'append' ||
				(rowChange.kind === 'iadd' && !rules.iaddRebinds) ||
				(rowChange.kind === 'plus' && rules.plusMutates);
			return [repr(start), repr(rowStart.map((r) => (appended ? [...r, v] : [...r])))];
		}
	};
}

function dictFromkeys(rng: Rng): Program {
	const [shared, own] = rng.pick([
		['shared', 'own'],
		['by_role', 'by_team'],
		['queues', 'inboxes'],
		['tags', 'labels']
	] as const);
	const keys = rng.sample(['api', 'db', 'web', 'ops', 'qa', 'ml'], 3) as [string, string, string];
	const used = new Set<number>();
	const [v1, v2, v3, v4] = freshValues(rng, 4, used) as [number, number, number, number];
	const [first, second, third] = rng.shuffle(keys) as [string, string, string];
	const keyList = `[${keys.map((k) => `'${k}'`).join(', ')}]`;
	return {
		lines: [
			`keys = ${keyList}`,
			`${shared} = dict.fromkeys(keys, [])`,
			`${own} = {k: [] for k in keys}`,
			`${shared}['${first}'].append(${v1})`,
			`${own}['${first}'].append(${v1})`,
			`${shared}['${second}'] = ${shared}['${second}'] + [${v2}]`,
			`${shared}['${third}'].append(${v3})`,
			`${own}['${third}'].append(${v4})`,
			`print(${shared})`,
			`print(${own})`
		],
		run: (rules) => {
			const common: PyList = [];
			const a = new Map<string, PyList>(keys.map((k) => [k, rules.fromkeysCopies ? [] : common]));
			const b = new Map<string, PyList>(keys.map((k) => [k, []]));
			(a.get(first) as PyList).push(v1);
			(b.get(first) as PyList).push(v1);
			const old = a.get(second) as PyList;
			if (rules.plusMutates) old.push(v2);
			else a.set(second, [...old, v2]);
			(a.get(third) as PyList).push(v3);
			(b.get(third) as PyList).push(v4);
			const dict = (m: Map<string, PyList>) => `{${keys.map((k) => `'${k}': ${repr(m.get(k) as PyList)}`).join(', ')}}`;
			return [dict(a), dict(b)];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/alias-copy': aliasCopy,
	'intern/plus-equals': plusEquals,
	'intern/nested-grid': nestedGrid,
	'junior/shallow-deep': shallowDeep,
	'junior/default-arg': defaultArg,
	'junior/call-mutation': callMutation,
	'intern/loop-var': loopVar,
	'junior/dict-fromkeys': dictFromkeys
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
	for (let tries = 0; tries < 200; tries += 1) {
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
