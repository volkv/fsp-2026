// Re-rendering of a React component tree: after each state update, which components render and in what order. The
// generator builds a tree (props of different stability, memo, context, children passed as a prop, batched updates),
// shows it as JSX and computes the renders by the model the statement spells out; the gate checks the answer with an
// independent Python program over the same tree.
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

// ---------------------------------------------------------------------------------------------------------------
// The model.

type PropKind = 'literal' | 'module' | 'state' | 'inline-object' | 'inline-fn' | 'hook';

interface Prop {
	name: string;
	kind: PropKind;
	/** The state variable (`state`, an `inline-object` built from state) or the hook (`hook`) the value comes from. */
	refs: string[];
	/** The attribute value as written in JSX, braces included. */
	text: string;
}

interface El {
	comp: string;
	props: Prop[];
	/** Elements nested in this one: created by the same owner, passed as `children`. */
	children: El[];
}

interface StateVar {
	name: string;
	setter: string;
	initial: number | string;
}

interface Hook {
	name: string;
	kind: 'useMemo' | 'useCallback';
	deps: string[];
	body: string;
}

interface Comp {
	name: string;
	memo: boolean;
	states: StateVar[];
	hooks: Hook[];
	/** The local name of the context value it reads with useContext, or null. */
	consumes: string | null;
	/** The value of the context provider wrapping everything it renders, or null. */
	provider: Prop | null;
	elements: El[];
	rendersChildren: boolean;
	/** `{children}` goes before its own elements. */
	childrenFirst: boolean;
}

interface Update {
	comp: string;
	variable: string;
	op: 'set' | 'inc';
	value: number | string;
}

interface Model {
	root: string;
	comps: Record<string, Comp>;
	/** The context object and its default value, when the tree has one. */
	context: { name: string; fallback: string } | null;
	constants: { name: string; text: string }[];
	events: Update[][];
}

/** What a misconception changes in the rules. */
interface Rules {
	/** Every component skips a render when its props are shallow-equal, as if it were wrapped in memo. */
	propsCompareWithoutMemo: boolean;
	/** memo compares by content: inline objects, functions and children with the same text are equal. */
	memoDeepCompare: boolean;
	/** Setting the same value renders the component. */
	sameValueRenders: boolean;
	/** Any update renders the tree from the root. */
	renderFromRoot: boolean;
	/** useMemo and useCallback give a new value on every render. */
	hooksNewEachRender: boolean;
	/** useMemo and useCallback never give a new value, whatever the dependencies. */
	hooksForever: boolean;
	/** A context update does not reach a consumer through a memo component that skipped its render. */
	contextBlockedByMemo: boolean;
	/** A provider value written as an object literal is the same while its fields are the same. */
	providerValueDeep: boolean;
	/** A context update renders every component under the provider. */
	contextRendersSubtree: boolean;
	/** Children passed as a prop render whenever the component that places them renders. */
	childrenFollowWrapper: boolean;
	/** Every update of one handler gets its own render pass. */
	batchTwice: boolean;
}

const RIGHT: Rules = {
	propsCompareWithoutMemo: false,
	memoDeepCompare: false,
	sameValueRenders: false,
	renderFromRoot: false,
	hooksNewEachRender: false,
	hooksForever: false,
	contextBlockedByMemo: false,
	providerValueDeep: false,
	contextRendersSubtree: false,
	childrenFollowWrapper: false,
	batchTwice: false
};

interface Fiber {
	comp: string;
	el: El | null;
	owner: string | null;
	parent: string | null;
	/** Fibers between the provider's owner and this one, root side first (only under the provider). */
	underProvider: boolean;
}

/** The fiber tree in pre-order: a component's own elements and the children it was given, in the order it renders them. */
function fibers(model: Model): Fiber[] {
	const out: Fiber[] = [];
	const visit = (comp: string, el: El | null, owner: string | null, parent: string | null, under: boolean) => {
		out.push({ comp, el, owner, parent, underProvider: under });
		const c = model.comps[comp];
		if (!c) throw new Error(`no component ${comp}`);
		const inside = under || c.provider !== null;
		const own = c.elements.map((child) => ({ child, owner: comp }));
		const given = c.rendersChildren ? (el?.children ?? []).map((child) => ({ child, owner: owner ?? comp })) : [];
		const order = c.childrenFirst ? [...given, ...own] : [...own, ...given];
		for (const { child, owner: o } of order) visit(child.comp, child, o, comp, inside);
	};
	visit(model.root, null, null, null, false);
	return out;
}

function simulate(model: Model, rules: Rules): string[] {
	const tree = fibers(model);
	const values = new Map<string, number | string>();
	for (const c of Object.values(model.comps)) for (const s of c.states) values.set(`${c.name}.${s.name}`, s.initial);
	const lines: string[] = [];
	for (const event of model.events) {
		const passes = rules.batchTwice ? event.map((u) => [u]) : [event];
		const rendered: string[] = [];
		for (const pass of passes) {
			const dirty = new Set<string>();
			const changed = new Set<string>();
			for (const u of pass) {
				const key = `${u.comp}.${u.variable}`;
				const old = values.get(key);
				if (old === undefined) throw new Error(`no state ${key}`);
				const next = u.op === 'inc' ? Number(old) + Number(u.value) : u.value;
				if (!Object.is(old, next)) changed.add(key);
				if (!Object.is(old, next) || rules.sameValueRenders) dirty.add(u.comp);
				values.set(key, next);
			}
			if (rules.renderFromRoot && dirty.size > 0) dirty.add(model.root);
			const done = new Set<string>();
			const hookChanged = new Set<string>();
			const skippedMemo = new Set<string>();
			let providerChanged = false;
			const varChanged = (owner: string, refs: readonly string[]) => refs.some((r) => changed.has(`${owner}.${r}`));
			const propChanged = (owner: string, p: Prop): boolean => {
				if (p.kind === 'literal' || p.kind === 'module') return false;
				if (p.kind === 'state') return varChanged(owner, p.refs);
				if (p.kind === 'hook') return p.refs.some((h) => hookChanged.has(`${owner}.${h}`));
				return !rules.memoDeepCompare || varChanged(owner, p.refs);
			};
			for (const f of tree) {
				const c = model.comps[f.comp];
				if (!c) throw new Error(`no component ${f.comp}`);
				const ownerRendered = f.owner !== null && done.has(f.owner);
				const fresh = ownerRendered || (rules.childrenFollowWrapper && f.parent !== null && done.has(f.parent));
				let propsDiffer = false;
				if (fresh && f.el && f.owner) {
					const owner = f.owner;
					propsDiffer =
						f.el.props.some((p) => (ownerRendered ? propChanged(owner, p) : false)) ||
						(f.el.children.length > 0 && ownerRendered && !rules.memoDeepCompare);
				}
				const byParent = fresh && (c.memo || rules.propsCompareWithoutMemo ? propsDiffer : true);
				let byContext = false;
				if (c.consumes !== null && f.underProvider && providerChanged) {
					byContext = !rules.contextBlockedByMemo || !ancestorsSkipped(tree, f, skippedMemo);
				}
				const bySubtree = rules.contextRendersSubtree && f.underProvider && providerChanged;
				const renders = dirty.has(f.comp) || byParent || byContext || bySubtree;
				if (!renders) {
					if (c.memo) skippedMemo.add(f.comp);
					continue;
				}
				done.add(f.comp);
				rendered.push(f.comp);
				for (const h of c.hooks) {
					const differs = rules.hooksForever
						? false
						: rules.hooksNewEachRender || h.deps.some((d) => changed.has(`${c.name}.${d}`));
					if (differs) hookChanged.add(`${c.name}.${h.name}`);
				}
				if (c.provider) {
					const p = c.provider;
					providerChanged =
						p.kind === 'inline-object' && rules.providerValueDeep ? varChanged(c.name, p.refs) : propChanged(c.name, p);
				}
			}
		}
		lines.push(rendered.length > 0 ? rendered.join(' ') : '-');
	}
	return lines;
}

/** Whether a memo component on the way from the provider down to the fiber (itself included) skipped its render. */
function ancestorsSkipped(tree: readonly Fiber[], f: Fiber, skipped: ReadonlySet<string>): boolean {
	const byComp = new Map(tree.map((x) => [x.comp, x]));
	let at: Fiber | undefined = f;
	while (at && at.underProvider) {
		if (skipped.has(at.comp)) return true;
		at = at.parent === null ? undefined : byComp.get(at.parent);
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Building trees.

const COMPONENT_NAMES = [
	'Header',
	'Sidebar',
	'Toolbar',
	'List',
	'Row',
	'Card',
	'Footer',
	'Badge',
	'Avatar',
	'Menu',
	'Panel',
	'Chart',
	'Filters',
	'Search',
	'Counter',
	'Price',
	'Summary',
	'Tabs',
	'Logo',
	'Pager',
	'Feed',
	'Banner',
	'Status',
	'Details',
	'Preview',
	'Legend',
	'Notice',
	'Grid',
	'Tile',
	'Cart'
] as const;
const ROOT_NAMES = ['App', 'Page', 'Shop', 'Dashboard', 'Screen'] as const;
const NUMBER_VARS = ['count', 'page', 'step', 'total', 'limit', 'size'] as const;
const TEXT_VARS: readonly { name: string; values: readonly string[] }[] = [
	{ name: 'tab', values: ['home', 'news', 'help'] },
	{ name: 'mode', values: ['view', 'edit', 'draft'] },
	{ name: 'sort', values: ['date', 'name', 'price'] },
	{ name: 'view', values: ['list', 'grid', 'table'] },
	{ name: 'filter', values: ['all', 'open', 'done'] }
];
const LABELS = ['Каталог', 'Отчёт', 'Заказы', 'Профиль', 'Склад', 'Новости'] as const;

const cap = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;

class Builder {
	readonly rng: Rng;
	readonly names: string[];
	readonly comps: Record<string, Comp> = {};
	readonly constants: { name: string; text: string }[] = [];
	readonly events: Update[][] = [];
	readonly values = new Map<string, number | string>();
	readonly textValues = new Map<string, readonly string[]>();
	context: { name: string; fallback: string } | null = null;
	root = '';

	constructor(rng: Rng) {
		this.rng = rng;
		this.names = rng.shuffle(COMPONENT_NAMES);
	}

	comp(memo: boolean, name?: string): Comp {
		const n = name ?? this.names.pop();
		if (!n) throw new Error('out of component names');
		const c: Comp = {
			name: n,
			memo,
			states: [],
			hooks: [],
			consumes: null,
			provider: null,
			elements: [],
			rendersChildren: false,
			childrenFirst: false
		};
		this.comps[n] = c;
		return c;
	}

	rootComp(): Comp {
		const c = this.comp(false, this.rng.pick(ROOT_NAMES));
		this.root = c.name;
		return c;
	}

	numberState(c: Comp, avoid: readonly string[] = []): StateVar {
		const name = this.rng.pick(NUMBER_VARS.filter((v) => !avoid.includes(v) && !c.states.some((s) => s.name === v)));
		const s: StateVar = { name, setter: `set${cap(name)}`, initial: this.rng.int(0, 5) };
		c.states.push(s);
		this.values.set(`${c.name}.${name}`, s.initial);
		return s;
	}

	textState(c: Comp, avoid: readonly string[] = []): StateVar {
		const v = this.rng.pick(
			TEXT_VARS.filter((t) => !avoid.includes(t.name) && !c.states.some((s) => s.name === t.name))
		);
		const s: StateVar = { name: v.name, setter: `set${cap(v.name)}`, initial: this.rng.pick(v.values) };
		c.states.push(s);
		this.values.set(`${c.name}.${v.name}`, s.initial);
		this.textValues.set(`${c.name}.${v.name}`, v.values);
		return s;
	}

	/** A new value for a state variable, different from its current one. */
	fresh(c: Comp, s: StateVar): Update {
		const key = `${c.name}.${s.name}`;
		const now = this.values.get(key);
		const pool = this.textValues.get(key);
		let value: number | string;
		if (pool) value = this.rng.pick(pool.filter((v) => v !== now));
		else value = Number(now) + this.rng.int(1, 4);
		return { comp: c.name, variable: s.name, op: 'set', value };
	}

	same(c: Comp, s: StateVar): Update {
		const now = this.values.get(`${c.name}.${s.name}`);
		if (now === undefined) throw new Error('no state');
		return { comp: c.name, variable: s.name, op: 'set', value: now };
	}

	inc(c: Comp, s: StateVar): Update {
		return { comp: c.name, variable: s.name, op: 'inc', value: 1 };
	}

	/** Records an event and moves the tracked values. */
	event(...updates: Update[]): void {
		for (const u of updates) {
			const key = `${u.comp}.${u.variable}`;
			const old = this.values.get(key);
			this.values.set(key, u.op === 'inc' ? Number(old) + Number(u.value) : u.value);
		}
		this.events.push(updates);
	}

	literal(): Prop {
		if (this.rng.bool()) {
			const name = this.rng.pick(['title', 'label', 'caption']);
			return { name, kind: 'literal', refs: [], text: `"${this.rng.pick(LABELS)}"` };
		}
		const name = this.rng.pick(['max', 'rows', 'gap']);
		return { name, kind: 'literal', refs: [], text: `{${this.rng.int(2, 9)}}` };
	}

	moduleConst(): Prop {
		const name = this.rng.pick(['items', 'options', 'columns']);
		const constant = this.rng.pick(['ITEMS', 'OPTIONS', 'PRESETS']);
		if (!this.constants.some((c) => c.name === constant)) {
			this.constants.push({ name: constant, text: `[${this.rng.int(1, 9)}, ${this.rng.int(10, 19)}]` });
		}
		return { name, kind: 'module', refs: [], text: `{${constant}}` };
	}

	stateProp(s: StateVar): Prop {
		return { name: s.name, kind: 'state', refs: [s.name], text: `{${s.name}}` };
	}

	inlineObject(): Prop {
		const name = this.rng.pick(['style', 'config', 'layout']);
		return { name, kind: 'inline-object', refs: [], text: `{{ gap: ${this.rng.int(2, 16)} }}` };
	}

	inlineFn(owner: Comp): Prop {
		const name = this.rng.pick(['onClick', 'onOpen', 'onSelect']);
		const s = owner.states[0];
		const body = s
			? typeof s.initial === 'number'
				? `() => ${s.setter}((v) => v + 1)`
				: `() => ${s.setter}('${s.initial}')`
			: `() => console.log('${name}')`;
		return { name, kind: 'inline-fn', refs: [], text: `{${body}}` };
	}

	hook(owner: Comp, kind: 'useMemo' | 'useCallback', deps: StateVar[]): Prop {
		const taken = owner.hooks.map((h) => h.name);
		const name =
			kind === 'useCallback'
				? this.rng.pick(['onSave', 'onReset', 'onPick', 'onMore', 'onClose'].filter((n) => !taken.includes(n)))
				: this.rng.pick(['settings', 'filters', 'meta', 'limits'].filter((n) => !taken.includes(n)));
		const dep = deps[0];
		const body =
			kind === 'useCallback'
				? dep
					? `() => console.log(${dep.name})`
					: `() => console.log('${name}')`
				: dep
					? `() => ({ ${dep.name} })`
					: `() => ({ step: ${this.rng.int(1, 9)} })`;
		owner.hooks.push({ name, kind, deps: deps.map((d) => d.name), body });
		return { name, kind: 'hook', refs: [name], text: `{${name}}` };
	}

	model(): Model {
		return {
			root: this.root,
			comps: this.comps,
			context: this.context,
			constants: this.constants,
			events: this.events
		};
	}
}

const el = (c: Comp, props: Prop[] = [], children: El[] = []): El => ({ comp: c.name, props, children });

/** Distinct prop names within one element. */
function uniqueProps(props: Prop[]): Prop[] {
	const seen = new Set<string>();
	return props.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}

type ClassBuilder = (b: Builder) => void;

const JUNIOR: Record<string, ClassBuilder> = {
	// Memo children of the root with props of different stability; a plain child renders whenever the root does.
	'memo-props': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const a = b.numberState(root);
		const t = b.textState(root);
		const m1 = b.comp(true);
		const m2 = b.comp(true);
		const m3 = b.comp(true);
		const p1 = b.comp(false);
		const q = b.comp(rng.bool());
		p1.elements.push(el(q, q.memo ? [b.literal()] : []));
		if (rng.bool()) {
			const leaf = b.comp(false);
			m1.elements.push(el(leaf));
		}
		root.elements.push(
			...rng.shuffle([
				el(m1, uniqueProps([b.literal(), b.stateProp(a)])),
				el(m2, uniqueProps([b.literal(), b.inlineObject()])),
				el(m3, uniqueProps([b.literal(), b.moduleConst()])),
				el(p1, [b.literal()])
			])
		);
		const steps = rng.shuffle([() => b.fresh(root, a), () => b.fresh(root, t), () => b.fresh(root, rng.pick([a, t]))]);
		for (const s of steps) b.event(s());
	},
	// Updates with the same value next to real ones, in the root and in a child with its own state.
	'same-value': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const x = b.numberState(root);
		const mode = b.textState(root);
		const a = b.comp(false);
		const a1 = b.comp(false);
		a.elements.push(el(a1));
		const memoChild = b.comp(true);
		const c = b.comp(false);
		const y = b.numberState(c, [x.name]);
		const c1 = b.comp(false);
		c.elements.push(el(c1));
		root.elements.push(...rng.shuffle([el(a, [b.stateProp(x)]), el(memoChild, [b.literal()]), el(c, [b.literal()])]));
		const order = rng.shuffle([
			() => b.same(root, rng.pick([x, mode])),
			() => b.same(c, y),
			() => b.fresh(root, mode),
			() => b.inc(c, y)
		]);
		for (const s of order) b.event(s());
		b.event(rng.bool() ? b.inc(root, x) : b.fresh(root, x));
	},
	// State of a component in the middle: only its subtree renders, never its parent or siblings.
	'local-state': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const t = b.textState(root);
		const sibling = b.comp(false);
		const mid = b.comp(false);
		const s = b.numberState(mid);
		const k1 = b.comp(false);
		const k2 = b.comp(true);
		const k3 = b.comp(true);
		if (rng.bool()) k1.elements.push(el(b.comp(false)));
		mid.elements.push(...rng.shuffle([el(k1), el(k2, [b.literal()]), el(k3, [b.stateProp(s)])]));
		root.elements.push(...rng.shuffle([el(sibling, [b.literal()]), el(mid, [b.stateProp(t)])]));
		const order = rng.shuffle([() => b.fresh(mid, s), () => b.inc(mid, s)]);
		b.event(order[0]?.() ?? b.inc(mid, s));
		b.event(b.fresh(root, t));
		b.event(order[1]?.() ?? b.inc(mid, s));
	},
	// useCallback and useMemo with empty dependencies keep memo working; an inline function breaks it.
	'stable-hooks': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const n = b.numberState(root);
		const m = b.textState(root);
		const m1 = b.comp(true);
		const m2 = b.comp(true);
		const m3 = b.comp(true);
		const m4 = b.comp(true);
		root.elements.push(
			...rng.shuffle([
				el(m1, [b.hook(root, 'useCallback', [])]),
				el(m2, uniqueProps([b.literal(), b.inlineFn(root)])),
				el(m3, [b.hook(root, 'useMemo', [])]),
				el(m4, uniqueProps([b.literal(), b.stateProp(m)]))
			])
		);
		const order = rng.shuffle([() => b.fresh(root, n), () => b.fresh(root, m), () => b.inc(root, n)]);
		for (const s of order) b.event(s());
	}
};

const MIDDLE: Record<string, ClassBuilder> = {
	// Callbacks to memo children: inline, useCallback with no dependencies and with a dependency that changes.
	'unstable-callback': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const q = b.textState(root);
		const page = b.numberState(root);
		const list = b.comp(true);
		const row1 = b.comp(false);
		const row2 = b.comp(true);
		list.elements.push(el(row1, [b.inlineFn(list)]), el(row2, uniqueProps([b.literal(), b.inlineFn(list)])));
		const toolbar = b.comp(true);
		const button = b.comp(false);
		toolbar.elements.push(el(button, [b.literal()]));
		const pager = b.comp(true);
		const footer = b.comp(false);
		root.elements.push(
			...rng.shuffle([
				el(list, [b.hook(root, 'useCallback', [q]), b.moduleConst()]),
				el(toolbar, [b.hook(root, 'useCallback', [])]),
				el(pager, uniqueProps([b.stateProp(page), b.inlineFn(root)])),
				el(footer, [b.literal()])
			])
		);
		const order = rng.shuffle([() => b.fresh(root, page), () => b.fresh(root, q), () => b.same(root, q)]);
		for (const s of order) b.event(s());
		b.event(rng.bool() ? b.fresh(root, q) : b.inc(root, page));
	},
	// A context provider over memo components: consumers render on a new value through a memo that skipped.
	'context-bypass': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const theme = b.textState(root);
		const count = b.numberState(root);
		const ctxName = rng.pick(['ThemeContext', 'SettingsContext', 'UiContext']);
		b.context = { name: ctxName, fallback: 'null' };
		const kind = rng.pick(['inline', 'state', 'memo'] as const);
		if (kind === 'inline') {
			root.provider = { name: 'value', kind: 'inline-object', refs: [theme.name], text: `{{ ${theme.name} }}` };
		} else if (kind === 'state') root.provider = b.stateProp(theme);
		else root.provider = { ...b.hook(root, 'useMemo', [theme]), name: 'value' };
		const shell = b.comp(true);
		const panel = b.comp(false);
		const badge = b.comp(false);
		badge.consumes = 'ui';
		panel.elements.push(el(badge));
		shell.elements.push(el(panel, [b.literal()]));
		const side = b.comp(true);
		const avatar = b.comp(true);
		avatar.consumes = 'ui';
		side.elements.push(el(avatar, [b.literal()]));
		const counter = b.comp(false);
		root.elements.push(
			...rng.shuffle([el(shell, [b.literal()]), el(side, [b.literal()]), el(counter, [b.stateProp(count)])])
		);
		const order = rng.shuffle([() => b.fresh(root, count), () => b.fresh(root, theme), () => b.same(root, theme)]);
		for (const s of order) b.event(s());
		b.event(rng.bool() ? b.fresh(root, theme) : b.inc(root, count));
	},
	// Children passed as a prop: the same elements when the wrapper renders by itself, new ones (and a broken memo)
	// when their owner renders.
	'children-prop': (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const n = b.numberState(root);
		const layout = b.comp(false);
		const open = b.textState(layout, [n.name]);
		const head = b.comp(false);
		layout.elements.push(el(head, [b.stateProp(open)]));
		layout.rendersChildren = true;
		layout.childrenFirst = rng.bool();
		const feed = b.comp(false);
		const ad = b.comp(true);
		const frame = b.comp(true);
		frame.rendersChildren = true;
		const widget = b.comp(false);
		const card = b.comp(true);
		root.elements.push(
			...rng.shuffle([
				el(layout, [b.literal()], rng.shuffle([el(feed), el(ad, [b.literal()])])),
				el(frame, [b.literal()], [el(widget)]),
				el(card, [b.literal()])
			])
		);
		const order = rng.shuffle([() => b.fresh(layout, open), () => b.inc(root, n)]);
		for (const s of order) b.event(s());
		b.event(rng.bool() ? b.same(layout, open) : b.same(root, n));
		b.event(b.fresh(layout, open));
	},
	// Updates of two components in one handler: one pass, each component at most once.
	batched: (b) => {
		const rng = b.rng;
		const root = b.rootComp();
		const a = b.numberState(root);
		const mid = b.comp(false);
		const s = b.textState(mid);
		const leaf = b.comp(true);
		const note = b.comp(false);
		mid.elements.push(...rng.shuffle([el(leaf, [b.stateProp(s)]), el(note)]));
		const side = b.comp(true);
		root.elements.push(...rng.shuffle([el(mid, [b.literal()]), el(side, [b.literal()])]));
		b.event(b.fresh(root, a), b.fresh(mid, s));
		const second = rng.shuffle([b.same(root, a), b.fresh(mid, s)]);
		b.event(...second);
		b.event(b.inc(root, a));
		b.event(...rng.shuffle([b.fresh(mid, s), b.inc(root, a)]));
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Showing the tree as JSX.

function jsxValue(v: number | string): string {
	return typeof v === 'number' ? String(v) : `'${v}'`;
}

function showElement(e: El, indent: string): string[] {
	const attrs = e.props.map((p) => ` ${p.name}=${p.text}`).join('');
	if (e.children.length === 0) return [`${indent}<${e.comp}${attrs} />`];
	return [
		`${indent}<${e.comp}${attrs}>`,
		...e.children.flatMap((c) => showElement(c, `${indent}  `)),
		`${indent}</${e.comp}>`
	];
}

function showComponent(model: Model, c: Comp, received: El | null): string[] {
	const params = [...(received?.props.map((p) => p.name) ?? []), ...(c.rendersChildren ? ['children'] : [])];
	const head = `function ${c.name}(${params.length > 0 ? `{ ${params.join(', ')} }` : ''}) {`;
	const body: string[] = [];
	for (const s of c.states) body.push(`  const [${s.name}, ${s.setter}] = useState(${jsxValue(s.initial)});`);
	if (c.consumes !== null && model.context) body.push(`  const ${c.consumes} = useContext(${model.context.name});`);
	for (const h of c.hooks) body.push(`  const ${h.name} = ${h.kind}(${h.body}, [${h.deps.join(', ')}]);`);
	const inner: string[] = [];
	const own = c.elements.flatMap((e) => showElement(e, '      '));
	const kids = c.rendersChildren ? ['      {children}'] : [];
	inner.push(...(c.childrenFirst ? [...kids, ...own] : [...own, ...kids]));
	if (inner.length === 0) {
		const shown = c.consumes ?? received?.props.find((p) => p.kind === 'literal' || p.kind === 'state')?.name;
		body.push(shown ? `  return <div>{String(${shown})}</div>;` : `  return <div>${c.name}</div>;`);
	} else if (c.provider && model.context) {
		body.push(
			'  return (',
			`    <${model.context.name}.Provider value=${c.provider.text}>`,
			...inner,
			`    </${model.context.name}.Provider>`,
			'  );'
		);
	} else {
		body.push('  return (', '    <div>', ...inner, '    </div>', '  );');
	}
	if (!c.memo) return [head, ...body, '}'];
	return [`const ${c.name} = memo(${head}`, ...body, '});'];
}

function showProgram(model: Model): string {
	const tree = fibers(model);
	const uses = new Set<string>(['useState']);
	const comps = tree.map((f) => model.comps[f.comp]).filter((c): c is Comp => c !== undefined);
	if (comps.some((c) => c.memo)) uses.add('memo');
	if (model.context) uses.add('createContext').add('useContext');
	for (const c of comps) for (const h of c.hooks) uses.add(h.kind);
	const lines = [`import { ${[...uses].sort().join(', ')} } from 'react';`, ''];
	if (model.context) lines.push(`const ${model.context.name} = createContext(${model.context.fallback});`);
	for (const k of model.constants) lines.push(`const ${k.name} = ${k.text};`);
	if (model.context || model.constants.length > 0) lines.push('');
	tree.forEach((f, i) => {
		const c = model.comps[f.comp];
		if (!c) return;
		if (i > 0) lines.push('');
		lines.push(...showComponent(model, c, f.el));
	});
	return lines.join('\n');
}

function showUpdate(u: Update, model: Model): string {
	const c = model.comps[u.comp];
	const s = c?.states.find((x) => x.name === u.variable);
	if (!s) throw new Error('no state for an update');
	const call = u.op === 'inc' ? `${s.setter}((v) => v + ${u.value})` : `${s.setter}(${jsxValue(u.value)})`;
	return `\`${call}\` в \`${u.comp}\``;
}

function describe(model: Model): string {
	const usesContext = model.context !== null;
	const usesBatch = model.events.some((e) => e.length > 1);
	const rules = [
		'- рендер — вызов функции компонента; первый рендер уже прошёл, `StrictMode` не используется;',
		'- вызов сеттера со значением, равным текущему по `Object.is`, рендера не вызывает (считаем, что React сразу отбрасывает такое обновление);',
		'- компонент, чьё состояние изменилось, рендерится; при рендере компонента заново создаются все JSX-элементы в его коде, и компонент каждого созданного элемента тоже рендерится — кроме обёрнутого в `memo`, если все его пропсы (включая `children`) равны прежним по `Object.is`;',
		'- элемент, созданный в компоненте, который в этот раз не рендерился (например, переданный как `children`), — тот же объект, что и раньше: из-за него компонент не рендерится;',
		'- `useMemo` и `useCallback` возвращают прежнее значение, пока их зависимости равны прежним по `Object.is`;',
		...(usesContext
			? [
					'- компонент, который читает контекст через `useContext`, рендерится, когда значение ближайшего `Provider` изменилось по `Object.is`, даже если компонент выше пропустил рендер;'
				]
			: []),
		...(usesBatch
			? [
					'- обновления, вызванные в одном обработчике события, React объединяет: один проход рендера, каждый компонент — не больше одного раза;'
				]
			: []),
		'- порядок рендера — порядок обхода дерева: компонент раньше своих потомков, соседние — в порядке, в котором они стоят в разметке.'
	];
	const events = model.events.map((e, i) => {
		const text =
			e.length === 1
				? `вызывается ${showUpdate(e[0] as Update, model)}`
				: `в одном обработчике события вызываются ${e.map((u) => showUpdate(u, model)).join(', затем ')}`;
		return `${i + 1}. ${cap(text)}.`;
	});
	return [
		`Дерево компонентов React; корень — \`${model.root}\` (разметка для краткости упрощена до \`<div>\`).`,
		'',
		'```jsx',
		showProgram(model),
		'```',
		'',
		'После первого рендера по очереди происходят события ниже; каждое начинается, когда рендер после предыдущего закончился.',
		'',
		'Правила модели (так ведёт себя React):',
		...rules,
		'',
		'События:',
		...events,
		'',
		'Для каждого события введите отдельную строку: имена компонентов, которые отрисуются, в порядке рендера через один пробел. Если не отрисуется ни один — введите `-`.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: the same rules, written over the tree as nested JSON with a recursive walk.

const PYTHON_REFERENCE = `import json

model = json.loads(input())
comps = model["comps"]
values = {}
for c in comps.values():
    for s in c["states"]:
        values[(c["name"], s["name"])] = s["initial"]


def walk(name, element, owner, ctx_changed, out, state):
    comp = comps[name]
    owner_rendered = owner is not None and owner in state["rendered"]
    rerender = name in state["dirty"]
    if owner_rendered:
        if not comp["memo"]:
            rerender = True
        else:
            for prop in element["props"]:
                kind = prop["kind"]
                if kind in ("inline-object", "inline-fn"):
                    rerender = True
                elif kind == "state" and any((owner, r) in state["changed"] for r in prop["refs"]):
                    rerender = True
                elif kind == "hook" and any((owner, r) in state["new_hooks"] for r in prop["refs"]):
                    rerender = True
            if element["children"]:
                rerender = True
    if comp["consumes"] is not None and ctx_changed:
        rerender = True
    if rerender:
        state["rendered"].add(name)
        out.append(name)
        for hook in comp["hooks"]:
            if any((name, d) in state["changed"] for d in hook["deps"]):
                state["new_hooks"].add((name, hook["name"]))
    inner_ctx = ctx_changed
    provider = comp["provider"]
    if provider is not None:
        kind = provider["kind"]
        if not rerender:
            inner_ctx = False
        elif kind == "inline-object":
            inner_ctx = True
        elif kind == "state":
            inner_ctx = any((name, r) in state["changed"] for r in provider["refs"])
        elif kind == "hook":
            inner_ctx = any((name, r) in state["new_hooks"] for r in provider["refs"])
    own = [(e, name) for e in comp["elements"]]
    given = [(e, owner) for e in (element["children"] if element is not None else [])] if comp["rendersChildren"] else []
    for child, child_owner in (given + own if comp["childrenFirst"] else own + given):
        walk(child["comp"], child, child_owner, inner_ctx, out, state)


lines = []
for event in model["events"]:
    state = {"dirty": set(), "changed": set(), "rendered": set(), "new_hooks": set()}
    for u in event:
        key = (u["comp"], u["variable"])
        new = values[key] + u["value"] if u["op"] == "inc" else u["value"]
        if new != values[key]:
            state["changed"].add(key)
            state["dirty"].add(u["comp"])
        values[key] = new
    out = []
    walk(model["root"], None, None, False, out, state)
    lines.append(" ".join(out) if out else "-")
print("\\n".join(lines))
`;

// ---------------------------------------------------------------------------------------------------------------

const WRONG: Record<string, Partial<Rules>> = {
	'props-compare-without-memo': { propsCompareWithoutMemo: true },
	'memo-deep-compare': { memoDeepCompare: true },
	'same-value-renders': { sameValueRenders: true },
	'render-from-root': { renderFromRoot: true },
	'hooks-new-each-render': { hooksNewEachRender: true },
	'hooks-ignore-deps': { hooksForever: true },
	'context-blocked-by-memo': { contextBlockedByMemo: true },
	'provider-value-deep': { providerValueDeep: true },
	'context-renders-subtree': { contextRendersSubtree: true },
	'children-follow-wrapper': { childrenFollowWrapper: true },
	'batch-twice': { batchTwice: true }
};

/** The misconceptions every instance of a class exposes by construction. */
const REQUIRED: Record<string, readonly string[]> = {
	'junior/memo-props': ['props-compare-without-memo', 'memo-deep-compare'],
	'junior/same-value': ['same-value-renders', 'props-compare-without-memo'],
	'junior/local-state': ['render-from-root', 'props-compare-without-memo'],
	'junior/stable-hooks': ['memo-deep-compare', 'hooks-new-each-render'],
	'middle/unstable-callback': ['hooks-ignore-deps', 'memo-deep-compare', 'hooks-new-each-render'],
	'middle/context-bypass': ['context-blocked-by-memo', 'context-renders-subtree', 'same-value-renders'],
	'middle/children-prop': ['children-follow-wrapper', 'memo-deep-compare', 'same-value-renders'],
	'middle/batched': ['batch-twice', 'same-value-renders']
};

const differs = (a: readonly string[], b: readonly string[]): boolean =>
	a.length !== b.length || a.some((x, i) => x !== b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const middle = input.grade === 'middle';
	const classBuilder = (middle ? MIDDLE : JUNIOR)[input.classId];
	if (!classBuilder) throw new Error(`${descriptor.key}: no builder for ${input.grade}/${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Every tree of a class exposes the required misconceptions by construction; the draw is repeated only as a
	// safeguard, and the last draw is kept.
	let model: Model;
	let answer: string[];
	let wrong: Record<string, string[] | null>;
	let tries = 0;
	do {
		const b = new Builder(rng);
		classBuilder(b);
		model = b.model();
		answer = simulate(model, RIGHT);
		const right = answer;
		wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(model, { ...RIGHT, ...change });
				return [id, differs(value, right) ? value : null];
			})
		);
		tries += 1;
	} while (tries < 20 && required.some((id) => wrong[id] === null));
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(model), code: null },
		answer: { kind: 'sequence', value: answer }
	});
	const stdin = JSON.stringify(model);
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
