// Which values a flow collector on an Android screen receives along a timeline of lifecycle events: a cold flow or a
// StateFlow collected with lifecycleScope.launch, repeatOnLifecycle, flowWithLifecycle or the deprecated
// launchWhenStarted; for Senior — a cold upstream shared with stateIn(WhileSubscribed) and a slow collector of a
// StateFlow (conflation). The model follows the documentation of androidx.lifecycle and kotlinx.coroutines; it is a
// model, not a device run. All times are multiples of 100 ms and no two timed things of the model coincide, except
// the callbacks of one event.
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

type LcKind = 'home' | 'return' | 'dialog' | 'dialogClose' | 'rotate';
interface LcEvent {
	t: number;
	kind: LcKind;
}

type Collector = 'launch' | 'started' | 'resumed' | 'withLifecycle' | 'whenStarted';
type Source = 'cold' | 'state' | 'stateIn' | 'conflate';

interface Scenario {
	source: Source;
	collector: Collector;
	/** Cold flow and upstream: period, first value and step of the counter. */
	period: number;
	first: number;
	step: number;
	/** StateFlow: the initial value and the values set from the ViewModel, by time. */
	initial: number;
	sets: [number, number][];
	/** stateIn: WhileSubscribed(timeout), replayExpirationMillis = 0 or the default. */
	timeout: number;
	replayZero: boolean;
	/** Conflation: how long the collector handles one value. */
	busy: number;
	events: LcEvent[];
	end: number;
	names: Names;
}

interface Names {
	vm: string;
	flow: string;
	screen: string;
}

interface Rules {
	suspendsNotCancels: boolean;
	collectsInBackground: boolean;
	stopsOnPause: boolean;
	resumedAsStarted: boolean;
	noReplayOnRestart: boolean;
	launchStopsOnStop: boolean;
	survivesRotation: boolean;
	whenStartedRestarts: boolean;
	pausedDrops: boolean;
	noStopTimeout: boolean;
	upstreamNeverStops: boolean;
	vmRecreatedOnRotation: boolean;
	keepsCachedValue: boolean;
	everyValue: boolean;
	latestEvenIfEqual: boolean;
}

const RIGHT: Rules = {
	suspendsNotCancels: false,
	collectsInBackground: false,
	stopsOnPause: false,
	resumedAsStarted: false,
	noReplayOnRestart: false,
	launchStopsOnStop: false,
	survivesRotation: false,
	whenStartedRestarts: false,
	pausedDrops: false,
	noStopTimeout: false,
	upstreamNeverStops: false,
	vmRecreatedOnRotation: false,
	keepsCachedValue: false,
	everyValue: false,
	latestEvenIfEqual: false
};

type Span = [number, number];

/** Rank of a lifecycle state: 1 — CREATED, 2 — STARTED, 3 — RESUMED. */
const RANK = { created: 1, started: 2, resumed: 3 } as const;

/** Intervals during which the screen is at least at `rank`; a rotation closes one and opens the next at once. */
function spans(s: Scenario, rank: number, splitOnRotation: boolean): Span[] {
	const out: Span[] = [];
	let state = 3;
	let open: number | null = 0;
	for (const ev of s.events) {
		const before = state;
		if (ev.kind === 'home') state = 1;
		else if (ev.kind === 'return' || ev.kind === 'dialogClose') state = 3;
		else if (ev.kind === 'dialog') state = 2;
		if (ev.kind === 'rotate') {
			if (splitOnRotation && open !== null) {
				out.push([open, ev.t]);
				open = ev.t;
			}
			continue;
		}
		if (before >= rank && state < rank && open !== null) {
			out.push([open, ev.t]);
			open = null;
		} else if (before < rank && state >= rank) open = ev.t;
	}
	if (open !== null) out.push([open, s.end]);
	return out;
}

/**
 * The values received under the rules, the timer moments the model relied on (an emission after a delay, a delay
 * ending, a sharing timeout, the end of a slow handling) — none may coincide with a lifecycle event, a set or the end —
 * and `clash` when an emission falls exactly on the end of its collection.
 */
interface Outcome {
	values: number[];
	timers: number[];
	clash: boolean;
}

function simulate(s: Scenario, rules: Rules): Outcome {
	const out: Outcome = { values: [], timers: [], clash: false };
	if (s.source === 'stateIn') return stateIn(s, rules, out);
	if (s.source === 'conflate') return conflate(s, rules, out);
	let collector = s.collector;
	if (collector === 'withLifecycle') collector = 'started';
	if (collector === 'whenStarted' && rules.whenStartedRestarts) collector = 'started';
	if (collector === 'launch' && rules.launchStopsOnStop) collector = 'started';
	if (collector === 'resumed' && rules.resumedAsStarted) collector = 'started';
	if (collector === 'started' && rules.stopsOnPause) collector = 'resumed';
	if ((collector === 'started' || collector === 'resumed') && rules.collectsInBackground) collector = 'launch';
	const split = !rules.survivesRotation;
	const instances = spans(s, RANK.created, split);
	const gate = collector === 'resumed' ? spans(s, RANK.resumed, split) : spans(s, RANK.started, split);
	const pausing =
		collector === 'whenStarted' ||
		(rules.suspendsNotCancels && (collector === 'started' || collector === 'resumed') && s.source === 'cold');
	const sessions = collector === 'launch' ? instances : gate;
	const values = out.values;
	if (s.source === 'state') {
		sessions.forEach(([a, b], index) => {
			if (!(rules.noReplayOnRestart && index > 0)) values.push(stateAt(s, a));
			for (const [t, v] of s.sets) if (t > a && t < b) values.push(v);
		});
		return out;
	}
	if (!pausing) {
		for (const [a, b] of sessions) {
			for (let k = 0; ; k += 1) {
				const t = a + k * s.period;
				if (t === b) out.clash = true;
				if (t >= b) break;
				values.push(s.first + k * s.step);
				if (k > 0) out.timers.push(t);
			}
		}
		return out;
	}
	// Paused, not cancelled: the counter goes on within one instance of the activity; a delay that ends while the
	// screen is below the state waits for the next start. `pausedDrops` — the timer runs on and values due meanwhile
	// are lost.
	for (const [c, d] of instances) {
		const inside = gate.filter(([a, b]) => a >= c && b <= d);
		if (rules.pausedDrops) {
			for (let k = 0; c + k * s.period < d; k += 1) {
				const t = c + k * s.period;
				if (inside.some(([a, b]) => t >= a && t < b)) values.push(s.first + k * s.step);
			}
			continue;
		}
		let k = 0;
		let at: number | null = inside[0]?.[0] ?? null;
		while (at !== null && at < d) {
			values.push(s.first + k * s.step);
			k += 1;
			const due = at + s.period;
			out.timers.push(due);
			const open = inside.find(([a, b]) => due >= a && due < b);
			at = open ? due : (inside.find(([a]) => a > due)?.[0] ?? null);
		}
	}
	return out;
}

function stateAt(s: Scenario, t: number): number {
	let v = s.initial;
	for (const [at, value] of s.sets) if (at <= t) v = value;
	return v;
}

/** stateIn(viewModelScope, WhileSubscribed(timeout[, replayExpirationMillis = 0]), initial) over a cold upstream. */
function stateIn(s: Scenario, rules: Rules, out: Outcome): Outcome {
	const sessions = spans(s, RANK.started, true);
	const rotations = s.events.filter((e) => e.kind === 'rotate').map((e) => e.t);
	// Upstream runs [start, stop) and the moments the cached value is reset to the initial one.
	const runs: Span[] = [];
	const resets: number[] = [];
	let runStart = 0;
	for (let i = 0; i < sessions.length; i += 1) {
		const end = sessions[i]?.[1] ?? s.end;
		const next = sessions[i + 1]?.[0];
		if (next === undefined) break;
		if (rules.vmRecreatedOnRotation && rotations.includes(next)) {
			runs.push([runStart, next]);
			resets.push(next);
			runStart = next;
			continue;
		}
		if (rules.upstreamNeverStops) continue;
		const timeout = rules.noStopTimeout ? 0 : s.timeout;
		const stopAt = end + timeout;
		out.timers.push(stopAt);
		if (rules.noStopTimeout ? next >= stopAt : next > stopAt) {
			runs.push([runStart, stopAt]);
			if (s.replayZero && !rules.keepsCachedValue) resets.push(stopAt);
			runStart = next;
		}
	}
	runs.push([runStart, s.end]);
	const changes: [number, number][] = [];
	for (const [a, b] of runs) {
		for (let k = 1; ; k += 1) {
			const t = a + k * s.period;
			if (t === b) out.clash = true;
			if (t >= b) break;
			changes.push([t, s.first + (k - 1) * s.step]);
			out.timers.push(t);
		}
	}
	for (const r of resets) changes.push([r, s.initial]);
	changes.sort((x, y) => x[0] - y[0]);
	// The value of the StateFlow over time: a set to an equal value changes nothing.
	const timeline: [number, number][] = [];
	let current = s.initial;
	for (const [t, v] of changes) {
		if (v === current) continue;
		current = v;
		timeline.push([t, v]);
	}
	const valueAt = (t: number): number => {
		let v = s.initial;
		for (const [at, value] of timeline) if (at <= t) v = value;
		return v;
	};
	for (const [a, b] of sessions) {
		out.values.push(valueAt(a));
		for (const [t, v] of timeline) if (t > a && t < b) out.values.push(v);
	}
	return out;
}

/** A StateFlow collected by a slow collector: it handles one value for `busy` ms, then takes the latest one. */
function conflate(s: Scenario, rules: Rules, out: Outcome): Outcome {
	const sessions = spans(s, RANK.started, true);
	const values = out.values;
	for (const [a, b] of sessions) {
		const inSession = s.sets.filter(([t]) => t > a && t < b);
		if (rules.everyValue) {
			let free = a;
			const queue: [number, number][] = [[a, stateAt(s, a)], ...inSession];
			for (const [t, v] of queue) {
				const at = Math.max(t, free);
				if (at >= b) break;
				values.push(v);
				free = at + s.busy;
			}
			continue;
		}
		let last = stateAt(s, a);
		values.push(last);
		let free = a + s.busy;
		for (;;) {
			out.timers.push(free);
			if (free >= b) break;
			const busyFrom = free - s.busy;
			const changed = inSession.some(([t]) => t > busyFrom && t < free);
			const now = stateAt(s, free);
			if (changed && (now !== last || rules.latestEvenIfEqual)) {
				values.push(now);
				last = now;
				free += s.busy;
				continue;
			}
			const next = inSession.find(([t]) => t > free);
			if (!next) break;
			values.push(next[1]);
			last = next[1];
			free = next[0] + s.busy;
		}
	}
	return out;
}

// ---- scenarios ----

const VMS = ['Prices', 'Orders', 'Chat', 'Tracker', 'Weather', 'Scores', 'Delivery', 'Feed'] as const;

function namesOf(rng: Rng): Names {
	const vm = rng.pick(VMS);
	return {
		vm,
		flow: rng.pick(['updates', 'ticks', 'status', 'counter', 'progress']),
		screen: `${vm}Activity`
	};
}

/** A timeline from RESUMED at 0: pairs that leave and come back, and rotations while resumed. */
function timeline(
	rng: Rng,
	kinds: readonly ('home' | 'dialog' | 'rotate')[],
	count: number,
	gap: [number, number]
): LcEvent[] {
	const events: LcEvent[] = [];
	let t = 0;
	for (let i = 0; i < count; i += 1) {
		const kind = rng.pick(kinds);
		t += rng.int(gap[0], gap[1]) * 100;
		if (kind === 'rotate') {
			events.push({ t, kind });
			continue;
		}
		events.push({ t, kind });
		t += rng.int(gap[0], gap[1]) * 100;
		events.push({ t, kind: kind === 'home' ? 'return' : 'dialogClose' });
	}
	return events;
}

function lastT(events: readonly LcEvent[]): number {
	return events.at(-1)?.t ?? 0;
}

function base(rng: Rng): Omit<Scenario, 'source' | 'collector' | 'events' | 'end'> {
	return {
		period: rng.pick([1000, 1500, 2000]),
		first: rng.int(1, 9),
		step: rng.pick([1, 2, 3, 5, 10]),
		initial: 0,
		sets: [],
		timeout: 0,
		replayZero: false,
		busy: 0,
		names: namesOf(rng)
	};
}

function stateSets(
	rng: Rng,
	initial: number,
	end: number,
	every: [number, number],
	pool: readonly number[]
): [number, number][] {
	const sets: [number, number][] = [];
	let t = 0;
	let current = initial;
	for (;;) {
		t += rng.int(every[0], every[1]) * 100;
		if (t >= end) break;
		const v = rng.pick(pool.filter((x) => x !== current));
		sets.push([t, v]);
		current = v;
	}
	return sets;
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const b = base(rng);
	if (grade === 'middle') {
		if (classId === 'cold-restart') {
			const events = timeline(rng, ['home', 'home', 'dialog'], rng.int(2, 3), [6, 25]);
			return {
				...b,
				source: 'cold',
				collector: rng.pick(['started', 'withLifecycle']),
				events,
				end: lastT(events) + rng.int(10, 30) * 100
			};
		}
		if (classId === 'state-flow') {
			const events = timeline(rng, ['home', 'dialog'], rng.int(2, 3), [6, 25]);
			const end = lastT(events) + rng.int(10, 30) * 100;
			return {
				...b,
				source: 'state',
				collector: rng.pick(['started', 'started', 'resumed']),
				initial: 0,
				sets: stateSets(rng, 0, end, [7, 20], [1, 2, 3, 4, 5, 6, 7, 8, 9]),
				events,
				end
			};
		}
		if (classId === 'launch-vs-repeat') {
			const events = timeline(rng, ['home', 'rotate'], rng.int(2, 3), [6, 25]);
			return { ...b, source: 'cold', collector: 'launch', events, end: lastT(events) + rng.int(10, 30) * 100 };
		}
		const events = timeline(rng, ['home', 'home', 'dialog', 'rotate'], rng.int(2, 3), [6, 25]);
		return { ...b, source: 'cold', collector: 'whenStarted', events, end: lastT(events) + rng.int(10, 30) * 100 };
	}
	if (classId === 'conflation') {
		const events = timeline(rng, ['home', 'dialog'], rng.int(1, 2), [8, 30]);
		const end = lastT(events) + rng.int(15, 30) * 100;
		const initial = rng.int(1, 4);
		return {
			...b,
			source: 'conflate',
			collector: 'started',
			initial,
			busy: rng.int(6, 15) * 100,
			sets: stateSets(rng, initial, end, [2, 7], [1, 2, 3, 4]),
			events,
			end
		};
	}
	const period = rng.pick([700, 1000, 1500]);
	if (classId === 'rotation-timeout') {
		const events = timeline(rng, ['rotate', 'home', 'home'], rng.int(2, 3), [8, 70]);
		return {
			...b,
			period,
			source: 'stateIn',
			collector: 'started',
			timeout: 5000,
			events: events.some((e) => e.kind === 'rotate')
				? events
				: [{ t: 1300, kind: 'rotate' }, ...events.map((e) => ({ ...e, t: e.t + 1300 }))],
			end: 0
		};
	}
	const events = timeline(rng, ['home'], rng.int(2, 3), [5, 45]);
	return {
		...b,
		period,
		source: 'stateIn',
		collector: 'started',
		timeout: rng.pick([1000, 2000, 3000]),
		replayZero: classId === 'replay-expiration',
		events,
		end: lastT(events) + rng.int(10, 30) * 100
	};
}

// ---- statement ----

function eventText(ev: LcEvent): string {
	switch (ev.kind) {
		case 'home':
			return 'пользователь сворачивает приложение (`onPause`, `onStop`)';
		case 'return':
			return 'пользователь возвращается (`onStart`, `onResume`)';
		case 'dialog':
			return 'поверх открывается полупрозрачная активность-диалог (`onPause`)';
		case 'dialogClose':
			return 'диалог закрывается (`onResume`)';
		case 'rotate':
			return 'поворот экрана: активность уничтожается и создаётся заново (`onPause`, `onStop`, `onDestroy`, затем у новой `onCreate`, `onStart`, `onResume`)';
	}
}

function collectorCode(s: Scenario, flowExpr: string, body: string): string[] {
	switch (s.collector) {
		case 'launch':
			return ['lifecycleScope.launch {', `    ${flowExpr}.collect { ${body} }`, '}'];
		case 'started':
		case 'resumed':
			return [
				'lifecycleScope.launch {',
				`    repeatOnLifecycle(Lifecycle.State.${s.collector.toUpperCase()}) {`,
				`        ${flowExpr}.collect { ${body} }`,
				'    }',
				'}'
			];
		case 'withLifecycle':
			return [
				'lifecycleScope.launch {',
				`    ${flowExpr}`,
				'        .flowWithLifecycle(lifecycle, Lifecycle.State.STARTED)',
				`        .collect { ${body} }`,
				'}'
			];
		case 'whenStarted':
			return [
				'@Suppress("DEPRECATION")',
				'lifecycleScope.launchWhenStarted {',
				`    ${flowExpr}.collect { ${body} }`,
				'}'
			];
	}
}

function renderCode(s: Scenario): string {
	const vm = `${s.names.vm}ViewModel`;
	const f = s.names.flow;
	const lines: string[] = [];
	if (s.source === 'cold' || s.source === 'stateIn') {
		const emitFirst = s.source === 'cold';
		lines.push(
			`fun ${f}(): Flow<Int> = flow {`,
			`    var n = ${s.first}`,
			'    while (true) {',
			...(emitFirst
				? ['        emit(n)', `        n += ${s.step}`, `        delay(${s.period})`]
				: [`        delay(${s.period})`, '        emit(n)', `        n += ${s.step}`]),
			'    }',
			'}',
			''
		);
	}
	if (s.source === 'stateIn') {
		const started = s.replayZero
			? `SharingStarted.WhileSubscribed(stopTimeoutMillis = ${s.timeout}, replayExpirationMillis = 0)`
			: `SharingStarted.WhileSubscribed(${s.timeout})`;
		lines.push(
			`class ${vm} : ViewModel() {`,
			`    val ${f}: StateFlow<Int> = ${f}()`,
			`        .stateIn(viewModelScope, ${started}, ${s.initial})`,
			'}',
			''
		);
	}
	if (s.source === 'state' || s.source === 'conflate') {
		lines.push(
			`class ${vm} : ViewModel() {`,
			`    val ${f} = MutableStateFlow(${s.initial})   // значения задаёт ViewModel по сценарию`,
			'}',
			''
		);
	}
	const flowExpr = s.source === 'cold' ? `${f}()` : `vm.${f}`;
	const body = s.source === 'conflate' ? 'render(it); delay(' + String(s.busy) + ')' : 'render(it)';
	lines.push(
		`class ${s.names.screen} : AppCompatActivity() {`,
		...(s.source === 'cold' ? [] : [`    private val vm: ${vm} by viewModels()`]),
		'',
		'    override fun onCreate(savedInstanceState: Bundle?) {',
		'        super.onCreate(savedInstanceState)',
		...collectorCode(s, flowExpr, body).map((l) => `        ${l}`),
		'    }',
		'}'
	);
	return lines.join('\n');
}

function describe(s: Scenario): string {
	const steps = s.events.map((ev) => `- **${ev.t} мс** — ${eventText(ev)};`);
	const sets =
		s.source === 'state' || s.source === 'conflate'
			? [
					'',
					`ViewModel присваивает \`${s.names.flow}.value\`: ${s.sets.map(([t, v]) => `в ${t} мс — ${v}`).join(', ')}.`
				]
			: [];
	const notes = [
		'По модели жизненного цикла Android и `kotlinx.coroutines` (lifecycle-runtime-ktx 2.8, не на устройстве): все колбэки одного события происходят в один момент, обработка значений мгновенна (если в коде нет `delay`), ни одно событие сценария не совпадает по времени с выпуском значения.',
		`Активность \`${s.names.screen}\` открыта в 0 мс (\`onCreate\`, \`onStart\`, \`onResume\`); ViewModel живёт, пока жива задача экрана. Дальше:`
	];
	return [
		...notes,
		'',
		...steps,
		`- **${s.end} мс** — конец наблюдения.`,
		...sets,
		'',
		'Введите по порядку значения, которые получила `render` за всё время наблюдения (во всех экземплярах активности), по одному в строке.'
	].join('\n');
}

// ---- reference ----

const PYTHON_REFERENCE = `import json

s = json.loads(input())
END = s["end"]
ev = {}
for e in s["events"]:
    ev.setdefault(e["t"], []).append(e["kind"])
src, col = s["source"], s["collector"]
if col == "withLifecycle":
    col = "started"
need = {"launch": 1, "started": 2, "whenStarted": 2, "resumed": 3}[col]
out = []

# the ViewModel's StateFlow (for "state", "conflate" and "stateIn")
sets = {t: v for t, v in s["sets"]}
flow_value = s["initial"]
version = 0  # bumps on every real change

# stateIn: upstream coroutine and the WhileSubscribed timer
up_on = False
up_next = None
up_n = None
stop_at = None

# collector coroutine of the current activity
rank = 3
alive = False      # collect is running (not cancelled)
paused = False     # launchWhenStarted: dispatcher paused
cold_n = None      # counter of the cold flow inside this collection
wake = None        # cold flow: when its delay ends
pending = False    # cold flow under launchWhenStarted: delay ended while paused
seen = None        # StateFlow collector: last value it emitted
seen_ver = None
busy_until = None


def set_flow(v):
    global flow_value, version
    if v != flow_value:
        flow_value = v
        version += 1


def deliver_state(now):
    global seen, seen_ver, busy_until
    out.append(flow_value)
    seen = flow_value
    seen_ver = version
    if src == "conflate":
        busy_until = now + s["busy"]


def start_collect(now):
    global alive, cold_n, wake, seen, seen_ver, busy_until, up_on, up_next, up_n, stop_at
    alive = True
    if src == "cold":
        cold_n = s["first"]
        out.append(cold_n)
        cold_n += s["step"]
        wake = now + s["period"]
    else:
        seen, seen_ver, busy_until = None, None, None
        if src == "stateIn":
            stop_at = None
            if not up_on:
                up_on, up_next, up_n = True, now + s["period"], s["first"]
        deliver_state(now)


def stop_collect(now):
    global alive, wake, stop_at
    alive = False
    wake = None
    if src == "stateIn":
        stop_at = now + s["timeout"]


def active(r):
    return r >= need


rank = 3
start_collect(0)
for now in range(100, END, 100):
    # lifecycle events at this moment
    for kind in ev.get(now, []):
        old = rank
        if kind == "rotate":
            if alive or paused:
                stop_collect(now)
            paused = False
            pending = False
            # the new activity runs onCreate/onStart/onResume
            start_collect(now)
            continue
        rank = {"home": 1, "return": 3, "dialog": 2, "dialogClose": 3}[kind]
        if col == "launch":
            continue
        if col == "whenStarted":
            if active(old) and not active(rank):
                paused = True
            elif not active(old) and active(rank):
                paused = False
                if pending:
                    pending = False
                    out.append(cold_n)
                    cold_n += s["step"]
                    wake = now + s["period"]
            continue
        if active(old) and not active(rank):
            stop_collect(now)
        elif not active(old) and active(rank):
            start_collect(now)
    # stateIn: the sharing timer and the upstream
    if src == "stateIn":
        if stop_at is not None and now == stop_at and not alive:
            up_on = False
            up_next = None
            stop_at = None
            if s["replayZero"]:
                set_flow(s["initial"])
        if up_on and up_next == now:
            set_flow(up_n)
            up_n += s["step"]
            up_next = now + s["period"]
    if now in sets:
        set_flow(sets[now])
    # the collector
    if src == "cold" and wake == now:
        if paused:
            pending = True
            wake = None
        else:
            out.append(cold_n)
            cold_n += s["step"]
            wake = now + s["period"]
    elif src in ("state", "stateIn") and alive and seen_ver != version and flow_value != seen:
        deliver_state(now)
    elif src == "conflate" and alive:
        if busy_until is not None and now >= busy_until:
            busy_until = None
        if busy_until is None and seen_ver != version:
            if flow_value != seen:
                deliver_state(now)
            else:
                seen_ver = version
print("\\n".join(str(v) for v in out))
`;

// ---- build ----

const WRONG: Record<string, Partial<Rules>> = {
	'suspends-not-cancels': { suspendsNotCancels: true },
	'collects-in-background': { collectsInBackground: true },
	'stops-on-pause': { stopsOnPause: true },
	'resumed-as-started': { resumedAsStarted: true },
	'no-replay-on-restart': { noReplayOnRestart: true },
	'launch-stops-on-stop': { launchStopsOnStop: true },
	'survives-rotation': { survivesRotation: true },
	'when-started-restarts': { whenStartedRestarts: true },
	'paused-drops': { pausedDrops: true },
	'no-stop-timeout': { noStopTimeout: true },
	'upstream-never-stops': { upstreamNeverStops: true },
	'vm-recreated-on-rotation': { vmRecreatedOnRotation: true },
	'keeps-cached-value': { keepsCachedValue: true },
	'every-value': { everyValue: true },
	'latest-even-if-equal': { latestEvenIfEqual: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/cold-restart': ['suspends-not-cancels', 'collects-in-background'],
	'middle/state-flow': ['no-replay-on-restart', 'collects-in-background'],
	'middle/launch-vs-repeat': ['launch-stops-on-stop', 'survives-rotation'],
	'middle/when-started': ['when-started-restarts', 'paused-drops'],
	'senior/while-subscribed': ['no-stop-timeout', 'upstream-never-stops'],
	'senior/conflation': ['every-value'],
	'senior/rotation-timeout': ['vm-recreated-on-rotation', 'no-stop-timeout'],
	'senior/replay-expiration': ['keeps-cached-value']
};

/** Whether the collection pauses (from leaving to coming back) include one shorter and one longer than the timeout. */
function shortAndLongPause(s: Scenario): boolean {
	const pauses = s.events.flatMap((e, i) => (e.kind === 'home' ? [(s.events[i + 1] as LcEvent).t - e.t] : []));
	return pauses.some((p) => p < s.timeout) && pauses.some((p) => p > s.timeout);
}

function withEnd(s: Scenario, rng: Rng): Scenario {
	if (s.end > 0) return s;
	return { ...s, end: lastT(s.events) + rng.int(10, 40) * 100 };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const s = withEnd(scenario(rng, input.grade, input.classId), rng);
		const { values, timers, clash } = simulate(s, RIGHT);
		const fixed = new Set([...s.events.map((e) => e.t), s.end]);
		const setTimes = new Set(s.sets.map(([t]) => t));
		if (clash || timers.some((t) => fixed.has(t) || setTimes.has(t)) || [...setTimes].some((t) => fixed.has(t)))
			continue;
		if (values.length < 3 || values.length > 14) continue;
		if (input.classId === 'while-subscribed' && !shortAndLongPause(s)) continue;
		const answer = values.map(String);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(s, { ...RIGHT, ...change }).values.map(String);
				return [id, value.length === answer.length && value.every((v, i) => v === answer[i]) ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: renderCode(s) } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
