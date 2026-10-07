// Code splitting: which chunks a build makes from a module graph with static imports and dynamic `import()`, and how
// many chunks and kilobytes the browser downloads on each step of a session — the initial chunk, a chunk per set of
// dynamic roots that need a module (shared chunks), modules of the initial chunk never repeated, nested dynamic
// imports, a dynamic import of a module that is already loaded, chunks already loaded never fetched again.
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

interface Mod {
	name: string;
	size: number;
	imports: string[];
	dynamic: string[];
}

type StepKind = 'open' | 'go' | 'click' | 'hover';

interface Step {
	kind: StepKind;
	/** The module the step imports dynamically. */
	target: string;
	/** Which module's code calls `import()` (the router in `main.js`, or a page). */
	from: string;
	/** A route path or a button caption, shown in the statement. */
	label: string;
}

interface Graph {
	mods: Mod[];
	steps: Step[];
}

interface Rules {
	duplicateShared: boolean;
	oneCommonChunk: boolean;
	staticNotDeduped: boolean;
	dynamicTargetChunk: boolean;
	nestedInParent: boolean;
	refetchLoaded: boolean;
}

const RIGHT: Rules = {
	duplicateShared: false,
	oneCommonChunk: false,
	staticNotDeduped: false,
	dynamicTargetChunk: false,
	nestedInParent: false,
	refetchLoaded: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'duplicate-shared': { duplicateShared: true },
	'one-common-chunk': { oneCommonChunk: true },
	'static-not-deduped': { staticNotDeduped: true },
	'dynamic-target-chunk': { dynamicTargetChunk: true },
	'nested-in-parent': { nestedInParent: true },
	'refetch-loaded': { refetchLoaded: true }
};

const REQUIRED: Record<string, string[]> = {
	'shared-chunk': ['duplicate-shared', 'one-common-chunk', 'refetch-loaded'],
	'entry-dedupe': ['static-not-deduped', 'dynamic-target-chunk'],
	'nested-dynamic': ['nested-in-parent', 'duplicate-shared'],
	'prefetch-hover': ['refetch-loaded', 'one-common-chunk']
};

const ENTRY = 'main.js';

// ---------------------------------------------------------------------------------------------------------------
// The model.

interface Chunk {
	roots: Set<string>;
	size: number;
}

function split(graph: Graph, rules: Rules): { entrySize: number; chunks: Chunk[] } {
	const byName = new Map(graph.mods.map((m) => [m.name, m]));
	const isEntryDynamic = (from: string): boolean => from === ENTRY;
	/** Static closure; a misconception folds nested dynamic imports into the static graph. */
	const closure = (start: string): Set<string> => {
		const seen = new Set<string>();
		const stack = [start];
		while (stack.length > 0) {
			const name = stack.pop() ?? '';
			if (seen.has(name)) continue;
			seen.add(name);
			const mod = byName.get(name);
			if (!mod) continue;
			stack.push(...mod.imports);
			if (rules.nestedInParent && !isEntryDynamic(name)) stack.push(...mod.dynamic);
		}
		return seen;
	};
	const entry = closure(ENTRY);
	const roots = new Set<string>();
	for (const mod of graph.mods) {
		if (rules.nestedInParent && !isEntryDynamic(mod.name)) continue;
		for (const target of mod.dynamic) roots.add(target);
	}
	const sizeOf = (names: Iterable<string>): number => {
		let total = 0;
		for (const name of names) total += byName.get(name)?.size ?? 0;
		return total;
	};
	const chunks: Chunk[] = [];
	const membership = new Map<string, Set<string>>();
	for (const root of roots) {
		if (entry.has(root)) {
			if (rules.dynamicTargetChunk) chunks.push({ roots: new Set([root]), size: sizeOf([root]) });
			continue;
		}
		const reach = [...closure(root)].filter((name) => rules.staticNotDeduped || !entry.has(name));
		if (rules.duplicateShared) {
			chunks.push({ roots: new Set([root]), size: sizeOf(reach) });
			continue;
		}
		for (const name of reach) {
			const set = membership.get(name) ?? new Set<string>();
			set.add(root);
			membership.set(name, set);
		}
	}
	const groups = new Map<string, { roots: Set<string>; names: string[] }>();
	for (const [name, set] of membership) {
		const key = rules.oneCommonChunk && set.size > 1 ? '*common*' : [...set].sort().join('|');
		const group = groups.get(key) ?? { roots: new Set<string>(), names: [] };
		for (const root of set) group.roots.add(root);
		group.names.push(name);
		groups.set(key, group);
	}
	for (const group of groups.values()) chunks.push({ roots: group.roots, size: sizeOf(group.names) });
	return { entrySize: sizeOf(entry), chunks };
}

/** `<chunks in the build> <chunks> <KB>` for every step. */
function solve(graph: Graph, rules: Rules): string {
	const { entrySize, chunks } = split(graph, rules);
	const loaded = new Set<Chunk>();
	const out: number[] = [chunks.length + 1];
	for (const step of graph.steps) {
		let count = 0;
		let kb = 0;
		if (step.kind === 'open') {
			count += 1;
			kb += entrySize;
		}
		for (const chunk of chunks) {
			if (!chunk.roots.has(step.target)) continue;
			if (loaded.has(chunk) && !rules.refetchLoaded) continue;
			loaded.add(chunk);
			count += 1;
			kb += chunk.size;
		}
		out.push(count, kb);
	}
	return out.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Graphs.

const ROUTES = [
	['pages/Home.js', '/'],
	['pages/Catalog.js', '/catalog'],
	['pages/Product.js', '/product'],
	['pages/Cart.js', '/cart'],
	['pages/Profile.js', '/profile'],
	['pages/Orders.js', '/orders'],
	['pages/Settings.js', '/settings']
] as const;

const LIBS = [
	'lib/format.js',
	'lib/date.js',
	'lib/validation.js',
	'lib/markdown.js',
	'lib/charts.js',
	'lib/i18n.js',
	'ui/Table.js',
	'ui/Modal.js',
	'ui/Form.js',
	'ui/Gallery.js',
	'ui/Tabs.js',
	'store/cart.js'
] as const;

const WIDGETS = [
	['widgets/Reviews.js', 'Отзывы'],
	['widgets/PriceChart.js', 'История цен'],
	['widgets/MapView.js', 'Показать на карте'],
	['widgets/Editor.js', 'Редактировать']
] as const;

const mod = (name: string, size: number): Mod => ({ name, size, imports: [], dynamic: [] });

function makeGraph(rng: Rng, classId: string): Graph {
	const main = mod(ENTRY, rng.int(8, 30));
	const router = mod('lib/router.js', rng.int(6, 20));
	const session = mod('store/session.js', rng.int(3, 12));
	main.imports.push(router.name, session.name);
	const mods: Mod[] = [main, router, session];
	const routeCount = classId === 'entry-dedupe' ? 3 : rng.int(3, 4);
	const routes = rng.sample(ROUTES, routeCount);
	const pages = routes.map(([name]) => mod(name, rng.int(6, 40)));
	mods.push(...pages);
	main.dynamic.push(...pages.map((p) => p.name));
	const libNames = rng.sample(LIBS, rng.int(5, 7));
	const libs = libNames.map((name) => mod(name, rng.int(3, 90)));
	mods.push(...libs);
	// Each library is used by one to three pages; the first ones are shared on purpose.
	libs.forEach((lib, i) => {
		const users = i < 2 ? 2 : i < 3 ? Math.min(3, pages.length) : rng.int(1, Math.min(3, pages.length));
		for (const page of rng.sample(pages, users)) page.imports.push(lib.name);
	});
	// A library may lean on another one.
	for (let i = 0; i < 2; i += 1) {
		const [a, b] = rng.sample(libs, 2);
		if (a && b && !b.imports.includes(a.name)) a.imports.push(b.name);
	}
	const steps: Step[] = [];
	const routeStep = (kind: StepKind, i: number): Step => {
		const [name, path] = routes[i] ?? ROUTES[0];
		return { kind, target: name, from: ENTRY, label: path };
	};
	if (classId === 'shared-chunk') {
		const order = rng.shuffle(pages.map((_, i) => i));
		steps.push(routeStep('open', order[0] ?? 0), routeStep('go', order[1] ?? 1), routeStep('go', order[2] ?? 2));
		steps.push(routeStep('go', order[rng.int(0, 1)] ?? 0));
		return { mods, steps };
	}
	if (classId === 'entry-dedupe') {
		// The entry imports some libraries the pages use too, and one page imports an entry module dynamically.
		const fromEntry = rng.sample(libs, 2);
		for (const lib of fromEntry) main.imports.push(lib.name);
		const order = rng.shuffle([0, 1, 2]);
		const caller = pages[order[1] ?? 1];
		const target = rng.pick(fromEntry);
		if (caller) caller.dynamic.push(target.name);
		steps.push(routeStep('open', order[0] ?? 0), routeStep('go', order[1] ?? 1));
		if (caller) steps.push({ kind: 'click', target: target.name, from: caller.name, label: 'Подробнее' });
		steps.push(routeStep('go', order[2] ?? 2));
		return { mods, steps };
	}
	if (classId === 'nested-dynamic') {
		const [widgetName, caption] = rng.pick(WIDGETS);
		const widget = mod(widgetName, rng.int(10, 60));
		mods.push(widget);
		const order = rng.shuffle(pages.map((_, i) => i));
		const parent = pages[order[0] ?? 0];
		const other = pages[order[1] ?? 1];
		if (parent && other) {
			parent.dynamic.push(widget.name);
			// The widget shares one library with its page and one with another page.
			const parentLib = parent.imports[0];
			const otherOnly = other.imports.find((name) => !parent.imports.includes(name));
			if (parentLib) widget.imports.push(parentLib);
			if (otherOnly) widget.imports.push(otherOnly);
			const own = mod(rng.pick(['lib/canvas.js', 'lib/geo.js', 'lib/diff.js']), rng.int(5, 70));
			mods.push(own);
			widget.imports.push(own.name);
			steps.push(routeStep('open', order[0] ?? 0));
			steps.push({ kind: 'click', target: widget.name, from: parent.name, label: caption });
			steps.push(routeStep('go', order[1] ?? 1));
			if (pages.length > 2) steps.push(routeStep('go', order[2] ?? 2));
		}
		return { mods, steps };
	}
	// Prefetch on hover: the router calls the same import() early.
	const order = rng.shuffle(pages.map((_, i) => i));
	steps.push(routeStep('open', order[0] ?? 0), routeStep('hover', order[1] ?? 1), routeStep('go', order[2] ?? 2));
	steps.push(routeStep('go', order[1] ?? 1));
	return { mods, steps };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function stepText(step: Step, i: number): string {
	const call = `\`import('./${step.target}')\``;
	switch (step.kind) {
		case 'open':
			return `${i}. Пользователь открывает \`${step.label}\`: загружается начальный чанк, затем роутер вызывает ${call}.`;
		case 'go':
			return `${i}. Переходит на \`${step.label}\`: роутер вызывает ${call}.`;
		case 'hover':
			return `${i}. Наводит курсор на ссылку \`${step.label}\`: роутер заранее вызывает ${call} (предзагрузка), страница не меняется.`;
		case 'click':
			return `${i}. На странице нажимает «${step.label}»: код \`${step.from}\` вызывает ${call}.`;
	}
}

function describe(graph: Graph): string {
	const rows = graph.mods.map(
		(m) =>
			`| \`${m.name}\` | ${m.size} | ${m.imports.map((n) => `\`${n}\``).join(', ') || '—'} | ${m.dynamic.map((n) => `\`${n}\``).join(', ') || '—'} |`
	);
	return [
		'Одностраничное приложение собирается сборщиком. Граф модулей (размеры — после минификации, в КБ):',
		'',
		'| Модуль | КБ | Статический `import` | Динамический `import()` |',
		'|---|---|---|---|',
		...rows,
		'',
		'Сборщик делит код на чанки по таким правилам (это модель, а не настройки конкретного сборщика):',
		'',
		`1. Начальный чанк — точка входа \`${ENTRY}\` и все модули, достижимые из неё по статическим импортам (транзитивно).`,
		'2. Каждый модуль, который где-либо загружается через `import()`, — корень. Каждый модуль вне начального чанка относится к множеству корней, из которых он достижим по статическим импортам (корень достижим сам из себя).',
		'3. Модули вне начального чанка с одинаковым множеством корней образуют один чанк; размер чанка — сумма размеров его модулей.',
		'4. `import()` корня загружает все чанки, в множестве корней которых он есть, кроме уже загруженных. Модуль, который уже загружен, повторно не загружается.',
		'',
		'Сеанс пользователя:',
		'',
		...graph.steps.map((s, i) => stepText(s, i + 1)),
		'',
		`Введите через пробел целые числа: сначала сколько всего чанков создаст сборка (вместе с начальным), затем для каждого шага по порядку — сколько чанков загрузится на этом шаге и сколько это КБ. Для шага, на котором ничего не загружается, — \`0 0\`. Пример для двух шагов: \`6 2 140 1 35\`.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json

g = json.loads(input())
mods = {m["name"]: m for m in g["mods"]}


def reach(start):
    out, todo = set(), [start]
    while todo:
        cur = todo.pop()
        if cur not in out:
            out.add(cur)
            todo.extend(mods[cur]["imports"])
    return out


initial = reach("main.js")
targets = {t for m in g["mods"] for t in m["dynamic"]} - initial
owners = {}
for t in sorted(targets):
    for name in reach(t) - initial:
        owners.setdefault(name, set()).add(t)
chunk_of = {}
for name, roots in owners.items():
    key = frozenset(roots)
    chunk_of.setdefault(key, 0)
    chunk_of[key] += mods[name]["size"]
have = set()
result = [len(chunk_of) + 1]
for step in g["steps"]:
    n = kb = 0
    if step["kind"] == "open":
        n, kb = 1, sum(mods[x]["size"] for x in initial)
    for key, size in chunk_of.items():
        if step["target"] in key and key not in have:
            have.add(key)
            n += 1
            kb += size
    result += [n, kb]
print(" ".join(map(str, result)))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	let chosen: { graph: Graph; answer: string; wrong: Record<string, string | null> } | null = null;
	// Graphs are drawn until every misconception the class is built around changes the answer; the last draw stands
	// if none settles (the probes stay exact either way).
	for (let tries = 0; tries < 300; tries += 1) {
		const graph = makeGraph(rng, input.classId);
		const answer = solve(graph, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(graph, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { graph, answer, wrong };
		if (required.every((id) => wrong[id] !== null)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { graph, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(graph), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(graph) }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
