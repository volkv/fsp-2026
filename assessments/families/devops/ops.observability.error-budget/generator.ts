// Error budget of an SLO: how much of it the incidents of the window spent, how much is left and which share of it
// is gone. Middle counts time (weighted by the share of errors, or bad minutes against a threshold, with a rolling
// window cutting an incident); senior counts requests under uneven day and night traffic, with maintenance excluded
// from the window or two SLOs of one service with budgets of their own.
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

const DAY = 1440;
const DAY_FROM = 8 * 60;
const DAY_TO = 20 * 60;

/** An incident: start (minutes from 2026-01-01 00:00 UTC, null when only its length is given), length, shares in %. */
interface Incident {
	start: number | null;
	minutes: number;
	share: number;
	/** Two SLOs: the share of successful requests slower than the latency threshold. */
	slow: number;
}

interface Params {
	grade: 'middle' | 'senior';
	classId: string;
	service: string;
	windowDays: number;
	/** SLO in hundredths of a percent: 9990 is 99.9 %. */
	slo: number;
	latencySlo: number;
	latencyMs: number;
	/** Bad-minute SLI: the threshold share of errors, %. */
	threshold: number;
	/** Window start and end in minutes; a window without dates when both are null. */
	from: number | null;
	to: number | null;
	rolling: boolean;
	dayRate: number;
	nightRate: number;
	maintenance: { start: number; minutes: number }[];
	incidents: Incident[];
}

interface Rules {
	fullDuration: boolean;
	clamp: boolean;
	wholeIncidents: boolean;
	shareWeighted: boolean;
	strictThreshold: boolean;
	averageRate: boolean;
	bandByStart: boolean;
	maintenanceErrors: boolean;
	maintenanceInTotal: boolean;
	errorsInLatency: boolean;
	sharedBudget: boolean;
}

const RIGHT: Rules = {
	fullDuration: false,
	clamp: false,
	wholeIncidents: false,
	shareWeighted: false,
	strictThreshold: false,
	averageRate: false,
	bandByStart: false,
	maintenanceErrors: false,
	maintenanceInTotal: false,
	errorsInLatency: false,
	sharedBudget: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'full-duration': { fullDuration: true },
	clamp: { clamp: true },
	'whole-incidents': { wholeIncidents: true },
	'share-weighted': { shareWeighted: true },
	'strict-threshold': { strictThreshold: true },
	'average-rate': { averageRate: true },
	'band-by-start': { bandByStart: true },
	'maintenance-errors': { maintenanceErrors: true },
	'maintenance-in-total': { maintenanceInTotal: true },
	'errors-in-latency': { errorsInLatency: true },
	'shared-budget': { sharedBudget: true }
};

const isDay = (minute: number): boolean => {
	const m = ((minute % DAY) + DAY) % DAY;
	return m >= DAY_FROM && m < DAY_TO;
};

/** Cuts [a, b) into pieces that lie inside one traffic band: day 08:00–20:00 or night. */
function bandPieces(a: number, b: number): { from: number; to: number; day: boolean }[] {
	const pieces: { from: number; to: number; day: boolean }[] = [];
	let at = a;
	while (at < b) {
		const base = Math.floor(at / DAY) * DAY;
		const edges = [base + DAY_FROM, base + DAY_TO, base + DAY].filter((e) => e > at);
		const next = Math.min(b, edges[0] ?? b);
		pieces.push({ from: at, to: next, day: isDay(at) });
		at = next;
	}
	return pieces;
}

/** Parts of [a, b) outside the maintenance windows. */
function outside(a: number, b: number, windows: readonly { start: number; minutes: number }[]): [number, number][] {
	let parts: [number, number][] = [[a, b]];
	for (const w of windows) {
		const wa = w.start;
		const wb = w.start + w.minutes;
		parts = parts.flatMap(([x, y]): [number, number][] => {
			if (wb <= x || wa >= y) return [[x, y]];
			const left: [number, number][] = x < wa ? [[x, wa]] : [];
			const right: [number, number][] = wb < y ? [[wb, y]] : [];
			return [...left, ...right];
		});
	}
	return parts;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));

function middleAnswer(p: Params, rules: Rules): string {
	const budget = ((10000 - p.slo) * p.windowDays * 864) / 100;
	let spent = 0;
	for (const inc of p.incidents) {
		let minutes = inc.minutes;
		if (inc.start !== null && p.from !== null && p.to !== null && !rules.wholeIncidents) {
			minutes = Math.max(0, Math.min(inc.start + inc.minutes, p.to) - Math.max(inc.start, p.from));
		}
		if (p.classId === 'bad-minutes' && !rules.shareWeighted && !rules.fullDuration) {
			const bad = rules.strictThreshold ? inc.share > p.threshold : inc.share >= p.threshold;
			spent += bad ? minutes * 60 : 0;
		} else spent += rules.fullDuration ? minutes * 60 : (minutes * 60 * inc.share) / 100;
	}
	if (rules.clamp && spent > budget) return `${fmt(spent)} 0 100`;
	return `${fmt(spent)} ${fmt(budget - spent)} ${Math.floor((spent * 100) / budget)}`;
}

function seniorAnswer(p: Params, rules: Rules): string {
	const from = p.from ?? 0;
	const to = p.to ?? 0;
	const average = (p.dayRate + p.nightRate) / 2;
	let total = p.windowDays * 43200 * (p.dayRate + p.nightRate);
	if (!rules.maintenanceInTotal) {
		for (const w of p.maintenance) {
			for (const piece of bandPieces(w.start, w.start + w.minutes)) {
				total -= (piece.to - piece.from) * 60 * (piece.day ? p.dayRate : p.nightRate);
			}
		}
	}
	let errors = 0;
	let slow = 0;
	for (const inc of p.incidents) {
		const start = inc.start ?? 0;
		const a = rules.wholeIncidents ? start : Math.max(start, from);
		const b = rules.wholeIncidents ? start + inc.minutes : Math.min(start + inc.minutes, to);
		if (b <= a) continue;
		const parts: [number, number][] = rules.maintenanceErrors ? [[a, b]] : outside(a, b, p.maintenance);
		for (const [x, y] of parts) {
			for (const piece of bandPieces(x, y)) {
				const rate = rules.averageRate
					? average
					: rules.bandByStart
						? isDay(start)
							? p.dayRate
							: p.nightRate
						: piece.day
							? p.dayRate
							: p.nightRate;
				const requests = (piece.to - piece.from) * 60 * rate;
				const share = rules.fullDuration ? 100 : inc.share;
				errors += (requests * share) / 100;
				slow += (requests * (rules.errorsInLatency ? inc.slow + inc.share : inc.slow)) / 100;
			}
		}
	}
	const budget = Math.floor((total * (10000 - p.slo)) / 10000);
	if (p.classId === 'two-slo') {
		const latencyBudget = rules.sharedBudget ? budget : Math.floor((total * (10000 - p.latencySlo)) / 10000);
		return `${Math.floor((errors * 100) / budget)} ${Math.floor((slow * 100) / latencyBudget)}`;
	}
	if (rules.clamp && errors > budget) return `${fmt(errors)} 0 100`;
	return `${fmt(errors)} ${fmt(budget - errors)} ${Math.floor((errors * 100) / budget)}`;
}

const answerOf = (p: Params, rules: Rules): string =>
	p.grade === 'middle' ? middleAnswer(p, rules) : seniorAnswer(p, rules);

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SERVICES = ['orders-api', 'payments', 'search', 'checkout', 'profile-api', 'catalog', 'auth', 'notifications'];
const MIDDLE_SLO: Record<number, number[]> = { 28: [9900, 9950, 9975], 30: [9900, 9950, 9975, 9990, 9995] };
const SENIOR_SLO = [9900, 9950, 9975, 9990, 9995];

function base(rng: Rng, grade: 'middle' | 'senior', classId: string): Params {
	const windowDays = rng.pick([28, 30]);
	return {
		grade,
		classId,
		service: rng.pick(SERVICES),
		windowDays,
		slo: grade === 'middle' ? rng.pick(MIDDLE_SLO[windowDays] ?? [9900]) : rng.pick(SENIOR_SLO),
		latencySlo: 0,
		latencyMs: 0,
		threshold: 0,
		from: null,
		to: null,
		rolling: false,
		dayRate: 0,
		nightRate: 0,
		maintenance: [],
		incidents: []
	};
}

function middleScenario(rng: Rng, classId: string): Params {
	const p = base(rng, 'middle', classId);
	const budgetMin = ((10000 - p.slo) * p.windowDays * 864) / 100 / 60;
	const lo = Math.max(3, Math.round(budgetMin * 0.06));
	const hi = Math.max(lo + 8, Math.round(budgetMin * (classId === 'overspent' ? 0.9 : 0.35)));
	const share = (): number => (rng.bool(0.15) ? 100 : 5 * rng.int(2, 19));
	if (classId === 'bad-minutes') {
		p.threshold = rng.pick([2, 5, 10]);
		const kinds = rng.shuffle(['below', 'equal', 'above', rng.pick(['below', 'above']), rng.pick(['below', 'above'])]);
		p.incidents = kinds.slice(0, rng.int(4, 5)).map((kind) => ({
			start: null,
			minutes: rng.int(lo, hi),
			share:
				kind === 'equal' ? p.threshold : kind === 'below' ? rng.int(1, p.threshold - 1) : rng.int(p.threshold + 1, 60),
			slow: 0
		}));
		return p;
	}
	if (classId === 'window-boundary') {
		const now = rng.int(60, 300) * DAY + rng.int(0, 23) * 60;
		const from = now - p.windowDays * DAY;
		p.to = now;
		p.from = from;
		p.rolling = true;
		const long = Math.max(lo, 20);
		const inside = Array.from({ length: rng.int(3, 4) }, () => {
			const minutes = rng.int(lo, hi);
			return { start: rng.int(from + 60, now - minutes - 1), minutes, share: share(), slow: 0 };
		});
		const straddle = rng.int(long, Math.max(long + 10, hi));
		const before = rng.int(lo, hi);
		p.incidents = [
			...inside,
			{ start: from - rng.int(5, straddle - 5), minutes: straddle, share: share(), slow: 0 },
			{ start: from - rng.int(before + 30, 3 * DAY), minutes: before, share: share(), slow: 0 }
		].sort((x, y) => x.start - y.start);
		return p;
	}
	p.incidents = Array.from({ length: rng.int(3, 5) }, () => ({
		start: null,
		minutes: rng.int(lo, hi),
		share: share(),
		slow: 0
	}));
	return p;
}

function seniorScenario(rng: Rng, classId: string): Params {
	const p = base(rng, 'senior', classId);
	p.dayRate = 25 * rng.int(12, 48);
	p.nightRate = 25 * rng.int(2, 10);
	const avgMinutes = (p.windowDays * DAY * (10000 - p.slo)) / 10000;
	const lo = Math.max(5, Math.round(avgMinutes * 0.05));
	const hi = Math.max(lo + 15, Math.round(avgMinutes * 0.3));
	const share = (): number => 5 * rng.int(2, 20);
	const day0 = rng.int(0, 10) * 30 + rng.int(0, 5);
	if (classId === 'rolling-window') {
		p.to = day0 * DAY + p.windowDays * DAY + rng.int(0, 23) * 60;
		p.from = p.to - p.windowDays * DAY;
		p.rolling = true;
	} else {
		p.from = day0 * DAY;
		p.to = p.from + p.windowDays * DAY;
	}
	const from = p.from;
	const to = p.to;
	const anywhere = (minutes: number): number => rng.int(from + 30, to - minutes - 30);
	const acrossBand = (minutes: number): number => {
		const day = rng.int(1, p.windowDays - 2);
		const edge = from - (from % DAY) + day * DAY + rng.pick([DAY_FROM, DAY_TO]);
		return edge - rng.int(5, minutes - 5);
	};
	const incident = (start: number, minutes: number): Incident => ({ start, minutes, share: share(), slow: 0 });
	const n = rng.int(3, 4);
	const incidents: Incident[] = [];
	for (let i = 0; i < n; i += 1) {
		const minutes = rng.int(Math.max(lo, 15), hi);
		incidents.push(incident(i === 0 ? acrossBand(minutes) : anywhere(minutes), minutes));
	}
	if (classId === 'rolling-window') {
		const minutes = rng.int(Math.max(lo, 20), Math.max(hi, 40));
		incidents.push(incident(from - rng.int(5, minutes - 5), minutes));
	}
	if (classId === 'maintenance') {
		for (const day of rng.sample(range(1, p.windowDays - 2), rng.int(1, 2)).sort((a, b) => a - b)) {
			p.maintenance.push({ start: from + day * DAY + rng.int(0, 22) * 60, minutes: 30 * rng.int(1, 8) });
		}
		const first = p.maintenance[0] ?? { start: from + DAY, minutes: 60 };
		const minutes = rng.int(Math.max(lo, 20), Math.max(hi, 40));
		incidents.push(incident(first.start - rng.int(5, Math.min(minutes - 5, minutes)), minutes));
	}
	if (classId === 'two-slo') {
		p.latencySlo = rng.pick([9900, 9950, 9975]);
		p.latencyMs = rng.pick([200, 300, 500, 800]);
		for (const inc of incidents) {
			inc.share = 5 * rng.int(1, 8);
			// Failed and slow successful requests are disjoint shares of the same requests.
			inc.slow = 5 * rng.int(2, Math.min(14, (100 - inc.share) / 5));
		}
	}
	p.incidents = incidents.sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
	return p;
}

/** Whether the drawn scenario has the shape its class promises. */
function fits(p: Params): boolean {
	// One stream of requests has one share of errors at a time: incidents with dates never overlap.
	const dated = p.incidents.filter((i) => i.start !== null).sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
	if (dated.some((inc, i) => i > 0 && (inc.start ?? 0) < (dated[i - 1]?.start ?? 0) + (dated[i - 1]?.minutes ?? 0)))
		return false;
	if (p.incidents.some((i) => i.share + i.slow > 100)) return false;
	const right = answerOf(p, RIGHT);
	const [spent, remaining] = right.split(' ').map(Number);
	if (p.classId === 'partial-share')
		return (remaining ?? 0) >= 0 && p.incidents.filter((i) => i.share < 100).length >= 2;
	if (p.classId === 'overspent') return (remaining ?? 0) < 0;
	if (p.grade === 'senior' && p.classId !== 'two-slo') return (spent ?? 0) > 0;
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const pad = (n: number): string => String(n).padStart(2, '0');

function when(minute: number): string {
	const d = new Date(Date.UTC(2026, 0, 1) + minute * 60_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const pct = (hundredths: number): string => {
	const s = (hundredths / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
	return s.replace('.', ',');
};

/** What the statement shows, in the form it shows it; the reference reads only this. */
function shown(p: Params) {
	return {
		grade: p.grade,
		sli: p.classId === 'bad-minutes' ? 'minutes' : p.grade === 'middle' ? 'time' : 'requests',
		twoSlo: p.classId === 'two-slo',
		windowDays: p.windowDays,
		slo: pct(p.slo),
		latencySlo: pct(p.latencySlo),
		threshold: p.threshold,
		from: p.from === null ? null : when(p.from),
		to: p.to === null ? null : when(p.to),
		dayRate: p.dayRate,
		nightRate: p.nightRate,
		maintenance: p.maintenance.map((w) => ({ start: when(w.start), minutes: w.minutes })),
		incidents: p.incidents.map((i) => ({
			start: i.start === null ? null : when(i.start),
			minutes: i.minutes,
			share: i.share,
			slow: i.slow
		}))
	};
}

function describe(p: Params): string {
	const s = shown(p);
	const lines: string[] = [];
	if (p.grade === 'middle') {
		lines.push(
			`SLO сервиса \`${p.service}\` — доступность ${s.slo} % за окно ${p.windowDays} суток. Бюджет ошибок — ${pct(10000 - p.slo)} % длительности окна.`
		);
		if (p.classId === 'bad-minutes') {
			lines.push(
				'',
				`Доступность считается по минутам: минута **плохая**, если доля неуспешных запросов в ней не меньше ${p.threshold} %. Каждая плохая минута расходует минуту бюджета целиком, остальные минуты бюджет не расходуют. Во время инцидента доля ошибок постоянна; все инциденты целиком внутри окна, длительности — в целых минутах.`
			);
		} else {
			lines.push(
				'',
				'Инцидент длительностью D минут с долей неуспешных запросов p % расходует D · p / 100 минут бюджета (столько длился бы полный отказ с тем же числом ошибок). Во время инцидента доля ошибок постоянна.'
			);
			if (p.rolling) {
				lines.push(
					'',
					`Окно скользящее: сейчас ${s.to} UTC, в окно входят последние ${p.windowDays} суток — с ${s.from} UTC. Инцидент учитывается только той частью, которая попадает в окно.`
				);
			} else lines.push('', 'Все инциденты целиком внутри окна.');
		}
		lines.push('', 'Инциденты:', '');
		p.incidents.forEach((inc, i) => {
			const at = inc.start === null ? '' : `начало ${when(inc.start)} UTC, `;
			lines.push(`${i + 1}. ${at}${inc.minutes} мин, доля неуспешных запросов ${inc.share} %`);
		});
		lines.push(
			'',
			'Введите три числа через пробел: сколько бюджета израсходовано (в секундах), сколько осталось (в секундах; если бюджет превышен — отрицательное число) и какая доля бюджета израсходована, в процентах с округлением вниз до целого (может быть больше 100). Например: `1530 1062 59`.'
		);
		return lines.join('\n');
	}
	const window = p.rolling
		? `скользящее окно: сейчас ${s.to} UTC, в окно входят последние ${p.windowDays} суток — с ${s.from} UTC`
		: `окно ${p.windowDays} суток: с ${s.from} до ${s.to} UTC`;
	if (p.classId === 'two-slo') {
		lines.push(
			`У сервиса \`${p.service}\` два SLO за ${window}:`,
			'',
			`- **доступность**: не меньше ${s.slo} % запросов успешны;`,
			`- **задержка**: SLO ${s.latencySlo} % — успешных, но медленных запросов (${p.latencyMs} мс и дольше) не больше ${pct(10000 - p.latencySlo)} % от всех запросов окна.`,
			'',
			`Неуспешный запрос расходует только бюджет доступности: к SLO задержки он не относится, сколько бы ни длился. Успешный, но медленный запрос расходует только бюджет задержки. Бюджет каждого SLO — (100 % − SLO) от всех запросов окна, округлённое вниз до целого числа запросов.`
		);
	} else {
		lines.push(
			`SLO сервиса \`${p.service}\` — не меньше ${s.slo} % успешных запросов; ${window}. Бюджет ошибок — ${pct(10000 - p.slo)} % от всех запросов окна, округлённое вниз до целого числа запросов. Каждый неуспешный запрос расходует один запрос бюджета.`
		);
	}
	lines.push(
		'',
		`Нагрузка постоянна внутри каждого интервала: днём (с 08:00 до 20:00 UTC) — ${p.dayRate} запросов в секунду, ночью (с 20:00 до 08:00 UTC) — ${p.nightRate}. ${p.classId === 'two-slo' ? 'Доли неуспешных и медленных запросов указаны от всех запросов и во время инцидента постоянны.' : 'Доля неуспешных запросов во время инцидента постоянна.'}`
	);
	if (p.rolling) lines.push('', 'Инцидент учитывается только той частью, которая попадает в окно.');
	if (p.maintenance.length) {
		lines.push(
			'',
			'Плановые работы исключены из SLO: их запросы не входят в число запросов окна, а ошибки во время работ не расходуют бюджет. Работы:',
			'',
			...p.maintenance.map((w) => `- с ${when(w.start)} UTC, ${w.minutes} мин`)
		);
	}
	lines.push('', 'Инциденты:', '');
	p.incidents.forEach((inc, i) => {
		const extra = p.classId === 'two-slo' ? `, доля успешных, но медленных — ${inc.slow} %` : '';
		lines.push(
			`${i + 1}. начало ${when(inc.start ?? 0)} UTC, ${inc.minutes} мин, доля неуспешных запросов ${inc.share} %${extra}`
		);
	});
	lines.push(
		'',
		p.classId === 'two-slo'
			? 'Введите два числа через пробел: какая доля бюджета доступности и какая доля бюджета задержки израсходованы, в процентах с округлением вниз до целого (может быть больше 100). Например: `37 112`.'
			: 'Введите три числа через пробел: сколько бюджета израсходовано (неуспешных запросов), сколько осталось (если бюджет превышен — отрицательное число) и какая доля бюджета израсходована, в процентах с округлением вниз до целого (может быть больше 100). Например: `264600 95400 73`.'
	);
	return lines.join('\n');
}

// An independent reference: reads what the statement shows and walks the incidents minute by minute.
const PYTHON_REFERENCE = `import json
from datetime import datetime, timedelta

s = json.loads(input())

def parse(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M")

def hundredths(text):
    whole, _, frac = text.replace(",", ".").partition(".")
    return int(whole) * 100 + int((frac + "00")[:2])

budget_share = 10000 - hundredths(s["slo"])
if s["grade"] == "middle":
    window = s["windowDays"] * 86400
    budget = window * budget_share // 10000
    assert budget * 10000 == window * budget_share
    lo = parse(s["from"]) if s["from"] else None
    hi = parse(s["to"]) if s["to"] else None
    spent = 0
    for inc in s["incidents"]:
        minutes = 0
        for k in range(inc["minutes"]):
            if inc["start"] is not None:
                t = parse(inc["start"]) + timedelta(minutes=k)
                if not (lo <= t < hi):
                    continue
            minutes += 1
        if s["sli"] == "minutes":
            spent += minutes * 60 if inc["share"] >= s["threshold"] else 0
        else:
            assert (minutes * 60 * inc["share"]) % 100 == 0
            spent += minutes * 60 * inc["share"] // 100
    print(spent, budget - spent, spent * 100 // budget)
else:
    lo, hi = parse(s["from"]), parse(s["to"])
    def rate(t):
        return s["dayRate"] if 8 <= t.hour < 20 else s["nightRate"]
    def in_maintenance(t):
        for w in s["maintenance"]:
            a = parse(w["start"])
            if a <= t < a + timedelta(minutes=w["minutes"]):
                return True
        return False
    total = 0
    t = lo
    while t < hi:
        if not in_maintenance(t):
            total += 60 * rate(t)
        t += timedelta(minutes=1)
    errors = 0
    slow = 0
    for inc in s["incidents"]:
        start = parse(inc["start"])
        for k in range(inc["minutes"]):
            t = start + timedelta(minutes=k)
            if not (lo <= t < hi) or in_maintenance(t):
                continue
            errors += 60 * rate(t) * inc["share"]
            slow += 60 * rate(t) * inc["slow"]
    assert errors % 100 == 0 and slow % 100 == 0
    errors //= 100
    slow //= 100
    budget = total * budget_share // 10000
    if s["twoSlo"]:
        latency_budget = total * (10000 - hundredths(s["latencySlo"])) // 10000
        print(errors * 100 // budget, slow * 100 // latency_budget)
    else:
        print(errors, budget - errors, errors * 100 // budget)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/partial-share': ['full-duration'],
	'middle/overspent': ['clamp', 'full-duration'],
	'middle/window-boundary': ['whole-incidents', 'full-duration'],
	'middle/bad-minutes': ['share-weighted', 'strict-threshold'],
	'senior/uneven-traffic': ['average-rate', 'band-by-start'],
	'senior/maintenance': ['maintenance-errors', 'maintenance-in-total'],
	'senior/rolling-window': ['whole-incidents', 'average-rate'],
	'senior/two-slo': ['errors-in-latency', 'shared-budget']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const grade = input.grade === 'middle' ? 'middle' : 'senior';
	for (let tries = 0; tries < 300; tries += 1) {
		const p = grade === 'middle' ? middleScenario(rng, input.classId) : seniorScenario(rng, input.classId);
		if (!fits(p)) continue;
		const answer = answerOf(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(shown(p)) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
