// The module graph of a multi-module Gradle project: which modules a module sees when it compiles (`api` against
// `implementation`), which modules recompile after an ABI or a non-ABI change, which modules lie on a dependency cycle,
// and which feature modules see another feature. The question and the shape of the graph are the essential class;
// module names and the exact edges are surface.
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

type Config = 'api' | 'implementation';

interface Edge {
	from: string;
	to: string;
	config: Config;
}

interface Graph {
	modules: string[];
	edges: Edge[];
}

/** What the item asks. */
type Ask =
	| { kind: 'visible'; module: string }
	| { kind: 'recompile'; abi: string[]; nonAbi: string[] }
	| { kind: 'cycle' }
	| { kind: 'features' };

interface Rules {
	/** `implementation` passes its classes on to the consumers of the consumer. */
	implTransitive: boolean;
	/** `api` is read as `implementation`: only direct dependencies are seen. */
	apiAsImpl: boolean;
	/** Past an `api` edge every module below is seen, `implementation` edges included. */
	apiExposesAll: boolean;
	/** The `api` dependencies of a dependency are seen only when the consumer itself declared it with `api`. */
	apiNeedsApiConsumer: boolean;
	/** `api` exposes one level only: the `api` dependencies of an `api` dependency are not seen. */
	apiOneHop: boolean;
	/** A non-ABI change recompiles the direct consumers too. */
	nonAbiPropagates: boolean;
	/** The modules that depend on a cycle are counted as lying on it. */
	cycleIncludesReachers: boolean;
	/** Only `api` edges are thought to make a cycle. */
	cycleApiOnly: boolean;
}

const RIGHT: Rules = {
	implTransitive: false,
	apiAsImpl: false,
	apiExposesAll: false,
	apiNeedsApiConsumer: false,
	apiOneHop: false,
	nonAbiPropagates: false,
	cycleIncludesReachers: false,
	cycleApiOnly: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'impl-transitive': { implTransitive: true },
	'api-as-implementation': { apiAsImpl: true },
	'api-exposes-implementation': { apiExposesAll: true },
	'api-needs-api-consumer': { apiNeedsApiConsumer: true },
	'api-one-hop': { apiOneHop: true },
	'non-abi-propagates': { nonAbiPropagates: true },
	'cycle-includes-reachers': { cycleIncludesReachers: true },
	'cycle-api-only': { cycleApiOnly: true }
};

const FEATURES = [
	'catalog',
	'cart',
	'profile',
	'checkout',
	'search',
	'orders',
	'chat',
	'settings',
	'onboarding',
	'feed'
];
const DATA = ['orders', 'users', 'payments', 'products', 'messages', 'reviews'];
const CORE_MID = ['ui', 'network', 'database', 'analytics', 'auth', 'storage', 'designsystem'];
const CORE_LOW = ['model', 'common'];

const out = (g: Graph, m: string): Edge[] => g.edges.filter((e) => e.from === m);

/** Every module reachable from `from` over the edges that pass `keep`, `from` itself not included unless on a cycle. */
function reachable(g: Graph, from: string, keep: (e: Edge) => boolean = () => true): Set<string> {
	const seen = new Set<string>();
	const stack = out(g, from)
		.filter(keep)
		.map((e) => e.to);
	while (stack.length > 0) {
		const m = stack.pop() as string;
		if (seen.has(m)) continue;
		seen.add(m);
		for (const e of out(g, m)) if (keep(e)) stack.push(e.to);
	}
	return seen;
}

/** The modules whose classes `m` sees when it compiles (`m` itself not included). */
function visible(g: Graph, m: string, rules: Rules): Set<string> {
	if (rules.implTransitive) return reachable(g, m);
	const seen = new Set<string>();
	for (const edge of out(g, m)) {
		seen.add(edge.to);
		if (rules.apiAsImpl) continue;
		if (rules.apiNeedsApiConsumer && edge.config !== 'api') continue;
		for (const next of out(g, edge.to)) {
			if (next.config !== 'api') continue;
			seen.add(next.to);
			if (rules.apiExposesAll) for (const below of reachable(g, next.to)) seen.add(below);
			else if (!rules.apiOneHop) for (const below of reachable(g, next.to, (e) => e.config === 'api')) seen.add(below);
		}
	}
	seen.delete(m);
	return seen;
}

function recompiled(g: Graph, abi: readonly string[], nonAbi: readonly string[], rules: Rules): Set<string> {
	const result = new Set<string>();
	for (const y of nonAbi) {
		result.add(y);
		if (rules.nonAbiPropagates) for (const e of g.edges) if (e.to === y) result.add(e.from);
	}
	for (const x of abi) {
		result.add(x);
		for (const m of g.modules) if (visible(g, m, rules).has(x)) result.add(m);
	}
	return result;
}

/** The modules that lie on at least one cycle. */
function onCycle(g: Graph, rules: Rules): Set<string> {
	const keep = (e: Edge): boolean => !rules.cycleApiOnly || e.config === 'api';
	const cyclic = new Set(g.modules.filter((m) => reachable(g, m, keep).has(m)));
	if (rules.cycleIncludesReachers && cyclic.size > 0) {
		for (const m of g.modules) if ([...reachable(g, m, keep)].some((r) => cyclic.has(r))) cyclic.add(m);
	}
	return cyclic;
}

const isFeature = (m: string): boolean => m.startsWith(':feature:');

function leakingFeatures(g: Graph, rules: Rules): Set<string> {
	return new Set(g.modules.filter((m) => isFeature(m) && [...visible(g, m, rules)].some(isFeature)));
}

function solve(g: Graph, ask: Ask, rules: Rules): string[] {
	const set =
		ask.kind === 'visible'
			? visible(g, ask.module, rules)
			: ask.kind === 'recompile'
				? recompiled(g, ask.abi, ask.nonAbi, rules)
				: ask.kind === 'cycle'
					? onCycle(g, rules)
					: leakingFeatures(g, rules);
	return set.size === 0 ? ['-'] : [...set].sort();
}

const hasCycle = (g: Graph): boolean => g.modules.some((m) => reachable(g, m).has(m));

/**
 * A layered project: the app, feature modules, data modules, core modules and the lowest core modules. Edges go only
 * downwards, so the graph is acyclic; a class adds its own edges afterwards.
 */
function layered(rng: Rng, senior: boolean): { g: Graph; layers: string[][] } {
	const features = rng.sample(FEATURES, senior ? 4 : 3).map((n) => `:feature:${n}`);
	const data = rng.sample(DATA, senior ? 2 : rng.int(1, 2)).map((n) => `:data:${n}`);
	const mid = rng.sample(CORE_MID, senior ? 3 : 2).map((n) => `:core:${n}`);
	const low = (senior ? CORE_LOW : rng.sample(CORE_LOW, 1)).map((n) => `:core:${n}`);
	const layers = [[':app'], features, data, mid, low];
	const edges: Edge[] = [];
	const apiShare = senior ? 0.5 : 0.45;
	const add = (from: string, to: string): void => {
		if (!edges.some((e) => e.from === from && e.to === to))
			edges.push({ from, to, config: rng.bool(apiShare) ? 'api' : 'implementation' });
	};
	for (const f of features) edges.push({ from: ':app', to: f, config: 'implementation' });
	for (const f of features) for (const t of rng.sample([...data, ...mid], rng.int(1, 2))) add(f, t);
	for (const d of data) for (const t of rng.sample([...mid, ...low], rng.int(1, 2))) add(d, t);
	for (const [i, m] of mid.entries()) {
		const below = [...mid.slice(i + 1), ...low];
		for (const t of rng.sample(below, Math.min(below.length, rng.int(senior ? 1 : 0, senior ? 2 : 1)))) add(m, t);
	}
	return { g: { modules: layers.flat(), edges }, layers };
}

interface Scenario {
	g: Graph;
	ask: Ask;
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const senior = grade === 'senior';
	const { g, layers } = layered(rng, senior);
	const [, features = [], data = [], mid = [], low = []] = layers;
	if (classId === 'visibility') return { g, ask: { kind: 'visible', module: rng.pick([':app', ...features]) } };
	if (classId === 'recompile-abi' || classId === 'abi-chains')
		return {
			g,
			ask: { kind: 'recompile', abi: [rng.pick(senior ? [...mid, ...low] : [...data, ...mid, ...low])], nonAbi: [] }
		};
	if (classId === 'mixed-change') {
		const [x, y] = rng.sample([...data, ...mid, ...low], 2) as [string, string];
		return { g, ask: { kind: 'recompile', abi: [x], nonAbi: [y] } };
	}
	if (classId === 'mixed-changes') {
		const [x, z, y] = rng.sample([...data, ...mid, ...low], 3) as [string, string, string];
		return { g, ask: { kind: 'recompile', abi: [x, z], nonAbi: [y] } };
	}
	if (classId === 'cycle') {
		// A lower module starts to depend on a module above it that already reaches it: a cycle of 3+ modules.
		const lower = rng.pick([...mid, ...low]);
		const above = g.modules.filter((m) => m !== ':app' && reachable(g, m).has(lower));
		// Only a module that reaches `lower` through another module: no self-dependency, no cycle of two. Without one the
		// graph stays acyclic and the draw is rejected.
		const candidates = above.filter((m) => !out(g, m).some((e) => e.to === lower));
		if (candidates.length > 0)
			g.edges.push({ from: lower, to: rng.pick(candidates), config: rng.bool(0.5) ? 'api' : 'implementation' });
		if (senior) {
			// A second upward edge that closes no cycle: from a module nothing above it is reached from.
			const from = rng.pick(features);
			const to = rng.pick(features.filter((f) => f !== from));
			if (!reachable(g, to).has(from)) g.edges.push({ from, to, config: 'implementation' });
		}
		return { g, ask: { kind: 'cycle' } };
	}
	// feature-isolation: a shared navigation module that knows feature screens, direct feature edges, and
	// `implementation` chains that hide one feature from another.
	const nav = ':core:navigation';
	g.modules.splice(1 + features.length + data.length, 0, nav);
	for (const f of rng.sample(features, rng.int(1, 2)))
		g.edges.push({ from: f, to: nav, config: rng.bool(0.5) ? 'api' : 'implementation' });
	for (const f of rng.sample(features, rng.int(1, 2)))
		if (!g.edges.some((e) => e.from === f && e.to === nav))
			g.edges.push({ from: nav, to: f, config: rng.bool(0.6) ? 'api' : 'implementation' });
	if (rng.bool(0.6)) {
		const [a, b] = rng.sample(features, 2) as [string, string];
		g.edges.push({ from: a, to: b, config: rng.bool(0.5) ? 'api' : 'implementation' });
	}
	for (const d of data)
		if (rng.bool(0.4))
			g.edges.push({ from: d, to: rng.pick(features), config: rng.bool(0.5) ? 'api' : 'implementation' });
	return { g, ask: { kind: 'features' } };
}

function render(g: Graph): string {
	const blocks = g.modules.map((m) => {
		const deps = out(g, m);
		const body = deps.length
			? deps.map((e) => `    ${e.config}(project("${e.to}"))`)
			: ['    // нет зависимостей от модулей проекта'];
		return [`// ${m.slice(1).replaceAll(':', '/')}/build.gradle.kts`, 'dependencies {', ...body, '}'].join('\n');
	});
	return blocks.join('\n\n');
}

const RECOMPILE_MODEL = [
	'Модель перекомпиляции (упрощённая, но точная для этого задания):',
	'',
	'- **не-ABI-изменение** модуля (тело функции, `private`-член) перекомпилирует только сам модуль;',
	'- **ABI-изменение** модуля (публичная сигнатура) перекомпилирует сам модуль и каждый модуль, у которого он есть в compile classpath, то есть чьи исходники видят его классы при компиляции;',
	'- перекомпиляция потребителя не меняет его собственный ABI: дальше волна не идёт.'
].join('\n');

function describe(s: Scenario): string {
	const intro =
		'Многомодульный Android-проект на Gradle. Конфигурации `api` и `implementation` работают как в плагинах `java-library` и Android library. Файлы сборки модулей приведены под условием (показаны только зависимости между модулями проекта).';
	const listHint =
		'Введите пути модулей так, как они записаны в `project(...)` (например, `:core:ui`), по одному в строке, в любом порядке';
	if (s.ask.kind === 'visible')
		return [
			intro,
			'',
			`Классы каких модулей проекта доступны исходникам модуля \`${s.ask.module}\` при компиляции? Сам \`${s.ask.module}\` не включайте.`,
			'',
			`${listHint}.`
		].join('\n');
	if (s.ask.kind === 'recompile') {
		const what =
			s.ask.nonAbi.length === 0
				? `В модуле \`${s.ask.abi[0]}\` меняют публичную сигнатуру (ABI-изменение).`
				: `В одном коммите ${s.ask.abi.map((x) => `меняют публичную сигнатуру в \`${x}\``).join(' и ')} и ${s.ask.nonAbi.map((y) => `тело приватной функции в \`${y}\``).join(' и ')}.`;
		return [intro, '', RECOMPILE_MODEL, '', `${what} Какие модули перекомпилируются?`, '', `${listHint}.`].join('\n');
	}
	if (s.ask.kind === 'cycle')
		return [
			intro,
			'',
			'Сборка падает с ошибкой циклической зависимости между модулями. Какие модули лежат хотя бы на одном цикле зависимостей?',
			'',
			`${listHint}; если цикла нет — одна строка \`-\`.`
		].join('\n');
	return [
		intro,
		'',
		'Правило архитектуры: модуль фичи (путь начинается с `:feature:`) не должен видеть при компиляции классы другого модуля фичи. Какие модули фич нарушают это правило?',
		'',
		`${listHint}; если нарушителей нет — одна строка \`-\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
mods = p["modules"]
edges = [tuple(e) for e in p["edges"]]
ask = p["ask"]

# Exported classes of a module: itself and everything its api edges export, as a fixed point.
exported = {m: {m} for m in mods}
changed = True
while changed:
    changed = False
    for a, b, cfg in edges:
        if cfg == "api" and not exported[b] <= exported[a]:
            exported[a] |= exported[b]
            changed = True

def classpath(m):
    seen = set()
    for a, b, _ in edges:
        if a == m:
            seen |= exported[b]
    seen.discard(m)
    return seen

if ask["kind"] == "visible":
    result = classpath(ask["module"])
elif ask["kind"] == "recompile":
    result = set(ask["nonAbi"]) | set(ask["abi"])
    for m in mods:
        if classpath(m) & set(ask["abi"]):
            result.add(m)
elif ask["kind"] == "cycle":
    idx = {m: i for i, m in enumerate(mods)}
    n = len(mods)
    reach = [[False] * n for _ in range(n)]
    for a, b, _ in edges:
        reach[idx[a]][idx[b]] = True
    for k in range(n):
        for i in range(n):
            if reach[i][k]:
                for j in range(n):
                    if reach[k][j]:
                        reach[i][j] = True
    result = {m for m in mods if reach[idx[m]][idx[m]]}
else:
    result = {m for m in mods if m.startswith(":feature:") and any(v.startswith(":feature:") for v in classpath(m))}
print("\\n".join(sorted(result)) or "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/visibility': ['impl-transitive', 'api-as-implementation'],
	'middle/recompile-abi': ['impl-transitive', 'api-as-implementation'],
	'middle/mixed-change': ['non-abi-propagates', 'api-as-implementation'],
	'middle/cycle': ['cycle-includes-reachers', 'cycle-api-only'],
	'senior/abi-chains': ['api-one-hop', 'api-needs-api-consumer', 'impl-transitive'],
	'senior/feature-isolation': ['impl-transitive', 'api-as-implementation'],
	'senior/mixed-changes': ['non-abi-propagates', 'api-exposes-implementation'],
	'senior/cycle': ['cycle-includes-reachers', 'cycle-api-only']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Graphs are drawn until the answer is a proper subset and every misconception the class needs changes it.
	for (let tries = 0; tries < 400; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const cyclic = s.ask.kind === 'cycle';
		if (hasCycle(s.g) !== cyclic) continue;
		const answer = solve(s.g, s.ask, RIGHT);
		if (answer[0] === '-' || answer.length >= s.g.modules.length - 1) continue;
		if (s.ask.kind === 'features' && answer.length === s.g.modules.filter(isFeature).length) continue;
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(s.g, s.ask, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: render(s.g) } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					modules: s.g.modules,
					edges: s.g.edges.map((e) => [e.from, e.to, e.config]),
					ask: s.ask
				})
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
