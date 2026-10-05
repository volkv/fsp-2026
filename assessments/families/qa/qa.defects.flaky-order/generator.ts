// An order-dependent flaky test: a matrix of runs in random order — every test's position in every run and which
// tests failed. The tester names the tests that cause the failures. Middle: the mechanism is given (anywhere before,
// right before, within the same module) and one polluter explains every run. Senior: the mechanism is not given —
// one or two polluters, two that are needed together, a polluter with a cleaning test, a missing setup test — and
// exactly one explanation fits all runs. The generator enumerates every hypothesis of the level and keeps only data
// with a single consistent one. The mechanism is the essential class; names and orders are surface.
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

const AREAS = [
	'auth',
	'cart',
	'order',
	'payment',
	'profile',
	'search',
	'report',
	'catalog',
	'invoice',
	'coupon',
	'stock'
];
const ACTIONS = [
	'create',
	'update',
	'delete',
	'list',
	'export',
	'refund',
	'login',
	'cache',
	'retry',
	'notify',
	'merge'
];
const MODULES = ['test_orders.py', 'test_users.py', 'test_billing.py', 'test_catalog.py'];

type Kind = 'precedes' | 'adjacent' | 'module' | 'or' | 'and' | 'cleaner' | 'setup';

interface Hyp {
	kind: Kind;
	/** `cleaner`: [polluter, cleaner]; `setup`: [the preparing test]; otherwise the polluters. */
	tests: string[];
}

interface Run {
	order: string[];
	failed: string[];
}

function fails(h: Hyp, pos: ReadonlyMap<string, number>, v: string, moduleOf: ReadonlyMap<string, string>): boolean {
	const at = (t: string | undefined) => pos.get(t ?? '') ?? -1;
	const pv = at(v);
	const [a, b] = h.tests;
	switch (h.kind) {
		case 'precedes':
			return at(a) < pv;
		case 'adjacent':
			return at(a) === pv - 1;
		case 'module':
			return moduleOf.get(a ?? '') === moduleOf.get(v) && at(a) < pv;
		case 'or':
			return h.tests.some((t) => at(t) < pv);
		case 'and':
			return h.tests.every((t) => at(t) < pv);
		case 'cleaner':
			return at(a) < pv && !(at(a) < at(b) && at(b) < pv);
		case 'setup':
			return !(at(a) < pv);
	}
}

/** A run with the position of every test, for checking many hypotheses against it. */
interface Indexed {
	pos: Map<string, number>;
	failed: ReadonlySet<string>;
}

function consistent(
	h: Hyp,
	runs: readonly Indexed[],
	victims: readonly string[],
	moduleOf: ReadonlyMap<string, string>
) {
	return runs.every((run) => victims.every((v) => fails(h, run.pos, v, moduleOf) === run.failed.has(v)));
}

function hypotheses(level: string, kind: Kind, tests: readonly string[], victims: readonly string[]): Hyp[] {
	const free = tests.filter((t) => !victims.includes(t));
	if (level === 'middle') return free.map((t) => ({ kind, tests: [t] }));
	const out: Hyp[] = [];
	for (const t of free) out.push({ kind: 'or', tests: [t] }, { kind: 'setup', tests: [t] });
	for (let i = 0; i < free.length; i += 1) {
		for (let j = i + 1; j < free.length; j += 1) {
			const pair = [free[i] ?? '', free[j] ?? ''];
			out.push({ kind: 'or', tests: pair }, { kind: 'and', tests: pair });
		}
		for (let j = 0; j < free.length; j += 1)
			if (i !== j) out.push({ kind: 'cleaner', tests: [free[i] ?? '', free[j] ?? ''] });
	}
	return out;
}

function testNames(rng: Rng, count: number): string[] {
	const out = new Set<string>();
	while (out.size < count) out.add(`test_${rng.pick(AREAS)}_${rng.pick(ACTIONS)}`);
	return [...out];
}

const CLASS_KIND: Record<string, Kind> = {
	precedes: 'precedes',
	adjacent: 'adjacent',
	'many-victims': 'precedes',
	'module-reset': 'module',
	'two-polluters': 'or',
	cleaner: 'cleaner',
	'both-needed': 'and',
	'missing-setup': 'setup'
};

interface Scenario {
	tests: string[];
	moduleOf: Map<string, string>;
	truth: Hyp;
	victims: string[];
	runs: Run[];
}

function scenario(rng: Rng, level: string, classId: string): Scenario {
	const kind = CLASS_KIND[classId] ?? 'precedes';
	const middle = level === 'middle';
	const moduleOf = new Map<string, string>();
	let tests: string[];
	if (classId === 'module-reset') {
		const modules = rng.sample(MODULES, 3);
		tests = [];
		for (const m of modules) {
			for (const t of testNames(rng, rng.int(3, 4))) {
				if (tests.includes(t)) continue;
				tests.push(t);
				moduleOf.set(t, m);
			}
		}
	} else tests = testNames(rng, middle ? rng.int(8, 10) : rng.int(10, 12));
	const victimCount = classId === 'adjacent' || classId === 'many-victims' ? rng.int(2, 3) : 1;
	let victims: string[];
	let roles: string[];
	if (classId === 'module-reset') {
		const module = rng.pick([...new Set(moduleOf.values())]);
		const inModule = tests.filter((t) => moduleOf.get(t) === module);
		const shuffled = rng.shuffle(inModule);
		roles = [shuffled[0] ?? ''];
		victims = [shuffled[1] ?? ''];
	} else {
		const picked = rng.sample(
			tests,
			victimCount + (['precedes', 'adjacent', 'module', 'setup'].includes(kind) ? 1 : 2)
		);
		victims = picked.slice(0, victimCount);
		roles = picked.slice(victimCount);
	}
	const truth: Hyp = { kind, tests: roles };
	const runCount = middle ? rng.int(6, 8) : rng.int(8, 10);
	const runs: Run[] = [];
	for (let r = 0; r < runCount; r += 1) {
		let order: string[];
		if (classId === 'module-reset') {
			const modules = rng.shuffle([...new Set(moduleOf.values())]);
			order = modules.flatMap((m) => rng.shuffle(tests.filter((t) => moduleOf.get(t) === m)));
		} else order = rng.shuffle(tests);
		if (classId === 'adjacent' && rng.bool(0.6)) {
			// Put a victim right after the polluter: otherwise it would rarely fail.
			const v = rng.pick(victims);
			order = order.filter((t) => t !== v);
			order.splice(order.indexOf(roles[0] ?? '') + 1, 0, v);
		}
		const pos = new Map(order.map((t, i) => [t, i]));
		runs.push({ order, failed: victims.filter((v) => fails(truth, pos, v, moduleOf)) });
	}
	return { tests, moduleOf, truth, victims, runs };
}

const PYTHON_REFERENCE = `import json
from itertools import combinations, permutations

d = json.loads(input())
runs = d["runs"]
module = d["modules"]
victims = sorted({t for run in runs for t in run["failed"]})
free = [t for t in d["tests"] if t not in victims]


def fails(kind, tests, pos, v):
    if kind == "precedes":
        return pos[tests[0]] < pos[v]
    if kind == "adjacent":
        return pos[tests[0]] == pos[v] - 1
    if kind == "module":
        return module[tests[0]] == module[v] and pos[tests[0]] < pos[v]
    if kind == "or":
        return any(pos[t] < pos[v] for t in tests)
    if kind == "and":
        return all(pos[t] < pos[v] for t in tests)
    if kind == "cleaner":
        p, c = tests
        return pos[p] < pos[v] and not (pos[p] < pos[c] < pos[v])
    if kind == "setup":
        return not pos[tests[0]] < pos[v]


def fits(kind, tests):
    for run in runs:
        pos = {t: i for i, t in enumerate(run["order"])}
        for v in victims:
            if fails(kind, tests, pos, v) != (v in run["failed"]):
                return False
    return True


if d["level"] == "middle":
    candidates = [(d["mechanism"], [t]) for t in free]
else:
    candidates = [(k, [t]) for t in free for k in ("or", "setup")]
    candidates += [(k, list(pair)) for pair in combinations(free, 2) for k in ("or", "and")]
    candidates += [("cleaner", list(pair)) for pair in permutations(free, 2)]
found = [tests for kind, tests in candidates if fits(kind, tests)]
assert len(found) == 1, found
for t in sorted(found[0]):
    print(t)
`;

const MECHANISM: Record<string, string> = {
	precedes:
		'Известно: падения вызывает один тест-загрязнитель (сам он не падает). Тест-жертва падает в прогоне тогда и только тогда, когда загрязнитель выполнился в этом прогоне раньше неё — в любом месте.',
	adjacent:
		'Известно: падения вызывает один тест-загрязнитель (сам он не падает). Он оставляет открытую транзакцию, и её получает только следующий тест: тест-жертва падает тогда и только тогда, когда загрязнитель выполнился **непосредственно перед ней**. Чувствительных тестов несколько.',
	module:
		'Тесты лежат в модулях; модуль выполняется целиком, модули идут по очереди, и перед каждым модулем база создаётся заново. Известно: падения вызывает один тест-загрязнитель (сам он не падает). Тест-жертва падает тогда и только тогда, когда загрязнитель выполнился раньше неё **в том же модуле**.'
};

const SENIOR_MECHANISMS = [
	'один или два загрязнителя: жертва падает, если раньше неё выполнился хотя бы один из них;',
	'два загрязнителя, нужные вместе: жертва падает, только если раньше неё выполнились оба;',
	'загрязнитель и очищающий тест: жертва падает, если загрязнитель выполнился раньше неё и между ними не выполнился очищающий тест;',
	'недостающая подготовка: жертва падает, если раньше неё не выполнился тест, который готовит для неё данные.'
];

function matrix(sc: Scenario, withModules: boolean): string[] {
	const rows = [...sc.tests].sort((a, b) =>
		withModules ? `${sc.moduleOf.get(a)}${a}`.localeCompare(`${sc.moduleOf.get(b)}${b}`) : a.localeCompare(b)
	);
	const label = (t: string) => (withModules ? `${sc.moduleOf.get(t)}::${t}` : t);
	const width = Math.max(...rows.map((t) => label(t).length)) + 2;
	const header = `${'прогон'.padEnd(width)}${sc.runs.map((_, i) => String(i + 1).padStart(5)).join('')}`;
	const lines = rows.map((t) => {
		const cells = sc.runs.map((run) => {
			const p = run.order.indexOf(t) + 1;
			return `${p}${run.failed.includes(t) ? '*' : ' '}`.padStart(5);
		});
		return `${label(t).padEnd(width)}${cells.join('')}`;
	});
	return [header, ...lines];
}

function describe(sc: Scenario, level: string, kind: Kind): string {
	const intro =
		'Набор автотестов запускают в случайном порядке, и он иногда краснеет. Тесты пользуются общим состоянием (база, кэш, глобальные настройки). В таблице — позиция каждого теста в каждом прогоне (1 — выполнился первым); `*` — тест в этом прогоне упал. Других причин падений нет.';
	const body =
		level === 'middle'
			? [MECHANISM[kind] ?? '', '', 'Какой тест — загрязнитель? Введите его имя. Например: `test_cart_merge`.']
			: [
					'Падения вызывает порядок выполнения. Возможные механизмы (у всех упавших тестов он один и тот же):',
					'',
					...SENIOR_MECHANISMS.map((m, i) => `${i + 1}. ${m}`),
					'',
					'Тесты-причины сами не падают. С данными согласуется ровно одно объяснение. Назовите тесты-причины: загрязнителя (или обоих), загрязнителя вместе с очищающим тестом или тест, готовящий данные. Введите имена по одному в строке, в любом порядке. Например:',
					'',
					'```',
					'test_cart_merge',
					'test_auth_login',
					'```'
				];
	return [intro, '', '```', ...matrix(sc, kind === 'module'), '```', '', ...body].join('\n');
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/precedes': ['neighbour'],
	'middle/adjacent': ['victim'],
	'middle/many-victims': ['neighbour'],
	'middle/module-reset': ['neighbour'],
	'senior/two-polluters': ['one-of-two', 'neighbour'],
	'senior/cleaner': ['one-of-two'],
	'senior/both-needed': ['one-of-two'],
	'senior/missing-setup': ['neighbour']
};

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${cls.id}`;
	const kind = CLASS_KIND[cls.id] ?? 'precedes';
	const required = REQUIRED[where] ?? [];
	for (let tries = 0; tries < 600; tries += 1) {
		const sc = scenario(rng, input.grade, cls.id);
		// Every victim fails at least once and passes at least once.
		if (
			sc.victims.some((v) => !sc.runs.some((r) => r.failed.includes(v)) || sc.runs.every((r) => r.failed.includes(v)))
		)
			continue;
		const indexed = sc.runs.map((r) => ({ pos: new Map(r.order.map((t, i) => [t, i])), failed: new Set(r.failed) }));
		const found = hypotheses(input.grade, kind, sc.tests, sc.victims).filter((h) =>
			consistent(h, indexed, sc.victims, sc.moduleOf)
		);
		if (found.length !== 1) continue;
		const answer = [...sc.truth.tests].sort();
		if (JSON.stringify([...(found[0]?.tests ?? [])].sort()) !== JSON.stringify(answer)) continue;
		const firstRed = sc.runs.find((r) => r.failed.length > 0);
		const victim = firstRed
			? [...firstRed.failed].sort((a, b) => firstRed.order.indexOf(a) - firstRed.order.indexOf(b))[0]
			: undefined;
		const before = firstRed && victim ? firstRed.order[firstRed.order.indexOf(victim) - 1] : undefined;
		const earlier =
			sc.truth.kind === 'cleaner'
				? sc.truth.tests[0]
				: firstRed && sc.truth.tests.length === 2
					? [...sc.truth.tests].sort((a, b) => firstRed.order.indexOf(a) - firstRed.order.indexOf(b))[0]
					: undefined;
		const key = JSON.stringify(answer);
		const candidates: Record<string, string[] | null> = {
			victim: victim ? [victim] : null,
			neighbour: before ? [before] : null,
			'one-of-two': earlier && sc.truth.tests.length === 2 ? [earlier] : null
		};
		const wrong = Object.fromEntries(
			Object.entries(candidates).map(([id, v]) => [id, v === null || JSON.stringify([...v].sort()) === key ? null : v])
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc, input.grade, kind), code: null },
			answer: { kind: 'set', value: answer }
		});
		const stdin = JSON.stringify({
			level: input.grade,
			mechanism: kind,
			tests: sc.tests,
			modules: Object.fromEntries(sc.moduleOf),
			runs: sc.runs
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, v]) => [
						id,
						v === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value: [...v].sort() } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no unambiguous runs for ${where} after 600 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
