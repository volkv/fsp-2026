// Recomposition in Jetpack Compose: after one write to a snapshot state, which composable functions of a screen run
// again. A read during composition subscribes the nearest restartable scope; a called child is skipped when all its
// parameters are stable and equal; an unstable parameter (`List`, a class with `var`) makes the child run whenever its
// caller runs; a provider lambda moves the read into the child; reads in `onClick` and in `Modifier.offset { }` are
// not reads of composition; inline containers (`Column`, `Row`, `Box`) have no scope of their own, while the content
// lambda of a non-inline container is a scope of its own; `derivedStateOf` invalidates its reader only when its result
// changes. The answer is computed by the model below and proved by an independent Python program.
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

// The scene of a screen: its state holder, two Int states, one String state, and names for the composables.

interface Theme {
	holder: string;
	screen: string;
	ints: readonly [string, string];
	labels: Readonly<Record<string, string>>;
	str: string;
	strValue: string;
	listValues: readonly string[];
	names: readonly string[];
	button: string;
}

const THEMES: readonly Theme[] = [
	{
		holder: 'CartState',
		screen: 'CartScreen',
		ints: ['count', 'discount'],
		labels: { count: 'Товаров', discount: 'Скидка' },
		str: 'title',
		strValue: 'Корзина',
		listValues: ['Чай', 'Сыр', 'Хлеб'],
		names: [
			'CartHeader',
			'ItemCounter',
			'DiscountBadge',
			'PriceSummary',
			'ProductList',
			'CheckoutBar',
			'PromoBanner',
			'EmptyHint',
			'TotalLabel',
			'DeliveryNote',
			'CouponField',
			'CartFooter'
		],
		button: 'Оформить'
	},
	{
		holder: 'ChatState',
		screen: 'ChatScreen',
		ints: ['unread', 'online'],
		labels: { unread: 'Непрочитанных', online: 'В сети' },
		str: 'topic',
		strValue: 'Команда',
		listValues: ['Привет', 'Готово', 'Ок'],
		names: [
			'ChatHeader',
			'UnreadBadge',
			'MessageList',
			'InputBar',
			'TypingHint',
			'AvatarRow',
			'SendButton',
			'PinnedNote',
			'OnlineDot',
			'ChatFooter',
			'DraftLabel',
			'MembersLine'
		],
		button: 'Отправить'
	},
	{
		holder: 'ProfileState',
		screen: 'ProfileScreen',
		ints: ['followers', 'level'],
		labels: { followers: 'Подписчиков', level: 'Уровень' },
		str: 'nick',
		strValue: 'anna',
		listValues: ['Kotlin', 'Compose', 'Room'],
		names: [
			'ProfileHeader',
			'FollowersCounter',
			'LevelBadge',
			'SkillsList',
			'AvatarImage',
			'EditButton',
			'StatsRow',
			'BioText',
			'ProgressLabel',
			'AwardsStrip',
			'ContactsCard',
			'ProfileFooter'
		],
		button: 'Подписаться'
	},
	{
		holder: 'OrdersState',
		screen: 'OrdersScreen',
		ints: ['pending', 'page'],
		labels: { pending: 'В обработке', page: 'Страница' },
		str: 'filter',
		strValue: 'Все',
		listValues: ['№12', '№15', '№19'],
		names: [
			'OrdersHeader',
			'PendingCounter',
			'PageIndicator',
			'OrderList',
			'FilterChips',
			'RefreshButton',
			'StatusBanner',
			'EmptyState',
			'SummaryLine',
			'SortMenu',
			'HelpLink',
			'OrdersFooter'
		],
		button: 'Обновить'
	},
	{
		holder: 'FeedState',
		screen: 'FeedScreen',
		ints: ['likes', 'offset'],
		labels: { likes: 'Отметок', offset: 'Сдвиг' },
		str: 'section',
		strValue: 'Новое',
		listValues: ['Пост 1', 'Пост 2', 'Пост 3'],
		names: [
			'FeedHeader',
			'LikesCounter',
			'ScrollHint',
			'PostList',
			'StoriesRow',
			'ComposeButton',
			'TrendingBlock',
			'AdSlot',
			'NewPostsLabel',
			'TabsBar',
			'SearchField',
			'FeedFooter'
		],
		button: 'Написать'
	}
];

// The model.

type PType = 'Int' | 'Boolean' | 'String' | 'List<String>' | 'Promo' | '() -> Int' | 'Holder';
interface Param {
	name: string;
	type: PType;
}
/** A read of a state: the value itself, `>= t` on an Int, or the length of the String. */
interface Read {
	prop: string;
	op: 'id' | 'ge' | 'len';
	t: number;
}
type Arg =
	| { k: 'read'; read: Read }
	| { k: 'const'; text: string }
	| { k: 'param'; name: string }
	| { k: 'provider'; prop: string }
	| { k: 'holder' }
	| { k: 'list' }
	| { k: 'promo' }
	| { k: 'derived'; name: string };
type Show =
	| { k: 'read'; read: Read }
	| { k: 'param'; name: string }
	| { k: 'invoke'; name: string }
	| { k: 'derived'; name: string }
	| { k: 'const'; text: string };
/** Where a deferred lambda (`Modifier.offset { }`) takes its value: a state or a provider parameter. */
type Source = { prop: string } | { provider: string };
type Stmt =
	| { k: 'call'; fn: Fn; args: Arg[] }
	| { k: 'text'; show: Show; label: string }
	| { k: 'event'; prop: string }
	| { k: 'deferred'; src: Source; body: Stmt[] }
	| { k: 'inline'; box: 'Column' | 'Row' | 'Box'; body: Stmt[] }
	| { k: 'section'; title: string; body: Stmt[] }
	| { k: 'derivedDecl'; name: string; read: Read };
interface Fn {
	name: string;
	params: Param[];
	body: Stmt[];
}

interface Scenario {
	theme: Theme;
	values: Record<string, number | string>;
	changed: string;
	next: number;
	root: Fn;
	usesPromo: boolean;
	usesSection: boolean;
}

/** The misconceptions; all false is the model of the platform. */
interface Rules {
	allChildren: boolean;
	onlyReaders: boolean;
	unstableSkipped: boolean;
	providerInParent: boolean;
	eventSubscribes: boolean;
	inlineOwnScope: boolean;
	sectionInline: boolean;
	derivedAlways: boolean;
}
const RIGHT: Rules = {
	allChildren: false,
	onlyReaders: false,
	unstableSkipped: false,
	providerInParent: false,
	eventSubscribes: false,
	inlineOwnScope: false,
	sectionInline: false,
	derivedAlways: false
};

function evalRead(read: Read, values: Record<string, number | string>): number | boolean {
	const v = values[read.prop];
	if (typeof v === 'string') return read.op === 'len' ? v.length : v.length * 1000;
	if (v === undefined) throw new Error(`no state ${read.prop}`);
	return read.op === 'ge' ? v >= read.t : v;
}

/** What a parameter is bound to in one call: a value that changed or not, its stability, a provider or the holder. */
interface Bound {
	changed: boolean;
	stable: boolean;
	provider: string | null;
}

const SECTION = 'SectionCard';

function simulate(sc: Scenario, r: Rules): string[] {
	const after = { ...sc.values, [sc.changed]: sc.next };
	const readChanged = (read: Read): boolean => evalRead(read, sc.values) !== evalRead(read, after);
	const executed = new Set<string>();

	/** Derived states of a function body: whether each one's result changes (or is taken as changing). */
	const derivedChanges = (body: Stmt[]): Map<string, boolean> => {
		const map = new Map<string, boolean>();
		const walk = (stmts: Stmt[]): void => {
			for (const s of stmts) {
				if (s.k === 'derivedDecl') map.set(s.name, r.derivedAlways ? s.read.prop === sc.changed : readChanged(s.read));
				if (s.k === 'inline' || s.k === 'section' || s.k === 'deferred') walk(s.body);
			}
		};
		walk(body);
		return map;
	};

	/** Whether the statements of one scope read the changed state during composition. */
	const scopeReads = (stmts: Stmt[], env: Map<string, Bound>, derived: Map<string, boolean>): boolean => {
		const invokes = (name: string): boolean => env.get(name)?.provider === sc.changed;
		for (const s of stmts) {
			switch (s.k) {
				case 'text': {
					const sh = s.show;
					if (sh.k === 'read' && sh.read.prop === sc.changed) return true;
					if (sh.k === 'invoke' && invokes(sh.name)) return true;
					if (sh.k === 'derived' && derived.get(sh.name)) return true;
					break;
				}
				case 'call':
					for (const a of s.args) {
						if (a.k === 'read' && a.read.prop === sc.changed) return true;
						if (a.k === 'provider' && r.providerInParent && a.prop === sc.changed) return true;
						if (a.k === 'derived' && derived.get(a.name)) return true;
					}
					break;
				case 'event':
					if (r.eventSubscribes && s.prop === sc.changed) return true;
					break;
				case 'deferred': {
					const hit = 'prop' in s.src ? s.src.prop === sc.changed : invokes(s.src.provider);
					if (r.eventSubscribes && hit) return true;
					if (!r.inlineOwnScope && scopeReads(s.body, env, derived)) return true;
					break;
				}
				case 'inline':
					if (!r.inlineOwnScope && scopeReads(s.body, env, derived)) return true;
					break;
				case 'section':
					if (r.sectionInline && scopeReads(s.body, env, derived)) return true;
					break;
				case 'derivedDecl':
					break;
			}
		}
		return false;
	};

	const bind = (args: Arg[], env: Map<string, Bound>, derived: Map<string, boolean>): Bound[] =>
		args.map((a): Bound => {
			switch (a.k) {
				case 'read':
					return { changed: readChanged(a.read), stable: true, provider: null };
				case 'const':
				case 'holder':
					return { changed: false, stable: true, provider: null };
				case 'list':
				case 'promo':
					return { changed: false, stable: r.unstableSkipped, provider: null };
				case 'param': {
					const b = env.get(a.name);
					if (!b) throw new Error(`unbound ${a.name}`);
					return b;
				}
				case 'provider':
					return r.providerInParent
						? { changed: a.prop === sc.changed, stable: true, provider: a.prop }
						: { changed: false, stable: true, provider: a.prop };
				case 'derived':
					return { changed: derived.get(a.name) ?? false, stable: true, provider: null };
			}
		});

	const runScope = (stmts: Stmt[], active: boolean, env: Map<string, Bound>, derived: Map<string, boolean>): void => {
		for (const s of stmts) {
			if (s.k === 'call') visit(s.fn, active, bind(s.args, env, derived));
			else if (s.k === 'inline' || s.k === 'deferred') {
				const own = r.inlineOwnScope && scopeReads(s.body, env, derived);
				runScope(s.body, active || own, env, derived);
			} else if (s.k === 'section') {
				// The container itself: a title constant and a remembered content lambda — both equal.
				const sectionRuns = active && r.allChildren;
				if (sectionRuns) executed.add(SECTION);
				const lambda = r.sectionInline ? active : sectionRuns || scopeReads(s.body, env, derived);
				runScope(s.body, lambda, env, derived);
			}
		}
	};

	const visit = (fn: Fn, called: boolean, args: Bound[]): void => {
		const env = new Map<string, Bound>(fn.params.map((p, i) => [p.name, args[i] as Bound]));
		const derived = derivedChanges(fn.body);
		const invalid = scopeReads(fn.body, env, derived);
		const skippable = args.every((a) => a.stable);
		const equal = args.every((a) => !a.changed);
		const runs = invalid || (called && !r.onlyReaders && (r.allChildren || !(skippable && equal)));
		if (runs) executed.add(fn.name);
		runScope(fn.body, runs, env, derived);
	};

	visit(sc.root, false, [{ changed: false, stable: true, provider: null }]);
	return [...executed].sort();
}

// Building the scenarios.

class Names {
	readonly #pool: string[];
	constructor(rng: Rng, theme: Theme) {
		this.#pool = rng.shuffle(theme.names);
	}
	next(): string {
		const name = this.#pool.pop();
		if (!name) throw new Error('out of names');
		return name;
	}
}

const DERIVED_NAMES = ['showBadge', 'isLarge', 'needsHint', 'highlight'];

interface Kit {
	rng: Rng;
	theme: Theme;
	names: Names;
	p: string;
	q: string;
	old: number;
	next: number;
}

/** A threshold for `p >= t` that flips between the old and the new value, or one that does not. */
function threshold(kit: Kit, flips: boolean): number {
	const lo = Math.min(kit.old, kit.next);
	const hi = Math.max(kit.old, kit.next);
	if (flips) return kit.rng.int(lo + 1, hi);
	return kit.rng.bool() || lo < 3 ? hi + kit.rng.int(2, 6) : kit.rng.int(1, lo - 1);
}

const readP = (kit: Kit, op: 'id' | 'ge' = 'id', flips = true): Read => ({
	prop: kit.p,
	op,
	t: op === 'ge' ? threshold(kit, flips) : 0
});

function paramFor(arg: Arg, kit: Kit): Param {
	switch (arg.k) {
		case 'read':
			if (arg.read.op === 'ge') return { name: `${arg.read.prop}Over${arg.read.t}`, type: 'Boolean' };
			if (arg.read.prop === kit.theme.str) return { name: arg.read.prop, type: 'String' };
			return { name: arg.read.prop, type: 'Int' };
		case 'const':
			return { name: 'text', type: 'String' };
		case 'provider':
			return { name: `${arg.prop}Provider`, type: '() -> Int' };
		case 'holder':
			return { name: 'state', type: 'Holder' };
		case 'list':
			return { name: 'items', type: 'List<String>' };
		case 'promo':
			return { name: 'promo', type: 'Promo' };
		case 'derived':
			return { name: arg.name, type: 'Boolean' };
		case 'param':
			throw new Error('a forwarded parameter keeps its declaration');
	}
}

/** Shows a parameter in a `Text`, as a leaf composable would. */
const showParam = (p: Param, kit: Kit): Stmt => {
	switch (p.type) {
		case 'List<String>':
			return { k: 'text', show: { k: 'param', name: p.name }, label: 'each' };
		case '() -> Int':
			return { k: 'text', show: { k: 'invoke', name: p.name }, label: kit.theme.labels[kit.p] ?? 'Значение' };
		default:
			return { k: 'text', show: { k: 'param', name: p.name }, label: 'Значение' };
	}
};

/** A leaf or a child with one grandchild: `name(param)` showing the parameter. */
function child(kit: Kit, arg: Arg, grand: 'none' | 'forward' | 'const' = 'none'): { stmt: Stmt; fn: Fn } {
	const param = paramFor(arg, kit);
	const body: Stmt[] = [showParam(param, kit)];
	if (grand === 'forward') {
		const g: Fn = { name: kit.names.next(), params: [param], body: [showParam(param, kit)] };
		body.push({ k: 'call', fn: g, args: [{ k: 'param', name: param.name }] });
	} else if (grand === 'const') body.push(constChild(kit).stmt);
	const fn: Fn = { name: kit.names.next(), params: [param], body };
	return { stmt: { k: 'call', fn, args: [arg] }, fn };
}

function constChild(kit: Kit): { stmt: Stmt; fn: Fn } {
	const text = kit.rng.pick(['Подробнее', 'Помощь', 'Скоро', 'Новое']);
	const fn: Fn = { name: kit.names.next(), params: [{ name: 'text', type: 'String' }], body: [] };
	fn.body.push({ k: 'text', show: { k: 'param', name: 'text' }, label: 'Значение' });
	return { stmt: { k: 'call', fn, args: [{ k: 'const', text }] }, fn };
}

/** A child getting the holder itself, reading one state in its body (directly or inside a container). */
function holderChild(kit: Kit, prop: string, extra: Stmt[] = [], box: 'Row' | 'Column' | null = null): Stmt {
	const read: Stmt = {
		k: 'text',
		show: { k: 'read', read: { prop, op: 'id', t: 0 } },
		label: kit.theme.labels[prop] ?? 'Значение'
	};
	const inner = [read, ...extra];
	const fn: Fn = {
		name: kit.names.next(),
		params: [{ name: 'state', type: 'Holder' }],
		body: box ? [{ k: 'inline', box, body: inner }] : inner
	};
	return { k: 'call', fn, args: [{ k: 'holder' }] };
}

const textRead = (kit: Kit, prop: string): Stmt => ({
	k: 'text',
	show: { k: 'read', read: { prop, op: 'id', t: 0 } },
	label: kit.theme.labels[prop] ?? 'Заголовок'
});

const strRead = (kit: Kit): Arg => ({ k: 'read', read: { prop: kit.theme.str, op: 'id', t: 0 } });

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const theme = rng.pick(THEMES);
	const [a, b] = rng.shuffle(theme.ints);
	const p = a as string;
	const q = b as string;
	const old = rng.int(2, 14);
	let next = old + rng.pick([-2, -1, 1, 2, 3]);
	if (next < 0) next = old + 1;
	const kit: Kit = { rng, theme, names: new Names(rng, theme), p, q, old, next };
	const values: Record<string, number | string> = { [p]: old, [q]: rng.int(0, 9), [theme.str]: theme.strValue };
	const root: Fn = { name: theme.screen, params: [{ name: 'state', type: 'Holder' }], body: [] };
	const body = root.body;
	const key = `${grade}/${classId}`;

	if (key === 'junior/param-passing') {
		body.push(textRead(kit, p));
		body.push(child(kit, { k: 'read', read: readP(kit) }, rng.pick(['forward', 'const', 'none'])).stmt);
		body.push(child(kit, { k: 'read', read: readP(kit, 'ge', false) }, rng.pick(['forward', 'none'])).stmt);
		body.push(child(kit, strRead(kit)).stmt);
		if (rng.bool()) body.push(child(kit, { k: 'read', read: readP(kit, 'ge', true) }).stmt);
		if (rng.bool()) body.push(constChild(kit).stmt);
		root.body = rng.shuffle(body);
	} else if (key === 'junior/provider') {
		const prov: Arg = { k: 'provider', prop: p };
		const holder = child(kit, prov, rng.bool() ? 'forward' : 'none');
		if (holder.fn.body.length > 1 && rng.bool())
			holder.fn.body[0] = { k: 'text', show: { k: 'const', text: 'Итого' }, label: '' };
		body.push(holder.stmt);
		body.push(child(kit, strRead(kit), rng.pick(['none', 'const'])).stmt);
		body.push(holderChild(kit, q));
		body.push(child(kit, { k: 'list' }, rng.pick(['none', 'const'])).stmt);
		if (rng.bool()) body.push(textRead(kit, q));
		root.body = rng.shuffle(body);
	} else if (key === 'junior/unstable-param') {
		body.push(rng.bool() ? textRead(kit, p) : child(kit, { k: 'read', read: readP(kit) }).stmt);
		body.push(child(kit, { k: 'list' }, 'const').stmt);
		body.push(rng.bool() ? child(kit, { k: 'promo' }).stmt : child(kit, strRead(kit)).stmt);
		body.push(child(kit, { k: 'read', read: { prop: q, op: 'id', t: 0 } }).stmt);
		if (rng.bool()) body.push(child(kit, { k: 'read', read: readP(kit, 'ge', rng.bool()) }).stmt);
		root.body = rng.shuffle(body);
	} else if (key === 'junior/event-read') {
		body.push({ k: 'event', prop: p });
		body.push(textRead(kit, rng.bool() ? q : theme.str));
		const g = child(kit, { k: 'read', read: readP(kit, rng.bool() ? 'id' : 'ge', true) });
		body.push(holderChild(kit, p, [g.stmt]));
		body.push(child(kit, { k: 'list' }).stmt);
		if (rng.bool()) body.push(child(kit, strRead(kit)).stmt);
		root.body = rng.shuffle(body);
	} else if (key === 'middle/inline-container') {
		const inside: Stmt[] = [textRead(kit, p), child(kit, { k: 'read', read: readP(kit) }).stmt];
		inside.push(child(kit, { k: 'read', read: readP(kit, 'ge', false) }).stmt);
		body.push(child(kit, { k: 'list' }, rng.pick(['none', 'const'])).stmt);
		body.push(constChild(kit).stmt);
		body.push({ k: 'inline', box: rng.pick(['Column', 'Row'] as const), body: rng.shuffle(inside) });
		const fProp = rng.bool() ? p : q;
		body.push(holderChild(kit, fProp, [child(kit, { k: 'list' }).stmt], 'Row'));
		root.body = rng.shuffle(body);
	} else if (key === 'middle/donut-hole') {
		const inside: Stmt[] = [
			textRead(kit, p),
			child(kit, { k: 'read', read: readP(kit) }, rng.pick(['none', 'forward'])).stmt
		];
		inside.push(child(kit, { k: 'read', read: readP(kit, 'ge', false) }).stmt);
		if (rng.bool()) inside.push(child(kit, { k: 'list' }).stmt);
		body.push(child(kit, { k: 'list' }, 'const').stmt);
		body.push(textRead(kit, rng.bool() ? q : theme.str));
		body.push({ k: 'section', title: rng.pick(['Сводка', 'Главное', 'Сейчас']), body: rng.shuffle(inside) });
		if (rng.bool()) body.push(child(kit, { k: 'provider', prop: p }).stmt);
		root.body = rng.shuffle(body);
	} else if (key === 'middle/derived-state') {
		const [n1, n2] = rng.sample(DERIVED_NAMES, 2) as [string, string];
		const flip: Fn = {
			name: kit.names.next(),
			params: [{ name: 'state', type: 'Holder' }],
			body: [
				{ k: 'derivedDecl', name: n1, read: readP(kit, 'ge', true) },
				{ k: 'text', show: { k: 'derived', name: n1 }, label: '' },
				child(kit, { k: 'derived', name: n1 }).stmt
			]
		};
		const still: Fn = {
			name: kit.names.next(),
			params: [{ name: 'state', type: 'Holder' }],
			body: [
				{ k: 'derivedDecl', name: n2, read: readP(kit, 'ge', false) },
				{ k: 'text', show: { k: 'derived', name: n2 }, label: '' },
				child(kit, { k: 'list' }).stmt
			]
		};
		if (rng.bool()) still.body.push(child(kit, { k: 'derived', name: n2 }).stmt);
		body.push({ k: 'call', fn: flip, args: [{ k: 'holder' }] });
		body.push({ k: 'call', fn: still, args: [{ k: 'holder' }] });
		if (rng.bool()) body.push(textRead(kit, p));
		else body.push(textRead(kit, q));
		body.push(child(kit, { k: 'list' }).stmt);
		root.body = rng.shuffle(body);
	} else {
		// middle/deferred-read
		body.push({ k: 'deferred', src: { prop: p }, body: [constChild(kit).stmt] });
		body.push(child(kit, { k: 'list' }).stmt);
		const prov = child(kit, { k: 'provider', prop: p });
		const provName = `${p}Provider`;
		prov.fn.body = [
			{ k: 'deferred', src: { provider: provName }, body: [{ k: 'text', show: { k: 'const', text: '•' }, label: '' }] }
		];
		body.push(prov.stmt);
		const inner = rng.bool() ? constChild(kit).stmt : child(kit, { k: 'read', read: { prop: q, op: 'id', t: 0 } }).stmt;
		body.push(holderChild(kit, p, [inner], 'Column'));
		if (rng.bool()) body.push({ k: 'event', prop: p });
		root.body = rng.shuffle(body);
	}
	const usesPromo = JSON.stringify(root).includes('"promo"');
	const usesSection = JSON.stringify(root).includes('"section"');
	return { theme, values, changed: p, next, root, usesPromo, usesSection };
}

// Rendering the code.

function typeText(t: PType, theme: Theme): string {
	return t === 'Holder' ? theme.holder : t;
}

function readText(read: Read): string {
	if (read.op === 'ge') return `state.${read.prop} >= ${read.t}`;
	if (read.op === 'len') return `state.${read.prop}.length`;
	return `state.${read.prop}`;
}

function argText(a: Arg): string {
	switch (a.k) {
		case 'read':
			return readText(a.read);
		case 'const':
			return JSON.stringify(a.text);
		case 'param':
			return a.name;
		case 'provider':
			return `{ state.${a.prop} }`;
		case 'holder':
			return 'state';
		case 'list':
			return 'state.items';
		case 'promo':
			return 'state.promo';
		case 'derived':
			return a.name;
	}
}

function renderStmts(stmts: Stmt[], sc: Scenario, indent: string, params: Param[]): string[] {
	const out: string[] = [];
	const typeOf = (name: string): PType | undefined => params.find((p) => p.name === name)?.type;
	for (const s of stmts) {
		switch (s.k) {
			case 'call': {
				const args = s.args.map((a, i) => `${s.fn.params[i]?.name ?? '?'} = ${argText(a)}`);
				out.push(`${indent}${s.fn.name}(${args.join(', ')})`);
				break;
			}
			case 'text': {
				const sh = s.show;
				if (sh.k === 'const') out.push(`${indent}Text(${JSON.stringify(sh.text)})`);
				else if (sh.k === 'read') out.push(`${indent}Text("${s.label}: \${${readText(sh.read)}}")`);
				else if (sh.k === 'invoke') out.push(`${indent}Text("${s.label}: \${${sh.name}()}")`);
				else if (sh.k === 'derived') out.push(`${indent}Text(if (${sh.name}) "Да" else "Нет")`);
				else {
					const t = typeOf(sh.name);
					if (t === 'List<String>') out.push(`${indent}${sh.name}.forEach { Text(it) }`);
					else if (t === 'Promo') out.push(`${indent}Text(${sh.name}.code)`);
					else if (t === 'Boolean') out.push(`${indent}Text(if (${sh.name}) "Да" else "Нет")`);
					else if (t === 'String') out.push(`${indent}Text(${sh.name})`);
					else out.push(`${indent}Text("${s.label}: $${sh.name}")`);
				}
				break;
			}
			case 'event':
				out.push(
					`${indent}Button(onClick = { Log.d("ui", "${s.prop}=\${state.${s.prop}}") }) { Text("${sc.theme.button}") }`
				);
				break;
			case 'deferred': {
				const v = 'prop' in s.src ? `state.${s.src.prop}` : `${s.src.provider}()`;
				out.push(`${indent}Box(Modifier.offset { IntOffset(${v}, 0) }) {`);
				out.push(...renderStmts(s.body, sc, `${indent}    `, params));
				out.push(`${indent}}`);
				break;
			}
			case 'inline':
				out.push(`${indent}${s.box} {`);
				out.push(...renderStmts(s.body, sc, `${indent}    `, params));
				out.push(`${indent}}`);
				break;
			case 'section':
				out.push(`${indent}${SECTION}(title = ${JSON.stringify(s.title)}) {`);
				out.push(...renderStmts(s.body, sc, `${indent}    `, params));
				out.push(`${indent}}`);
				break;
			case 'derivedDecl':
				out.push(`${indent}val ${s.name} by remember { derivedStateOf { ${readText(s.read)} } }`);
				break;
		}
	}
	return out;
}

function collectFns(fn: Fn, into: Fn[] = []): Fn[] {
	into.push(fn);
	const walk = (stmts: Stmt[]): void => {
		for (const s of stmts) {
			if (s.k === 'call') collectFns(s.fn, into);
			if (s.k === 'inline' || s.k === 'section' || s.k === 'deferred') walk(s.body);
		}
	};
	walk(fn.body);
	return into;
}

function render(sc: Scenario): string {
	const t = sc.theme;
	const [p, q] = t.ints;
	const lines: string[] = [];
	if (sc.usesPromo) lines.push('data class Promo(var code: String)', '');
	lines.push(
		'@Stable',
		`class ${t.holder} {`,
		`    var ${p} by mutableStateOf(${String(sc.values[p])})`,
		`    var ${q} by mutableStateOf(${String(sc.values[q])})`,
		`    var ${t.str} by mutableStateOf(${JSON.stringify(sc.values[t.str])})`,
		`    val items: List<String> = listOf(${t.listValues.map((v) => JSON.stringify(v)).join(', ')})`
	);
	if (sc.usesPromo) lines.push('    val promo = Promo("SALE")');
	lines.push('}');
	if (sc.usesSection) {
		lines.push(
			'',
			'@Composable',
			`fun ${SECTION}(title: String, content: @Composable () -> Unit) {`,
			'    Column {',
			'        Text(title)',
			'        content()',
			'    }',
			'}'
		);
	}
	for (const fn of collectFns(sc.root)) {
		const params = fn.params.map((p) => `${p.name}: ${typeText(p.type, t)}`).join(', ');
		lines.push('', '@Composable', `fun ${fn.name}(${params}) {`, ...renderStmts(fn.body, sc, '    ', fn.params), '}');
	}
	return lines.join('\n');
}

function describe(sc: Scenario): string {
	const t = sc.theme;
	return [
		`Экран на Jetpack Compose (код ниже) уже показан: состояние \`${t.holder}\` создано со значениями из кода, композиция построена.`,
		`Затем выполняется \`state.${sc.changed} = ${sc.next}\`, и проходит одна перекомпоновка.`,
		'',
		'Ответ — по модели Compose, а не по запуску на устройстве. Условия модели:',
		'',
		'- компилятор Compose с выключенным режимом strong skipping (как до Kotlin 2.0.20): вызванная функция пропускается, только если все её параметры стабильных типов и равны прежним по `equals`;',
		`- класс \`${t.holder}\` помечен \`@Stable\`, корневую функцию \`${t.screen}\` никто снаружи заново не вызывает;`,
		'- лямбды в коде захватывают только стабильные значения, компилятор их запоминает: при перекомпоновке это тот же объект, что и прежде.',
		'',
		`Какие функции, объявленные в этом коде, выполнятся заново (их тело выполнится хотя бы раз)? Библиотечные (\`Text\`, \`Column\`, \`Row\`, \`Box\`, \`Button\`) не в счёт.`,
		'Введите имена функций, по одному в строке, в любом порядке; если ни одна не выполнится — `-`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

sc = json.loads(input())
changed = sc["changed"]
before = sc["values"]
after = dict(before)
after[changed] = sc["next"]


def evaluate(read, values):
    v = values[read["prop"]]
    if isinstance(v, str):
        return len(v) if read["op"] == "len" else ("s", v)
    return v >= read["t"] if read["op"] == "ge" else v


# Every function call and every content lambda of a non-inline container becomes a node with a link to the scope that
# runs it; inline containers (Column, Row, Box) belong to the scope around them.
nodes = []


def add(kind, name, parent, args):
    nodes.append({"kind": kind, "name": name, "parent": parent, "args": args, "reads": False})
    return len(nodes) - 1


def value_of(arg, env, derived):
    k = arg["k"]
    if k == "read":
        return ("val", evaluate(arg["read"], before), evaluate(arg["read"], after))
    if k == "param":
        return env[arg["name"]]
    if k == "provider":
        return ("provider", arg["prop"])
    if k in ("list", "promo"):
        return ("unstable",)
    if k == "derived":
        return ("val",) + derived[arg["name"]]
    return ("val", arg.get("text", "holder"), arg.get("text", "holder"))


def scan(stmts, scope, env, derived):
    for s in stmts:
        k = s["k"]
        if k == "derivedDecl":
            derived[s["name"]] = (evaluate(s["read"], before), evaluate(s["read"], after))
    for s in stmts:
        k = s["k"]
        if k == "text":
            sh = s["show"]
            if sh["k"] == "read" and sh["read"]["prop"] == changed:
                nodes[scope]["reads"] = True
            if sh["k"] == "invoke" and env[sh["name"]] == ("provider", changed):
                nodes[scope]["reads"] = True
            if sh["k"] == "derived":
                old, new = derived[sh["name"]]
                if old != new:
                    nodes[scope]["reads"] = True
        elif k == "call":
            vals = [value_of(a, env, derived) for a in s["args"]]
            for a in s["args"]:
                if a["k"] == "read" and a["read"]["prop"] == changed:
                    nodes[scope]["reads"] = True
                if a["k"] == "derived" and derived[a["name"]][0] != derived[a["name"]][1]:
                    nodes[scope]["reads"] = True
            fn = s["fn"]
            me = add("fn", fn["name"], scope, vals)
            scan(fn["body"], me, {p["name"]: v for p, v in zip(fn["params"], vals)}, {})
        elif k in ("inline", "deferred"):
            scan(s["body"], scope, env, derived)
        elif k == "section":
            box = add("section", "SectionCard", scope, [("val", s["title"], s["title"]), ("val", "lambda", "lambda")])
            lam = add("lambda", None, box, None)
            scan(s["body"], lam, env, derived)
        # "event": a read inside onClick happens on a click, not in composition.


root = add("fn", sc["root"]["name"], None, [("val", "holder", "holder")])
scan(sc["root"]["body"], root, {"state": ("val", "holder", "holder")}, {})

memo = {}


def runs(i):
    if i in memo:
        return memo[i]
    n = nodes[i]
    if n["reads"]:
        result = True
    elif n["parent"] is None:
        result = False
    elif n["kind"] == "lambda":
        result = runs(n["parent"])
    else:
        caller_runs = runs(n["parent"])
        stable = all(v[0] != "unstable" for v in n["args"])
        same = all(v[0] != "val" or v[1] == v[2] for v in n["args"])
        result = caller_runs and not (stable and same)
    memo[i] = result
    return result


names = sorted({n["name"] for i, n in enumerate(nodes) if n["kind"] != "lambda" and runs(i)})
print("\\n".join(names) if names else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'all-children': { allChildren: true },
	'only-readers': { onlyReaders: true },
	'unstable-skipped': { unstableSkipped: true },
	'provider-in-parent': { providerInParent: true },
	'event-subscribes': { eventSubscribes: true },
	'inline-own-scope': { inlineOwnScope: true },
	'section-inline': { sectionInline: true },
	'derived-always': { derivedAlways: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/param-passing': ['all-children', 'only-readers'],
	'junior/provider': ['provider-in-parent'],
	'junior/unstable-param': ['unstable-skipped', 'all-children'],
	'junior/event-read': ['event-subscribes'],
	'middle/inline-container': ['inline-own-scope', 'unstable-skipped'],
	'middle/donut-hole': ['section-inline'],
	'middle/derived-state': ['derived-always'],
	'middle/deferred-read': ['event-subscribes', 'all-children']
};

const asSet = (names: string[]): string[] => (names.length ? names : ['-']);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const sc = scenario(rng, input.grade, input.classId);
		const answer = asSet(simulate(sc, RIGHT));
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = asSet(simulate(sc, { ...RIGHT, ...change }));
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc), code: { language: 'kotlin', source: render(sc) } },
			answer: { kind: 'set', value: answer }
		});
		const stdin = JSON.stringify({ changed: sc.changed, next: sc.next, values: sc.values, root: sc.root });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
