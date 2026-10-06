// An alerting rule and the values its expression sees at every evaluation: the moments the alert becomes pending, fires,
// drops back from pending and resolves. Middle: one series, `for` against the evaluation interval and the comparison at
// the threshold. Senior: `keep_firing_for`, series that vanish, and one alert per series of the result.
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

type Op = '>' | '>=' | '<';

interface Params {
	group: string;
	alert: string;
	metric: string;
	op: Op;
	/** Threshold and values in thousandths. */
	threshold: number;
	interval: number;
	hold: number;
	keep: number;
	/** Series name (instance) → value at every evaluation; null — no sample, the series is absent. */
	series: { instance: string | null; values: (number | null)[] }[];
}

interface Rules {
	noReset: boolean;
	strictFor: boolean;
	fireAtFor: boolean;
	compareFlip: boolean;
	pendingFirst: boolean;
	resolveAfterFor: boolean;
	ignoreKeep: boolean;
	keepFromLastTrue: boolean;
	missingHolds: boolean;
	oneAlert: boolean;
	keepNoReset: boolean;
}

const RIGHT: Rules = {
	noReset: false,
	strictFor: false,
	fireAtFor: false,
	compareFlip: false,
	pendingFirst: false,
	resolveAfterFor: false,
	ignoreKeep: false,
	keepFromLastTrue: false,
	missingHolds: false,
	oneAlert: false,
	keepNoReset: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-reset': { noReset: true },
	'strict-for': { strictFor: true },
	'fire-at-for': { fireAtFor: true },
	'compare-flip': { compareFlip: true },
	'pending-first': { pendingFirst: true },
	'resolve-after-for': { resolveAfterFor: true },
	'ignore-keep': { ignoreKeep: true },
	'keep-from-last-true': { keepFromLastTrue: true },
	'missing-holds-value': { missingHolds: true },
	'one-alert': { oneAlert: true },
	'keep-no-reset': { keepNoReset: true }
};

function holds(op: Op, value: number, threshold: number, flip: boolean): boolean {
	if (op === '<') return flip ? value <= threshold : value < threshold;
	const strict = op === '>' ? !flip : flip;
	return strict ? value > threshold : value >= threshold;
}

/** Whether the expression returns the series at every evaluation. */
function conditions(p: Params, values: readonly (number | null)[], rules: Rules): boolean[] {
	let last: number | null = null;
	return values.map((v) => {
		const seen = v === null && rules.missingHolds ? last : v;
		if (v !== null) last = v;
		return seen !== null && holds(p.op, seen, p.threshold, rules.compareFlip);
	});
}

/** The events of one alert over its conditions: `<moment> <event>`. */
function alertEvents(p: Params, cond: readonly boolean[], rules: Rules): { t: number; event: string }[] {
	const events: { t: number; event: string }[] = [];
	let state: 'inactive' | 'pending' | 'firing' = 'inactive';
	let activeAt = 0;
	let emptySince: number | null = null;
	let lastTrue = 0;
	const keep = rules.ignoreKeep ? 0 : p.keep;
	cond.forEach((on, i) => {
		const t = i * p.interval;
		if (on) {
			if (!rules.keepNoReset) emptySince = null;
			if (state === 'inactive') {
				state = 'pending';
				activeAt = t;
				if (p.hold === 0 && !rules.pendingFirst) {
					state = 'firing';
					events.push({ t, event: 'firing' });
				} else events.push({ t, event: 'pending' });
			} else if (state === 'pending') {
				const passed = t - activeAt;
				if (rules.strictFor ? passed > p.hold : passed >= p.hold) {
					state = 'firing';
					events.push({ t: rules.fireAtFor ? activeAt + p.hold : t, event: 'firing' });
				}
			}
			lastTrue = t;
			return;
		}
		if (state === 'pending' && !rules.noReset) {
			state = 'inactive';
			events.push({ t, event: 'reset' });
		} else if (state === 'firing') {
			const window = keep > 0 ? keep : rules.resolveAfterFor ? p.hold : 0;
			if (window === 0) {
				state = 'inactive';
				events.push({ t, event: 'resolved' });
				return;
			}
			emptySince ??= rules.keepFromLastTrue ? lastTrue : t;
			if (t - emptySince >= window) {
				state = 'inactive';
				emptySince = null;
				events.push({ t, event: 'resolved' });
			}
		}
	});
	return events;
}

function answerOf(p: Params, rules: Rules): string[] {
	if (rules.oneAlert && p.series.length > 1) {
		const per = p.series.map((s) => conditions(p, s.values, rules));
		const any = (per[0] ?? []).map((_, i) => per.some((c) => c[i]));
		return alertEvents(p, any, rules).map((e) => `${e.t} ${e.event}`);
	}
	const all = p.series.flatMap((s) =>
		alertEvents(p, conditions(p, s.values, rules), rules).map((e) => ({ ...e, instance: s.instance }))
	);
	all.sort((a, b) => a.t - b.t || (a.instance ?? '').localeCompare(b.instance ?? ''));
	return all.map((e) => (e.instance === null ? `${e.t} ${e.event}` : `${e.t} ${e.instance} ${e.event}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const JOBS = ['payments', 'checkout', 'search', 'orders', 'profile', 'billing', 'catalog', 'gateway'];

/** A pattern of `runs` non-empty stretches separated by empty ones, starting and ending empty. */
function pattern(rng: Rng, runs: number, holdSteps: number, maxEmpty: number): boolean[] {
	const out: boolean[] = Array<boolean>(rng.int(1, 3)).fill(false);
	for (let r = 0; r < runs; r += 1) {
		out.push(...Array<boolean>(rng.int(1, holdSteps + 2)).fill(true));
		out.push(...Array<boolean>(r === runs - 1 ? rng.int(2, 4) : rng.int(1, maxEmpty)).fill(false));
	}
	return out;
}

/** A value for a condition; `edge` puts it exactly on the threshold where that keeps the condition. */
function valueFor(rng: Rng, op: Op, threshold: number, on: boolean, edge: boolean): number {
	if (op === '<') {
		if (on) return threshold - rng.int(1, Math.min(threshold, 60));
		return edge ? threshold : threshold + rng.int(1, 1000 - threshold);
	}
	if (op === '>=') {
		if (on) return edge ? threshold : threshold + rng.int(1, 2 * threshold);
		return rng.int(0, threshold - 1);
	}
	if (on) return threshold + rng.int(1, 2 * threshold);
	return edge ? threshold : rng.int(0, threshold - 1);
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const job = rng.pick(JOBS);
	const op: Op =
		classId === 'multi-series'
			? '>'
			: classId === 'threshold-equal'
				? rng.pick(['>', '>=', '<'] as const)
				: rng.pick(['>', '>', '<'] as const);
	const threshold = op === '<' ? rng.pick([950, 990, 995]) : rng.pick([10, 20, 50, 100]);
	let interval = rng.pick([15, 30, 60]);
	let hold = interval * rng.int(2, 4);
	let keep = 0;
	if (classId === 'for-not-multiple') {
		interval = rng.pick([30, 60]);
		hold = interval * rng.int(1, 3) + (interval === 60 ? rng.pick([15, 30, 45]) : rng.pick([10, 15, 20]));
	}
	if (classId === 'for-zero') hold = 0;
	if (classId === 'keep-firing' || classId === 'keep-reset') keep = interval * rng.int(2, 4);
	const holdSteps = Math.ceil(hold / interval);
	const instances =
		classId === 'multi-series' ? rng.sample(['api-1', 'api-2', 'api-3', 'api-4'], rng.int(2, 3)).sort() : [null];
	const maxEmpty = classId === 'keep-reset' ? Math.max(1, keep / interval - 1) : 3;
	const runs = classId === 'multi-series' ? rng.int(1, 2) : grade === 'middle' ? rng.int(2, 3) : 3;
	const patterns = instances.map(() => pattern(rng, runs, holdSteps, maxEmpty));
	const length = Math.max(...patterns.map((on) => on.length));
	const series = instances.map((instance, n) => {
		const on = [...(patterns[n] ?? [])];
		while (on.length < length) on.push(false);
		const values: (number | null)[] = on.map((c) =>
			valueFor(rng, op, threshold, c, classId === 'threshold-equal' && rng.bool(0.35))
		);
		if (classId === 'missing-data') {
			// Gaps where the series is absent: inside a non-empty stretch, or right after it.
			const gaps = rng.int(2, 3);
			for (let g = 0; g < gaps; g += 1) {
				const at = rng.int(2, length - 2);
				const span = rng.int(1, 2);
				for (let k = at; k < Math.min(length, at + span); k += 1) values[k] = null;
			}
		}
		return { instance, values };
	});
	return {
		group: job,
		alert: `${job[0]?.toUpperCase() ?? ''}${job.slice(1)}${op === '<' ? 'LowSuccess' : 'HighErrors'}`,
		metric:
			classId === 'multi-series'
				? `instance:request_errors:ratio_rate5m{job="${job}"}`
				: op === '<'
					? `job:request_success:ratio_rate5m{job="${job}"}`
					: `job:request_errors:ratio_rate5m{job="${job}"}`,
		op,
		threshold,
		interval,
		hold,
		keep,
		series
	};
}

/** Whether the drawn scenario shows what its class is about. */
function fits(p: Params, classId: string, answer: readonly string[]): boolean {
	const has = (event: string): boolean => answer.some((line) => line.endsWith(` ${event}`));
	if (!has('firing') || !has('resolved')) return false;
	if ((p.series[0]?.values.length ?? 0) > 24 || answer.length > 10) return false;
	if (classId === 'reset' || classId === 'missing-data') return has('reset');
	if (classId === 'multi-series') return new Set(answer.map((l) => l.split(' ')[1])).size === p.series.length;
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function duration(seconds: number): string {
	if (seconds === 0) return '0s';
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (m === 0) return `${s}s`;
	return s === 0 ? `${m}m` : `${m}m${s}s`;
}

const decimal = (thousandths: number): string => (thousandths / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

function yaml(p: Params): string {
	return [
		'groups:',
		`  - name: ${p.group}`,
		`    interval: ${duration(p.interval)}`,
		'    rules:',
		`      - alert: ${p.alert}`,
		`        expr: ${p.metric} ${p.op} ${decimal(p.threshold)}`,
		`        for: ${duration(p.hold)}`,
		...(p.keep > 0 ? [`        keep_firing_for: ${duration(p.keep)}`] : []),
		'        labels:',
		'          severity: page'
	].join('\n');
}

const cell = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : decimal(v));

function table(p: Params): string[] {
	const multi = p.series.length > 1;
	const head = multi ? p.series.map((s) => `\`instance="${s.instance ?? ''}"\``) : ['значение'];
	const rows = (p.series[0]?.values ?? []).map(
		(_, i) => `| ${i * p.interval} | ${p.series.map((s) => cell(s.values[i])).join(' | ')} |`
	);
	return [`| момент, с | ${head.join(' | ')} |`, `|---|${head.map(() => '---').join('|')}|`, ...rows];
}

function describe(p: Params): string {
	const multi = p.series.length > 1;
	const lines = [
		'Prometheus вычисляет правило оповещения, показанное ниже. Считайте по такой модели:',
		'',
		`- правило вычисляется каждые ${p.interval} с, в моменты 0, ${p.interval}, ${2 * p.interval}, … с; в момент 0 оповещение неактивно;`,
		'- выражение **непусто** для ряда, если у ряда в этот момент есть значение и сравнение с порогом выполнено; если сравнение не выполнено или значения нет (прочерк — ряд пропал), выражение для ряда **пусто**;',
		'- неактивное оповещение при непустом выражении становится `pending`, момент запоминается; `pending` становится `firing` на первом вычислении, на котором с этого момента прошло не меньше `for` (при `for: 0s` — сразу на том же вычислении, события `pending` тогда нет);',
		'- если выражение пусто, оповещение в `pending` возвращается в неактивное (событие `reset`), а оповещение в `firing` снимается (событие `resolved`);'
	];
	if (p.keep > 0) {
		lines.push(
			'- `keep_firing_for`: оповещение в `firing` при пустом выражении не снимается сразу. Отсчёт идёт от первого вычисления, на котором выражение стало пустым; `resolved` — на первом вычислении, где с этого момента прошло не меньше `keep_firing_for` и выражение всё ещё пусто. Если выражение снова непусто раньше, оповещение остаётся `firing`, а отсчёт при следующем пустом вычислении начинается заново; на `pending` `keep_firing_for` не действует;'
		);
	}
	if (multi) {
		lines.push(
			'- выражение возвращает по ряду на каждый `instance`; у каждого ряда своё оповещение со своими состояниями;'
		);
	}
	lines.push(
		'- после `resolved` или `reset` всё начинается сначала.',
		'',
		'Значения выражения слева от сравнения:',
		''
	);
	lines.push(...table(p));
	lines.push(
		'',
		multi
			? 'Введите все события по порядку, по одному в строке: `<момент в секундах> <instance> <событие>`, где событие — `pending`, `firing`, `reset` или `resolved`. События одного момента — по алфавиту `instance`. Например:'
			: 'Введите все события по порядку, по одному в строке: `<момент в секундах> <событие>`, где событие — `pending`, `firing`, `reset` или `resolved`. Например:',
		'',
		'```',
		...(multi
			? ['60 api-1 pending', '60 api-3 pending', '180 api-1 firing']
			: ['60 pending', '180 firing', '240 resolved']),
		'```'
	);
	return lines.join('\n');
}

// An independent reference: reads the shown rule (YAML) and the shown table, and steps the alerts through the model.
const PYTHON_REFERENCE = `import json, re

data = json.loads(input())
rule = {}
for line in data["yaml"].split("\\n"):
    m = re.match(r"^\\s*-?\\s*(\\w+):\\s*(.*)$", line)
    if m and m.group(2):
        rule[m.group(1)] = m.group(2)

def seconds(text):
    m = re.fullmatch(r"(?:(\\d+)m)?(?:(\\d+)s)?", text)
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)

interval = seconds(rule["interval"])
hold = seconds(rule["for"])
keep = seconds(rule.get("keep_firing_for", "0s"))
m = re.fullmatch(r".*\\s(>=|>|<)\\s([0-9.]+)", rule["expr"])
op, threshold = m.group(1), float(m.group(2))

def returned(cell):
    if cell == "—":
        return False
    v = float(cell)
    return v > threshold if op == ">" else v >= threshold if op == ">=" else v < threshold

events = []
for name, cells in data["columns"]:
    state, active_at, empty_since = "inactive", None, None
    for i, cell in enumerate(cells):
        t = i * interval
        if returned(cell):
            empty_since = None
            if state == "inactive":
                active_at = t
                state = "pending"
                if hold == 0:
                    state = "firing"
                events.append((t, name, "firing" if hold == 0 else "pending"))
            elif state == "pending" and t - active_at >= hold:
                state = "firing"
                events.append((t, name, "firing"))
        elif state == "pending":
            state = "inactive"
            events.append((t, name, "reset"))
        elif state == "firing":
            if empty_since is None:
                empty_since = t
            if t - empty_since >= keep:
                state = "inactive"
                empty_since = None
                events.append((t, name, "resolved"))
events.sort(key=lambda e: (e[0], e[1] or ""))
for t, name, event in events:
    print(t, event) if name is None else print(t, name, event)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/reset': ['no-reset', 'strict-for'],
	'middle/for-not-multiple': ['fire-at-for'],
	'middle/threshold-equal': ['compare-flip', 'resolve-after-for'],
	'middle/for-zero': ['pending-first'],
	'senior/keep-firing': ['ignore-keep', 'keep-from-last-true'],
	'senior/missing-data': ['missing-holds-value', 'no-reset'],
	'senior/multi-series': ['one-alert', 'strict-for'],
	'senior/keep-reset': ['keep-no-reset', 'keep-from-last-true']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = answerOf(p, RIGHT);
		if (!fits(p, input.classId, answer)) continue;
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = yaml(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source } },
			answer: { kind: 'sequence', value: answer }
		});
		const columns = p.series.map((s) => [s.instance, s.values.map(cell)]);
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ yaml: source, columns }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
