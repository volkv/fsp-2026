// Waiting in automated tests on a fake clock: polling a condition with a timeout, retries with an exponential pause,
// nested waits, a shared deadline and an `eventually` helper for assertions. Time is an integer number of
// milliseconds on an explicit clock object, so the program is deterministic. The candidate writes what it prints.
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

interface Rules {
	sleepBeforeCheck: boolean;
	returnsAtEvent: boolean;
	stopsAtDeadline: boolean;
	noFinalCheck: boolean;
	sleepAfterLast: boolean;
	noCap: boolean;
	growthFirst: boolean;
	timeoutPerStep: boolean;
	deadlineAfterSleep: boolean;
	eventuallySwallows: boolean;
}

const RIGHT: Rules = {
	sleepBeforeCheck: false,
	returnsAtEvent: false,
	stopsAtDeadline: false,
	noFinalCheck: false,
	sleepAfterLast: false,
	noCap: false,
	growthFirst: false,
	timeoutPerStep: false,
	deadlineAfterSleep: false,
	eventuallySwallows: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'sleep-before-check': { sleepBeforeCheck: true },
	'returns-at-event': { returnsAtEvent: true },
	'stops-at-deadline': { stopsAtDeadline: true },
	'no-final-check': { noFinalCheck: true },
	'sleep-after-last': { sleepAfterLast: true },
	'no-cap': { noCap: true },
	'growth-first': { growthFirst: true },
	'timeout-per-step': { timeoutPerStep: true },
	'deadline-after-sleep': { deadlineAfterSleep: true },
	'eventually-swallows': { eventuallySwallows: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/poll-success': ['sleep-before-check', 'returns-at-event'],
	'middle/poll-timeout': ['stops-at-deadline', 'no-final-check'],
	'middle/retry-backoff': ['sleep-after-last', 'no-cap', 'growth-first'],
	'middle/backoff-poll': ['no-cap', 'sleep-before-check'],
	'senior/retry-around-wait': ['stops-at-deadline', 'no-final-check'],
	'senior/shared-deadline': ['timeout-per-step', 'stops-at-deadline'],
	'senior/backoff-deadline': ['no-cap', 'deadline-after-sleep'],
	'senior/eventually': ['eventually-swallows', 'stops-at-deadline']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const CLOCK = [
	'class FakeClock:',
	'    def __init__(self):',
	'        self.now = 0',
	'',
	'    def sleep(self, ms):',
	'        self.now += ms'
];

const WAIT_UNTIL = [
	'def wait_until(clock, condition, timeout, interval):',
	'    deadline = clock.now + timeout',
	'    checks = 0',
	'    while True:',
	'        checks += 1',
	'        if condition():',
	'            return checks',
	'        if clock.now >= deadline:',
	'            raise TimeoutError(checks)',
	'        clock.sleep(interval)'
];

const FLAKY = [
	'class Flaky:',
	'    def __init__(self, failures):',
	'        self.failures = failures',
	'        self.calls = 0',
	'',
	'    def __call__(self):',
	'        self.calls += 1',
	'        if self.calls <= self.failures:',
	"            raise ConnectionError('down')",
	"        return 'ok'"
];

/** Top-level blocks separated the way a module is: two empty lines. */
function program(blocks: string[][], main: string[]): string[] {
	return [...blocks.flatMap((b) => [...b, '', '']), 'clock = FakeClock()', ...main];
}

interface PollResult {
	ok: boolean;
	checks: number;
	now: number;
}

/**
 * The polling loop of the shown helpers: check, give up at the deadline, sleep; `cap` doubles the interval up to it.
 * The rules change the loop the way each misconception reads it.
 */
function poll(
	start: number,
	condition: (now: number) => boolean,
	timeout: number,
	interval: number,
	rules: Rules,
	options: { cap?: number; eventAt?: number } = {}
): PollResult {
	const deadline = start + timeout;
	let now = start;
	let checks = 0;
	let step = interval;
	const sleep = () => {
		now += step;
		if (options.cap !== undefined) step = rules.noCap ? step * 2 : Math.min(step * 2, options.cap);
	};
	let ok = false;
	if (rules.noFinalCheck) {
		while (now < deadline) {
			checks += 1;
			if (condition(now)) {
				ok = true;
				break;
			}
			sleep();
		}
	} else {
		for (;;) {
			if (rules.sleepBeforeCheck) sleep();
			checks += 1;
			if (condition(now)) {
				ok = true;
				break;
			}
			if (now >= deadline) break;
			if (!rules.sleepBeforeCheck) sleep();
		}
	}
	if (ok && rules.returnsAtEvent && options.eventAt !== undefined) now = Math.max(start, options.eventAt);
	if (!ok && rules.stopsAtDeadline) now = Math.max(start, Math.min(now, deadline));
	return { ok, checks, now };
}

/** A moment after `start` that falls between two polls with the given interval. */
function between(rng: Rng, start: number, interval: number, maxSteps: number): number {
	return start + rng.int(1, maxSteps) * interval - rng.int(1, interval - 1);
}

const STEPS = ['build', 'migrate', 'deploy', 'index', 'warmup', 'publish', 'export', 'sync'];

function pollSuccess(rng: Rng): Program {
	const names = rng.sample(STEPS, rng.int(2, 3));
	const timeout = 10_000;
	// The moments are planned along the right run, so each falls between two polls of its own wait.
	let now = 0;
	const jobs = names.map((name) => {
		const interval = rng.pick([150, 200, 250, 300, 400, 500]);
		const readyAt = between(rng, now, interval, 6);
		now = poll(now, (t) => t >= readyAt, timeout, interval, RIGHT).now;
		return { name, readyAt, interval };
	});
	return {
		lines: program(
			[CLOCK, WAIT_UNTIL],
			[
				`for name, ready_at, interval in [${jobs.map((j) => `('${j.name}', ${j.readyAt}, ${j.interval})`).join(', ')}]:`,
				`    checks = wait_until(clock, lambda: clock.now >= ready_at, timeout=${timeout}, interval=interval)`,
				'    print(name, checks, clock.now)'
			]
		),
		run: (rules) => {
			let t = 0;
			return jobs.map((j) => {
				const r = poll(t, (x) => x >= j.readyAt, timeout, j.interval, rules, { eventAt: j.readyAt });
				t = r.now;
				return `${j.name} ${r.checks} ${r.now}`;
			});
		}
	};
}

function pollTimeout(rng: Rng): Program {
	const interval = rng.pick([200, 250, 300, 400, 500]);
	const names = rng.sample(STEPS, 3);
	let now = 0;
	// One wait times out with a timeout that is not a multiple of the interval; the others succeed.
	const kinds = rng.shuffle(['timeout', 'ready', rng.pick(['timeout', 'ready'])]);
	const jobs = kinds.map((kind, i) => {
		const timeout = rng.int(3, 8) * interval + rng.int(1, interval - 1);
		const readyAt =
			kind === 'ready'
				? between(rng, now, interval, Math.floor(timeout / interval))
				: now + timeout + rng.int(2, 9) * interval;
		now = poll(now, (t) => t >= readyAt, timeout, interval, RIGHT).now;
		return { name: names[i] ?? 'step', readyAt, timeout };
	});
	return {
		lines: program(
			[CLOCK, WAIT_UNTIL],
			[
				`for name, ready_at, timeout in [${jobs.map((j) => `('${j.name}', ${j.readyAt}, ${j.timeout})`).join(', ')}]:`,
				'    try:',
				`        checks = wait_until(clock, lambda: clock.now >= ready_at, timeout=timeout, interval=${interval})`,
				"        print(name, 'ready', checks, clock.now)",
				'    except TimeoutError as error:',
				"        print(name, 'timeout', error.args[0], clock.now)"
			]
		),
		run: (rules) => {
			let t = 0;
			return jobs.map((j) => {
				const r = poll(t, (x) => x >= j.readyAt, j.timeout, interval, rules, { eventAt: j.readyAt });
				t = r.now;
				return `${j.name} ${r.ok ? 'ready' : 'timeout'} ${r.checks} ${r.now}`;
			});
		}
	};
}

/** The retry loop of the shown helper on a fresh Flaky; returns the attempt that succeeded or null. */
function retry(
	start: number,
	failures: number,
	attempts: number,
	delay: number,
	factor: number,
	cap: number,
	rules: Rules
): { attempt: number | null; now: number } {
	let now = start;
	let pause = rules.growthFirst ? (rules.noCap ? delay * factor : Math.min(delay * factor, cap)) : delay;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		if (attempt > failures) return { attempt, now };
		if (attempt === attempts) {
			if (rules.sleepAfterLast) now += pause;
			break;
		}
		now += pause;
		pause = rules.noCap ? pause * factor : Math.min(pause * factor, cap);
	}
	return { attempt: null, now };
}

const RETRY = [
	'def retry(clock, action, attempts, delay, factor, max_delay):',
	'    for attempt in range(1, attempts + 1):',
	'        try:',
	'            return action(), attempt',
	'        except ConnectionError:',
	'            if attempt == attempts:',
	'                raise',
	'            clock.sleep(delay)',
	'            delay = min(delay * factor, max_delay)'
];

function retryBackoff(rng: Rng): Program {
	const attempts = rng.int(4, 5);
	const delay = rng.pick([50, 100, 150, 200]);
	const factor = rng.int(2, 3);
	const cap = delay * factor * rng.int(1, 2) + rng.pick([0, 50, 100]);
	const runs = rng.shuffle([
		rng.int(attempts - 2, attempts - 1),
		rng.int(attempts, attempts + 2),
		...(rng.bool() ? [rng.int(0, attempts - 1)] : [])
	]);
	return {
		lines: program(
			[CLOCK, FLAKY, RETRY],
			[
				`for failures in [${runs.join(', ')}]:`,
				'    try:',
				`        result, attempt = retry(clock, Flaky(failures), attempts=${attempts}, delay=${delay}, factor=${factor}, max_delay=${cap})`,
				'        print(result, attempt, clock.now)',
				'    except ConnectionError:',
				"        print('gave up', clock.now)"
			]
		),
		run: (rules) => {
			let t = 0;
			return runs.map((failures) => {
				const r = retry(t, failures, attempts, delay, factor, cap, rules);
				t = r.now;
				return r.attempt === null ? `gave up ${r.now}` : `ok ${r.attempt} ${r.now}`;
			});
		}
	};
}

const WAIT_BACKOFF = [
	'def wait_backoff(clock, condition, timeout, interval, max_interval):',
	'    deadline = clock.now + timeout',
	'    checks = 0',
	'    while True:',
	'        checks += 1',
	'        if condition():',
	'            return checks',
	'        if clock.now >= deadline:',
	'            raise TimeoutError(checks)',
	'        clock.sleep(interval)',
	'        interval = min(interval * 2, max_interval)'
];

function backoffPoll(rng: Rng): Program {
	const names = rng.sample(STEPS, 2);
	const interval = rng.pick([50, 100, 150]);
	const cap = interval * rng.pick([4, 8]);
	const timeout = 60_000;
	let now = 0;
	const jobs = names.map((name) => {
		const readyAt = now + rng.int(cap * 2, cap * 6) + rng.int(1, 40);
		now = poll(now, (t) => t >= readyAt, timeout, interval, RIGHT, { cap }).now;
		return { name, readyAt };
	});
	return {
		lines: program(
			[CLOCK, WAIT_BACKOFF],
			[
				`for name, ready_at in [${jobs.map((j) => `('${j.name}', ${j.readyAt})`).join(', ')}]:`,
				`    checks = wait_backoff(clock, lambda: clock.now >= ready_at, timeout=${timeout}, interval=${interval}, max_interval=${cap})`,
				'    print(name, checks, clock.now)'
			]
		),
		run: (rules) => {
			let t = 0;
			return jobs.map((j) => {
				const r = poll(t, (x) => x >= j.readyAt, timeout, interval, rules, { cap, eventAt: j.readyAt });
				t = r.now;
				return `${j.name} ${r.checks} ${r.now}`;
			});
		}
	};
}

function retryAroundWait(rng: Rng): Program {
	const interval = rng.pick([200, 250, 300, 400]);
	const timeout = rng.int(3, 6) * interval + rng.int(1, interval - 1);
	const pause = rng.pick([500, 700, 1000, 1500]);
	const attempts = rng.int(3, 4);
	// The job gets ready during a later attempt or never.
	const lateAttempt = rng.int(2, attempts + 1);
	let now = 0;
	let readyAt = 0;
	for (let a = 1; a < lateAttempt; a += 1) {
		now = poll(now, () => false, timeout, interval, RIGHT).now + pause;
	}
	readyAt = lateAttempt > attempts ? 1_000_000 : between(rng, now, interval, Math.floor(timeout / interval));
	return {
		lines: program(
			[CLOCK, WAIT_UNTIL],
			[
				`job_ready = ${readyAt}`,
				`for attempt in range(1, ${attempts + 1}):`,
				'    try:',
				`        checks = wait_until(clock, lambda: clock.now >= job_ready, timeout=${timeout}, interval=${interval})`,
				"        print('ready', attempt, checks, clock.now)",
				'        break',
				'    except TimeoutError as error:',
				"        print('timeout', attempt, error.args[0], clock.now)",
				`        clock.sleep(${pause})`
			]
		),
		run: (rules) => {
			const out: string[] = [];
			let t = 0;
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				const r = poll(t, (x) => x >= readyAt, timeout, interval, rules, { eventAt: readyAt });
				t = r.now;
				if (r.ok) {
					out.push(`ready ${attempt} ${r.checks} ${r.now}`);
					break;
				}
				out.push(`timeout ${attempt} ${r.checks} ${r.now}`);
				t += pause;
			}
			return out;
		}
	};
}

function sharedDeadline(rng: Rng): Program {
	const interval = rng.pick([100, 200, 250, 300]);
	const names = rng.sample(STEPS, 3);
	const total = rng.int(8, 14) * interval + rng.int(1, interval - 1);
	// Steps are planned along the right run: the first fit, the last runs past the shared deadline.
	let now = 0;
	const deadline = total;
	const steps = names.map((name, i) => {
		const remaining = deadline - now;
		const readyAt =
			i < 2
				? between(rng, now, interval, Math.max(1, Math.min(4, Math.floor(remaining / interval) - 2)))
				: deadline + rng.int(1, 4) * interval - rng.int(1, interval - 1);
		const r = poll(now, (t) => t >= readyAt, remaining, interval, RIGHT);
		now = r.now;
		return { name, readyAt };
	});
	return {
		lines: program(
			[CLOCK, WAIT_UNTIL],
			[
				`deadline = clock.now + ${total}`,
				'try:',
				`    for name, ready_at in [${steps.map((s) => `('${s.name}', ${s.readyAt})`).join(', ')}]:`,
				`        checks = wait_until(clock, lambda: clock.now >= ready_at, timeout=deadline - clock.now, interval=${interval})`,
				'        print(name, checks, clock.now)',
				'except TimeoutError as error:',
				"    print('timeout', name, error.args[0], clock.now)"
			]
		),
		run: (rules) => {
			const out: string[] = [];
			let t = 0;
			for (const s of steps) {
				const timeout = rules.timeoutPerStep ? total : deadline - t;
				const r = poll(t, (x) => x >= s.readyAt, timeout, interval, rules, { eventAt: s.readyAt });
				t = r.now;
				if (!r.ok) {
					out.push(`timeout ${s.name} ${r.checks} ${r.now}`);
					return out;
				}
				out.push(`${s.name} ${r.checks} ${r.now}`);
			}
			return out;
		}
	};
}

const RETRY_UNTIL = [
	'def retry_until(clock, action, deadline, delay, max_delay):',
	'    attempt = 0',
	'    while True:',
	'        attempt += 1',
	'        try:',
	'            return action(), attempt',
	'        except ConnectionError:',
	'            if clock.now + delay > deadline:',
	'                raise TimeoutError(attempt)',
	'            clock.sleep(delay)',
	'            delay = min(delay * 2, max_delay)'
];

function backoffDeadline(rng: Rng): Program {
	const delay = rng.pick([50, 100, 150]);
	const cap = delay * rng.pick([2, 4]);
	const runs = rng.shuffle([
		{ failures: rng.int(3, 5), budget: rng.int(12, 30) * 50 + rng.int(1, 49) },
		{ failures: rng.int(6, 9), budget: rng.int(10, 20) * 50 + rng.int(1, 49) }
	]);
	const simulate = (start: number, failures: number, budget: number, rules: Rules) => {
		const deadline = start + budget;
		let now = start;
		let pause = delay;
		for (let attempt = 1; ; attempt += 1) {
			if (attempt > failures) return `ok ${attempt} ${now}`;
			if (rules.deadlineAfterSleep) {
				now += pause;
				if (now > deadline) return `timeout ${attempt} ${now}`;
			} else {
				if (now + pause > deadline) return `timeout ${attempt} ${now}`;
				now += pause;
			}
			pause = rules.noCap ? pause * 2 : Math.min(pause * 2, cap);
		}
	};
	return {
		lines: program(
			[CLOCK, FLAKY, RETRY_UNTIL],
			[
				`for failures, budget in [${runs.map((r) => `(${r.failures}, ${r.budget})`).join(', ')}]:`,
				'    deadline = clock.now + budget',
				'    try:',
				`        result, attempt = retry_until(clock, Flaky(failures), deadline, delay=${delay}, max_delay=${cap})`,
				'        print(result, attempt, clock.now)',
				'    except TimeoutError as error:',
				"        print('timeout', error.args[0], clock.now)"
			]
		),
		run: (rules) => {
			let t = 0;
			return runs.map((r) => {
				const line = simulate(t, r.failures, r.budget, rules);
				t = Number(line.split(' ').at(-1));
				return line;
			});
		}
	};
}

function eventually(rng: Rng): Program {
	const interval = rng.pick([150, 200, 250, 300]);
	const tick = 100;
	const rate = rng.int(2, 9);
	const processed = (now: number) => Math.floor(now / tick) * rate;
	let now = 0;
	// Targets are planned along the right run: one is reached, one is not within its timeout.
	const kinds = rng.shuffle(['pass', 'fail', rng.pick(['pass', 'fail'])]);
	const checks = kinds.map((kind) => {
		const timeout = rng.int(3, 7) * interval + rng.int(1, interval - 1);
		const target =
			kind === 'pass'
				? processed(now + rng.int(1, Math.floor(timeout / interval)) * interval) - rng.int(0, rate - 1)
				: processed(now + timeout + interval * rng.int(2, 4)) + rng.int(1, rate);
		now = poll(now, (t) => processed(t) >= target, timeout, interval, RIGHT).now;
		return { target, timeout };
	});
	return {
		lines: program(
			[
				CLOCK,
				['def processed(clock):', `    return clock.now // ${tick} * ${rate}`],
				[
					'def eventually(clock, assertion, timeout, interval):',
					'    deadline = clock.now + timeout',
					'    attempts = 0',
					'    while True:',
					'        attempts += 1',
					'        try:',
					'            assertion()',
					'            return attempts',
					'        except AssertionError:',
					'            if clock.now >= deadline:',
					'                raise',
					'            clock.sleep(interval)'
				]
			],
			[
				`for target, timeout in [${checks.map((c) => `(${c.target}, ${c.timeout})`).join(', ')}]:`,
				'    def check():',
				"        assert processed(clock) >= target, 'not yet'",
				'',
				'    try:',
				`        attempts = eventually(clock, check, timeout=timeout, interval=${interval})`,
				"        print('passed', target, attempts, clock.now)",
				'    except AssertionError:',
				"        print('failed', target, clock.now)"
			]
		),
		run: (rules) => {
			let t = 0;
			return checks.map((c) => {
				const r = poll(t, (x) => processed(x) >= c.target, c.timeout, interval, rules);
				t = r.now;
				return r.ok || rules.eventuallySwallows
					? `passed ${c.target} ${r.checks} ${r.now}`
					: `failed ${c.target} ${r.now}`;
			});
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'middle/poll-success': pollSuccess,
	'middle/poll-timeout': pollTimeout,
	'middle/retry-backoff': retryBackoff,
	'middle/backoff-poll': backoffPoll,
	'senior/retry-around-wait': retryAroundWait,
	'senior/shared-deadline': sharedDeadline,
	'senior/backoff-deadline': backoffDeadline,
	'senior/eventually': eventually
};

const STATEMENT = [
	'Что напечатает программа на Python 3? Время в программе — целые миллисекунды на фальшивых часах `clock`: оно',
	'сдвигается только вызовом `clock.sleep` и между запусками в цикле не сбрасывается.',
	'',
	'Введите вывод построчно, как он появится на экране: каждая напечатанная строка — отдельной строкой ответа,',
	'значения через один пробел, например `deploy 4 1500`.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = make(rng);
		const answer = p.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = p.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = p.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: STATEMENT, code: { language: 'python3', source } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${slot} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
