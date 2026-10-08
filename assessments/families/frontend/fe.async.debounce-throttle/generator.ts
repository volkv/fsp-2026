// Debounce and throttle on a timeline: given the moments of input or scroll events and the options of the wrapper
// (lodash 4 `debounce` and `throttle`: wait, leading, trailing, maxWait), when is the handler called and with which
// argument. The statement spells the semantics out; timers fire exactly on time, and a timer due at the moment of an
// event fires first.
//
// The generator computes the answer by the rules the statement gives: series of events for a debounce without maxWait,
// the state machine of the wrapper otherwise. The gate checks it with an independent program in Python, a port of the
// lodash source run on a queue of timers.
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

interface Config {
	kind: 'debounce' | 'throttle';
	wait: number;
	leading: boolean;
	trailing: boolean;
	/** The effective maxWait: `wait` for a throttle, `null` for a debounce without it. */
	maxWait: number | null;
	/** The options as the program writes them. */
	options: string;
}

interface Event {
	t: number;
	arg: string;
}

/** A call of the handler: the moment and the argument. */
type Call = `${number} ${string}`;

/** The misconceptions as switches of the model; all off is the wrapper. */
interface Rules {
	eventFirst: boolean;
	fromFirstEvent: boolean;
	firstArg: boolean;
	leadingTwice: boolean;
	naiveThrottle: boolean;
	ignoreTrailing: boolean;
	ignoreMaxWait: boolean;
}

const RIGHT: Rules = {
	eventFirst: false,
	fromFirstEvent: false,
	firstArg: false,
	leadingTwice: false,
	naiveThrottle: false,
	ignoreTrailing: false,
	ignoreMaxWait: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'boundary-joins': { eventFirst: true },
	'from-first-event': { fromFirstEvent: true },
	'trailing-first-arg': { firstArg: true },
	'leading-twice': { leadingTwice: true },
	'throttle-from-last-call': { naiveThrottle: true },
	'throttle-leading-only': { ignoreTrailing: true },
	'maxwait-ignored': { ignoreMaxWait: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The models.

/**
 * A debounce without maxWait by series: neighbours in a series are less than `wait` apart (exactly `wait` starts a new
 * series, the timer fires first). Leading — a call at the first event; trailing — at the last event + wait with its
 * argument, unless leading is on and the series has one event.
 */
function bySeries(cfg: Config, events: readonly Event[], rules: Rules): Call[] {
	const series: Event[][] = [];
	for (const e of events) {
		const current = series.at(-1);
		const anchor = rules.fromFirstEvent ? current?.[0] : current?.at(-1);
		const joins = anchor !== undefined && (rules.eventFirst ? e.t - anchor.t <= cfg.wait : e.t - anchor.t < cfg.wait);
		if (current && joins) current.push(e);
		else series.push([e]);
	}
	const calls: Call[] = [];
	for (const s of series) {
		const first = s[0];
		const last = s.at(-1);
		if (!first || !last) continue;
		const end = (rules.fromFirstEvent ? first.t : last.t) + cfg.wait;
		if (cfg.leading) calls.push(`${first.t} ${first.arg}`);
		const pending = cfg.leading ? s.slice(1) : s;
		const trailing = cfg.trailing && !rules.ignoreTrailing;
		if (trailing && pending.length > 0) {
			const arg = (rules.firstArg ? pending[0] : pending.at(-1))?.arg ?? '';
			calls.push(`${end} ${arg}`);
		} else if (trailing && rules.leadingTwice) calls.push(`${end} ${last.arg}`);
	}
	return calls;
}

/**
 * The state machine of the statement: the last event E, the start of the window I (the last call or the opening of a
 * window; 0 before the first event), a timer and a pending argument.
 */
function byStateMachine(cfg: Config, maxWait: number, events: readonly Event[], rules: Rules): Call[] {
	const trailing = cfg.trailing && !rules.ignoreTrailing;
	let lastEvent: number | null = null;
	let windowStart = 0;
	let timer: number | null = null;
	let pending: string | null = null;
	const calls: Call[] = [];
	const due = (t: number): boolean => lastEvent === null || t - lastEvent >= cfg.wait || t - windowStart >= maxWait;
	const call = (t: number, arg: string): void => {
		calls.push(`${t} ${arg}`);
		windowStart = t;
		pending = null;
	};
	const fire = (): void => {
		const at = timer;
		if (at === null) return;
		if (due(at)) {
			timer = null;
			if (trailing && pending !== null) call(at, pending);
			pending = null;
		} else {
			timer = Math.min((lastEvent ?? 0) + cfg.wait, windowStart + maxWait);
		}
	};
	for (const e of events) {
		while (timer !== null && (rules.eventFirst ? timer < e.t : timer <= e.t)) fire();
		const now = due(e.t);
		if (!(rules.firstArg && pending !== null)) pending = e.arg;
		lastEvent = e.t;
		if (now && timer === null) {
			windowStart = e.t;
			timer = e.t + cfg.wait;
			if (cfg.leading) call(e.t, e.arg);
		} else if (now) {
			timer = e.t + cfg.wait;
			call(e.t, e.arg);
		} else if (timer === null) timer = e.t + cfg.wait;
	}
	while (timer !== null) fire();
	return calls;
}

/** A throttle as many picture it: a call opens a window of `wait`; at its end the latest pending argument is called. */
function naiveThrottle(cfg: Config, events: readonly Event[]): Call[] {
	const calls: Call[] = [];
	let windowEnd: number | null = null;
	let pending: string | null = null;
	const close = (): void => {
		const end = windowEnd;
		if (end === null) return;
		if (cfg.trailing && pending !== null) {
			calls.push(`${end} ${pending}`);
			pending = null;
			windowEnd = end + cfg.wait;
		} else windowEnd = null;
	};
	for (const e of events) {
		while (windowEnd !== null && windowEnd <= e.t) close();
		if (windowEnd === null) {
			windowEnd = e.t + cfg.wait;
			if (cfg.leading) calls.push(`${e.t} ${e.arg}`);
			else pending = e.arg;
		} else pending = e.arg;
	}
	while (windowEnd !== null) close();
	return calls;
}

/** The calls under the rules; `null` — the misconception does not apply to this wrapper. */
function simulate(cfg: Config, events: readonly Event[], rules: Rules): Call[] | null {
	if (rules.naiveThrottle) return cfg.kind === 'throttle' ? naiveThrottle(cfg, events) : null;
	if (rules.ignoreTrailing && cfg.kind !== 'throttle') return null;
	if (rules.ignoreMaxWait && (cfg.kind !== 'debounce' || cfg.maxWait === null)) return null;
	if (rules.ignoreMaxWait || cfg.maxWait === null) return bySeries(cfg, events, rules);
	if (rules.fromFirstEvent || rules.leadingTwice) return null;
	return byStateMachine(cfg, cfg.maxWait, events, rules);
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: the lodash source ported to Python and run on a queue of timers.

const PYTHON_REFERENCE = `import json

d = json.loads(input())
wait = d["wait"]
leading = d["leading"]
trailing = d["trailing"]
maxing = d["maxWait"] is not None
max_wait = max(d["maxWait"], wait) if maxing else None

clock = {"now": 0}
timers = {}
next_id = [1]
calls = []
s = {"lastArgs": None, "lastCallTime": None, "lastInvokeTime": 0, "timerId": None}


def set_timeout(fn, ms):
    tid = next_id[0]
    next_id[0] += 1
    timers[tid] = (clock["now"] + ms, tid, fn)
    return tid


def clear_timeout(tid):
    timers.pop(tid, None)


def invoke_func(time):
    args = s["lastArgs"]
    s["lastArgs"] = None
    s["lastInvokeTime"] = time
    calls.append(f"{time} {args}")


def leading_edge(time):
    s["lastInvokeTime"] = time
    s["timerId"] = set_timeout(timer_expired, wait)
    if leading:
        invoke_func(time)


def remaining_wait(time):
    time_waiting = wait - (time - s["lastCallTime"])
    if maxing:
        return min(time_waiting, max_wait - (time - s["lastInvokeTime"]))
    return time_waiting


def should_invoke(time):
    if s["lastCallTime"] is None:
        return True
    since_call = time - s["lastCallTime"]
    since_invoke = time - s["lastInvokeTime"]
    return since_call >= wait or since_call < 0 or (maxing and since_invoke >= max_wait)


def trailing_edge(time):
    s["timerId"] = None
    if trailing and s["lastArgs"] is not None:
        invoke_func(time)
        return
    s["lastArgs"] = None


def timer_expired():
    time = clock["now"]
    if should_invoke(time):
        trailing_edge(time)
        return
    s["timerId"] = set_timeout(timer_expired, remaining_wait(time))


def debounced(arg):
    time = clock["now"]
    is_invoking = should_invoke(time)
    s["lastArgs"] = arg
    s["lastCallTime"] = time
    if is_invoking:
        if s["timerId"] is None:
            leading_edge(time)
            return
        if maxing:
            clear_timeout(s["timerId"])
            s["timerId"] = set_timeout(timer_expired, wait)
            invoke_func(time)
            return
    if s["timerId"] is None:
        s["timerId"] = set_timeout(timer_expired, wait)


def run_timers(until):
    while timers:
        due, tid, fn = min(timers.values())
        if until is not None and due > until:
            return
        del timers[tid]
        clock["now"] = due
        fn()


for t, arg in d["events"]:
    run_timers(t)
    clock["now"] = t
    debounced(arg)
run_timers(None)
print("\\n".join(calls))
`;

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const PLOTS = [
	{ event: 'input', handler: 'search', place: 'поле поиска' },
	{ event: 'input', handler: 'validate', place: 'поле формы' },
	{ event: 'scroll', handler: 'loadMore', place: 'лента' },
	{ event: 'resize', handler: 'relayout', place: 'окно' },
	{ event: 'mousemove', handler: 'track', place: 'карта' },
	{ event: 'keyup', handler: 'suggest', place: 'строка адреса' }
] as const;

const step10 = (rng: Rng, min: number, max: number): number => rng.int(Math.ceil(min / 10), Math.floor(max / 10)) * 10;

/** Series of events: inside a series neighbours are less than `wait` apart, between series at least `wait`. */
function seriesTimeline(rng: Rng, wait: number, series: number, sizes: [number, number], exactGap: boolean): number[] {
	const times: number[] = [];
	let t = step10(rng, 0, 100);
	const exactAt = exactGap ? rng.int(1, series - 1) : -1;
	for (let s = 0; s < series; s += 1) {
		if (s > 0) t += s === exactAt ? wait : step10(rng, wait + 30, wait * 2.5);
		const size = rng.int(sizes[0], sizes[1]);
		for (let i = 0; i < size; i += 1) {
			if (i > 0) t += step10(rng, 20, wait - 20);
			times.push(t);
		}
	}
	return times;
}

/** A stream of events less than `wait` apart for a while, pauses between streams; some gaps exactly `wait`. */
function streamTimeline(
	rng: Rng,
	wait: number,
	streams: number,
	length: [number, number],
	exactGaps: boolean
): number[] {
	const times: number[] = [];
	let t = step10(rng, 0, 100);
	for (let s = 0; s < streams; s += 1) {
		if (s > 0) t += exactGaps && rng.bool() ? wait : step10(rng, wait + 20, wait * 2);
		const size = rng.int(length[0], length[1]);
		for (let i = 0; i < size; i += 1) {
			if (i > 0) t += exactGaps && rng.bool(0.25) ? wait : step10(rng, 20, Math.min(wait - 10, 120));
			times.push(t);
		}
	}
	return times;
}

const ARGS = 'abcdefghijklmnopqrstuvwxyz';

function withArgs(times: readonly number[]): Event[] {
	return times.map((t, i) => ({ t, arg: ARGS[i] ?? `e${i}` }));
}

function config(
	kind: Config['kind'],
	wait: number,
	options: { leading?: boolean; trailing?: boolean; maxWait?: number }
): Config {
	const parts: string[] = [];
	if (options.leading !== undefined) parts.push(`leading: ${options.leading}`);
	if (options.trailing !== undefined) parts.push(`trailing: ${options.trailing}`);
	if (options.maxWait !== undefined) parts.push(`maxWait: ${options.maxWait}`);
	return {
		kind,
		wait,
		leading: options.leading ?? kind === 'throttle',
		trailing: options.trailing ?? true,
		maxWait: kind === 'throttle' ? wait : (options.maxWait ?? null),
		options: parts.length ? `{ ${parts.join(', ')} }` : ''
	};
}

interface Scenario {
	cfg: Config;
	events: Event[];
}

function scenario(rng: Rng, classId: string): Scenario {
	const wait = rng.pick([100, 150, 200, 250, 300]);
	switch (classId) {
		case 'debounce-trailing':
			return {
				cfg: config('debounce', wait, {}),
				events: withArgs(seriesTimeline(rng, wait, rng.int(2, 3), [2, 4], rng.bool(0.4)))
			};
		case 'debounce-leading':
			return {
				cfg: config('debounce', wait, { leading: true, trailing: false }),
				events: withArgs(seriesTimeline(rng, wait, rng.int(2, 3), [2, 4], rng.bool(0.4)))
			};
		case 'debounce-both':
			return {
				cfg: config('debounce', wait, { leading: true }),
				events: withArgs(seriesTimeline(rng, wait, 3, [1, 3], rng.bool(0.4)))
			};
		case 'throttle-basic':
			return {
				cfg: config('throttle', wait, {}),
				events: withArgs(streamTimeline(rng, wait, rng.int(1, 2), [4, 6], false))
			};
		case 'throttle-trailing-only':
			return {
				cfg: config('throttle', wait, { leading: false }),
				events: withArgs(streamTimeline(rng, wait, 2, [3, 6], rng.bool(0.4)))
			};
		case 'debounce-maxwait': {
			const maxWait = wait * rng.pick([2, 3]) + rng.pick([0, 50]);
			return {
				cfg: config('debounce', wait, { maxWait }),
				events: withArgs(streamTimeline(rng, wait, rng.int(1, 2), [6, 8], false))
			};
		}
		case 'throttle-boundary':
			return {
				cfg: config('throttle', wait, {}),
				events: withArgs(streamTimeline(rng, wait, 2, [3, 6], true))
			};
		default: {
			// debounce-leading-maxwait.
			const maxWait = wait * 2 + rng.pick([0, 50, 100]);
			return {
				cfg: config('debounce', wait, { leading: true, maxWait }),
				events: withArgs(streamTimeline(rng, wait, 2, [4, 8], rng.bool(0.3)))
			};
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const SERIES_RULES = [
	'Правила обёртки (как в lodash 4 без `maxWait`):',
	'',
	'- **серия** — события, у которых между соседними меньше `wait` мс; событие ровно через `wait` мс после предыдущего начинает новую серию;',
	'- `leading: true` — вызов в момент первого события серии с его аргументом;',
	'- `trailing: true` — вызов в момент «последнее событие серии + `wait`» с аргументом последнего события серии; если включён и `leading`, а в серии одно событие, этого вызова нет (аргумент уже передан).'
];

function machineRules(cfg: Config): string[] {
	const limit = cfg.kind === 'throttle' ? '`wait`' : '`maxWait`';
	return [
		'Правила обёртки (как в lodash 4). Обёртка помнит момент последнего события **E**, момент **I** — начало текущего окна ' +
			'(последний вызов или открытие окна, до первого события I = 0), таймер и отложенный аргумент. «Пора», если событий ' +
			`ещё не было, или с E прошло не меньше \`wait\`, или с I прошло не меньше ${limit}.`,
		'',
		'**Событие** в момент t с аргументом x: сначала проверяется «пора» (по прежнему E), затем отложенный аргумент := x, E := t, и:',
		'',
		'- «пора» и таймера нет — открывается окно: I := t, таймер на t + `wait`; при `leading: true` — вызов с x сейчас;',
		'- «пора» и таймер есть — таймер переставляется на t + `wait`, вызов с x сейчас;',
		'- иначе, если таймера нет, — таймер на t + `wait`.',
		'',
		'**Срабатывание таймера** в момент T: если «пора» — таймер снимается, и при `trailing: true` и наличии отложенного ' +
			`аргумента — вызов с ним; иначе таймер переставляется на min(E + \`wait\`, I + ${limit}).`,
		'',
		'**Каждый вызов**: I := момент вызова, отложенный аргумент сбрасывается. Если таймер снят без вызова (`trailing: false` ' +
			'или отложенного аргумента нет), отложенный аргумент тоже сбрасывается; перестановка таймера отложенный аргумент сохраняет.'
	];
}

function describe(rng: Rng, s: Scenario): string {
	const plot = rng.pick(PLOTS);
	const { cfg } = s;
	const call = `_.${cfg.kind}(${plot.handler}, ${cfg.wait}${cfg.options ? `, ${cfg.options}` : ''})`;
	const defaults =
		cfg.kind === 'throttle'
			? 'У `throttle` по умолчанию `leading: true` и `trailing: true`.'
			: 'У `debounce` по умолчанию `leading: false`, `trailing: true`.';
	return [
		`${plot.place[0]?.toUpperCase() ?? ''}${plot.place.slice(1)} передаёт события \`${plot.event}\` обработчику через обёртку lodash:`,
		'',
		'```js',
		`const on${plot.event[0]?.toUpperCase() ?? ''}${plot.event.slice(1)} = ${call};`,
		'```',
		'',
		`${defaults} События приходят в такие моменты (мс от начала) с такими аргументами:`,
		'',
		s.events.map((e) => `\`${e.t} ${e.arg}\``).join(', '),
		'',
		...(cfg.maxWait === null ? SERIES_RULES : machineRules(cfg)),
		'',
		'Таймеры срабатывают точно в назначенный момент; если событие и срабатывание таймера приходятся на один момент, сначала срабатывает таймер. После последнего события обёртка доводит дело до конца.',
		'',
		`Введите все вызовы \`${plot.handler}\` по порядку: для каждого вызова — момент в миллисекундах и аргумент, все пары подряд через пробел, например \`350 c 900 f\`.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/debounce-trailing': ['from-first-event', 'trailing-first-arg'],
	'junior/debounce-leading': ['from-first-event'],
	'junior/debounce-both': ['leading-twice', 'from-first-event'],
	'junior/throttle-basic': ['throttle-from-last-call', 'throttle-leading-only'],
	'middle/throttle-trailing-only': ['throttle-from-last-call'],
	'middle/debounce-maxwait': ['maxwait-ignored', 'trailing-first-arg'],
	'middle/throttle-boundary': ['boundary-joins', 'throttle-from-last-call'],
	'middle/debounce-leading-maxwait': ['maxwait-ignored']
};

const TRIES = 300;
const MAX_CALLS = 12;

interface Drawn {
	scenario: Scenario;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function draw(s: Scenario, required: readonly string[]): Drawn | null {
	const answer = simulate(s.cfg, s.events, RIGHT);
	if (answer === null || answer.length < 2 || answer.length > MAX_CALLS) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(s.cfg, s.events, { ...RIGHT, ...change });
			const same = value === null || (value.length === answer.length && value.every((x, i) => x === answer[i]));
			return [id, same ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { scenario: s, answer, wrong };
}

/** A fixed scenario of the class, used when no drawn one fits: every required misconception changes its answer. */
function fallback(classId: string): Scenario {
	const at = (...times: number[]): Event[] => withArgs(times);
	switch (classId) {
		case 'debounce-trailing':
			return { cfg: config('debounce', 200, {}), events: at(0, 150, 300, 700, 750) };
		case 'debounce-leading':
			return { cfg: config('debounce', 200, { leading: true, trailing: false }), events: at(0, 150, 300, 700, 750) };
		case 'debounce-both':
			return { cfg: config('debounce', 200, { leading: true }), events: at(0, 150, 300, 700, 1200, 1250) };
		case 'throttle-basic':
			return { cfg: config('throttle', 200, {}), events: at(0, 80, 160, 240, 320, 400, 480) };
		case 'throttle-trailing-only':
			return { cfg: config('throttle', 200, { leading: false }), events: at(0, 80, 160, 240, 320, 400, 480) };
		case 'debounce-maxwait':
			return { cfg: config('debounce', 100, { maxWait: 250 }), events: at(0, 60, 120, 180, 240, 300, 360, 420) };
		case 'throttle-boundary':
			return { cfg: config('throttle', 100, {}), events: at(0, 50, 100, 220, 320, 360) };
		default:
			return {
				cfg: config('debounce', 100, { leading: true, maxWait: 250 }),
				events: at(0, 60, 120, 180, 240, 300, 360, 420)
			};
	}
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let drawn: Drawn | null = null;
	for (let tries = 0; tries < TRIES && drawn === null; tries += 1) drawn = draw(scenario(rng, input.classId), required);
	drawn ??= draw(fallback(input.classId), required);
	if (drawn === null) throw new Error(`${descriptor.key}: the fallback of ${input.classId} does not fit`);
	const { scenario: s, answer, wrong } = drawn;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(rng, s), code: null },
		answer: { kind: 'tokens', value: answer.join(' ') }
	});
	const stdin = JSON.stringify({
		wait: s.cfg.wait,
		leading: s.cfg.leading,
		trailing: s.cfg.trailing,
		maxWait: s.cfg.maxWait,
		events: s.events.map((e) => [e.t, e.arg])
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null
						? null
						: { kind: 'answer' as const, answer: { kind: 'tokens' as const, value: value.join(' ') } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
