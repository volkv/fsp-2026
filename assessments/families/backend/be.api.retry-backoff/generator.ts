// Retries with exponential backoff: when a client gets its answer or gives up, given the server's responses, the
// policy's cap, attempt limit and deadline, Retry-After and which failures may be retried at all.
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

/** One response of the server: a code, or a timeout; how long it took; Retry-After in ms for a 503. */
interface Response {
	code: number | 'timeout';
	ms: number;
	retryAfterMs: number | null;
}

interface Params {
	baseMs: number;
	capMs: number;
	maxAttempts: number;
	timeoutMs: number;
	deadlineMs: number | null;
	method: 'GET' | 'POST';
	idempotencyKey: boolean;
	responses: Response[];
}

interface Rules {
	cap: boolean;
	pauseFromEnd: boolean;
	retryAfter: boolean;
	safeRetries: boolean;
	deadlineCountsTimeout: boolean;
	retry4xx: boolean;
	limitAsRetries: boolean;
}

const RIGHT: Rules = {
	cap: true,
	pauseFromEnd: true,
	retryAfter: true,
	safeRetries: true,
	deadlineCountsTimeout: true,
	retry4xx: false,
	limitAsRetries: false
};

/** Simulates the client: `<attempts> <outcome> <ms>` where the outcome is `ok`, a code, `timeout` or `deadline`. */
function simulate(p: Params, rules: Rules): string {
	let start = 0;
	for (let attempt = 1; ; attempt += 1) {
		const response = p.responses[attempt - 1];
		// Only a misconception goes past the responses the scenario lists.
		if (!response) return `${attempt - 1} past-limit`;
		const took = response.code === 'timeout' ? p.timeoutMs : response.ms;
		const end = start + took;
		if (response.code === 200) return `${attempt} ok ${end}`;
		const outcome = String(response.code);
		const retryable =
			response.code === 'timeout' || response.code === 500
				? p.method === 'GET' || p.idempotencyKey || !rules.safeRetries
				: response.code === 503 ||
					response.code === 429 ||
					(rules.retry4xx && response.code >= 400 && response.code < 500);
		const limit = rules.limitAsRetries ? p.maxAttempts + 1 : p.maxAttempts;
		if (!retryable || attempt === limit) return `${attempt} ${outcome} ${end}`;
		const backoff = rules.cap ? Math.min(p.capMs, p.baseMs * 2 ** (attempt - 1)) : p.baseMs * 2 ** (attempt - 1);
		const pause =
			rules.retryAfter && response.retryAfterMs !== null ? Math.max(backoff, response.retryAfterMs) : backoff;
		const next = (rules.pauseFromEnd ? end : start) + pause;
		if (p.deadlineMs !== null) {
			const latestEnd = rules.deadlineCountsTimeout ? next + p.timeoutMs : next;
			if (latestEnd > p.deadlineMs) return `${attempt} deadline ${end}`;
		}
		start = Math.max(next, end);
	}
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const baseMs = rng.pick([100, 150, 200, 250]);
	const timeoutMs = rng.pick([1000, 1500, 2000]);
	const fail = (codes: readonly (number | 'timeout')[]): Response => {
		const code = rng.pick(codes);
		return { code, ms: rng.int(15, 480), retryAfterMs: null };
	};
	const responses: Response[] = [];
	if (grade === 'middle') {
		const maxAttempts = rng.int(4, 6);
		if (classId === 'cap') {
			const okAt = maxAttempts - rng.int(0, 1);
			for (let i = 1; i < okAt; i += 1) responses.push(fail([503, 500, 'timeout']));
			responses.push({ code: 200, ms: rng.int(15, 480), retryAfterMs: null });
			return {
				baseMs,
				capMs: baseMs * rng.pick([2, 4]),
				maxAttempts,
				timeoutMs,
				deadlineMs: null,
				method: 'GET',
				idempotencyKey: false,
				responses
			};
		}
		if (classId === 'final-code') {
			// Retryable failures, then a final 4xx, then answers only a misconception would reach.
			const at = rng.int(2, maxAttempts - 1);
			for (let i = 1; i < at; i += 1) responses.push(fail([503, 500, 'timeout']));
			responses.push(fail([400, 404, 409, 422]));
			while (responses.length < maxAttempts - 1) responses.push(fail([503, 500]));
			responses.push({ code: 200, ms: rng.int(15, 480), retryAfterMs: null });
			return {
				baseMs,
				capMs: baseMs * rng.pick([2, 4]),
				maxAttempts,
				timeoutMs,
				deadlineMs: null,
				method: 'GET',
				idempotencyKey: false,
				responses
			};
		}
		if (classId === 'deadline') {
			for (let i = 1; i <= maxAttempts; i += 1) responses.push(fail([503, 'timeout', 500]));
			const p: Params = {
				baseMs,
				capMs: baseMs * 8,
				maxAttempts,
				timeoutMs,
				deadlineMs: null,
				method: 'GET',
				idempotencyKey: false,
				responses
			};
			// The deadline falls where the next attempt could start but could not finish.
			const free = simulateStarts(p);
			const k = rng.int(2, free.length - 1);
			const startK = free[k] ?? 0;
			p.deadlineMs = startK + rng.int(1, Math.floor(timeoutMs / 100) - 1) * 100;
			return p;
		}
		for (let i = 1; i < maxAttempts; i += 1) {
			const r = fail([503, 503, 500]);
			if (r.code === 503) r.retryAfterMs = rng.int(1, 3) * 1000;
			responses.push(r);
		}
		responses[0] = { code: 503, ms: rng.int(15, 480), retryAfterMs: rng.int(1, 3) * 1000 };
		responses.push({ code: 200, ms: rng.int(15, 480), retryAfterMs: null });
		return {
			baseMs,
			capMs: baseMs * 4,
			maxAttempts,
			timeoutMs,
			deadlineMs: null,
			method: 'GET',
			idempotencyKey: false,
			responses
		};
	}
	const maxAttempts = rng.int(5, 7);
	const p: Params = {
		baseMs,
		capMs: baseMs * 4,
		maxAttempts,
		timeoutMs,
		deadlineMs: null,
		method: 'POST',
		idempotencyKey: classId !== 'post-no-key',
		responses
	};
	if (classId === 'post-no-key') {
		// Retryable failures first, then one that must not be retried without a key.
		const lead = rng.int(1, maxAttempts - 3);
		for (let i = 0; i < lead; i += 1) responses.push(fail([503, 429]));
		responses.push(fail(['timeout', 500]));
		while (responses.length < maxAttempts - 1) responses.push(fail([503, 500]));
		responses.push({ code: 200, ms: rng.int(15, 480), retryAfterMs: null });
		return p;
	}
	if (classId === 'exhausted') {
		p.idempotencyKey = false;
		// Only retryable answers: the attempt limit ends it; one more answer is listed past the limit.
		for (let i = 0; i <= maxAttempts; i += 1) {
			const r = fail([503, 429]);
			if (rng.bool(0.4)) r.retryAfterMs = rng.int(1, 3) * 500;
			responses.push(r);
		}
		return p;
	}
	if (classId === 'post-with-key') {
		const lead = rng.int(1, maxAttempts - 3);
		for (let i = 0; i < lead; i += 1) responses.push(fail([503, 'timeout']));
		responses.push(fail([500, 'timeout']));
		const tail = rng.bool();
		while (responses.length < maxAttempts - 1) responses.push(fail(tail ? [409, 400] : [503, 500]));
		responses.push({ code: 200, ms: rng.int(15, 480), retryAfterMs: null });
		p.deadlineMs = null;
		return p;
	}
	for (let i = 0; i < maxAttempts; i += 1) {
		const r = fail([503, 503, 'timeout']);
		if (r.code === 503) r.retryAfterMs = rng.int(1, 4) * 500;
		responses.push(r);
	}
	responses[0] = { code: 503, ms: rng.int(15, 480), retryAfterMs: rng.int(2, 4) * 500 };
	p.method = 'GET';
	const starts = simulateStarts(p);
	p.deadlineMs =
		(starts[Math.min(starts.length - 1, rng.int(2, 4))] ?? 0) + rng.int(1, Math.floor(timeoutMs / 100) - 1) * 100;
	return p;
}

/** Start times of the attempts without a deadline: where a deadline can be set so that it bites. */
function simulateStarts(p: Params): number[] {
	const starts: number[] = [0];
	let start = 0;
	for (let attempt = 1; attempt < p.maxAttempts; attempt += 1) {
		const r = p.responses[attempt - 1];
		if (!r) break;
		const end = start + (r.code === 'timeout' ? p.timeoutMs : r.ms);
		const backoff = Math.min(p.capMs, p.baseMs * 2 ** (attempt - 1));
		start = end + (r.retryAfterMs !== null ? Math.max(backoff, r.retryAfterMs) : backoff);
		starts.push(start);
	}
	return starts;
}

function describe(p: Params): string {
	const lines = p.responses.map((r, i) => {
		const what =
			r.code === 'timeout'
				? `ответа нет, клиент прерывает попытку по таймауту`
				: r.code === 200
					? `200 OK через ${r.ms} мс`
					: `${r.code} через ${r.ms} мс${r.retryAfterMs !== null ? `, заголовок \`Retry-After: ${r.retryAfterMs / 1000}\`` : ''}`;
		return `${i + 1}. ${what}`;
	});
	return [
		`Клиент отправляет \`${p.method} /v1/payments\`${p.method === 'POST' ? (p.idempotencyKey ? ' с заголовком `Idempotency-Key`' : ' без ключа идемпотентности') : ''} и повторяет запрос по политике:`,
		'',
		`- попыток всего не больше ${p.maxAttempts}, включая первую; таймаут попытки — ${p.timeoutMs} мс;`,
		`- пауза перед повтором после попытки номер k — ${p.baseMs} · 2^(k−1) мс, но не больше ${p.capMs} мс; пауза отсчитывается от момента ответа (или таймаута);`,
		'- если ответ пришёл с `Retry-After` (секунды), клиент ждёт не меньше этого времени: пауза — наибольшее из двух;',
		'- повторяются ответы 503 и 429; таймаут и 500 повторяются, только если запрос идемпотентен (GET или POST с ключом идемпотентности); любой другой код — окончательный;',
		p.deadlineMs === null
			? '- общего срока нет.'
			: `- общий срок запроса — ${p.deadlineMs} мс от начала первой попытки: новая попытка не начинается, если её таймаут закончится позже срока; тогда итог — \`deadline\`.`,
		'',
		'Сервер отвечает на попытки так (если попыток меньше — остаток не нужен):',
		'',
		...lines,
		'',
		'Введите три значения через пробел: число сделанных попыток, итог (`ok`, код последнего ответа, `timeout` или `deadline`) и момент в миллисекундах от начала первой попытки, когда клиент получил последний ответ или таймаут. Например: `3 ok 1290`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
start = 0
attempt = 0
result = None
while result is None:
    attempt += 1
    r = p["responses"][attempt - 1]
    end = start + (p["timeoutMs"] if r["code"] == "timeout" else r["ms"])
    code = r["code"]
    if code == 200:
        result = f"{attempt} ok {end}"
        break
    if code in ("timeout", 500):
        retryable = p["method"] == "GET" or p["idempotencyKey"]
    else:
        retryable = code in (503, 429)
    if not retryable or attempt == p["maxAttempts"]:
        result = f"{attempt} {code} {end}"
        break
    pause = min(p["capMs"], p["baseMs"] * 2 ** (attempt - 1))
    if r["retryAfterMs"] is not None:
        pause = max(pause, r["retryAfterMs"])
    nxt = end + pause
    if p["deadlineMs"] is not None and nxt + p["timeoutMs"] > p["deadlineMs"]:
        result = f"{attempt} deadline {end}"
        break
    start = nxt
print(result)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'no-cap': { cap: false },
	'pause-from-start': { pauseFromEnd: false },
	'ignore-retry-after': { retryAfter: false },
	'retry-everything': { safeRetries: false },
	'deadline-at-start': { deadlineCountsTimeout: false },
	'retry-4xx': { retry4xx: true },
	'limit-as-retries': { limitAsRetries: true }
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception that applies to the class changes the answer.
	for (let tries = 0; tries < 200; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/cap': ['no-cap', 'pause-from-start'],
	'middle/deadline': ['deadline-at-start'],
	'middle/retry-after': ['ignore-retry-after'],
	'middle/final-code': ['retry-4xx'],
	'senior/post-no-key': ['retry-everything'],
	'senior/post-with-key': ['pause-from-start'],
	'senior/mixed-retry-after': ['ignore-retry-after', 'deadline-at-start'],
	'senior/exhausted': ['limit-as-retries', 'no-cap']
};

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
