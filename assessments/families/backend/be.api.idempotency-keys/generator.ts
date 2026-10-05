// Idempotency keys: what a payment API answers to a sequence of POST requests with and without `Idempotency-Key` —
// a stored response for a repeat, 422 for the same key with another body, 409 while the first request still runs —
// and, a level up, keys that expire and failed executions that are not stored.
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

type Outcome = 201 | 400 | 500;

interface Request {
	t: number;
	client: string;
	key: string | null;
	amount: number;
	/** What an execution of this request ends with. */
	outcome: Outcome;
}

interface Params {
	durationSec: number;
	/** Seconds a key lives after the end of the execution that stored it; `null` — longer than the scenario. */
	ttlSec: number | null;
	firstPayment: number;
	requests: Request[];
}

interface Rules {
	dedup: boolean;
	bodyCheck: boolean;
	inflightConflict: boolean;
	expiry: boolean;
	store5xx: boolean;
	store4xx: boolean;
	bodyFirst: boolean;
	dedupByBody: boolean;
	ttlFromStart: boolean;
}

const RIGHT: Rules = {
	dedup: true,
	bodyCheck: true,
	inflightConflict: true,
	expiry: true,
	store5xx: false,
	store4xx: true,
	bodyFirst: true,
	dedupByBody: false,
	ttlFromStart: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-dedup': { dedup: false },
	'body-ignored': { bodyCheck: false },
	'inflight-duplicate': { inflightConflict: false },
	'no-expiry': { expiry: false },
	'store-5xx': { store5xx: true },
	'forget-4xx': { store4xx: false },
	'conflict-before-body': { bodyFirst: false },
	'dedup-by-body': { dedupByBody: true },
	'ttl-from-start': { ttlFromStart: true }
};

interface Stored {
	amount: number;
	finish: number;
	response: string;
	outcome: Outcome;
}

/** The answer: the response to every request in order, then the number of payments created. */
function simulate(p: Params, rules: Rules): string {
	const keys = new Map<string, Stored>();
	let next = p.firstPayment;
	const responses: string[] = [];
	const execute = (r: Request): Stored => {
		const response = r.outcome === 201 ? `201:${next++}` : String(r.outcome);
		return { amount: r.amount, finish: r.t + p.durationSec, response, outcome: r.outcome };
	};
	for (const r of p.requests) {
		const key = rules.dedupByBody ? `body:${r.amount}` : r.key;
		if (key === null || !rules.dedup) {
			responses.push(execute(r).response);
			continue;
		}
		let stored = keys.get(key);
		if (stored && r.t >= stored.finish) {
			const released =
				(stored.outcome === 500 && !rules.store5xx) ||
				(stored.outcome === 400 && !rules.store4xx) ||
				(rules.expiry &&
					p.ttlSec !== null &&
					r.t >= stored.finish + p.ttlSec - (rules.ttlFromStart ? p.durationSec : 0));
			if (released) {
				keys.delete(key);
				stored = undefined;
			}
		}
		if (!stored) {
			const done = execute(r);
			keys.set(key, done);
			responses.push(done.response);
			continue;
		}
		const differs = rules.bodyCheck && r.amount !== stored.amount;
		const running = r.t < stored.finish;
		if (rules.bodyFirst && differs) responses.push('422');
		else if (running) responses.push(rules.inflightConflict ? '409' : execute(r).response);
		else if (differs) responses.push('422');
		else responses.push(stored.response);
	}
	return [...responses, String(next - p.firstPayment)].join(' ');
}

const CLIENTS = ['web', 'ios', 'android', 'partner', 'billing', 'cron'] as const;

/** One key's story: offsets in seconds from its start, the body and the outcome of an execution. */
type Story = { dt: number; amount: number; outcome?: Outcome; client?: string; rekey?: boolean }[];

function hexKey(rng: Rng): string {
	return Array.from({ length: 6 }, () => '0123456789abcdef'[rng.int(0, 15)]).join('');
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const durationSec = rng.int(3, 6);
	const ttlSec = grade === 'middle' ? rng.pick([20, 30, 40]) : null;
	const amount = (): number => rng.int(5, 90) * 100;
	const after = (): number => durationSec + rng.int(1, 6);
	const during = (): number => rng.int(1, durationSec - 1);
	const stories: Story[] = [];
	const a = amount();
	const b = amount();
	const other = (x: number): number => x + rng.pick([-1, 1]) * rng.int(1, 4) * 100;
	if (grade === 'junior') {
		if (classId === 'replay') {
			const first = after();
			stories.push([
				{ dt: 0, amount: a },
				{ dt: first, amount: a },
				{ dt: first + rng.int(1, 5), amount: a }
			]);
		} else if (classId === 'body-mismatch') {
			const mismatch = after();
			const story: Story = [
				{ dt: 0, amount: a },
				{ dt: mismatch, amount: other(a) }
			];
			if (rng.bool()) story.push({ dt: mismatch + rng.int(1, 4), amount: a });
			stories.push(story);
		} else if (classId === 'new-key-per-retry') {
			const retry = after();
			stories.push([
				{ dt: 0, amount: a },
				{ dt: retry, amount: a, rekey: true },
				{ dt: retry + after(), amount: a }
			]);
		} else {
			const late = after();
			stories.push([
				{ dt: 0, amount: a },
				{ dt: during(), amount: a },
				{ dt: late, amount: a }
			]);
		}
		stories.push(
			rng.bool()
				? [
						{ dt: 0, amount: b },
						{ dt: after(), amount: b }
					]
				: [{ dt: 0, amount: b }]
		);
	} else {
		const ttl = ttlSec ?? 0;
		if (classId === 'expiry') {
			const replay = after();
			stories.push([
				{ dt: 0, amount: a },
				{ dt: replay, amount: a },
				{ dt: durationSec + ttl + rng.int(1, 8), amount: a }
			]);
			stories.push([
				{ dt: 0, amount: b },
				{ dt: durationSec + ttl + rng.int(1, 8), amount: other(b) }
			]);
		} else if (classId === 'ttl-from-finish') {
			stories.push([
				{ dt: 0, amount: a },
				{ dt: ttl + rng.int(0, durationSec - 1), amount: a },
				{ dt: durationSec + ttl + rng.int(1, 8) + durationSec, amount: a }
			]);
			stories.push(
				rng.bool()
					? [
							{ dt: 0, amount: b },
							{ dt: after(), amount: other(b) }
						]
					: [
							{ dt: 0, amount: b },
							{ dt: after(), amount: b }
						]
			);
		} else if (classId === 'failed-first') {
			const retry = after();
			stories.push([
				{ dt: 0, amount: a, outcome: 500 },
				{ dt: retry, amount: a },
				{ dt: retry + after(), amount: a }
			]);
			const bad = rng.pick([0, -a]);
			const replay = after();
			stories.push([
				{ dt: 0, amount: bad, outcome: 400 },
				{ dt: replay, amount: bad, outcome: 400 },
				{ dt: replay + rng.int(1, 5), amount: b }
			]);
		} else {
			const twin = rng.int(1, durationSec - 1);
			const third = rng.int(1, durationSec - 1);
			const clients = rng.sample(CLIENTS, 2);
			stories.push([
				{ dt: 0, amount: a, client: clients[0] },
				{ dt: twin, amount: a, client: clients[1] },
				{ dt: third, amount: other(a), client: clients[1] },
				{ dt: after(), amount: a, client: clients[1] }
			]);
			stories.push([
				{ dt: 0, amount: b },
				{ dt: durationSec + ttl + rng.int(1, 6), amount: b }
			]);
		}
	}
	const keyed: Request[] = stories.flatMap((story) => {
		const start = rng.int(0, 12);
		let key = hexKey(rng);
		const client = rng.pick(CLIENTS);
		return story.map((step) => {
			// A client that makes a new key for a retry: this step and the next use it.
			if (step.rekey) key = hexKey(rng);
			return {
				t: start + step.dt,
				client: step.client ?? client,
				key,
				amount: step.amount,
				outcome: step.outcome ?? 201
			};
		});
	});
	const loose: Request[] = Array.from({ length: rng.int(1, 2) }, () => ({
		t: rng.int(0, 20),
		client: rng.pick(CLIENTS),
		key: null,
		amount: amount(),
		outcome: 201 as const
	}));
	return {
		durationSec,
		ttlSec,
		firstPayment: rng.int(100, 900) * 10 + 1,
		requests: [...keyed, ...loose].sort((x, y) => x.t - y.t)
	};
}

/** A scenario is clear when no two requests share a moment and none falls on a boundary of a stored key. */
function clear(p: Params): boolean {
	const moments = new Set(p.requests.map((r) => r.t));
	if (moments.size !== p.requests.length) return false;
	for (const r of p.requests) {
		for (const o of p.requests) {
			if (o.key === null || o.key !== r.key || o.t >= r.t) continue;
			const finish = o.t + p.durationSec;
			if (r.t === finish || (p.ttlSec !== null && r.t === finish + p.ttlSec)) return false;
		}
	}
	return true;
}

function describe(p: Params, grade: string): string {
	const rows = p.requests.map((r, i) => {
		const note = r.outcome === 201 ? '' : ` — выполнение закончится ответом ${r.outcome}`;
		return `| ${i + 1} | ${r.t} | ${r.client} | ${r.key === null ? '—' : `\`${r.key}\``} | \`{"amount": ${r.amount}}\`${note} |`;
	});
	const rules = [
		'- Запрос без ключа выполняется всегда.',
		'- Ключ, которого сервер не знает, сервер запоминает вместе с телом запроса и выполняет запрос.',
		'- Если ключ известен и тело отличается от запомненного — ответ 422, запрос не выполняется (так же и пока первый запрос с этим ключом ещё выполняется).',
		'- Если ключ известен, тело то же, а запрос, выполняющий этот ключ, ещё не завершился — ответ 409, запрос не выполняется.',
		'- Если ключ известен, тело то же и выполнение завершилось — сервер возвращает сохранённый ответ (тот же код и тот же номер платежа), ничего не выполняя.'
	];
	if (grade === 'middle') {
		rules.push(
			'- Ответы 2xx и 4xx сохраняются под ключом. Ответ 5xx не сохраняется: в момент завершения такого выполнения сервер забывает ключ, и следующий запрос с ним выполняется как новый.',
			`- Ключ хранится ${p.ttlSec} с с момента завершения выполнения, которое его сохранило; запрос, пришедший в этот момент или позже, сервер выполняет как с новым ключом.`
		);
	}
	return [
		`Клиенты отправляют \`POST /v1/payments\`. Каждое выполнение длится ${p.durationSec} с от момента прихода запроса. ${
			grade === 'middle'
				? 'Выполнение заканчивается ответом `201` и создаёт платёж, если в таблице не сказано другое; ответы 400 и 500 платёж не создают.'
				: 'Каждое выполнение заканчивается ответом `201` и создаёт платёж.'
		} Платежи получают номера по порядку, начиная с ${p.firstPayment}. Правила сервера для заголовка \`Idempotency-Key\`:`,
		'',
		...rules,
		'',
		'Запросы по порядку прихода (момент — в секундах):',
		'',
		'| # | момент | клиент | Idempotency-Key | тело |',
		'|---|---|---|---|---|',
		...rows,
		'',
		`Введите через пробел ответ на каждый запрос по порядку — \`201:<номер платежа>\` или код ответа, — а последним значением число созданных платежей. Например: \`201:${p.firstPayment + 50} 409 422 2\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
stored = {}
created = 0
answers = []

def run(r):
    global created
    if r["outcome"] == 201:
        created += 1
        return "201:%d" % (p["firstPayment"] + created - 1)
    return str(r["outcome"])

for r in p["requests"]:
    key = r["key"]
    if key is None:
        answers.append(run(r))
        continue
    s = stored.get(key)
    if s is not None and r["t"] >= s["end"]:
        if s["outcome"] == 500:
            s = None
        elif p["ttlSec"] is not None and r["t"] >= s["end"] + p["ttlSec"]:
            s = None
    if s is None:
        stored[key] = {"amount": r["amount"], "end": r["t"] + p["durationSec"], "outcome": r["outcome"], "answer": run(r)}
        answers.append(stored[key]["answer"])
    elif r["amount"] != s["amount"]:
        answers.append("422")
    elif r["t"] < s["end"]:
        answers.append("409")
    else:
        answers.append(s["answer"])
print(*answers, created)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/replay': ['no-dedup'],
	'junior/body-mismatch': ['body-ignored', 'no-dedup'],
	'junior/in-flight': ['inflight-duplicate', 'no-dedup'],
	'middle/expiry': ['no-expiry'],
	'middle/failed-first': ['store-5xx', 'forget-4xx'],
	'middle/race': ['conflict-before-body', 'inflight-duplicate'],
	'junior/new-key-per-retry': ['dedup-by-body'],
	'middle/ttl-from-finish': ['ttl-from-start', 'no-expiry']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		if (!clear(p)) continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade), code: null },
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
