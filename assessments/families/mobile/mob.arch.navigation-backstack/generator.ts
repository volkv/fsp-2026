// The back stack of Jetpack Navigation: what the stack holds after a series of `navigate` calls with `popUpTo`,
// `inclusive` and `launchSingleTop`, `popBackStack(route, inclusive)`, an explicit deep link with its synthetic stack,
// and bottom navigation with a stack per tab. The kind of operations is the essential class; routes are surface.
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

type Op =
	| { kind: 'navigate'; route: string; popUpTo: string | null; inclusive: boolean; singleTop: boolean }
	| { kind: 'pop' }
	| { kind: 'popTo'; route: string; inclusive: boolean }
	| { kind: 'deepLink'; route: string }
	| { kind: 'tab'; tab: string }
	| { kind: 'back' };

/** A nested graph of the deep-link class: its route, start destination and other destinations. */
interface NestedGraph {
	route: string;
	start: string;
	others: string[];
}

interface Scenario {
	start: string;
	/** Nested graphs under the root graph (deep links); the root graph's start is `start`. */
	graphs: NestedGraph[];
	/** Tabs of the bottom navigation, the first is the start tab; empty without bottom navigation. */
	tabs: string[];
	ops: Op[];
}

interface Rules {
	inclusiveIgnored: boolean;
	bottomOccurrence: boolean;
	singleTopAnywhere: boolean;
	singleTopBeforePopUp: boolean;
	noSaveState: boolean;
	deepLinkTargetOnly: boolean;
	deepLinkKeepsStack: boolean;
}

const RIGHT: Rules = {
	inclusiveIgnored: false,
	bottomOccurrence: false,
	singleTopAnywhere: false,
	singleTopBeforePopUp: false,
	noSaveState: false,
	deepLinkTargetOnly: false,
	deepLinkKeepsStack: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'inclusive-ignored': { inclusiveIgnored: true },
	'popup-bottom-occurrence': { bottomOccurrence: true },
	'singletop-anywhere': { singleTopAnywhere: true },
	'singletop-before-popup': { singleTopBeforePopUp: true },
	'no-save-state': { noSaveState: true },
	'deeplink-target-only': { deepLinkTargetOnly: true },
	'deeplink-keeps-stack': { deepLinkKeepsStack: true }
};

/** The index of the entry `route` pops to: the topmost one (or the bottom one under the misconception); -1 if absent. */
function find(stack: readonly string[], route: string, rules: Rules): number {
	return rules.bottomOccurrence ? stack.indexOf(route) : stack.lastIndexOf(route);
}

/** Pops down to `route`; nothing happens when it is not on the stack. */
function popTo(stack: string[], route: string, inclusive: boolean, rules: Rules): void {
	const at = find(stack, route, rules);
	if (at === -1) return;
	stack.length = inclusive && !rules.inclusiveIgnored ? at : at + 1;
}

function navigate(stack: string[], op: Extract<Op, { kind: 'navigate' }>, rules: Rules): void {
	if (op.singleTop && rules.singleTopAnywhere) {
		if (op.popUpTo !== null) popTo(stack, op.popUpTo, op.inclusive, rules);
		const at = stack.lastIndexOf(op.route);
		if (at !== -1) {
			stack.length = at + 1;
			return;
		}
		stack.push(op.route);
		return;
	}
	const topBefore = stack.at(-1);
	if (op.popUpTo !== null) popTo(stack, op.popUpTo, op.inclusive, rules);
	const top = rules.singleTopBeforePopUp ? topBefore : stack.at(-1);
	if (op.singleTop && top === op.route) {
		// Under the misconception the check saw the old top: the entry is then thought kept or put back.
		if (stack.at(-1) !== op.route) stack.push(op.route);
		return;
	}
	stack.push(op.route);
}

/** The synthetic stack of an explicit deep link: start destinations of the graphs down to the target, then it. */
function synthetic(s: Scenario, route: string): string[] {
	const stack = [s.start];
	const graph = s.graphs.find((g) => g.start === route || g.others.includes(route));
	if (graph) stack.push(graph.start);
	if (stack.at(-1) !== route) stack.push(route);
	return stack;
}

/** The final stack: of the whole NavController, or of the current tab with bottom navigation. */
function run(s: Scenario, rules: Rules): string[] {
	if (s.tabs.length > 0) {
		const stacks = new Map(s.tabs.map((t) => [t, [t]]));
		let current = s.tabs[0] as string;
		for (const op of s.ops) {
			const stack = stacks.get(current) as string[];
			if (op.kind === 'tab') {
				if (op.tab === current) continue;
				if (rules.noSaveState) stacks.set(current, [current]);
				current = op.tab;
			} else if (op.kind === 'back') {
				if (stack.length > 1) stack.pop();
				else current = s.tabs[0] as string;
			} else if (op.kind === 'navigate') navigate(stack, op, rules);
			else throw new Error(`${op.kind} in a tab scenario`);
		}
		return [...(stacks.get(current) as string[])];
	}
	let stack = [s.start];
	for (const op of s.ops) {
		if (op.kind === 'navigate') navigate(stack, op, rules);
		else if (op.kind === 'pop') stack.pop();
		else if (op.kind === 'popTo') popTo(stack, op.route, op.inclusive, rules);
		else if (op.kind === 'deepLink') {
			const link = rules.deepLinkTargetOnly ? [op.route] : synthetic(s, op.route);
			stack = rules.deepLinkKeepsStack ? [...stack, ...link.slice(-1)] : link;
		} else throw new Error(`${op.kind} outside bottom navigation`);
	}
	return stack;
}

const ROUTES = [
	'catalog',
	'product',
	'cart',
	'checkout',
	'payment',
	'receipt',
	'search',
	'results',
	'settings',
	'orders',
	'order',
	'reviews'
];

/** A random `navigate`: to a new or a stacked route, maybe with `popUpTo` to a stacked route and `launchSingleTop`. */
function randomNavigate(rng: Rng, stack: readonly string[], routes: readonly string[]): Op {
	const route = rng.bool(0.35) && stack.length > 1 ? rng.pick(stack.slice(1)) : rng.pick(routes);
	const withPopUp = rng.bool(0.5);
	const popUpTo = withPopUp ? rng.pick(stack) : null;
	return {
		kind: 'navigate',
		route,
		popUpTo,
		inclusive: withPopUp && rng.bool(0.5),
		singleTop: rng.bool(0.5) || route === stack.at(-1)
	};
}

/**
 * The ops of a stack without tabs. Besides random ones each class gets its decisive ops at random places: the classic
 * `navigate(r) { popUpTo(r); launchSingleTop }` and a single-top navigate to a route deep in the stack (`popup-singletop`),
 * or a duplicate of a stacked route that a later `popBackStack(route, inclusive)` pops to (`popback-inclusive`).
 */
function linearOps(rng: Rng, start: string, classId: string): Op[] {
	const routes = rng.sample(ROUTES, 6);
	const ops: Op[] = [];
	let stack = [start];
	const count = rng.int(6, 8);
	const decisive = new Set(rng.sample([2, 3, 4, 5, 6], 2));
	for (let i = 0; i < count; i += 1) {
		let op: Op;
		const roll = rng.next();
		const below = stack.slice(0, -1);
		const top = stack.at(-1) as string;
		const duplicated = stack.filter((r, k) => stack.indexOf(r) !== k);
		if (classId === 'popup-singletop' && decisive.has(i) && below.length > 0) {
			const route = rng.pick(below);
			op = rng.bool(0.6)
				? { kind: 'navigate', route, popUpTo: route, inclusive: false, singleTop: true }
				: { kind: 'navigate', route, popUpTo: null, inclusive: false, singleTop: true };
		} else if (classId === 'popback-inclusive' && decisive.has(i) && duplicated.length > 0) {
			op = { kind: 'popTo', route: rng.pick(duplicated), inclusive: rng.bool(0.6) };
		} else if (classId === 'popback-inclusive' && i < 3 && stack.length > 1) {
			// Early duplicates: a stacked route is opened again on top.
			const route = rng.pick(stack.filter((r) => r !== top).length > 0 ? stack.filter((r) => r !== top) : stack);
			op = { kind: 'navigate', route, popUpTo: null, inclusive: false, singleTop: false };
		} else if (classId === 'popback-inclusive' && roll < 0.3 && stack.length > 2) {
			op = { kind: 'popTo', route: stack[rng.int(1, stack.length - 2)] as string, inclusive: rng.bool(0.6) };
		} else if (roll < 0.12 && stack.length > 1) op = { kind: 'pop' };
		else op = randomNavigate(rng, stack, routes);
		ops.push(op);
		stack = run({ start, graphs: [], tabs: [], ops }, RIGHT);
		if (stack.length === 0) return [];
	}
	return ops;
}

function deepLinkScenario(rng: Rng): Scenario {
	const [shopStart, shopA, shopB, accStart, accA, accB] = rng.sample(ROUTES, 6) as [
		string,
		string,
		string,
		string,
		string,
		string
	];
	const graphs: NestedGraph[] = [
		{ route: 'shop', start: shopStart, others: [shopA, shopB] },
		{ route: 'account', start: accStart, others: [accA, accB] }
	];
	const all = [shopStart, shopA, shopB, accStart, accA, accB];
	const ops: Op[] = [];
	let stack = ['home'];
	for (let i = rng.int(2, 3); i > 0; i -= 1) {
		const op = randomNavigate(rng, stack, all);
		ops.push(op);
		stack = run({ start: 'home', graphs, tabs: [], ops }, RIGHT);
	}
	const target = rng.pick([shopA, shopB, accA, accB]);
	ops.push({ kind: 'deepLink', route: target });
	stack = run({ start: 'home', graphs, tabs: [], ops }, RIGHT);
	for (let i = rng.int(1, 3); i > 0; i -= 1) {
		const op: Op = rng.bool(0.25) ? { kind: 'pop' } : randomNavigate(rng, stack, all);
		ops.push(op);
		stack = run({ start: 'home', graphs, tabs: [], ops }, RIGHT);
		if (stack.length === 0) break;
	}
	return { start: 'home', graphs, tabs: [], ops };
}

/** Tab routes; none of them is a route inside a tab. */
const TABS = ['feed', 'explore', 'profile', 'inbox', 'favorites'];

function tabScenario(rng: Rng): Scenario {
	const tabs = ['home', ...rng.sample(TABS, 2)];
	const routes = rng.sample(ROUTES, 5);
	const ops: Op[] = [];
	const count = rng.int(9, 12);
	for (let i = 0; i < count; i += 1) {
		const stack = run({ start: 'home', graphs: [], tabs, ops }, RIGHT);
		const roll = rng.next();
		if (roll < 0.28) ops.push({ kind: 'tab', tab: rng.pick(tabs) });
		else if (roll < 0.42) ops.push({ kind: 'back' });
		else {
			// Inside a tab: a new or a stacked route, maybe popping up to an entry (the tab root is never popped itself).
			const route = rng.bool(0.35) && stack.length > 1 ? rng.pick(stack.slice(1)) : rng.pick(routes);
			const popUpAt = stack.length > 1 && rng.bool(0.4) ? rng.int(0, stack.length - 1) : -1;
			ops.push({
				kind: 'navigate',
				route,
				popUpTo: popUpAt === -1 ? null : (stack[popUpAt] as string),
				inclusive: popUpAt > 0 && rng.bool(0.4),
				singleTop: rng.bool(0.45)
			});
		}
	}
	return { start: 'home', graphs: [], tabs, ops };
}

/** Whether a scenario presses Back on the root of a tab other than the start one. */
function backAcrossTabs(s: Scenario): boolean {
	return s.ops.some((op, i) => {
		if (op.kind !== 'back') return false;
		const before = { ...s, ops: s.ops.slice(0, i) };
		const after = { ...s, ops: s.ops.slice(0, i + 1) };
		return run(before, RIGHT).length === 1 && run(before, RIGHT)[0] !== s.tabs[0] && run(after, RIGHT)[0] === s.tabs[0];
	});
}

function scenario(rng: Rng, classId: string): Scenario {
	if (classId === 'tabs') return tabScenario(rng);
	if (classId === 'deep-link') return deepLinkScenario(rng);
	const start = rng.pick(['home', 'login', 'onboarding']);
	return { start, graphs: [], tabs: [], ops: linearOps(rng, start, classId) };
}

const q = (route: string): string => `"${route}"`;

function renderOp(op: Op, tabs: boolean): string {
	switch (op.kind) {
		case 'navigate': {
			const options: string[] = [];
			if (op.popUpTo !== null)
				options.push(op.inclusive ? `popUpTo(${q(op.popUpTo)}) { inclusive = true }` : `popUpTo(${q(op.popUpTo)})`);
			if (op.singleTop) options.push('launchSingleTop = true');
			const call = tabs ? 'navigateInTab' : 'navController.navigate';
			return options.length === 0 ? `${call}(${q(op.route)})` : `${call}(${q(op.route)}) { ${options.join('; ')} }`;
		}
		case 'pop':
			return 'navController.popBackStack()';
		case 'popTo':
			return `navController.popBackStack(${q(op.route)}, inclusive = ${op.inclusive})`;
		case 'deepLink':
			return `// пользователь открывает явную ссылку (NavDeepLinkBuilder) на ${q(op.route)}`;
		case 'tab':
			return `selectTab(${q(op.tab)})`;
		case 'back':
			return 'pressBack()';
	}
}

function renderCode(s: Scenario): string {
	const ops = s.ops.map((op) => renderOp(op, s.tabs.length > 0));
	if (s.graphs.length > 0) {
		const graph = [
			`NavHost(navController, startDestination = ${q(s.start)}) {`,
			`    composable(${q(s.start)}) { HomeScreen() }`,
			...s.graphs.flatMap((g) => [
				`    navigation(startDestination = ${q(g.start)}, route = ${q(g.route)}) {`,
				...[g.start, ...g.others].map((r) => `        composable(${q(r)}) { /* … */ }`),
				'    }'
			]),
			'}'
		];
		return [...graph, '', '// приложение открыто, на экране стартовый destination', ...ops].join('\n');
	}
	const first =
		s.tabs.length > 0
			? `// на экране вкладка ${q(s.start)}, её стек: [${s.start}]`
			: `// стартовый destination графа — ${q(s.start)}; стек: [${s.start}]`;
	return [first, ...ops].join('\n');
}

const ANSWER_HINT =
	'Введите итоговый стек снизу вверх: по одному маршруту экрана в строке (записи вложенных графов `navigation` не указывайте), первая строка — нижняя запись стека, последняя — экран, который видит пользователь.';

function describe(s: Scenario): string {
	if (s.tabs.length > 0)
		return [
			`Приложение с нижней навигацией на вкладки ${s.tabs.map((t) => `\`${t}\``).join(', ')} (стартовая — \`${s.tabs[0]}\`); у каждой вкладки свой стек, корень стека — маршрут вкладки. Операции под условием выполняются по порядку. Правила модели (как при переключении вкладок с \`saveState\`/\`restoreState\`, вкладки — вложенные графы):`,
			'',
			'- `selectTab(t)`: стек текущей вкладки сохраняется как есть, на экране — сохранённый стек вкладки `t` (при первом выборе — только её корень); выбор текущей вкладки ничего не меняет;',
			'- `navigateInTab(route) { … }`: обычный `navigate` с теми же параметрами, но только в стеке текущей вкладки;',
			'- `pressBack()`: снимает верхнюю запись стека текущей вкладки; на корне нестартовой вкладки — переход на стартовую вкладку с её сохранённым стеком.',
			'',
			'Остальное — по документированному поведению Navigation (не на устройстве).',
			'',
			`Каков в конце стек текущей вкладки? ${ANSWER_HINT}`
		].join('\n');
	const deep =
		s.graphs.length > 0
			? ' Явная ссылка (deep link через `NavDeepLinkBuilder`) открывает приложение в новой задаче: прежний стек очищается, строится синтетический стек.'
			: '';
	return [
		`Jetpack Navigation (Compose), маршруты — строки. Операции под условием выполняются по порядку.${deep} Считайте по документированному поведению \`NavController\` (не на устройстве).`,
		'',
		`Каков стек \`NavController\` после всех операций? ${ANSWER_HINT}`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())

def nav(st, op):
    if op["popUpTo"] is not None:
        positions = [i for i, r in enumerate(st) if r == op["popUpTo"]]
        if positions:
            keep = positions[-1] + (0 if op["inclusive"] else 1)
            del st[keep:]
    if op["singleTop"] and st and st[-1] == op["route"]:
        return
    st.append(op["route"])

if p["tabs"]:
    tabs = p["tabs"]
    saved = {t: [t] for t in tabs}
    cur = tabs[0]
    for op in p["ops"]:
        k = op["kind"]
        if k == "tab":
            cur = op["tab"]
        elif k == "back":
            if len(saved[cur]) > 1:
                saved[cur].pop()
            else:
                cur = tabs[0]
        else:
            nav(saved[cur], op)
    result = saved[cur]
else:
    owner = {}
    for g in p["graphs"]:
        for r in [g["start"]] + g["others"]:
            owner[r] = g["start"]
    st = [p["start"]]
    for op in p["ops"]:
        k = op["kind"]
        if k == "navigate":
            nav(st, op)
        elif k == "pop":
            st.pop()
        elif k == "popTo":
            positions = [i for i, r in enumerate(st) if r == op["route"]]
            if positions:
                del st[positions[-1] + (0 if op["inclusive"] else 1):]
        elif k == "deepLink":
            target = op["route"]
            st = [p["start"]]
            if target in owner:
                st.append(owner[target])
            if st[-1] != target:
                st.append(target)
    result = st
print("\\n".join(result))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'popup-singletop': ['singletop-before-popup', 'inclusive-ignored', 'singletop-anywhere'],
	tabs: ['no-save-state'],
	'deep-link': ['deeplink-target-only', 'deeplink-keeps-stack'],
	'popback-inclusive': ['popup-bottom-occurrence', 'inclusive-ignored']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	for (let tries = 0; tries < 1000; tries += 1) {
		const s = scenario(rng, input.classId);
		if (s.ops.length === 0) continue;
		const answer = run(s, RIGHT);
		if (answer.length < 2) continue;
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = run(s, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// Tabs: Back crosses to the start tab somewhere, and an option of navigate decides something inside a tab.
		if (
			input.classId === 'tabs' &&
			(!backAcrossTabs(s) ||
				['singletop-anywhere', 'singletop-before-popup', 'inclusive-ignored', 'popup-bottom-occurrence'].every(
					(id) => wrong[id] === null
				))
		)
			continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: renderCode(s) } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
