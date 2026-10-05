// A requirements traceability matrix with the results of a test run: which requirements have no tests, which are
// covered but not confirmed, the shares of covered, executed and confirmed requirements, a release criterion by
// priority, and tests left linked to deleted requirements.
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

type Status = 'pass' | 'fail' | 'blocked' | 'not run';

interface Test {
	id: string;
	requirements: string[];
	status: Status;
}

interface Params {
	requirements: { id: string; priority: 'высокий' | 'средний' | 'низкий' }[];
	tests: Test[];
	/** Release: the least share of confirmed requirements, in percent. */
	threshold: number | null;
	/** Release: the decision the draw aims at, so that both decisions occur. */
	aim: 'go' | 'no-go' | null;
}

interface Rules {
	anyPass: boolean;
	testsDenominator: boolean;
	blockedRun: boolean;
	roundUp: boolean;
}

const RIGHT: Rules = { anyPass: false, testsDenominator: false, blockedRun: false, roundUp: false };

const PRIORITIES = ['высокий', 'средний', 'низкий'] as const;

const id = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(2, '0')}`;

function testsOf(p: Params, r: string): Test[] {
	return p.tests.filter((t) => t.requirements.includes(r));
}

function confirmed(p: Params, r: string, rules: Rules): boolean {
	const tests = testsOf(p, r);
	if (tests.length === 0) return false;
	return rules.anyPass ? tests.some((t) => t.status === 'pass') : tests.every((t) => t.status === 'pass');
}

const ran = (t: Test, rules: Rules): boolean =>
	t.status === 'pass' || t.status === 'fail' || (rules.blockedRun && t.status === 'blocked');

function percent(part: number, whole: number, rules: Rules): number {
	const exact = (100 * part) / whole;
	return rules.roundUp ? Math.ceil(exact - 1e-9) : Math.floor(exact + 1e-9);
}

const list = (ids: readonly string[]): string => (ids.length ? ids.join(' ') : '-');

function solve(p: Params, classId: string, rules: Rules): string {
	const live = p.requirements.map((r) => r.id);
	const covered = live.filter((r) => testsOf(p, r).length > 0);
	const ok = live.filter((r) => confirmed(p, r, rules));
	switch (classId) {
		case 'gaps':
			return `${list(live.filter((r) => !covered.includes(r)))} | ${list(covered.filter((r) => !ok.includes(r)))}`;
		case 'percentages': {
			if (rules.testsDenominator) {
				const n = p.tests.length;
				const linked = p.tests.filter((t) => t.requirements.some((r) => live.includes(r))).length;
				const run = p.tests.filter((t) => ran(t, rules)).length;
				const passed = p.tests.filter((t) => t.status === 'pass').length;
				return [linked, run, passed].map((x) => percent(x, n, rules)).join(' ');
			}
			const executed = live.filter((r) => testsOf(p, r).some((t) => ran(t, rules))).length;
			return [covered.length, executed, ok.length].map((x) => percent(x, live.length, rules)).join(' ');
		}
		case 'release': {
			const high = p.requirements.filter((r) => r.priority === 'высокий' && !ok.includes(r.id)).map((r) => r.id);
			const share = rules.testsDenominator
				? percent(p.tests.filter((t) => t.status === 'pass').length, p.tests.length, rules)
				: percent(ok.length, live.length, rules);
			const go = high.length === 0 && share >= (p.threshold ?? 100);
			return `${go ? 'go' : 'no-go'} ${share} | ${list(high)}`;
		}
		case 'orphans': {
			const orphans = p.tests.filter((t) => t.requirements.every((r) => !live.includes(r))).map((t) => t.id);
			const idle = covered.filter((r) => testsOf(p, r).every((t) => !ran(t, rules)));
			return `${list(orphans)} | ${list(idle)}`;
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function scenario(rng: Rng, classId: string): Params {
	const n = rng.int(8, 12);
	const first = rng.int(1, 20);
	const requirements = Array.from({ length: n }, (_, k) => ({
		id: id('R', first + k),
		priority: rng.pick(PRIORITIES)
	}));
	// Deleted requirements: ids in the same series that are not in the list any more.
	const deleted =
		classId === 'orphans' ? rng.sample([first + n, first + n + 1, first + n + 3], 2).map((x) => id('R', x)) : [];
	const m = rng.int(10, 15);
	// A release candidate has few gaps, none among high-priority requirements, and a mostly green run.
	const release = classId === 'release';
	const gapPool = requirements.filter((r) => !release || r.priority !== 'высокий').map((r) => r.id);
	const uncovered = new Set(rng.sample(gapPool, Math.min(gapPool.length, release ? rng.int(0, 2) : rng.int(1, 3))));
	const coverable = requirements.map((r) => r.id).filter((r) => !uncovered.has(r));
	const pass = release ? rng.pick([0.85, 0.9, 0.95]) : 0.55;
	const rest = (1 - pass) / 3;
	const weights: [Status, number][] = [
		['pass', pass],
		['fail', rest],
		['blocked', rest],
		['not run', rest]
	];
	const status = (): Status => {
		let x = rng.next();
		for (const [s, w] of weights) {
			if (x < w) return s;
			x -= w;
		}
		return 'pass';
	};
	const tests: Test[] = Array.from({ length: m }, (_, k) => ({
		id: id('T', k + 1),
		requirements: rng.sample(coverable, rng.bool(0.3) ? 2 : 1).sort(),
		status: status()
	}));
	for (const r of deleted) {
		const t = rng.pick(tests);
		t.requirements = rng.bool(0.6) ? [r] : [...t.requirements, r].sort();
	}
	return {
		requirements,
		tests,
		threshold: release ? rng.int(10, 17) * 5 : null,
		aim: release ? rng.pick(['go', 'no-go'] as const) : null
	};
}

function suits(p: Params, classId: string, answer: string): boolean {
	switch (classId) {
		case 'gaps':
			return !answer.includes('| -');
		case 'orphans':
			return !answer.startsWith('-') && !answer.endsWith('| -');
		case 'release':
			return answer.startsWith(`${p.aim ?? ''} `);
		default:
			return true;
	}
}

function describe(p: Params, classId: string): string {
	const out = [
		'Требования и их приоритеты:',
		'',
		'```',
		...p.requirements.map((r) => `${r.id}  ${r.priority}`),
		'```',
		'',
		'Тесты, требования, которые они проверяют, и статус последнего прогона:',
		'',
		'```',
		...p.tests.map((t) => `${t.id}  ${t.requirements.join(', ').padEnd(12)}  ${t.status}`),
		'```',
		'',
		'Требование покрыто, если с ним связан хотя бы один тест. Требование подтверждено, если с ним связан хотя бы один тест и все его тесты в статусе `pass`. Тест выполнен, если его статус `pass` или `fail`; `blocked` и `not run` — тест не выполнялся.'
	];
	out.push('');
	switch (classId) {
		case 'gaps':
			out.push(
				'Введите через пробел требования без тестов, затем знак `|` и покрытые, но не подтверждённые требования; в каждой части — по возрастанию номера (если таких нет — `-`). Например: `R-04 | R-02 R-07`.'
			);
			break;
		case 'percentages':
			out.push(
				'Введите через пробел три доли всех требований в процентах, округлённые вниз до целого: покрытых, имеющих хотя бы один выполненный тест, подтверждённых. Например: `83 66 41`.'
			);
			break;
		case 'release':
			out.push(
				`Критерий выпуска: все требования высокого приоритета подтверждены, и подтверждено не меньше ${p.threshold ?? 0}% всех требований (доля округляется вниз до целого процента).`,
				'',
				'Введите `go` или `no-go`, через пробел долю подтверждённых требований в процентах (округлённую вниз), затем знак `|` и неподтверждённые требования высокого приоритета по возрастанию номера (если таких нет — `-`). Например: `no-go 58 | R-03`.'
			);
			break;
		case 'orphans':
			out.push(
				'Требований, которых нет в списке, в спецификации больше нет — их удалили. Висячий тест связан только с удалёнными требованиями.',
				'',
				'Введите через пробел висячие тесты по возрастанию номера, затем знак `|` и покрытые требования, ни один тест которых не выполнялся, по возрастанию номера (если таких нет — `-`). Например: `T-04 | R-02 R-09`.'
			);
			break;
	}
	return out.join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
cls = p["classId"]
reqs = [r["id"] for r in p["requirements"]]
tests = p["tests"]
linked = {r: [t for t in tests if r in t["requirements"]] for r in reqs}
covered = [r for r in reqs if linked[r]]
good = [r for r in reqs if linked[r] and all(t["status"] == "pass" for t in linked[r])]
pct = lambda a, b: 100 * a // b
show = lambda xs: " ".join(xs) or "-"
if cls == "gaps":
    out = show([r for r in reqs if not linked[r]]) + " | " + show([r for r in covered if r not in good])
elif cls == "percentages":
    done = [r for r in reqs if any(t["status"] in ("pass", "fail") for t in linked[r])]
    out = f"{pct(len(covered), len(reqs))} {pct(len(done), len(reqs))} {pct(len(good), len(reqs))}"
elif cls == "release":
    high = [r["id"] for r in p["requirements"] if r["priority"] == "высокий" and r["id"] not in good]
    share = pct(len(good), len(reqs))
    out = ("go" if not high and share >= p["threshold"] else "no-go") + f" {share} | " + show(high)
elif cls == "orphans":
    orphans = [t["id"] for t in tests if all(r not in reqs for r in t["requirements"])]
    idle = [r for r in covered if all(t["status"] not in ("pass", "fail") for t in linked[r])]
    out = show(orphans) + " | " + show(idle)
print(out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'any-pass-suffices': { anyPass: true },
	'tests-denominator': { testsDenominator: true },
	'blocked-as-run': { blockedRun: true },
	'round-up': { roundUp: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	gaps: ['any-pass-suffices'],
	release: ['any-pass-suffices', 'round-up'],
	percentages: ['tests-denominator', 'blocked-as-run', 'any-pass-suffices'],
	orphans: ['blocked-as-run']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Matrices are drawn until the question is well posed and every misconception the class must expose changes
	// the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p = scenario(rng, classId);
		const answer = solve(p, classId, RIGHT);
		if (!suits(p, classId, answer)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [wid, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...RIGHT, ...change });
			wrong[wid] = value === answer ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((wid) => wrong[wid] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ classId, ...p }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([wid, value]) => [
						wid,
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
