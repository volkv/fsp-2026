// Reducers: what a series of dispatched actions leaves in the state and which parts of the state keep their identity.
// The generator runs the same reducer on plain objects (identity included) and prints what the shown program prints;
// the gate runs the shown program with Node.
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
	/** Output a misconception predicts; `null` — it does not apply to the class. */
	wrong: Record<string, string[] | null>;
}

// ---------------------------------------------------------------------------------------------------------------
// Intern: a flat state of three numbers and a reducer over a switch.

interface FlatPlot {
	count: string;
	unit: string;
	extra: string;
	sign: '+' | '-';
	add: string;
	sub: string;
	set: string;
	reset: string;
}

const FLAT_PLOTS: readonly FlatPlot[] = [
	{ count: 'qty', unit: 'price', extra: 'coupon', sign: '-', add: 'add', sub: 'remove', set: 'coupon', reset: 'clear' },
	{ count: 'seats', unit: 'fare', extra: 'fee', sign: '+', add: 'book', sub: 'cancel', set: 'fee', reset: 'reset' },
	{
		count: 'units',
		unit: 'cost',
		extra: 'shipping',
		sign: '+',
		add: 'restock',
		sub: 'ship',
		set: 'shipping',
		reset: 'reset'
	},
	{ count: 'hours', unit: 'rate', extra: 'bonus', sign: '+', add: 'log', sub: 'undo', set: 'bonus', reset: 'restart' }
];

interface Flat {
	count: number;
	unit: number;
	extra: number;
}

type FlatAction =
	| { kind: 'add'; amount: number }
	| { kind: 'sub'; amount: number }
	| { kind: 'set'; value: number }
	| { kind: 'reset' }
	| { kind: 'unknown'; type: string; amount: number | null; caseOf: 'add' | 'sub' | null };

/** How a misconception changes the reducer. */
interface FlatRules {
	setAccumulates: boolean;
	unknown: 'same' | 'initial' | 'case-insensitive';
	reset: 'initial' | 'zero' | 'noop';
	guard: 'reject' | 'clamp' | 'none';
}

const FLAT_RIGHT: FlatRules = { setAccumulates: false, unknown: 'same', reset: 'initial', guard: 'reject' };

function runFlat(initial: Flat, actions: readonly FlatAction[], guarded: boolean, rules: FlatRules, sign: '+' | '-') {
	let state = initial;
	const out: string[] = [];
	const sub = (s: Flat, amount: number): Flat => {
		if (guarded && amount > s.count) {
			if (rules.guard === 'reject') return s;
			if (rules.guard === 'clamp') return { ...s, count: 0 };
		}
		return { ...s, count: s.count - amount };
	};
	for (const action of actions) {
		if (action.kind === 'add') state = { ...state, count: state.count + action.amount };
		else if (action.kind === 'sub') state = sub(state, action.amount);
		else if (action.kind === 'set')
			state = { ...state, extra: rules.setAccumulates ? state.extra + action.value : action.value };
		else if (action.kind === 'reset')
			state = rules.reset === 'initial' ? initial : rules.reset === 'zero' ? { ...state, count: 0, extra: 0 } : state;
		else if (rules.unknown === 'initial') state = initial;
		else if (rules.unknown === 'case-insensitive' && action.caseOf !== null && action.amount !== null)
			state = action.caseOf === 'add' ? { ...state, count: state.count + action.amount } : sub(state, action.amount);
		const total = state.count * state.unit + (sign === '+' ? state.extra : -state.extra);
		out.push(`${state.count} ${total}`);
	}
	return out;
}

function internProgram(rng: Rng, classId: string): Program {
	const plot = rng.pick(FLAT_PLOTS);
	const initial: Flat = { count: rng.int(1, 4), unit: rng.pick([40, 50, 90, 120, 150, 200, 250, 300]), extra: 0 };
	initial.extra = rng.int(1, 5) * 10;
	const guarded = classId === 'guard';
	const withReset = classId === 'reset';
	const actions: FlatAction[] = [];
	const add = (): FlatAction => ({ kind: 'add', amount: rng.int(1, 5) });
	const set = (): FlatAction => ({ kind: 'set', value: rng.int(1, 9) * 10 });
	let count = initial.count;
	const pushSub = (amount: number) => {
		actions.push({ kind: 'sub', amount });
		if (!(guarded && amount > count)) count -= amount;
	};
	const pushAdd = () => {
		const a = add();
		actions.push(a);
		if (a.kind === 'add') count += a.amount;
	};
	if (classId === 'payload') {
		// Two settings of the extra field: it is replaced, not accumulated; removals stay within the count.
		pushAdd();
		actions.push(set());
		pushSub(rng.int(1, count));
		pushAdd();
		actions.push(set());
	} else if (classId === 'unknown') {
		// A case variant of a known type and a type the reducer does not handle, both after the state changed.
		pushAdd();
		const caseOf = rng.pick<'add' | 'sub'>(['add', 'sub']);
		const known = caseOf === 'add' ? plot.add : plot.sub;
		const variant = rng.bool() ? known.toUpperCase() : `${known[0]?.toUpperCase() ?? ''}${known.slice(1)}`;
		const amount = caseOf === 'add' ? rng.int(1, 5) : rng.int(1, Math.max(1, count - 1));
		const foreign = rng.pick(['discount', 'refresh', 'sync', 'archive']);
		const tail: FlatAction[] = [
			{ kind: 'unknown', type: variant, amount, caseOf },
			{ kind: 'unknown', type: foreign, amount: null, caseOf: null }
		];
		actions.push(...rng.shuffle(tail));
		actions.splice(rng.int(1, actions.length), 0, set());
		pushAdd();
	} else if (classId === 'reset') {
		pushAdd();
		actions.push(set());
		actions.push({ kind: 'reset' });
		pushAdd();
		actions.push(set());
	} else {
		// guard: one removal asks for more than there is and is rejected as a whole.
		pushAdd();
		pushSub(rng.int(1, count - 1));
		pushSub(count + rng.int(1, 4));
		pushAdd();
		pushSub(rng.int(1, count));
	}
	const show = (a: FlatAction): string => {
		if (a.kind === 'add') return `{ type: '${plot.add}', amount: ${a.amount} }`;
		if (a.kind === 'sub') return `{ type: '${plot.sub}', amount: ${a.amount} }`;
		if (a.kind === 'set') return `{ type: '${plot.set}', value: ${a.value} }`;
		if (a.kind === 'reset') return `{ type: '${plot.reset}' }`;
		return a.amount === null ? `{ type: '${a.type}' }` : `{ type: '${a.type}', amount: ${a.amount} }`;
	};
	const { count: c, unit: u, extra: e } = plot;
	const lines = [
		`const initial = { ${c}: ${initial.count}, ${u}: ${initial.unit}, ${e}: ${initial.extra} };`,
		'',
		'function reducer(state, action) {',
		'  switch (action.type) {',
		`    case '${plot.add}':`,
		`      return { ...state, ${c}: state.${c} + action.amount };`,
		`    case '${plot.sub}':`,
		...(guarded ? [`      if (action.amount > state.${c}) return state;`] : []),
		`      return { ...state, ${c}: state.${c} - action.amount };`,
		`    case '${plot.set}':`,
		`      return { ...state, ${e}: action.value };`,
		...(withReset ? [`    case '${plot.reset}':`, '      return initial;'] : []),
		'    default:',
		'      return state;',
		'  }',
		'}',
		'',
		'const actions = [',
		...actions.map((a, i) => `  ${show(a)}${i === actions.length - 1 ? '' : ','}`),
		'];',
		'',
		'let state = initial;',
		'for (const action of actions) {',
		'  state = reducer(state, action);',
		`  console.log(state.${c}, state.${c} * state.${u} ${plot.sign} state.${e});`,
		'}'
	];
	const run = (change: Partial<FlatRules>) =>
		runFlat(initial, actions, guarded, { ...FLAT_RIGHT, ...change }, plot.sign);
	const applies = (yes: boolean, change: Partial<FlatRules>) => (yes ? run(change) : null);
	return {
		lines,
		answer: run({}),
		wrong: {
			'set-accumulates': applies(classId === 'payload', { setAccumulates: true }),
			'unknown-resets': applies(classId === 'unknown', { unknown: 'initial' }),
			'unknown-case-insensitive': applies(classId === 'unknown', { unknown: 'case-insensitive' }),
			'reset-to-zero': applies(withReset, { reset: 'zero' }),
			'initial-mutated': applies(withReset, { reset: 'noop' }),
			'guard-clamps': applies(guarded, { guard: 'clamp' }),
			'guard-ignored': applies(guarded, { guard: 'none' })
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Junior: nested immutable updates of a list and identity checks between the previous and the next state.

interface ListPlot {
	list: string;
	flag: string;
	weight: string;
	titles: readonly string[];
}

const LIST_PLOTS: readonly ListPlot[] = [
	{ list: 'tasks', flag: 'done', weight: 'points', titles: ['docs', 'tests', 'deploy', 'review', 'design', 'budget'] },
	{ list: 'todos', flag: 'checked', weight: 'hours', titles: ['milk', 'bread', 'tea', 'rice', 'eggs', 'apples'] },
	{ list: 'cards', flag: 'pinned', weight: 'votes', titles: ['login', 'search', 'cart', 'profile', 'export', 'chat'] },
	{ list: 'notes', flag: 'starred', weight: 'size', titles: ['ideas', 'plans', 'books', 'trips', 'gifts', 'goals'] }
];

interface Item {
	id: number;
	title: string;
	flag: boolean;
	weight: number;
}

interface ListState {
	filter: string;
	items: Item[];
	stats: { edits: number };
}

type ListAction =
	| { type: 'toggle'; id: number }
	| { type: 'rename'; id: number; title: string }
	| { type: 'remove'; id: number }
	| { type: 'filter'; value: string }
	| { type: 'other'; name: string };

const FILTERS = ['all', 'open', 'closed'] as const;

/** The reducer of the shown program, on plain objects: identity is the same as in the program. */
function listReducer(state: ListState, action: ListAction): ListState {
	switch (action.type) {
		case 'toggle':
			return {
				...state,
				items: state.items.map((t) => (t.id === action.id ? { ...t, flag: !t.flag } : t)),
				stats: { edits: state.stats.edits + 1 }
			};
		case 'rename':
			return { ...state, items: state.items.map((t) => (t.id === action.id ? { ...t, title: action.title } : t)) };
		case 'remove':
			return { ...state, items: state.items.filter((t) => t.id !== action.id) };
		case 'filter':
			if (state.filter === action.value) return state;
			return { ...state, filter: action.value };
		default:
			return state;
	}
}

const flagWeight = (s: ListState): number => s.items.filter((t) => t.flag).reduce((sum, t) => sum + t.weight, 0);

interface Step {
	action: ListAction;
	prev: ListState;
	next: ListState;
}

function runList(initial: ListState, actions: readonly ListAction[]): Step[] {
	const steps: Step[] = [];
	let prev = initial;
	for (const action of actions) {
		const next = listReducer(prev, action);
		steps.push({ action, prev, next });
		prev = next;
	}
	return steps;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function juniorProgram(rng: Rng, classId: string): Program {
	const plot = rng.pick(LIST_PLOTS);
	const size = classId === 'item-identity' ? 4 : rng.int(3, 4);
	const titles = rng.sample(plot.titles, size);
	const spare = plot.titles.filter((t) => !titles.includes(t));
	const firstId = rng.int(1, 5);
	const items: Item[] = titles.map((title, i) => ({
		id: firstId + i,
		title,
		flag: rng.bool(0.4),
		weight: rng.int(1, 9)
	}));
	const initial: ListState = { filter: 'all', items, stats: { edits: 0 } };
	const actions: ListAction[] = [];
	// The state after the actions drawn so far, so that every next action refers to what is there.
	const current = (): ListState => runList(initial, actions).at(-1)?.next ?? initial;
	const idAt = (index: number): number => current().items[index]?.id ?? firstId;
	const anyId = (): number => rng.pick(current().items).id;
	const renameAction = (id: number): ListAction => ({
		type: 'rename',
		id,
		title: rng.pick(spare.length > 0 ? spare : ['draft'])
	});
	const newFilter = (): ListAction => ({
		type: 'filter',
		value: rng.pick(FILTERS.filter((f) => f !== current().filter))
	});
	const foreign = (): ListAction => ({
		type: 'other',
		name: rng.pick(['reset', 'sort', 'toggleAll', 'clear', `${plot.list}/toggle`])
	});

	if (classId === 'slice-refs') {
		// Each action changes one or two slices: a filter only the top level, a toggle the list and the counters, a
		// rename or a removal only the list.
		const kinds = rng.shuffle([
			'filter',
			'toggle',
			'rename',
			rng.pick(['toggle', 'remove', 'filter']),
			rng.pick(['remove', 'rename', 'toggle'])
		]);
		for (const kind of kinds) {
			if (kind === 'filter') actions.push(newFilter());
			else if (kind === 'rename') actions.push(renameAction(anyId()));
			else actions.push({ type: kind === 'toggle' ? 'toggle' : 'remove', id: anyId() });
		}
	} else if (classId === 'item-identity') {
		// A map that keeps untouched items, a removal that shifts positions, a removal past the compared positions.
		actions.push({ type: 'toggle', id: idAt(rng.int(2, 3)) });
		actions.push(rng.bool() ? { type: 'toggle', id: idAt(rng.int(0, 1)) } : renameAction(idAt(rng.int(0, 1))));
		actions.push({ type: 'remove', id: idAt(rng.int(0, 1)) });
		actions.push(renameAction(idAt(rng.int(0, current().items.length - 1))));
		actions.push({ type: 'remove', id: idAt(current().items.length - 1) });
	} else if (classId === 'noop-actions') {
		// Actions that change nothing: some return the state itself, some build a new one with equal values.
		const missing = firstId + size + rng.int(0, 5);
		const noops: ListAction[] = [
			foreign(),
			{ type: 'filter', value: 'all' },
			{ type: 'remove', id: missing },
			{ type: 'rename', id: idAt(rng.int(0, size - 1)), title: '' }
		];
		const order = rng.shuffle(noops);
		actions.push({ type: 'toggle', id: anyId() });
		for (const a of order) {
			if (a.type === 'rename') {
				const target = current().items.find((t) => t.id === a.id);
				actions.push({ ...a, title: target?.title ?? '' });
			} else actions.push(a);
		}
		actions.splice(rng.int(2, actions.length), 0, { type: 'toggle', id: anyId() });
	} else {
		// store: a listener is notified only when the reducer returns a new state; a snapshot taken before keeps
		// its values.
		actions.push({ type: 'toggle', id: anyId() });
		actions.push(rng.bool() ? foreign() : { type: 'filter', value: 'all' });
		actions.push({ type: 'remove', id: anyId() });
		actions.push(rng.bool() ? newFilter() : renameAction(anyId()));
		actions.push(rng.bool() ? foreign() : { type: 'filter', value: current().filter });
		actions.push({ type: 'toggle', id: anyId() });
	}

	const steps = runList(initial, actions);
	const showAction = (a: ListAction): string => {
		if (a.type === 'toggle' || a.type === 'remove') return `{ type: '${a.type}', id: ${a.id} }`;
		if (a.type === 'rename') return `{ type: 'rename', id: ${a.id}, title: '${a.title}' }`;
		if (a.type === 'filter') return `{ type: 'filter', value: '${a.value}' }`;
		return `{ type: '${a.name}' }`;
	};
	const L = plot.list;
	const F = plot.flag;
	const W = plot.weight;
	const head = [
		'const initial = {',
		"  filter: 'all',",
		`  ${L}: [`,
		...items.map(
			(t, i) =>
				`    { id: ${t.id}, title: '${t.title}', ${F}: ${t.flag}, ${W}: ${t.weight} }${i === items.length - 1 ? '' : ','}`
		),
		'  ],',
		'  stats: { edits: 0 }',
		'};',
		'',
		'function reducer(state, action) {',
		'  switch (action.type) {',
		"    case 'toggle':",
		'      return {',
		'        ...state,',
		`        ${L}: state.${L}.map((t) => (t.id === action.id ? { ...t, ${F}: !t.${F} } : t)),`,
		'        stats: { edits: state.stats.edits + 1 }',
		'      };',
		"    case 'rename':",
		`      return { ...state, ${L}: state.${L}.map((t) => (t.id === action.id ? { ...t, title: action.title } : t)) };`,
		"    case 'remove':",
		`      return { ...state, ${L}: state.${L}.filter((t) => t.id !== action.id) };`,
		"    case 'filter':",
		'      if (state.filter === action.value) return state;',
		'      return { ...state, filter: action.value };',
		'    default:',
		'      return state;',
		'  }',
		'}',
		'',
		`const weight = (s) => s.${L}.filter((t) => t.${F}).reduce((sum, t) => sum + t.${W}, 0);`,
		'',
		'const actions = [',
		...actions.map((a, i) => `  ${showAction(a)}${i === actions.length - 1 ? '' : ','}`),
		'];',
		''
	];
	const b = (x: boolean): string => String(x);

	if (classId === 'store') {
		const lines = [
			...head,
			'function createStore(reducer, state) {',
			'  const listeners = [];',
			'  return {',
			'    getState: () => state,',
			'    subscribe: (fn) => listeners.push(fn),',
			'    dispatch(action) {',
			'      const next = reducer(state, action);',
			'      if (next === state) return;',
			'      state = next;',
			'      listeners.forEach((fn) => fn());',
			'    }',
			'  };',
			'}',
			'',
			'const store = createStore(reducer, initial);',
			'const before = store.getState();',
			'store.subscribe(() => {',
			'  const now = store.getState();',
			`  console.log(now.${L}.length, weight(now), before.${L}.length, weight(before));`,
			'});',
			'for (const action of actions) store.dispatch(action);'
		];
		const line = (now: ListState, then: ListState) =>
			`${now.items.length} ${flagWeight(now)} ${then.items.length} ${flagWeight(then)}`;
		const answer = steps.filter((s) => s.next !== s.prev).map((s) => line(s.next, initial));
		return {
			lines,
			answer,
			wrong: {
				'snapshot-live': steps.filter((s) => s.next !== s.prev).map((s) => line(s.next, s.next)),
				'notify-always': steps.map((s) => line(s.next, initial)),
				'spread-copies-nested': null,
				'equal-means-same': null,
				'always-new-state': null,
				'map-copies-all': null,
				'ignores-shift': null
			}
		};
	}

	const lines = [
		...head,
		'let prev = initial;',
		'for (const action of actions) {',
		'  const next = reducer(prev, action);'
	];
	if (classId === 'slice-refs') {
		lines.push(`  console.log(next === prev, next.${L} === prev.${L}, next.stats === prev.stats, weight(next));`);
		const answer = steps.map(
			(s) =>
				`${b(s.next === s.prev)} ${b(s.next.items === s.prev.items)} ${b(s.next.stats === s.prev.stats)} ${flagWeight(s.next)}`
		);
		// A spread copies the nested arrays and objects too: every slice of a new state is new.
		const deep = steps.map((s) =>
			s.next === s.prev ? `true true true ${flagWeight(s.next)}` : `false false false ${flagWeight(s.next)}`
		);
		lines.push('  prev = next;', '}');
		return {
			lines,
			answer,
			wrong: {
				'spread-copies-nested': deep,
				'snapshot-live': null,
				'notify-always': null,
				'equal-means-same': null,
				'always-new-state': null,
				'map-copies-all': null,
				'ignores-shift': null
			}
		};
	}
	if (classId === 'item-identity') {
		lines.push(
			`  console.log(next.${L} === prev.${L}, next.${L}[0] === prev.${L}[0], next.${L}[1] === prev.${L}[1], weight(next));`
		);
		const at = (s: ListState, i: number): Item | undefined => s.items[i];
		const answer = steps.map(
			(s) =>
				`${b(s.next.items === s.prev.items)} ${b(at(s.next, 0) === at(s.prev, 0))} ${b(at(s.next, 1) === at(s.prev, 1))} ${flagWeight(s.next)}`
		);
		// map builds a new object for every item.
		const copies = steps.map((s) => {
			const mapped = s.action.type === 'toggle' || s.action.type === 'rename';
			const eq = (i: number) => (mapped ? false : at(s.next, i) === at(s.prev, i));
			return `${b(s.next.items === s.prev.items)} ${b(eq(0))} ${b(eq(1))} ${flagWeight(s.next)}`;
		});
		// An item that survived a removal is taken as «the same» at its old position.
		const byId = steps.map((s) => {
			const kept = (i: number) => {
				const item = at(s.next, i);
				return item !== undefined && s.prev.items.includes(item);
			};
			const eq = (i: number) => (s.action.type === 'remove' ? kept(i) : at(s.next, i) === at(s.prev, i));
			return `${b(s.next.items === s.prev.items)} ${b(eq(0))} ${b(eq(1))} ${flagWeight(s.next)}`;
		});
		lines.push('  prev = next;', '}');
		return {
			lines,
			answer,
			wrong: {
				'map-copies-all': copies,
				'ignores-shift': byId,
				'spread-copies-nested': null,
				'snapshot-live': null,
				'notify-always': null,
				'equal-means-same': null,
				'always-new-state': null
			}
		};
	}
	// noop-actions
	lines.push(`  console.log(next === prev, next.${L} === prev.${L}, next.stats.edits, weight(next));`);
	const answer = steps.map(
		(s) => `${b(s.next === s.prev)} ${b(s.next.items === s.prev.items)} ${s.next.stats.edits} ${flagWeight(s.next)}`
	);
	// Equal values are taken for the same object.
	const equal = steps.map(
		(s) =>
			`${b(same(s.next, s.prev))} ${b(same(s.next.items, s.prev.items))} ${s.next.stats.edits} ${flagWeight(s.next)}`
	);
	// Every call of the reducer is taken to build a new state object.
	const fresh = steps.map(
		(s) => `false ${b(s.next.items === s.prev.items)} ${s.next.stats.edits} ${flagWeight(s.next)}`
	);
	lines.push('  prev = next;', '}');
	return {
		lines,
		answer,
		wrong: {
			'equal-means-same': equal,
			'always-new-state': fresh,
			'spread-copies-nested': null,
			'snapshot-live': null,
			'notify-always': null,
			'map-copies-all': null,
			'ignores-shift': null
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------

const differs = (a: readonly string[], b: readonly string[]): boolean =>
	a.length !== b.length || a.some((x, i) => x !== b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draw = () => (input.grade === 'intern' ? internProgram(rng, input.classId) : juniorProgram(rng, input.classId));
	// Every misconception that applies to the class is built to change the output; a draw where one does not (a
	// toggle that lands back on the same weight, say) is drawn again, and the last draw is kept with that misconception
	// marked as not applying to this instance.
	let program = draw();
	for (let tries = 0; tries < 30; tries += 1) {
		if (Object.values(program.wrong).every((w) => w === null || differs(w, program.answer))) break;
		program = draw();
	}
	const source = program.lines.join('\n');
	const toAnswer = (values: readonly string[]) => ({ kind: 'sequence' as const, value: [...values] });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа (Node.js)? Введите вывод построчно, как он появится в консоли: значения в строке — ' +
				'через один пробел, как их печатает `console.log`.',
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
					const values = program.wrong[id] ?? null;
					return [
						id,
						values === null || !differs(values, program.answer)
							? null
							: { kind: 'answer' as const, answer: toAnswer(values) }
					];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
