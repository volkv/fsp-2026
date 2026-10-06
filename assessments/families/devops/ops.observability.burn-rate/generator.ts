// Multiwindow burn-rate alerts over a piecewise error ratio: at every evaluation an alert is on when the burn rate is
// above its threshold over both its long and its short window. Middle gets the thresholds; senior derives them from the
// share of the SLO window's budget an alert may let burn over its long window.
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

const STEP = 5;

interface Alert {
	name: 'fast' | 'slow';
	long: number;
	short: number;
	/** Middle: the burn-rate threshold in tenths (14.4 is 144). */
	factor10: number;
	/** Senior: the share of the SLO window's budget spent over the long window, %. */
	budgetPct: number;
}

interface Params {
	grade: 'middle' | 'senior';
	classId: string;
	service: string;
	/** SLO in hundredths of a percent; error ratios in hundredths of a percent too. */
	slo: number;
	days: number;
	/** Start of the observation, minutes of the day. */
	start: number;
	horizon: number;
	history: number;
	segments: { from: number; to: number; ratio: number }[];
	alerts: Alert[];
}

interface Rules {
	longOnly: boolean;
	shortOnly: boolean;
	ignoreHistory: boolean;
	defaultParams: boolean;
	days30: boolean;
	factorFromShort: boolean;
}

const RIGHT: Rules = {
	longOnly: false,
	shortOnly: false,
	ignoreHistory: false,
	defaultParams: false,
	days30: false,
	factorFromShort: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'long-only': { longOnly: true },
	'short-only': { shortOnly: true },
	'ignore-history': { ignoreHistory: true },
	'default-params': { defaultParams: true },
	'days-30': { days30: true },
	'factor-from-short': { factorFromShort: true }
};

const STANDARD: Alert[] = [
	{ name: 'fast', long: 60, short: 5, factor10: 144, budgetPct: 2 },
	{ name: 'slow', long: 360, short: 30, factor10: 60, budgetPct: 5 }
];

/** Sum of the error ratio over the minutes [t − w, t). */
function windowSum(p: Params, t: number, w: number, rules: Rules): number {
	let sum = 0;
	for (const s of p.segments) sum += Math.max(0, Math.min(t, s.to) - Math.max(t - w, s.from)) * s.ratio;
	if (!rules.ignoreHistory) sum += Math.max(0, Math.min(t, 0) - (t - w)) * p.history;
	return sum;
}

/** Whether the burn rate over a window of w minutes is above the alert's threshold. */
function above(p: Params, a: Alert, t: number, w: number, rules: Rules): boolean {
	const budget = 10000 - p.slo;
	const sum = windowSum(p, t, w, rules);
	if (p.grade === 'middle') return sum * 10 > a.factor10 * budget * w;
	// burn = (sum / w) / budget > pct/100 · window / basis, where basis is the long window (or the short one, wrongly).
	const windowMinutes = (rules.days30 ? 30 : p.days) * 1440;
	const basis = rules.factorFromShort ? a.short : a.long;
	return 100 * basis * sum > a.budgetPct * windowMinutes * budget * w;
}

function events(p: Params, rules: Rules): string[] {
	const alerts = rules.defaultParams ? STANDARD : p.alerts;
	const out: { t: number; line: string }[] = [];
	for (const a of alerts) {
		let on = false;
		for (let t = STEP; t <= p.horizon; t += STEP) {
			const long = above(p, a, t, a.long, rules);
			const short = above(p, a, t, a.short, rules);
			const now = rules.longOnly ? long : rules.shortOnly ? short : long && short;
			if (now !== on) out.push({ t, line: `${clock(p.start + t)} ${a.name} ${now ? 'on' : 'off'}` });
			on = now;
		}
	}
	out.sort((x, y) => x.t - y.t || x.line.localeCompare(y.line));
	return out.map((e) => e.line);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SERVICES = ['checkout', 'payments', 'search', 'orders-api', 'auth', 'catalog', 'delivery'];

function segments(rng: Rng, budget: number, classId: string): { from: number; to: number; ratio: number }[] {
	const cap = (x: number): number => Math.min(10000, x);
	const base = (): number => rng.int(1, Math.max(1, Math.floor(budget / 2)));
	const dur = (lo: number, hi: number): number => STEP * rng.int(lo / STEP, hi / STEP);
	const plan: { minutes: number; ratio: number }[] = [{ minutes: dur(10, 40), ratio: base() }];
	if (classId === 'fast-spike' || classId === 'derived-thresholds') {
		plan.push({ minutes: dur(10, 30), ratio: cap(budget * rng.int(25, 80)) });
		plan.push({ minutes: dur(30, 90), ratio: rng.bool() ? base() : budget * rng.int(2, 5) });
	} else if (classId === 'slow-burn' || classId === 'history') {
		plan.push({ minutes: dur(60, 150), ratio: budget * rng.int(7, 13) });
		plan.push({ minutes: dur(30, 60), ratio: base() });
	} else {
		plan.push({ minutes: dur(15, 45), ratio: cap(budget * rng.int(20, 60)) });
		plan.push({ minutes: dur(30, 90), ratio: budget * rng.int(6, 14) });
		plan.push({ minutes: dur(30, 60), ratio: base() });
	}
	let at = 0;
	return plan.map((s) => {
		const seg = { from: at, to: at + s.minutes, ratio: s.ratio };
		at += s.minutes;
		return seg;
	});
}

function scenario(rng: Rng, grade: 'middle' | 'senior', classId: string): Params {
	const slo = rng.pick([9990, 9950, 9900, 9995]);
	const budget = 10000 - slo;
	const segs = segments(rng, budget, classId);
	const horizon = segs[segs.length - 1]?.to ?? 60;
	const elevated = classId === 'slow-burn' || classId === 'history';
	const p: Params = {
		grade,
		classId,
		service: rng.pick(SERVICES),
		slo,
		days: classId === 'derived-thresholds' ? 28 : rng.pick([28, 30]),
		start: 60 * rng.int(0, 23 - Math.ceil(horizon / 60)),
		horizon,
		history: elevated ? budget * rng.int(3, 5) : rng.int(1, Math.max(1, Math.floor(budget / 2))),
		segments: segs,
		alerts: STANDARD.map((a) => ({ ...a }))
	};
	if (classId === 'custom-params') {
		const [long, short] = rng.pick([
			[30, 5],
			[60, 5],
			[120, 10]
		] as const);
		const [slowLong, slowShort] = rng.pick([
			[180, 15],
			[360, 30],
			[720, 60]
		] as const);
		p.alerts = [
			{ name: 'fast', long, short, factor10: rng.pick([100, 120, 160, 200]), budgetPct: 0 },
			{ name: 'slow', long: slowLong, short: slowShort, factor10: rng.pick([30, 40, 50, 80]), budgetPct: 0 }
		];
	}
	if (classId === 'custom-budget') {
		const long = rng.pick([60, 120]);
		const slowLong = rng.pick([180, 720]);
		p.alerts = [
			{ name: 'fast', long, short: long / 12, factor10: 0, budgetPct: rng.pick([1, 3, 4]) },
			{ name: 'slow', long: slowLong, short: slowLong / 12, factor10: 0, budgetPct: rng.pick([3, 10]) }
		];
	}
	return p;
}

/** Whether the drawn scenario shows what its class is about. */
function fits(p: Params, answer: readonly string[]): boolean {
	const fired = (name: string): boolean => answer.some((l) => l.endsWith(`${name} on`));
	if (p.classId === 'slow-burn' || p.classId === 'history') return fired('slow');
	if (p.classId === 'both-alerts') return fired('fast') && fired('slow');
	return fired('fast') && answer.length <= 6;
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (minutes: number): string => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const pct = (hundredths: number): string =>
	(hundredths / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
const tenths = (x: number): string => (x / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');

function shown(p: Params) {
	return {
		grade: p.grade,
		slo: pct(p.slo),
		days: p.days,
		start: clock(p.start),
		end: clock(p.start + p.horizon),
		history: pct(p.history),
		segments: p.segments.map((s) => ({
			from: clock(p.start + s.from),
			to: clock(p.start + s.to),
			ratio: pct(s.ratio)
		})),
		alerts: p.alerts.map((a) => ({
			name: a.name,
			long: a.long,
			short: a.short,
			factor: tenths(a.factor10),
			budgetPct: a.budgetPct
		}))
	};
}

function describe(p: Params): string {
	const s = shown(p);
	const budget = pct(10000 - p.slo);
	const lines = [
		`SLO сервиса \`${p.service}\` — ${s.slo} % успешных запросов за окно ${p.days} суток; бюджет ошибок — ${budget} % запросов. Трафик равномерный, поэтому **скорость сжигания** за окно — средняя доля ошибок за окно, делённая на ${budget} %.`,
		''
	];
	if (p.grade === 'middle') {
		lines.push('Оповещения:', '');
		for (const a of s.alerts)
			lines.push(
				`- \`${a.name}\`: скорость сжигания больше ${a.factor} и за последние ${a.long} мин, и за последние ${a.short} мин${a.name === 'fast' ? ';' : '.'}`
			);
	} else {
		lines.push(
			'Порог скорости сжигания оповещения — такой, при котором за его длинное окно расходуется заданная доля бюджета всего окна SLO. Оповещение включено, когда скорость сжигания больше порога и за длинное, и за короткое окно. Оповещения:',
			''
		);
		for (const a of s.alerts)
			lines.push(
				`- \`${a.name}\`: ${a.budgetPct} % бюджета за длинное окно ${a.long} мин, короткое окно — ${a.short} мин${a.name === 'fast' ? ';' : '.'}`
			);
	}
	lines.push(
		'',
		`Правила вычисляются каждые ${STEP} мин: в ${clock(p.start + STEP)}, ${clock(p.start + 2 * STEP)}, … и последний раз в ${s.end}. Окно длиной W в момент t — последние W минут до t. До первого вычисления оповещения выключены; оповещение включается (\`on\`) на вычислении, где его условие выполнено, и выключается (\`off\`) на первом вычислении, где не выполнено.`,
		'',
		'Доля ошибок:',
		'',
		`- до ${s.start} (и не меньше суток до этого) — ${s.history} %;`,
		...s.segments.map(
			(seg, i) => `- с ${seg.from} до ${seg.to} — ${seg.ratio} %${i === s.segments.length - 1 ? '.' : ';'}`
		),
		'',
		'Введите события по порядку, по одному в строке: `<ЧЧ:ММ> <оповещение> <on|off>`; события одного момента — сначала `fast`, затем `slow`. Например:',
		'',
		'```',
		'10:35 fast on',
		'10:50 fast off',
		'11:05 slow on',
		'```'
	);
	return lines.join('\n');
}

// An independent reference: expands the shown error ratio minute by minute and checks every window with fractions.
const PYTHON_REFERENCE = `import json
from fractions import Fraction

s = json.loads(input())

def minute(text):
    h, m = text.split(":")
    return int(h) * 60 + int(m)

def ratio(text):
    return Fraction(text.replace(",", ".")) / 100

start = minute(s["start"])
end = minute(s["end"])
history = ratio(s["history"])
error = {}
for seg in s["segments"]:
    for m in range(minute(seg["from"]), minute(seg["to"])):
        error[m] = ratio(seg["ratio"])

def avg(t, w):
    return sum((error.get(m, history) if m >= start else history) for m in range(t - w, t)) / w

budget = 1 - ratio(s["slo"])
lines = []
for a in s["alerts"]:
    if s["grade"] == "middle":
        threshold = Fraction(a["factor"].replace(",", "."))
    else:
        threshold = Fraction(a["budgetPct"], 100) * s["days"] * 1440 / a["long"]
    on = False
    for t in range(start + 5, end + 1, 5):
        now = avg(t, a["long"]) / budget > threshold and avg(t, a["short"]) / budget > threshold
        if now != on:
            lines.append((t, a["name"], "%02d:%02d %s %s" % (t // 60, t % 60, a["name"], "on" if now else "off")))
        on = now
for _, _, line in sorted(lines):
    print(line)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/fast-spike': ['long-only', 'short-only'],
	'middle/slow-burn': ['long-only', 'ignore-history'],
	'middle/both-alerts': ['long-only', 'short-only'],
	'middle/custom-params': ['default-params', 'long-only'],
	'senior/derived-thresholds': ['days-30', 'factor-from-short'],
	'senior/history': ['ignore-history', 'long-only'],
	'senior/both-alerts': ['long-only', 'short-only'],
	'senior/custom-budget': ['default-params', 'factor-from-short']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const grade = input.grade === 'middle' ? 'middle' : 'senior';
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, grade, input.classId);
		const answer = events(p, RIGHT);
		if (!fits(p, answer)) continue;
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = events(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		const required = REQUIRED[`${grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(shown(p)) }),
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
