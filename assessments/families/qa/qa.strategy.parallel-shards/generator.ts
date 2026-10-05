// Sharding a test suite over parallel executors by a stated rule: longest first onto the least loaded executor, with
// groups that must share an executor, with executors of different speeds, or as a queue the runner takes in list
// order. The answer is the run time and where every test goes.
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

interface Test {
	name: string;
	minutes: number;
	group: string | null;
}

interface Params {
	tests: Test[];
	/** Speed of each executor: 1 — normal, 2 — twice as fast. */
	speeds: number[];
}

interface Rules {
	noSort: boolean;
	roundRobin: boolean;
	ignoreGroups: boolean;
	leastLoaded: boolean;
	sortedQueue: boolean;
}

const RIGHT: Rules = { noSort: false, roundRobin: false, ignoreGroups: false, leastLoaded: false, sortedQueue: false };

const NAMES = [
	'login',
	'signup',
	'checkout',
	'cart',
	'search',
	'catalog',
	'profile',
	'orders',
	'refunds',
	'reports',
	'billing',
	'invoices',
	'export',
	'import',
	'chat',
	'push',
	'settings',
	'admin'
];

/** `<run time> | <executor of each test in table order>`. */
function solve(p: Params, classId: string, rules: Rules): string {
	// Units: a group is placed as one, at the position of its first test.
	const units: { members: number[]; minutes: number }[] = [];
	const byGroup = new Map<string, number>();
	p.tests.forEach((t, k) => {
		const at = t.group !== null && !rules.ignoreGroups ? byGroup.get(t.group) : undefined;
		if (at !== undefined) {
			const unit = units[at];
			if (unit) {
				unit.members.push(k);
				unit.minutes += t.minutes;
			}
			return;
		}
		if (t.group !== null && !rules.ignoreGroups) byGroup.set(t.group, units.length);
		units.push({ members: [k], minutes: t.minutes });
	});
	const sorted = classId === 'dynamic' ? rules.sortedQueue : !rules.noSort;
	const order = units.map((_, u) => u);
	if (sorted) order.sort((a, b) => (units[b]?.minutes ?? 0) - (units[a]?.minutes ?? 0) || a - b);
	const load = p.speeds.map(() => 0);
	const where = p.tests.map(() => 0);
	order.forEach((u, step) => {
		const unit = units[u];
		if (!unit) return;
		let pick = 0;
		if (rules.roundRobin) pick = step % p.speeds.length;
		else {
			const finish = (e: number): number =>
				(load[e] ?? 0) + (rules.leastLoaded ? 0 : unit.minutes / (p.speeds[e] ?? 1));
			for (let e = 1; e < p.speeds.length; e += 1) if (finish(e) < finish(pick)) pick = e;
		}
		load[pick] = (load[pick] ?? 0) + unit.minutes / (p.speeds[pick] ?? 1);
		for (const k of unit.members) where[k] = pick + 1;
	});
	return `${Math.max(...load)} | ${where.join(' ')}`;
}

function scenario(rng: Rng, classId: string): Params {
	const n = rng.int(8, 12);
	const names = rng.sample(NAMES, n);
	const even = classId === 'speeds';
	const tests: Test[] = names.map((name) => ({
		name,
		minutes: even ? rng.int(2, 15) * 2 : rng.int(3, 30),
		group: null
	}));
	if (classId === 'groups') {
		// Two groups share a database fixture or a device: their tests stay together.
		const members = rng.sample(
			tests.map((_, k) => k),
			rng.int(4, 6)
		);
		const split = rng.int(2, members.length - 2);
		members.forEach((k, i) => {
			const t = tests[k];
			if (t) t.group = i < split ? 'db' : 'device';
		});
	}
	const executors = rng.int(2, 4);
	const speeds = Array.from({ length: executors }, () => 1);
	if (even)
		for (const e of rng.sample(
			speeds.map((_, i) => i),
			rng.int(1, executors - 1)
		))
			speeds[e] = 2;
	return { tests, speeds };
}

function describe(p: Params, classId: string): string {
	const width = Math.max(...p.tests.map((t) => t.name.length)) + 2;
	const rows = p.tests.map(
		(t, k) =>
			`${String(k + 1).padEnd(4)}${t.name.padEnd(width)}${String(t.minutes).padStart(3)} мин${t.group ? `  группа ${t.group}` : ''}`
	);
	const out = [
		`Набор тестов прогоняется на ${p.speeds.length} параллельных исполнителях (номера 1–${p.speeds.length}). Тесты в порядке списка:`,
		'',
		'```',
		...rows,
		'```',
		''
	];
	switch (classId) {
		case 'lpt':
			out.push(
				'Раскладка: тесты берутся по убыванию длительности (равные — в порядке списка), и каждый отправляется на исполнитель с наименьшей суммарной длительностью уже назначенных тестов (при равенстве — с меньшим номером).'
			);
			break;
		case 'groups':
			out.push(
				'Тесты одной группы используют общий ресурс и должны идти на одном исполнителе подряд: группа раскладывается как один тест длительностью, равной сумме длительностей её тестов, и стоит в списке на месте своего первого теста.',
				'',
				'Раскладка: тесты и группы берутся по убыванию длительности (равные — в порядке списка), и каждый отправляется на исполнитель с наименьшей суммарной длительностью уже назначенного (при равенстве — с меньшим номером).'
			);
			break;
		case 'speeds': {
			const fast = p.speeds.map((s, e) => (s === 2 ? e + 1 : null)).filter((e) => e !== null);
			out.push(
				`Исполнител${fast.length > 1 ? 'и' : 'ь'} ${fast.join(', ')} вдвое быстрее остальных: тест длительностью t минут занимает на ${fast.length > 1 ? 'них' : 'нём'} t/2 минут.`,
				'',
				'Раскладка: тесты берутся по убыванию длительности (равные — в порядке списка), и каждый отправляется на исполнитель, где он закончится раньше всего — с учётом уже назначенных тестов и скорости исполнителя (при равенстве — на исполнитель с меньшим номером).'
			);
			break;
		}
		case 'dynamic':
			out.push(
				'Раннер ведёт общую очередь в порядке списка: как только исполнитель освобождается, он берёт следующий тест из очереди. В начале все исполнители свободны и берут тесты по порядку номеров исполнителей; если освобождаются одновременно, первым берёт исполнитель с меньшим номером.'
			);
			break;
	}
	out.push(
		'',
		'Введите время прогона всего набора в минутах (когда закончит последний исполнитель), затем знак `|` и через пробел номер исполнителя для каждого теста в порядке списка. Например: `41 | 1 2 2 1 3`.'
	);
	return out.join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
cls = p["classId"]
tests = p["tests"]
speeds = p["speeds"]
units, seen = [], {}
for k, t in enumerate(tests):
    g = t["group"]
    if g is not None and g in seen:
        units[seen[g]][0].append(k)
        units[seen[g]][1] += t["minutes"]
        continue
    if g is not None:
        seen[g] = len(units)
    units.append([[k], t["minutes"]])
order = list(range(len(units)))
if cls != "dynamic":
    order.sort(key=lambda u: (-units[u][1], u))
busy = [0] * len(speeds)
where = [0] * len(tests)
for u in order:
    members, minutes = units[u]
    ends = [busy[e] + minutes / speeds[e] for e in range(len(speeds))]
    e = ends.index(min(ends))
    busy[e] = ends[e]
    for k in members:
        where[k] = e + 1
total = max(busy)
print(f"{int(total) if total == int(total) else total} | " + " ".join(map(str, where)))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'no-sort': { noSort: true },
	'round-robin': { roundRobin: true },
	'ignore-groups': { ignoreGroups: true },
	'least-loaded': { leastLoaded: true },
	'sorted-queue': { sortedQueue: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	lpt: ['no-sort', 'round-robin'],
	groups: ['ignore-groups'],
	speeds: ['least-loaded'],
	dynamic: ['sorted-queue']
};

/** Misconceptions that do not touch a class's rule give its right answer: they do not apply there. */
const APPLIES: Record<string, string[]> = {
	lpt: ['no-sort', 'round-robin'],
	groups: ['no-sort', 'round-robin', 'ignore-groups'],
	speeds: ['no-sort', 'round-robin', 'least-loaded'],
	dynamic: ['round-robin', 'sorted-queue']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Suites are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, classId);
		const answer = solve(p, classId, RIGHT);
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = (APPLIES[classId] ?? []).includes(id) ? solve(p, classId, { ...RIGHT, ...change }) : answer;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
