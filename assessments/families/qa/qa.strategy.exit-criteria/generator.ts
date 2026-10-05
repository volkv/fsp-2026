// Exit criteria of a test cycle and the metrics behind a release decision: which criteria the data of a release
// violates, which violations a product owner's waiver lifts, the defect removal efficiency overall and of the system
// test phase, and flaky against constantly failing tests in nightly runs.
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

const SEVERITIES = ['blocker', 'critical', 'major', 'minor'] as const;
const STATUSES = ['open', 'reopened', 'fixed', 'rejected', 'duplicate'] as const;
type Severity = (typeof SEVERITIES)[number];

type Criterion =
	| { kind: 'pass-rate'; min: number }
	| { kind: 'blockers' }
	| { kind: 'critical'; max: number }
	| { kind: 'major'; max: number }
	| { kind: 'coverage'; min: number }
	| { kind: 'nightly'; min: number; of: number }
	| { kind: 'trend' };

interface Release {
	tests: { planned: number; pass: number; fail: number; blocked: number; notRun: number };
	/** Defects by severity, counts by status in the order of STATUSES. */
	defects: Record<Severity, number[]>;
	requirements: { confirmed: number; total: number };
	greenNights: number;
	nights: number;
	newDefects: [number, number];
}

interface CriteriaParams {
	kind: 'criteria';
	/** Waivers: the decision the draw aims at, so that both decisions occur. */
	aim: 'go' | 'no-go' | null;
	criteria: { id: string; rule: Criterion; waivable: boolean; waived: boolean }[];
	release: Release;
}

interface DreParams {
	kind: 'dre';
	/** By phase: confirmed defects and rejected or duplicate ones. */
	phases: { name: string; valid: number; rejected: number }[];
}

interface FlakyParams {
	kind: 'flaky';
	tests: { name: string; nights: boolean[] }[];
}

type Params = CriteriaParams | DreParams | FlakyParams;

interface Rules {
	strictness: boolean;
	countRejected: boolean;
	ofExecuted: boolean;
	allPhases: boolean;
	waivableAsWaived: boolean;
	anyFailFlaky: boolean;
}

const RIGHT: Rules = {
	strictness: false,
	countRejected: false,
	ofExecuted: false,
	allPhases: false,
	waivableAsWaived: false,
	anyFailFlaky: false
};

function open(r: Release, severity: Severity, rules: Rules): number {
	const [o = 0, re = 0, , rej = 0, dup = 0] = r.defects[severity];
	return o + re + (rules.countRejected ? rej + dup : 0);
}

/** Whether a criterion holds; the misconception swaps strict and non-strict comparisons. */
function holds(c: Criterion, r: Release, rules: Rules): boolean {
	const atLeast = (a: number, b: number): boolean => (rules.strictness ? a > b : a >= b);
	const atMost = (a: number, b: number): boolean => (rules.strictness ? a < b : a <= b);
	switch (c.kind) {
		case 'pass-rate': {
			const base = rules.ofExecuted ? r.tests.pass + r.tests.fail : r.tests.planned;
			return atLeast(100 * r.tests.pass, c.min * base);
		}
		case 'blockers':
			return open(r, 'blocker', rules) === 0;
		case 'critical':
			return atMost(open(r, 'critical', rules), c.max);
		case 'major':
			return atMost(open(r, 'major', rules), c.max);
		case 'coverage':
			return atLeast(100 * r.requirements.confirmed, c.min * r.requirements.total);
		case 'nightly':
			return atLeast(r.greenNights, c.min);
		case 'trend':
			return rules.strictness ? r.newDefects[1] <= r.newDefects[0] : r.newDefects[1] < r.newDefects[0];
	}
}

const list = (xs: readonly string[]): string => (xs.length ? xs.join(' ') : '-');

function solve(p: Params, classId: string, rules: Rules): string {
	if (p.kind === 'dre') {
		const count = (ph: DreParams['phases'][number]): number => ph.valid + (rules.countRejected ? ph.rejected : 0);
		const all = p.phases.reduce((s, ph) => s + count(ph), 0);
		const prod = count(p.phases[p.phases.length - 1] ?? { name: '', valid: 0, rejected: 0 });
		const system = p.phases.findIndex((ph) => ph.name === 'системное');
		const sys = count(p.phases[system] ?? { name: '', valid: 0, rejected: 0 });
		const later = p.phases.slice(system).reduce((s, ph) => s + count(ph), 0);
		const overall = Math.floor((100 * (all - prod)) / all);
		const phase = Math.floor((100 * sys) / (rules.allPhases ? all : later));
		return `${overall} ${phase}`;
	}
	if (p.kind === 'flaky') {
		const flaky = p.tests.filter((t) =>
			rules.anyFailFlaky ? t.nights.some((x) => !x) : t.nights.some((x) => !x) && t.nights.some((x) => x)
		);
		const broken = p.tests.filter((t) => t.nights.every((x) => !x));
		const failures = flaky.reduce((s, t) => s + t.nights.filter((x) => !x).length, 0);
		return `${list(flaky.map((t) => t.name))} | ${list(broken.map((t) => t.name))} | ${failures}`;
	}
	const violated = p.criteria.filter((c) => !holds(c.rule, p.release, rules));
	if (classId === 'violated') return list(violated.map((c) => c.id));
	const lifted = (c: CriteriaParams['criteria'][number]): boolean => c.waivable && (c.waived || rules.waivableAsWaived);
	const blocking = violated.filter((c) => !lifted(c)).map((c) => c.id);
	const waived = violated.filter(lifted).map((c) => c.id);
	return `${blocking.length ? 'no-go' : 'go'} | ${list(blocking)} | ${list(waived)}`;
}

const KINDS: Criterion['kind'][] = ['pass-rate', 'blockers', 'critical', 'major', 'coverage', 'nightly', 'trend'];

/** A value at the threshold, just inside or just outside it. */
function near(rng: Rng, threshold: number, spread: number): number {
	return rng.pick([threshold, threshold, threshold - rng.int(1, spread), threshold + rng.int(1, spread)]);
}

function criteriaScenario(rng: Rng, classId: string): CriteriaParams {
	const planned = rng.pick([200, 240, 250, 300, 400, 500]);
	const passMin = rng.pick([90, 92, 95, 96]);
	const pass = Math.min(planned, near(rng, Math.round((planned * passMin) / 100), 6));
	const fail = rng.int(0, Math.min(10, planned - pass));
	const blocked = rng.int(0, planned - pass - fail);
	const tests = { planned, pass, fail, blocked, notRun: planned - pass - fail - blocked };
	const criticalMax = rng.int(0, 3);
	const majorMax = rng.int(2, 8);
	const row = (openCount: number): number[] => {
		const opened = rng.int(0, openCount);
		return [opened, openCount - opened, rng.int(0, 20), rng.int(0, 3), rng.int(0, 2)];
	};
	const defects: Record<Severity, number[]> = {
		blocker: row(rng.pick([0, 0, 1])),
		critical: row(Math.max(0, near(rng, criticalMax, 1))),
		major: row(Math.max(0, near(rng, majorMax, 2))),
		minor: row(rng.int(0, 25))
	};
	const total = rng.pick([20, 25, 40, 50]);
	const covMin = rng.pick([80, 85, 90]);
	const confirmed = Math.min(total, near(rng, Math.round((total * covMin) / 100), 2));
	const nights = rng.int(5, 7);
	const nightlyMin = rng.int(3, nights - 1);
	const greenNights = Math.min(nights, Math.max(0, near(rng, nightlyMin, 1)));
	const previous = rng.int(8, 30);
	const newDefects: [number, number] = [previous, Math.max(0, near(rng, previous, 4))];
	const rules: Record<Criterion['kind'], Criterion> = {
		'pass-rate': { kind: 'pass-rate', min: passMin },
		blockers: { kind: 'blockers' },
		critical: { kind: 'critical', max: criticalMax },
		major: { kind: 'major', max: majorMax },
		coverage: { kind: 'coverage', min: covMin },
		nightly: { kind: 'nightly', min: nightlyMin, of: nights },
		trend: { kind: 'trend' }
	};
	const chosen = rng.sample(KINDS, rng.int(6, 7));
	const criteria = chosen.map((kind, k) => {
		const waivable = kind !== 'blockers' && rng.bool(0.7);
		return {
			id: String(k + 1),
			rule: rules[kind],
			waivable: classId === 'waivers' && waivable,
			waived: classId === 'waivers' && waivable && rng.bool(0.5)
		};
	});
	const release: Release = {
		tests,
		defects,
		requirements: { confirmed, total },
		greenNights,
		nights,
		newDefects
	};
	const aim = classId === 'waivers' ? rng.pick(['go', 'no-go'] as const) : null;
	// Aiming at «go», the owner waives every violated criterion that can be waived.
	if (aim === 'go') for (const c of criteria) if (c.waivable && !holds(c.rule, release, RIGHT)) c.waived = true;
	return { kind: 'criteria', aim, criteria, release };
}

const PHASES = ['модульное', 'интеграционное', 'системное', 'приёмочное', 'эксплуатация'];

function dreScenario(rng: Rng): DreParams {
	return {
		kind: 'dre',
		phases: PHASES.map((name) => ({
			name,
			valid: name === 'эксплуатация' ? rng.int(3, 25) : rng.int(8, 90),
			rejected: rng.int(1, 12)
		}))
	};
}

const TESTS = ['login', 'checkout', 'search', 'export', 'refund', 'profile', 'cart', 'push', 'reports', 'billing'];

function flakyScenario(rng: Rng): FlakyParams {
	const nights = rng.int(5, 7);
	const names = rng.sample(TESTS, rng.int(6, 9));
	const tests = names.map((name) => {
		const kind = rng.pick(['green', 'green', 'flaky', 'flaky', 'broken'] as const);
		const nightsRow = Array.from({ length: nights }, () =>
			kind === 'green' ? true : kind === 'broken' ? false : rng.bool(0.6)
		);
		return { name, nights: nightsRow };
	});
	return { kind: 'flaky', tests };
}

function suits(p: Params, classId: string, answer: string): boolean {
	if (p.kind === 'flaky') {
		const [flaky = '-', broken = '-'] = answer.split(' | ');
		return flaky !== '-' && broken !== '-';
	}
	if (p.kind === 'dre') return true;
	if (classId === 'violated') return answer.split(' ').length >= 2;
	return answer !== 'go | - | -' && answer.startsWith(`${p.aim ?? ''} `);
}

function criterionText(c: Criterion): string {
	switch (c.kind) {
		case 'pass-rate':
			return `доля тестов в статусе pass среди всех запланированных — не меньше ${c.min}%`;
		case 'blockers':
			return 'нет открытых дефектов серьёзности blocker';
		case 'critical':
			return `открытых дефектов серьёзности critical — не больше ${c.max}`;
		case 'major':
			return `открытых дефектов серьёзности major — не больше ${c.max}`;
		case 'coverage':
			return `подтверждено не меньше ${c.min}% требований`;
		case 'nightly':
			return `из последних ${c.of} ночных прогонов полностью зелёных — не меньше ${c.min}`;
		case 'trend':
			return 'новых дефектов за последнюю неделю строго меньше, чем за предыдущую';
	}
}

function describeCriteria(p: CriteriaParams, classId: string): string {
	const r = p.release;
	const header = ['серьёзность', ...STATUSES];
	const rows = SEVERITIES.map((s) => [s, ...r.defects[s].map(String)]);
	const width = 12;
	const line = (cells: string[]): string =>
		cells
			.map((c) => c.padEnd(width))
			.join('')
			.trimEnd();
	const out = [
		'Критерии выхода из тестирования релиза:',
		'',
		...p.criteria.map(
			(c) =>
				`${c.id}. ${criterionText(c.rule)}${classId === 'waivers' ? (c.waivable ? ' (можно снять решением владельца продукта)' : ' (снять нельзя)') : ''};`
		),
		'',
		'Данные релиза:',
		'',
		`- тесты: запланировано ${r.tests.planned}, pass ${r.tests.pass}, fail ${r.tests.fail}, blocked ${r.tests.blocked}, не запускались ${r.tests.notRun};`,
		`- требования: подтверждено ${r.requirements.confirmed} из ${r.requirements.total};`,
		`- ночные прогоны: из последних ${r.nights} полностью зелёными были ${r.greenNights};`,
		`- новых дефектов заведено: за предыдущую неделю ${r.newDefects[0]}, за последнюю ${r.newDefects[1]};`,
		'- дефекты по серьёзности и статусу:',
		'',
		'```',
		line(header),
		...rows.map(line),
		'```',
		'',
		'Открытый дефект — в статусе `open` или `reopened`; `rejected` и `duplicate` дефектами не считаются.',
		''
	];
	if (classId === 'violated')
		out.push(
			'Введите номера нарушенных критериев через пробел по возрастанию (если таких нет — `-`). Например: `2 5`.'
		);
	else {
		const waived = p.criteria.filter((c) => c.waived).map((c) => c.id);
		out.push(
			`Владелец продукта принял решение снять критерии: ${waived.length ? waived.join(', ') : 'ни одного'}. Снятый критерий выпуск не блокирует; нарушенный и не снятый — блокирует.`,
			'',
			'Введите `go` или `no-go`, затем знак `|` и нарушенные не снятые критерии, затем знак `|` и нарушенные, но снятые критерии; в каждой части — по возрастанию номера (если таких нет — `-`). Например: `no-go | 3 | 1`.'
		);
	}
	return out.join('\n');
}

function describeDre(p: DreParams): string {
	const width = Math.max(...p.phases.map((ph) => ph.name.length)) + 2;
	return [
		'Дефекты релиза по фазе, в которой их нашли:',
		'',
		'```',
		`${'фаза'.padEnd(width)}подтверждено  отклонено или дубликат`,
		...p.phases.map((ph) => `${ph.name.padEnd(width)}${String(ph.valid).padEnd(14)}${ph.rejected}`),
		'```',
		'',
		'Отклонённые дефекты и дубликаты дефектами не считаются. Эффективность устранения дефектов (DRE) — доля дефектов, найденных до выпуска, среди всех дефектов, включая найденные в эксплуатации. DRE фазы — доля дефектов, найденных в этой фазе, среди дефектов, найденных в ней и во всех следующих фазах (включая эксплуатацию).',
		'',
		'Введите через пробел два числа: DRE релиза и DRE фазы системного тестирования в процентах, округлённые вниз до целого. Например: `87 64`.'
	].join('\n');
}

function describeFlaky(p: FlakyParams): string {
	const width = Math.max(...p.tests.map((t) => t.name.length)) + 2;
	const nights = p.tests[0]?.nights.length ?? 0;
	return [
		`Результаты последних ${nights} ночных прогонов (P — тест прошёл, F — упал; ночи слева направо от старой к последней):`,
		'',
		'```',
		...p.tests.map((t) => `${t.name.padEnd(width)}${t.nights.map((x) => (x ? 'P' : 'F')).join(' ')}`),
		'```',
		'',
		'Нестабильный тест за эти ночи и проходил, и падал. Стабильно падающий тест падал каждую ночь.',
		'',
		'Введите нестабильные тесты в порядке таблицы, затем знак `|` и стабильно падающие тесты в порядке таблицы (если таких нет — `-`), затем знак `|` и сколько всего раз за эти ночи падали нестабильные тесты. Например: `search push | export | 5`.'
	].join('\n');
}

function describe(p: Params, classId: string): string {
	if (p.kind === 'dre') return describeDre(p);
	if (p.kind === 'flaky') return describeFlaky(p);
	return describeCriteria(p, classId);
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
cls = p["classId"]
show = lambda xs: " ".join(xs) or "-"
if p["kind"] == "dre":
    phases = p["phases"]
    total = sum(ph["valid"] for ph in phases)
    before = total - phases[-1]["valid"]
    k = [ph["name"] for ph in phases].index("системное")
    later = sum(ph["valid"] for ph in phases[k:])
    print(100 * before // total, 100 * phases[k]["valid"] // later)
elif p["kind"] == "flaky":
    tests = p["tests"]
    flaky = [t["name"] for t in tests if True in t["nights"] and False in t["nights"]]
    broken = [t["name"] for t in tests if not any(t["nights"])]
    falls = sum(t["nights"].count(False) for t in tests if t["name"] in flaky)
    print(show(flaky) + " | " + show(broken) + f" | {falls}")
else:
    r = p["release"]
    opened = {s: row[0] + row[1] for s, row in r["defects"].items()}
    bad = []
    for c in p["criteria"]:
        rule = c["rule"]
        kind = rule["kind"]
        if kind == "pass-rate":
            ok = r["tests"]["pass"] * 100 >= rule["min"] * r["tests"]["planned"]
        elif kind == "blockers":
            ok = opened["blocker"] == 0
        elif kind in ("critical", "major"):
            ok = opened[kind] <= rule["max"]
        elif kind == "coverage":
            ok = r["requirements"]["confirmed"] * 100 >= rule["min"] * r["requirements"]["total"]
        elif kind == "nightly":
            ok = r["greenNights"] >= rule["min"]
        else:
            ok = r["newDefects"][1] < r["newDefects"][0]
        if not ok:
            bad.append(c)
    if cls == "violated":
        print(show([c["id"] for c in bad]))
    else:
        stop = [c["id"] for c in bad if not c["waived"]]
        lifted = [c["id"] for c in bad if c["waived"]]
        print(("no-go" if stop else "go") + " | " + show(stop) + " | " + show(lifted))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'ge-vs-gt': { strictness: true },
	'count-rejected': { countRejected: true },
	'percent-of-executed': { ofExecuted: true },
	'denominator-all-phases': { allPhases: true },
	'waivable-as-waived': { waivableAsWaived: true },
	'flaky-includes-broken': { anyFailFlaky: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	violated: ['ge-vs-gt', 'count-rejected'],
	dre: ['count-rejected', 'denominator-all-phases'],
	waivers: ['ge-vs-gt'],
	flaky: ['flaky-includes-broken']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Data are drawn until the question is well posed and every misconception the class must expose changes the
	// answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p: Params =
			classId === 'dre' ? dreScenario(rng) : classId === 'flaky' ? flakyScenario(rng) : criteriaScenario(rng, classId);
		const answer = solve(p, classId, RIGHT);
		if (!suits(p, classId, answer)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...RIGHT, ...change });
			wrong[id] = value === answer ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ classId, ...p }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
