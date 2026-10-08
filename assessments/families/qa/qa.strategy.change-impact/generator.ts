// Change impact analysis for a regression run: which tests to run after some modules changed, given which module
// uses which, the modules each test touches, tests marked `always`, consumer-driven contract tests, dependencies
// through a published API that pass the impact on only when the API changed, and quarantined tests.
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

interface Edge {
	user: number;
	provider: number;
	/** The user reaches the provider only through its published API. */
	api: boolean;
}

interface Test {
	id: string;
	kind: 'unit' | 'integration' | 'e2e' | 'contract';
	/** Modules the test touches; for a contract test — consumer and provider. */
	modules: number[];
	always: boolean;
	quarantined: boolean;
}

interface Params {
	modules: string[];
	edges: Edge[];
	/** Changed modules, and whether the change touched the module's API. */
	changed: { module: number; api: boolean }[];
	tests: Test[];
}

interface Rules {
	directOnly: boolean;
	reverse: boolean;
	forgetAlways: boolean;
	contractTransitive: boolean;
	ignoreStable: boolean;
	keepQuarantined: boolean;
}

const RIGHT: Rules = {
	directOnly: false,
	reverse: false,
	forgetAlways: false,
	contractTransitive: false,
	ignoreStable: false,
	keepQuarantined: false
};

const NAMES = [
	'auth',
	'billing',
	'cart',
	'catalog',
	'search',
	'notify',
	'orders',
	'profile',
	'gateway',
	'reports',
	'pricing',
	'inventory',
	'delivery',
	'reviews'
];

/** Modules the change reaches: the changed ones and, through the rules, their users (or providers, by mistake). */
function affected(p: Params, rules: Rules): Set<number> {
	const out = new Set(p.changed.map((c) => c.module));
	// A module reached by the impact counts as changed without an API change.
	const apiChanged = new Set(p.changed.filter((c) => c.api).map((c) => c.module));
	let frontier = [...out];
	for (let depth = 0; frontier.length > 0; depth += 1) {
		if (rules.directOnly && depth === 1) break;
		const next: number[] = [];
		for (const m of frontier) {
			for (const e of p.edges) {
				const from = rules.reverse ? e.user : e.provider;
				const to = rules.reverse ? e.provider : e.user;
				if (from !== m || out.has(to)) continue;
				if (e.api && !rules.ignoreStable && !apiChanged.has(m)) continue;
				out.add(to);
				next.push(to);
			}
		}
		frontier = next;
	}
	return out;
}

/** The impact crosses at least one API edge, from a module whose API changed: the API rule both passes and blocks. */
function passesChangedApi(p: Params): boolean {
	const hit = affected(p, RIGHT);
	const changed = new Set(p.changed.map((c) => c.module));
	const apiChanged = new Set(p.changed.filter((c) => c.api).map((c) => c.module));
	return p.edges.some((e) => e.api && apiChanged.has(e.provider) && hit.has(e.user) && !changed.has(e.user));
}

function solve(p: Params, rules: Rules): string[] {
	const hit = affected(p, rules);
	const changed = new Set(p.changed.map((c) => c.module));
	const picked = p.tests.filter((t) => {
		if (t.quarantined && !rules.keepQuarantined) return false;
		if (t.always && !rules.forgetAlways) return true;
		if (t.kind === 'contract') return t.modules.some((m) => (rules.contractTransitive ? hit : changed).has(m));
		return t.modules.some((m) => hit.has(m));
	});
	return picked.length ? picked.map((t) => t.id) : ['-'];
}

const key = (lines: readonly string[]): string => [...lines].sort().join(' ');

function scenario(rng: Rng, classId: string): Params {
	const n = rng.int(7, 10);
	const modules = rng.sample(NAMES, n);
	const edges: Edge[] = [];
	// Module k uses one or two modules listed before it: no cycles, chains form naturally.
	for (let k = 1; k < n; k += 1) {
		for (const provider of rng.sample(
			Array.from({ length: k }, (_, i) => i),
			Math.min(k, rng.int(1, 2))
		)) {
			edges.push({ user: k, provider, api: classId === 'stable-api' && rng.bool(0.5) });
		}
	}
	const changed = rng
		.sample(
			Array.from({ length: n - 3 }, (_, i) => i + 1),
			rng.int(1, 2)
		)
		.sort((a, b) => a - b)
		.map((module) => ({ module, api: classId === 'stable-api' ? rng.bool(0.5) : true }));
	const tests: Test[] = [];
	const add = (kind: Test['kind'], ms: number[], always = false): void => {
		tests.push({ id: '', kind, modules: ms, always, quarantined: false });
	};
	for (const m of rng.sample(
		modules.map((_, i) => i),
		rng.int(5, 7)
	))
		add('unit', [m]);
	for (const e of rng.sample(edges, Math.min(edges.length, rng.int(3, 5)))) add('integration', [e.user, e.provider]);
	add('e2e', [], true);
	if (rng.bool(0.4)) add('e2e', [], true);
	if (classId === 'contracts')
		for (const e of rng.sample(edges, Math.min(edges.length, rng.int(3, 4)))) add('contract', [e.user, e.provider]);
	const order = rng.shuffle(tests);
	order.forEach((t, k) => {
		t.id = `T${String(k + 1).padStart(2, '0')}`;
	});
	if (classId === 'quarantine') for (const t of rng.sample(order, rng.int(2, 3))) t.quarantined = true;
	return { modules, edges, changed, tests: order };
}

const KIND: Record<Test['kind'], string> = {
	unit: 'модульный',
	integration: 'интеграционный',
	e2e: 'сквозной',
	contract: 'контрактный'
};

function describe(p: Params, classId: string): string {
	const name = (m: number): string => `\`${p.modules[m] ?? ''}\``;
	const users = p.modules
		.map((_, m) => {
			const uses = p.edges.filter((e) => e.user === m);
			if (uses.length === 0) return null;
			return `- ${name(m)} использует ${uses.map((e) => `${name(e.provider)}${e.api ? ' (только через опубликованный API)' : ''}`).join(', ')}`;
		})
		.filter((x) => x !== null);
	const rows = p.tests.map((t) => {
		const what =
			t.kind === 'contract'
				? `${p.modules[t.modules[0] ?? 0] ?? ''} → ${p.modules[t.modules[1] ?? 0] ?? ''}`
				: t.always
					? 'метка always'
					: t.modules.map((m) => p.modules[m] ?? '').join(', ');
		const cells = [t.id, KIND[t.kind], what];
		if (classId === 'quarantine') cells.push(t.quarantined ? 'карантин' : '');
		return cells;
	});
	const widths = [5, 16, Math.max(...rows.map((r) => (r[2] ?? '').length)) + 2];
	const table = rows.map((r) =>
		r
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join('')
			.trimEnd()
	);
	const changes = p.changed
		.map(
			(c) =>
				`${name(c.module)}${classId === 'stable-api' ? (c.api ? ' (изменён API)' : ' (правка без изменения API)') : ''}`
		)
		.join(', ');
	const out = [
		'Зависимости модулей («A использует B»: A вызывает код B, и изменение B может сломать A):',
		'',
		...users,
		'',
		`В релизе изменены модули: ${changes}.`,
		'',
		'Тесты и модули, которые они затрагивают:',
		'',
		'```',
		...table,
		'```',
		'',
		'Затронут изменённый модуль и каждый модуль, который использует затронутый — напрямую или через цепочку. В регрессию входят модульные, интеграционные и сквозные тесты, затрагивающие хотя бы один затронутый модуль, и все тесты с меткой always.'
	];
	if (classId === 'contracts')
		out.push(
			'',
			'Контрактный тест «потребитель → поставщик» проверяет, что поставщик выполняет ожидания потребителя; он входит в регрессию тогда и только тогда, когда изменён сам потребитель или сам поставщик.'
		);
	if (classId === 'stable-api')
		out.push(
			'',
			'Если A использует B только через опубликованный API, влияние от B переходит на A, только когда у B изменён API. Модуль, затронутый через зависимость, считается изменённым без изменения API.'
		);
	if (classId === 'quarantine')
		out.push('', 'Тесты в карантине нестабильны и в регрессию не входят, даже если затронуты или помечены always.');
	out.push(
		'',
		'Введите номера тестов, входящих в регрессию, по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:',
		'',
		'```',
		'T02',
		'T05',
		'T11',
		'```'
	);
	return out.join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
api_changed = {c["module"] for c in p["changed"] if c["api"]}
hit = {c["module"] for c in p["changed"]}
grown = True
while grown:
    grown = False
    for e in p["edges"]:
        if e["provider"] in hit and e["user"] not in hit:
            if e["api"] and e["provider"] not in api_changed:
                continue
            hit.add(e["user"])
            grown = True
changed = {c["module"] for c in p["changed"]}
run = []
for t in p["tests"]:
    if t["quarantined"]:
        continue
    if t["always"] or (t["kind"] == "contract" and set(t["modules"]) & changed) or (t["kind"] != "contract" and set(t["modules"]) & hit):
        run.append(t["id"])
print("\\n".join(run) or "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'direct-only': { directOnly: true },
	'reverse-direction': { reverse: true },
	'forget-always': { forgetAlways: true },
	'contract-transitive': { contractTransitive: true },
	'ignore-stable-api': { ignoreStable: true },
	'keep-quarantined': { keepQuarantined: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	transitive: ['direct-only', 'reverse-direction', 'forget-always'],
	contracts: ['contract-transitive', 'reverse-direction'],
	'stable-api': ['ignore-stable-api', 'direct-only'],
	quarantine: ['keep-quarantined', 'direct-only']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Graphs are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p = scenario(rng, classId);
		const answer = solve(p, RIGHT);
		// Some tests stay out of the run: the selection is a real choice.
		if (key(answer) === '-' || answer.length > p.tests.length - 2) continue;
		const wrong: Record<string, string[] | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, { ...RIGHT, ...change });
			wrong[id] = key(value) === key(answer) ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((id) => wrong[id] === null)) continue;
		if (classId === 'stable-api' && !passesChangedApi(p)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
