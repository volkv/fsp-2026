// A GitHub Actions matrix: which jobs `exclude` and `include` leave, and how the jobs end when some of them fail —
// `fail-fast` cancels the rest, `max-parallel` holds jobs in a queue, `continue-on-error` keeps a failure from
// cancelling. The candidate counts the jobs and their outcomes.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_PIPELINE_YAML } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Combo = Record<string, string>;

interface Params {
	keys: { name: string; values: string[] }[];
	exclude: Combo[];
	include: Combo[];
	/** `null` — the key is absent (the default is `true`). */
	failFast: boolean | null;
	maxParallel: number | null;
	continueOnError: boolean;
	baseMinutes: Record<string, number>;
	extra: { key: string; value: string; minutes: number }[];
	failing: Combo;
}

interface Rules {
	excludeAfterInclude: boolean;
	includeAlwaysNew: boolean;
	includeOverwritesOriginal: boolean;
	addedFrozen: boolean;
	addedKept: boolean;
	extensionIgnored: boolean;
	cancelOnlyQueued: boolean;
	coeCancels: boolean;
	noMaxParallel: boolean;
	failFastDefaultOff: boolean;
}

const RIGHT: Rules = {
	excludeAfterInclude: false,
	includeAlwaysNew: false,
	includeOverwritesOriginal: false,
	addedFrozen: false,
	addedKept: false,
	extensionIgnored: false,
	cancelOnlyQueued: false,
	coeCancels: false,
	noMaxParallel: false,
	failFastDefaultOff: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'exclude-after-include': { excludeAfterInclude: true },
	'include-always-new': { includeAlwaysNew: true },
	'include-overwrites-original': { includeOverwritesOriginal: true },
	'added-not-overwritten': { addedFrozen: true },
	'added-kept': { addedKept: true },
	'include-extension-ignored': { extensionIgnored: true },
	'cancel-only-queued': { cancelOnlyQueued: true },
	'coe-cancels': { coeCancels: true },
	'no-max-parallel': { noMaxParallel: true },
	'fail-fast-default-off': { failFastDefaultOff: true }
};

const matches = (combo: Combo, part: Combo): boolean => Object.entries(part).every(([k, v]) => combo[k] === v);

/** The jobs of the matrix in their order; `ambiguous` — a later include could extend a combination an earlier one created. */
function expand(p: Params, rules: Rules): { jobs: Combo[]; ambiguous: boolean } {
	let product: Combo[] = [{}];
	for (const key of p.keys) product = product.flatMap((c) => key.values.map((v) => ({ ...c, [key.name]: v })));
	const original = rules.excludeAfterInclude ? product : product.filter((c) => !p.exclude.some((e) => matches(c, e)));
	const combos: { orig: Combo; added: Combo }[] = original.map((orig) => ({ orig: { ...orig }, added: {} }));
	const created: Combo[] = [];
	let ambiguous = false;
	for (const inc of p.include) {
		if (!rules.includeAlwaysNew && created.some((c) => Object.entries(inc).every(([k, v]) => !(k in c) || c[k] === v)))
			ambiguous = true;
		if (rules.includeAlwaysNew) {
			created.push({ ...inc });
			continue;
		}
		let added = false;
		for (const c of combos) {
			const changes = ([k, v]: [string, string]): boolean =>
				(k in c.orig && c.orig[k] !== v) || (rules.addedFrozen && k in c.added && c.added[k] !== v);
			if (Object.entries(inc).some(changes)) continue;
			added = true;
			if (rules.extensionIgnored) continue;
			for (const [k, v] of Object.entries(inc))
				if (!(k in c.orig) && !(rules.addedKept && k in c.added)) c.added[k] = v;
		}
		if (added) continue;
		const [firstKey, firstValue] = Object.entries(inc)[0] ?? ['', ''];
		const sharing = combos.filter((c) => firstKey in c.orig && c.orig[firstKey] === firstValue);
		if (rules.includeOverwritesOriginal && sharing.length > 0) {
			for (const c of sharing) Object.assign(c.orig, inc);
			continue;
		}
		created.push({ ...inc });
	}
	let jobs = [...combos.map((c) => ({ ...c.orig, ...c.added })), ...created];
	if (rules.excludeAfterInclude) jobs = jobs.filter((c) => !p.exclude.some((e) => matches(c, e)));
	return { jobs, ambiguous };
}

type Outcome = 'success' | 'failure' | 'cancelled';

function minutes(p: Params, job: Combo): number {
	return (
		(p.baseMinutes[job.os ?? ''] ?? 0) +
		p.extra.filter((e) => job[e.key] === e.value).reduce((sum, e) => sum + e.minutes, 0)
	);
}

/** `<total> <success> <failure> <cancelled> <minute the matrix ends>`, or `null` when two events coincide where the order would matter. */
function simulate(p: Params, rules: Rules): string | null {
	const { jobs, ambiguous } = expand(p, rules);
	if (ambiguous) return null;
	const slots = p.maxParallel === null || rules.noMaxParallel ? jobs.length : p.maxParallel;
	const failFast = p.failFast ?? !rules.failFastDefaultOff;
	const outcome: (Outcome | null)[] = jobs.map(() => null);
	const running: { i: number; end: number }[] = [];
	let next = 0;
	let cancelledAll = false;
	let finish = 0;
	const start = (t: number): void => {
		while (!cancelledAll && running.length < slots && next < jobs.length) {
			running.push({ i: next, end: t + minutes(p, jobs[next] as Combo) });
			next += 1;
		}
	};
	start(0);
	while (running.length > 0) {
		const t = Math.min(...running.map((r) => r.end));
		finish = t;
		const ending = running.filter((r) => r.end === t);
		for (const r of ending) running.splice(running.indexOf(r), 1);
		let trigger = false;
		for (const r of ending) {
			const job = jobs[r.i] as Combo;
			const fails = matches(job, p.failing);
			outcome[r.i] = fails ? 'failure' : 'success';
			const mayFail = p.continueOnError && job.experimental === 'true' && !rules.coeCancels;
			if (fails && failFast && !mayFail && !cancelledAll) trigger = true;
		}
		if (trigger) {
			if (ending.length > 1) return null;
			cancelledAll = true;
			for (let i = next; i < jobs.length; i += 1) outcome[i] = 'cancelled';
			next = jobs.length;
			if (!rules.cancelOnlyQueued) {
				for (const r of running) outcome[r.i] = 'cancelled';
				running.length = 0;
			}
		}
		start(t);
	}
	const count = (o: Outcome): number => outcome.filter((x) => x === o).length;
	return `${jobs.length} ${count('success')} ${count('failure')} ${count('cancelled')} ${finish}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const OS = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
const SECOND = [
	{ name: 'node', values: ['18', '20', '22', '24'] },
	{ name: 'python', values: ['3.10', '3.11', '3.12', '3.13'] },
	{ name: 'go', values: ['1.22', '1.23', '1.24'] },
	{ name: 'java', values: ['17', '21', '23'] }
];
const THIRD = [
	{ name: 'db', values: ['postgres', 'mysql'] },
	{ name: 'arch', values: ['x64', 'arm64'] }
];

interface ClassSpec {
	keys: 2 | 3;
	exclude: [number, number];
	/** Kinds of include objects: an extension of combinations, a new combination, a re-added excluded one. */
	include: ('extend' | 'new' | 'readd' | 'flag')[];
	failFast: (boolean | null)[];
	maxParallel: boolean;
	continueOnError: boolean;
}

const SPECS: Record<string, ClassSpec> = {
	'junior/exclude': {
		keys: 2,
		exclude: [1, 2],
		include: [],
		failFast: [null],
		maxParallel: false,
		continueOnError: false
	},
	'junior/max-parallel': {
		keys: 2,
		exclude: [0, 1],
		include: [],
		failFast: [true, null],
		maxParallel: true,
		continueOnError: false
	},
	'junior/include-new': {
		keys: 2,
		exclude: [0, 1],
		include: ['new', 'extend'],
		failFast: [false],
		maxParallel: false,
		continueOnError: false
	},
	'junior/include-extend': {
		keys: 2,
		exclude: [0, 1],
		include: ['extend', 'extend'],
		failFast: [false],
		maxParallel: false,
		continueOnError: false
	},
	'middle/include-overwrite': {
		keys: 3,
		exclude: [0, 1],
		include: ['flag', 'new', 'extend'],
		// The overwritten `experimental` decides whether a failure cancels the rest: fail-fast is on.
		failFast: [true, null],
		maxParallel: false,
		continueOnError: true
	},
	'middle/continue-on-error': {
		keys: 2,
		exclude: [0, 1],
		include: ['flag', 'extend'],
		failFast: [true, null],
		maxParallel: true,
		continueOnError: true
	},
	'middle/timeline': {
		keys: 3,
		exclude: [1, 2],
		include: [],
		failFast: [true, null],
		maxParallel: true,
		continueOnError: false
	},
	'middle/exclude-include': {
		keys: 2,
		exclude: [1, 2],
		include: ['readd', 'extend'],
		failFast: [false, true],
		maxParallel: true,
		continueOnError: false
	}
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/exclude': ['fail-fast-default-off'],
	'junior/max-parallel': ['no-max-parallel'],
	'junior/include-new': ['include-always-new'],
	'junior/include-extend': ['include-always-new', 'include-extension-ignored'],
	'middle/include-overwrite': ['include-overwrites-original', 'added-not-overwritten', 'added-kept'],
	'middle/continue-on-error': ['coe-cancels'],
	'middle/timeline': ['cancel-only-queued', 'no-max-parallel'],
	'middle/exclude-include': ['exclude-after-include']
};

const EXTRA_KEYS = [
	{ name: 'coverage', values: ['true'] },
	{ name: 'shell', values: ['pwsh', 'bash'] },
	{ name: 'label', values: ['lts', 'edge'] }
];

function scenario(rng: Rng, spec: ClassSpec): Params {
	const second = rng.pick(SECOND);
	const keys = [
		{ name: 'os', values: rng.sample(OS, rng.int(2, 3)) },
		{ name: second.name, values: rng.sample(second.values, rng.int(2, 3)).sort() }
	];
	if (spec.keys === 3) {
		const third = rng.pick(THIRD);
		keys.push({ name: third.name, values: [...third.values] });
	}
	const pickCombo = (count: number): Combo =>
		Object.fromEntries(rng.sample(keys, count).map((k) => [k.name, rng.pick(k.values)]));
	const exclude = Array.from({ length: rng.int(spec.exclude[0], spec.exclude[1]) }, () =>
		pickCombo(rng.int(2, keys.length))
	);
	const include: Combo[] = [];
	const os = keys[0]?.values ?? [];
	const sv = keys[1]?.values ?? [];
	// The key an extension adds lengthens the jobs it reaches: the extension shows in the answer.
	const extensionMinutes: Params['extra'] = [];
	for (const kind of spec.include) {
		if (kind === 'extend') {
			const extra = rng.pick(EXTRA_KEYS);
			const value = rng.pick(extra.values);
			include.push({ [second.name]: rng.pick(sv), [extra.name]: value });
			if (!extensionMinutes.some((e) => e.key === extra.name && e.value === value))
				extensionMinutes.push({ key: extra.name, value, minutes: rng.int(2, 6) });
		} else if (kind === 'flag') {
			// Adds `experimental` to the combinations of one OS; a later include overwrites the added value for some of them.
			const flagged = rng.pick(os);
			include.push({ os: flagged, experimental: 'true' });
			if (rng.bool(0.5)) include.push({ os: flagged, [second.name]: rng.pick(sv), experimental: 'false' });
		} else if (kind === 'new') {
			const unused = second.values.filter((v) => !sv.includes(v));
			const value = unused.length > 0 ? rng.pick(unused) : rng.pick(sv);
			include.push({ os: rng.pick(os), [second.name]: value, ...(rng.bool(0.5) ? { experimental: 'true' } : {}) });
		} else {
			const removed = exclude[0];
			if (removed) {
				const full = Object.fromEntries(keys.map((k) => [k.name, removed[k.name] ?? rng.pick(k.values)]));
				include.push(full);
			}
		}
	}
	const baseMinutes = Object.fromEntries(OS.map((o) => [o, rng.int(3, 14)]));
	const extra = [
		...rng.sample(sv, rng.int(1, 2)).map((value) => ({ key: second.name, value, minutes: rng.int(1, 5) })),
		...extensionMinutes
	];
	const failKeys = rng.bool(0.5) ? ['os', second.name] : [rng.pick(['os', second.name])];
	let failing: Combo = Object.fromEntries(
		failKeys.map((k) => [k, rng.pick(keys.find((x) => x.name === k)?.values ?? [])])
	);
	if (spec.continueOnError && rng.bool(0.6)) {
		failing = {
			...Object.fromEntries(Object.entries(failing).filter(([k]) => k !== second.name)),
			experimental: 'true'
		};
	}
	return {
		keys,
		exclude,
		include,
		failFast: rng.pick(spec.failFast),
		maxParallel: spec.maxParallel ? rng.int(2, 3) : null,
		continueOnError: spec.continueOnError,
		baseMinutes,
		extra,
		failing
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Text.

const yamlValue = (v: string): string => (/^\d+\.\d+$/.test(v) ? `'${v}'` : v);

function comboLines(list: Combo[], indent: string): string[] {
	return list.flatMap((c) =>
		Object.entries(c).map(([k, v], i) => `${indent}${i === 0 ? '- ' : '  '}${k}: ${yamlValue(v)}`)
	);
}

function workflowYaml(p: Params): string {
	const lines = ['name: test', 'on: [push, pull_request]', 'jobs:', '  test:', '    runs-on: ${{ matrix.os }}'];
	if (p.continueOnError) lines.push('    continue-on-error: ${{ matrix.experimental == true }}');
	lines.push('    strategy:');
	if (p.failFast !== null) lines.push(`      fail-fast: ${p.failFast}`);
	if (p.maxParallel !== null) lines.push(`      max-parallel: ${p.maxParallel}`);
	lines.push('      matrix:');
	for (const k of p.keys) lines.push(`        ${k.name}: [${k.values.map(yamlValue).join(', ')}]`);
	if (p.exclude.length) lines.push('        exclude:', ...comboLines(p.exclude, '          '));
	if (p.include.length) lines.push('        include:', ...comboLines(p.include, '          '));
	lines.push('    steps:', '      - uses: actions/checkout@v4', '      - run: make test');
	return lines.join('\n');
}

function describe(p: Params): string {
	const base = Object.entries(p.baseMinutes)
		.filter(([os]) => p.keys[0]?.values.includes(os) || p.include.some((c) => c.os === os))
		.map(([os, m]) => `\`${os}\` — ${m} мин`)
		.join(', ');
	const extra = p.extra.map((e) => `при \`${e.key}: ${e.value}\` — ещё ${e.minutes} мин`).join(', ');
	const failing = Object.entries(p.failing)
		.map(([k, v]) => `\`${k}: ${v}\``)
		.join(' и ');
	return [
		'Workflow GitHub Actions с матрицей ниже. Как GitHub Actions строит матрицу и выполняет её задания:',
		'',
		'- сначала берутся все сочетания значений ключей матрицы (кроме `include` и `exclude`); порядок — как при вложенных циклах: первый ключ меняется медленнее всех, значения — в порядке списков;',
		'- затем из них удаляются сочетания, подходящие под какой-либо объект `exclude` (подходит — совпадают все ключи объекта);',
		'- затем по порядку применяются объекты `include`: объект добавляется ко **всем** оставшимся исходным сочетаниям, где он не меняет ни одного исходного значения матрицы (значения, добавленные предыдущими `include`, менять можно); если он не подошёл ни к одному сочетанию, он становится новым сочетанием в конце списка;',
		'- задания стартуют по порядку сочетаний: без `max-parallel` — все сразу в минуту 0, с `max-parallel: N` — не больше N одновременно, следующее по порядку стартует, как только освободилось место;',
		'- `fail-fast` по умолчанию `true`: когда задание завершается ошибкой, все выполняющиеся и ещё не начатые задания матрицы отменяются (`cancelled`); задание, у которого `continue-on-error` истинно, при ошибке считается упавшим, но отмену не запускает; при `fail-fast: false` все задания выполняются до конца.',
		'',
		`Длительность задания: ${base}; ${extra}. Упадут (в конце своей длительности) задания, у которых ${failing}; остальные завершатся успешно.`,
		'',
		'Введите через пробел пять чисел: сколько заданий в матрице, сколько завершится успешно, сколько с ошибкой, сколько будет отменено и в какую минуту от старта матрицы завершится (или будет отменено) последнее задание. Например: `8 5 1 2 17`.'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
doc = parse_yaml(data["yaml"])
job = doc["jobs"]["test"]
strategy = job["strategy"]
matrix = strategy["matrix"]
keys = [k for k in matrix if k not in ("include", "exclude")]

combos = [{}]
for k in keys:
    combos = [dict(c, **{k: v}) for c in combos for v in matrix[k]]


def fits(c, part):
    return all(c.get(k) == v for k, v in part.items())


combos = [c for c in combos if not any(fits(c, e) for e in matrix.get("exclude") or [])]
originals = [dict(c) for c in combos]
extra = [{} for _ in combos]
new = []
for inc in matrix.get("include") or []:
    hit = False
    for i, orig in enumerate(originals):
        if all(orig[k] == v for k, v in inc.items() if k in orig):
            hit = True
            for k, v in inc.items():
                if k not in orig:
                    extra[i][k] = v
    if not hit:
        new.append(dict(inc))
jobs = [dict(o, **e) for o, e in zip(originals, extra)] + new

fail_fast = strategy.get("fail-fast", "true") == "true"
slots = int(strategy["max-parallel"]) if "max-parallel" in strategy else len(jobs)
may_fail = "continue-on-error" in job


def duration(c):
    return data["base"][c["os"]] + sum(e["minutes"] for e in data["extra"] if c.get(e["key"]) == e["value"])


state = ["queued"] * len(jobs)
ends = {}
t = 0
queue = list(range(len(jobs)))
while True:
    while queue and len(ends) < slots:
        i = queue.pop(0)
        state[i] = "running"
        ends[i] = t + duration(jobs[i])
    if not ends:
        break
    t = min(ends.values())
    done = [i for i, e in ends.items() if e == t]
    stop = False
    for i in done:
        del ends[i]
        failed = fits(jobs[i], data["failing"])
        state[i] = "failure" if failed else "success"
        if failed and fail_fast and not (may_fail and jobs[i].get("experimental") == "true"):
            stop = True
    if stop:
        for i in list(ends) + queue:
            state[i] = "cancelled"
        ends = {}
        queue = []
print(len(jobs), state.count("success"), state.count("failure"), state.count("cancelled"), t)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const spec = SPECS[key];
	if (!spec) throw new Error(`${descriptor.key}: no class ${key}`);
	// Scenarios are drawn until every misconception that the class must expose changes the answer.
	for (let tries = 0; tries < 800; tries += 1) {
		const p = scenario(rng, spec);
		const answer = simulate(p, RIGHT);
		// Every job of the right matrix has an OS: its duration is defined.
		if (answer === null || expand(p, RIGHT).jobs.some((j) => j.os === undefined)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[key] ?? []).some((id) => wrong[id] === null)) continue;
		const yaml = workflowYaml(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, base: p.baseMinutes, extra: p.extra, failing: p.failing })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${key} after 800 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
