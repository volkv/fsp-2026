// `fetchWithRetry` in the browser: every attempt is a `fetch` with its own timeout (`AbortSignal.timeout`), pauses grow
// exponentially under a cap with a jitter of given percentages, `Retry-After` stretches a pause, and only network
// errors, timeouts and 408, 429, 500, 502, 503, 504 are retried. A level up, a total deadline and the user's abort cut
// an attempt or a pause short (`AbortSignal.any`), a pause that would end past the deadline gives up at once, and
// decorrelated jitter. The answer is when every attempt starts, how the call ends and when.
//
// The generator simulates the shown code on a timeline; the gate checks every answer against an independent Python
// simulation over the same data. Jitter is an integer percentage, so every pause is an exact integer.
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

/** The server's answer to one attempt, or a network error, after `ms`; an answer slower than the timeout is cut. */
interface Reply {
	kind: 'status' | 'network';
	code: number;
	ms: number;
	/** `Retry-After` in seconds. */
	retryAfter: number | null;
}

interface Params {
	attempts: number;
	timeout: number;
	base: number;
	cap: number;
	/** Jitter of pause n, in percent. */
	jitter: number[];
	jitterKind: 'full' | 'decorrelated';
	replies: Reply[];
	deadline: number | null;
	abortAt: number | null;
}

interface Rules {
	noCap: boolean;
	jitterAfterCap: boolean;
	noJitter: boolean;
	pauseFromStart: boolean;
	timeoutWaitsResponse: boolean;
	timeoutFinal: boolean;
	retry4xx: boolean;
	noRetry408429: boolean;
	ignoreRetryAfter: boolean;
	limitAsRetries: boolean;
	abortWaits: boolean;
	noEarlyGiveUp: boolean;
}

const RIGHT: Rules = {
	noCap: false,
	jitterAfterCap: false,
	noJitter: false,
	pauseFromStart: false,
	timeoutWaitsResponse: false,
	timeoutFinal: false,
	retry4xx: false,
	noRetry408429: false,
	ignoreRetryAfter: false,
	limitAsRetries: false,
	abortWaits: false,
	noEarlyGiveUp: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-cap': { noCap: true },
	'jitter-after-cap': { jitterAfterCap: true },
	'no-jitter': { noJitter: true },
	'pause-from-start': { pauseFromStart: true },
	'timeout-waits-response': { timeoutWaitsResponse: true },
	'timeout-final': { timeoutFinal: true },
	'retry-4xx': { retry4xx: true },
	'no-retry-408-429': { noRetry408429: true },
	'ignore-retry-after': { ignoreRetryAfter: true },
	'limit-as-retries': { limitAsRetries: true },
	'abort-waits': { abortWaits: true },
	'no-early-give-up': { noEarlyGiveUp: true }
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface Outcome {
	answer: string;
	/** Moments of the right timeline: a deadline or an abort must not coincide with any of them. */
	moments: number[];
}

/** The timeline of `fetchWithRetry`: `<start of every attempt> <outcome> <moment of the outcome>`. */
function simulate(p: Params, r: Rules): Outcome {
	const starts: number[] = [];
	const moments: number[] = [];
	const limit = r.limitAsRetries ? p.attempts + 1 : p.attempts;
	const stop = (outcome: string, at: number): Outcome => ({ answer: [...starts, outcome, at].join(' '), moments });
	/** A cut of the interval [from, to): the user's abort or the deadline, whichever comes first. */
	const cut = (from: number, to: number): { outcome: string; at: number } | null => {
		const cuts: { outcome: string; at: number }[] = [];
		if (p.abortAt !== null && p.abortAt >= from && p.abortAt < to) cuts.push({ outcome: 'aborted', at: p.abortAt });
		if (p.deadline !== null && p.deadline >= from && p.deadline < to)
			cuts.push({ outcome: 'deadline', at: p.deadline });
		cuts.sort((a, b) => a.at - b.at);
		const first = cuts[0];
		if (!first) return null;
		// The misconception: an abort is noticed only when the attempt or the pause ends.
		return r.abortWaits ? { outcome: first.outcome, at: to } : first;
	};
	let t = 0;
	let prev = p.base;
	for (let n = 1; ; n += 1) {
		const reply = p.replies[n - 1];
		// Only a misconception reaches past the replies the scenario lists.
		if (!reply) return stop('past-limit', t);
		starts.push(t);
		const slow = reply.ms > p.timeout && !r.timeoutWaitsResponse;
		const end = t + (slow ? p.timeout : reply.ms);
		moments.push(t, end);
		const during = cut(t, end);
		if (during) return stop(during.outcome, during.at);
		let failure: string | null = null;
		if (slow) failure = 'timeout';
		else if (reply.kind === 'network') failure = 'network';
		else if (reply.code >= 200 && reply.code < 300) return stop('ok', end);
		else {
			const is4xx = reply.code >= 400 && reply.code < 500;
			const retryable = r.noRetry408429
				? RETRYABLE.has(reply.code) && !is4xx
				: RETRYABLE.has(reply.code) || (r.retry4xx && is4xx);
			if (!retryable) return stop(String(reply.code), end);
		}
		if (failure === 'timeout' && r.timeoutFinal) return stop('timeout', end);
		if (n >= limit) return stop(failure ?? String(reply.code), end);
		const jitter = r.noJitter ? 100 : (p.jitter[n - 1] ?? 100);
		let pause: number;
		if (p.jitterKind === 'full') {
			const exp = p.base * 2 ** (n - 1);
			pause = r.noCap
				? Math.floor((exp * jitter) / 100)
				: r.jitterAfterCap
					? Math.min(p.cap, Math.floor((exp * jitter) / 100))
					: Math.floor((Math.min(p.cap, exp) * jitter) / 100);
		} else {
			const raw = p.base + Math.floor(((prev * 3 - p.base) * jitter) / 100);
			pause = r.noCap ? raw : Math.min(p.cap, raw);
			prev = pause;
		}
		// A timed-out attempt has no response and so no header.
		if (!slow && reply.retryAfter !== null && !r.ignoreRetryAfter) pause = Math.max(pause, reply.retryAfter * 1000);
		if (p.deadline !== null && !r.noEarlyGiveUp && end + pause >= p.deadline) return stop('deadline', end);
		const from = r.pauseFromStart ? t : end;
		const next = Math.max(from + pause, end);
		moments.push(next);
		const sleeping = cut(end, next);
		if (sleeping) return stop(sleeping.outcome, sleeping.at);
		t = next;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const pickMs = (rng: Rng): number => rng.int(2, 60) * 10;
const failCode = (rng: Rng, codes: readonly number[]): Reply => ({
	kind: 'status',
	code: rng.pick(codes),
	ms: pickMs(rng),
	retryAfter: null
});
const networkError = (rng: Rng): Reply => ({ kind: 'network', code: 0, ms: rng.int(1, 30) * 10, retryAfter: null });
const success = (rng: Rng): Reply => ({
	kind: 'status',
	code: rng.pick([200, 200, 201, 204]),
	ms: pickMs(rng),
	retryAfter: null
});
const slowReply = (rng: Rng, timeout: number, codes: readonly number[]): Reply => ({
	kind: 'status',
	code: rng.pick(codes),
	ms: timeout + rng.int(1, 20) * 50,
	retryAfter: null
});
const percents = (rng: Rng, count: number): number[] => Array.from({ length: count }, () => rng.int(4, 20) * 5);

function basePolicy(rng: Rng, attempts: number, capFactor: readonly number[]): Params {
	const base = rng.pick([100, 150, 200, 250]);
	return {
		attempts,
		timeout: rng.pick([800, 1000, 1500, 2000]),
		base,
		cap: base * rng.pick(capFactor),
		jitter: percents(rng, attempts),
		jitterKind: 'full',
		replies: [],
		deadline: null,
		abortAt: null
	};
}

const RETRY_CODES = [500, 502, 503, 504] as const;

/** A random retryable failure: a 5xx, a network error or a timeout. */
function retryableFailure(rng: Rng, timeout: number): Reply {
	const roll = rng.int(1, 6);
	if (roll <= 3) return failCode(rng, RETRY_CODES);
	if (roll === 4) return networkError(rng);
	return slowReply(rng, timeout, [200, 503]);
}

function scenario(rng: Rng, classId: string): Params {
	switch (classId) {
		case 'jitter-cap': {
			const p = basePolicy(rng, rng.int(5, 6), [2, 4]);
			const okAt = p.attempts - rng.int(0, 1);
			for (let i = 1; i < okAt; i += 1) p.replies.push(rng.bool(0.8) ? failCode(rng, RETRY_CODES) : networkError(rng));
			p.replies.push(success(rng));
			return p;
		}
		case 'attempt-timeout': {
			const p = basePolicy(rng, rng.int(4, 5), [4, 8]);
			const okAt = p.attempts - rng.int(0, 1);
			const slow = new Set(
				rng.sample(
					Array.from({ length: okAt - 1 }, (_, i) => i),
					rng.int(1, 2)
				)
			);
			for (let i = 0; i < okAt - 1; i += 1)
				p.replies.push(slow.has(i) ? slowReply(rng, p.timeout, [200, 200, 503]) : failCode(rng, RETRY_CODES));
			p.replies.push(success(rng));
			return p;
		}
		case 'status-policy': {
			const p = basePolicy(rng, rng.int(5, 6), [4, 8]);
			const finalAt = rng.int(3, p.attempts - 1);
			for (let i = 1; i < finalAt; i += 1) {
				const reply = failCode(rng, [408, 429, 429, 503, 503, 500]);
				if ((reply.code === 429 || reply.code === 503) && rng.bool(0.6)) reply.retryAfter = rng.int(1, 3);
				p.replies.push(reply);
			}
			p.replies.push(failCode(rng, [400, 401, 403, 404, 409, 422]));
			while (p.replies.length < p.attempts) p.replies.push(failCode(rng, [503, 500]));
			p.replies.push(success(rng));
			return p;
		}
		case 'attempts-limit': {
			const p = basePolicy(rng, rng.int(3, 5), [2, 4]);
			for (let i = 0; i < p.attempts; i += 1) {
				const reply = rng.bool(0.25) ? networkError(rng) : failCode(rng, [429, 503, 503, 502, 500, 408]);
				if ((reply.code === 429 || reply.code === 503) && rng.bool(0.5)) reply.retryAfter = rng.int(1, 4);
				p.replies.push(reply);
			}
			p.replies.push(success(rng));
			return p;
		}
		case 'deadline':
		case 'user-abort': {
			const p = basePolicy(rng, rng.int(5, 6), [4, 8]);
			for (let i = 0; i < p.attempts; i += 1) p.replies.push(retryableFailure(rng, p.timeout));
			const free = simulate(p, RIGHT);
			const starts = free.answer.split(' ').slice(0, -2).map(Number);
			// The cut falls inside attempt n (n ≥ 2 when there are enough attempts) or inside the pause after it.
			const n = starts.length >= 3 ? rng.int(2, starts.length - 1) : 1;
			const start = starts[n - 1] ?? 0;
			const nextStart = starts[n] ?? start + 3000;
			const reply = p.replies[n - 1] as Reply;
			const end = start + Math.min(reply.ms, p.timeout);
			const inAttempt = rng.bool();
			const at = inAttempt ? rng.int(start + 1, end - 1) : rng.int(end + 1, Math.max(end + 1, nextStart - 1));
			if (classId === 'deadline') p.deadline = at;
			else p.abortAt = at;
			if (classId === 'user-abort' && rng.bool(0.5)) p.deadline = (starts.at(-1) ?? 0) + 5000;
			return p;
		}
		case 'retry-after-deadline': {
			const p = basePolicy(rng, rng.int(5, 6), [4, 8]);
			for (let i = 0; i < p.attempts; i += 1) {
				const reply = rng.bool(0.7) ? failCode(rng, [503, 429, 500]) : retryableFailure(rng, p.timeout);
				if (reply.code === 503 || reply.code === 429) reply.retryAfter = rng.int(1, 5);
				p.replies.push(reply);
			}
			const free = simulate(p, RIGHT);
			const starts = free.answer.split(' ').slice(0, -2).map(Number);
			// The deadline lies past attempt n's end but before the pause the server asks for would end.
			const n = rng.int(1, Math.max(1, starts.length - 1));
			const start = starts[n - 1] ?? 0;
			const reply = p.replies[n - 1] as Reply;
			const end = start + Math.min(reply.ms, p.timeout);
			const nextStart = starts[n] ?? end + 1000;
			p.deadline = rng.int(end + 1, Math.max(end + 1, nextStart - 1));
			return p;
		}
		default: {
			const p = basePolicy(rng, rng.int(5, 6), [6, 10]);
			p.jitterKind = 'decorrelated';
			const okAt = p.attempts - rng.int(0, 1);
			for (let i = 1; i < okAt; i += 1) {
				const reply = retryableFailure(rng, p.timeout);
				if (reply.code === 503 && rng.bool(0.3)) reply.retryAfter = rng.int(1, 2);
				p.replies.push(reply);
			}
			p.replies.push(success(rng));
			return p;
		}
	}
}

/**
 * The misconceptions every instance of a class must expose. A deadline that cuts an attempt short exposes waiting for
 * the attempt; one that the next pause would overrun exposes the missing early give-up.
 */
const REQUIRED: Record<string, (p: Params, answer: string) => string[]> = {
	'middle/jitter-cap': () => ['no-jitter', 'jitter-after-cap'],
	'middle/attempt-timeout': () => ['timeout-waits-response', 'timeout-final'],
	'middle/status-policy': () => ['retry-4xx', 'no-retry-408-429'],
	'middle/attempts-limit': () => ['limit-as-retries'],
	'senior/deadline': (p, answer) =>
		answer.endsWith(`deadline ${p.deadline ?? ''}`) ? ['abort-waits'] : ['no-early-give-up'],
	'senior/user-abort': () => ['abort-waits'],
	'senior/retry-after-deadline': () => ['ignore-retry-after', 'no-early-give-up'],
	'senior/decorrelated': () => ['no-cap', 'pause-from-start']
};

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const MIDDLE_CODE = [
	'const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);',
	'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
	'',
	'async function fetchWithRetry(url, { attempts, timeout, base, cap, jitter }) {',
	'  for (let n = 1; ; n++) {',
	'    let response = null;',
	'    let failure = null;',
	'    try {',
	'      response = await fetch(url, { signal: AbortSignal.timeout(timeout) });',
	'    } catch (error) {',
	"      failure = error.name === 'TimeoutError' ? 'timeout' : 'network';",
	'    }',
	"    if (response?.ok) return 'ok';",
	'    if (response && !RETRYABLE.has(response.status)) return String(response.status);',
	'    if (n === attempts) return failure ?? String(response.status);',
	'    let pause = Math.floor((Math.min(cap, base * 2 ** (n - 1)) * jitter[n - 1]) / 100);',
	"    const retryAfter = response?.headers.get('Retry-After');",
	'    if (retryAfter) pause = Math.max(pause, Number(retryAfter) * 1000);',
	'    await sleep(pause);',
	'  }',
	'}'
];

function seniorCode(p: Params): string[] {
	const pauseLines =
		p.jitterKind === 'full'
			? ['    let pause = Math.floor((Math.min(cap, base * 2 ** (n - 1)) * jitter[n - 1]) / 100);']
			: [
					'    let pause = Math.min(cap, base + Math.floor(((prev * 3 - base) * jitter[n - 1]) / 100));',
					'    prev = pause;'
				];
	return [
		'const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);',
		'',
		'function sleep(ms, signal) {',
		'  return new Promise((resolve, reject) => {',
		'    const timer = setTimeout(resolve, ms);',
		"    signal.addEventListener('abort', () => {",
		'      clearTimeout(timer);',
		'      reject(signal.reason);',
		'    });',
		'  });',
		'}',
		'',
		'async function fetchWithRetry(url, policy, signal) {',
		'  const { attempts, timeout, base, cap, jitter, deadline } = policy;',
		'  const started = Date.now();',
		'  const outer = AbortSignal.any([signal, AbortSignal.timeout(deadline)]);',
		...(p.jitterKind === 'decorrelated' ? ['  let prev = base;'] : []),
		'  for (let n = 1; ; n++) {',
		'    let response = null;',
		'    let failure = null;',
		'    try {',
		'      const attempt = AbortSignal.any([outer, AbortSignal.timeout(timeout)]);',
		'      response = await fetch(url, { signal: attempt });',
		'    } catch (error) {',
		"      if (signal.aborted) return 'aborted';",
		"      if (outer.aborted) return 'deadline';",
		"      failure = error.name === 'TimeoutError' ? 'timeout' : 'network';",
		'    }',
		"    if (response?.ok) return 'ok';",
		'    if (response && !RETRYABLE.has(response.status)) return String(response.status);',
		'    if (n === attempts) return failure ?? String(response.status);',
		...pauseLines,
		"    const retryAfter = response?.headers.get('Retry-After');",
		'    if (retryAfter) pause = Math.max(pause, Number(retryAfter) * 1000);',
		"    if (Date.now() - started + pause >= deadline) return 'deadline';",
		'    try {',
		'      await sleep(pause, outer);',
		'    } catch {',
		"      return signal.aborted ? 'aborted' : 'deadline';",
		'    }',
		'  }',
		'}'
	];
}

function describeReply(reply: Reply, i: number, timeout: number): string {
	if (reply.kind === 'network')
		return `${i + 1}. через ${reply.ms} мс — сетевая ошибка (\`fetch\` отклоняется с \`TypeError\`);`;
	const header = reply.retryAfter !== null ? ` с заголовком \`Retry-After: ${reply.retryAfter}\`` : '';
	const late = reply.ms > timeout ? ' (если клиент ещё ждёт)' : '';
	return `${i + 1}. ответ \`${reply.code}\`${header} через ${reply.ms} мс${late};`;
}

function describe(p: Params, senior: boolean): string {
	const policy = [
		`- \`attempts = ${p.attempts}\` — попыток всего, включая первую;`,
		`- \`timeout = ${p.timeout}\` — таймаут одной попытки, мс;`,
		`- \`base = ${p.base}\`, \`cap = ${p.cap}\` — мс;`,
		`- \`jitter = [${p.jitter.slice(0, p.attempts - 1).join(', ')}]\` — проценты для пауз после попыток 1, 2, …;`
	];
	if (senior) policy.push(`- \`deadline = ${p.deadline ?? 0}\` — общий срок, мс от вызова.`);
	const abort =
		p.abortAt !== null
			? [
					'',
					`Через ${p.abortAt} мс после вызова пользователь закрывает экран: компонент вызывает \`controller.abort()\` у контроллера, чей \`signal\` передан в \`fetchWithRetry\`.`
				]
			: senior
				? ['', 'Пользователь экран не закрывает: переданный `signal` не отменяется.']
				: [];
	return [
		senior
			? 'Клиент в браузере повторяет запрос с общим сроком и возможностью отмены:'
			: 'Клиент в браузере повторяет запрос по политике:',
		'',
		['```js', ...(senior ? seniorCode(p) : MIDDLE_CODE), '```'].join('\n'),
		'',
		'Политика:',
		'',
		...policy,
		...abort,
		'',
		'Сервер на попытки отвечает так (ответы, до которых дело не дойдёт, тоже перечислены):',
		'',
		...p.replies.map((reply, i) => describeReply(reply, i, p.timeout)),
		'',
		'Считаем, что `fetch` отвечает ровно через указанное время, таймеры срабатывают точно, а остальной код выполняется мгновенно; `Date.now()` отсчитываем от вызова `fetchWithRetry`.',
		'',
		'Введите через пробел: моменты (мс от вызова), когда начинается каждая попытка, затем то, что вернёт `fetchWithRetry`, и момент, когда она это вернёт. Например: `0 340 1210 ok 1530`.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: the same timeline as a sequence of events in Python.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
RETRY = {408, 429, 500, 502, 503, 504}


def first_cut(lo, hi):
    hits = []
    if p["abortAt"] is not None and lo <= p["abortAt"] < hi:
        hits.append((p["abortAt"], "aborted"))
    if p["deadline"] is not None and lo <= p["deadline"] < hi:
        hits.append((p["deadline"], "deadline"))
    return min(hits) if hits else None


def run():
    starts = []
    clock = 0
    prev = p["base"]
    n = 0
    while True:
        n += 1
        r = p["replies"][n - 1]
        starts.append(clock)
        timed_out = r["ms"] > p["timeout"]
        finish = clock + (p["timeout"] if timed_out else r["ms"])
        hit = first_cut(clock, finish)
        if hit:
            return starts, hit[1], hit[0]
        if timed_out:
            reason = "timeout"
        elif r["kind"] == "network":
            reason = "network"
        elif 200 <= r["code"] <= 299:
            return starts, "ok", finish
        elif r["code"] in RETRY:
            reason = str(r["code"])
        else:
            return starts, str(r["code"]), finish
        if n == p["attempts"]:
            return starts, reason, finish
        pct = p["jitter"][n - 1]
        if p["jitterKind"] == "full":
            wait = min(p["cap"], p["base"] * 2 ** (n - 1)) * pct // 100
        else:
            wait = min(p["cap"], p["base"] + (prev * 3 - p["base"]) * pct // 100)
            prev = wait
        if not timed_out and r["kind"] == "status" and r["retryAfter"] is not None:
            wait = max(wait, r["retryAfter"] * 1000)
        if p["deadline"] is not None and finish + wait >= p["deadline"]:
            return starts, "deadline", finish
        hit = first_cut(finish, finish + wait)
        if hit:
            return starts, hit[1], hit[0]
        clock = finish + wait


starts, outcome, moment = run()
print(" ".join([str(s) for s in starts] + [outcome, str(moment)]))
`;

interface Candidate {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function candidate(p: Params): Candidate | null {
	const right = simulate(p, RIGHT);
	// A deadline or an abort exactly at an event of the timeline would make the order a matter of timers.
	if ([p.deadline, p.abortAt].some((x) => x !== null && right.moments.includes(x))) return null;
	if (right.answer.includes('past-limit')) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change }).answer;
			return [id, value === right.answer ? null : value];
		})
	);
	return { p, answer: right.answer, wrong };
}

/** A scenario for a seed whose draws never fit: fixed numbers that expose the class's misconceptions. */
function fixedScenario(classId: string): Params {
	const reply = (code: number, ms: number, retryAfter: number | null = null): Reply => ({
		kind: 'status',
		code,
		ms,
		retryAfter
	});
	const base: Params = {
		attempts: 5,
		timeout: 1000,
		base: 200,
		cap: 800,
		jitter: [50, 80, 60, 90, 70],
		jitterKind: 'full',
		replies: [reply(503, 120), reply(500, 1400), reply(429, 90, 2), reply(502, 300), reply(200, 150)],
		deadline: null,
		abortAt: null
	};
	switch (classId) {
		case 'status-policy':
			return {
				...base,
				replies: [reply(408, 120), reply(429, 90, 2), reply(404, 60), reply(503, 80), reply(200, 70), reply(200, 70)]
			};
		case 'attempts-limit':
			return { ...base, attempts: 3, replies: [reply(503, 120), reply(429, 90, 2), reply(502, 300), reply(200, 70)] };
		case 'deadline':
			return { ...base, deadline: 2650 };
		case 'user-abort':
			return { ...base, abortAt: 2650, deadline: 30000 };
		case 'retry-after-deadline':
			return {
				...base,
				replies: [reply(503, 120), reply(503, 200, 4), reply(503, 90), reply(502, 300), reply(200, 150)],
				deadline: 3500
			};
		case 'decorrelated':
			return { ...base, jitterKind: 'decorrelated', cap: 1500 };
		default:
			return base;
	}
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? (() => []);
	let chosen: Candidate | null = null;
	for (let tries = 0; tries < 300 && chosen === null; tries += 1) {
		const p = scenario(rng, input.classId);
		if (senior && p.deadline === null) p.deadline = 60000;
		const c = candidate(p);
		if (c && required(c.p, c.answer).every((id) => c.wrong[id] !== null)) chosen = c;
	}
	chosen ??= candidate(fixedScenario(input.classId));
	if (chosen === null) throw new Error(`${descriptor.key}: the fixed scenario of ${input.classId} does not fit`);
	const c = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(c.p, senior), code: null },
		answer: { kind: 'tokens', value: c.answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(c.p) }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(c.wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
