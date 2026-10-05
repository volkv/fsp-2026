// Idempotent creation through the eyes of a tester: a feed of POST requests with and without Idempotency-Key, from two
// clients, repeated with the same or another body, while the first one runs, after a 500 or after the key expires; the
// tester predicts every response and how many resources the feed really created.
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

type Client = 'A' | 'B';

interface Req {
	/** Arrival, seconds from the start. */
	t: number;
	client: Client;
	key: string | null;
	vacancy: number;
	/** How long the request runs if it is executed, seconds. */
	duration: number;
	/** If executed, it ends with 500. */
	fails: boolean;
}

interface Params {
	/** Intern feeds are sequential and show no times. */
	timed: boolean;
	/** How long a key is kept, seconds; `null` — longer than the feed. */
	ttl: number | null;
	firstId: number;
	requests: Req[];
}

interface Rules {
	replayCreates: boolean;
	countAttempts: boolean;
	noKeyDeduped: boolean;
	keyGlobal: boolean;
	replay500: boolean;
	mismatchReplays: boolean;
	noExpiry: boolean;
	expiryInclusive: boolean;
	inflightWaits: boolean;
}

const RIGHT: Rules = {
	replayCreates: false,
	countAttempts: false,
	noKeyDeduped: false,
	keyGlobal: false,
	replay500: false,
	mismatchReplays: false,
	noExpiry: false,
	expiryInclusive: false,
	inflightWaits: false
};

interface Exec {
	index: number;
	finish: number;
	fails: boolean;
}

interface Entry {
	t0: number;
	vacancy: number;
	exec: Exec;
}

type Outcome = { kind: 'exec' | 'replay'; exec: Exec } | { kind: 'code'; code: string };

/** The responses in order and the number of created applications, under a model of the contract. */
function simulate(p: Params, rules: Rules): string {
	const entries = new Map<string, Entry>();
	const execs: Exec[] = [];
	const outcomes: Outcome[] = [];
	const noKey: { client: Client; vacancy: number; exec: Exec }[] = [];
	const run = (r: Req, index: number): Exec => {
		const exec = { index, finish: r.t + r.duration, fails: r.fails };
		execs.push(exec);
		return exec;
	};
	p.requests.forEach((r, index) => {
		if (r.key === null) {
			const same = rules.noKeyDeduped
				? noKey.find((x) => x.client === r.client && x.vacancy === r.vacancy && x.exec.finish <= r.t && !x.exec.fails)
				: undefined;
			if (same) {
				outcomes.push({ kind: 'replay', exec: same.exec });
				return;
			}
			const exec = run(r, index);
			noKey.push({ client: r.client, vacancy: r.vacancy, exec });
			outcomes.push({ kind: 'exec', exec });
			return;
		}
		const scope = rules.keyGlobal ? r.key : `${r.client}|${r.key}`;
		let entry = entries.get(scope);
		if (entry) {
			const ttl = p.ttl;
			const expired =
				ttl !== null && !rules.noExpiry && (rules.expiryInclusive ? r.t > entry.t0 + ttl : r.t >= entry.t0 + ttl);
			const forgotten = entry.exec.fails && r.t >= entry.exec.finish && !rules.replay500;
			if (expired || forgotten || rules.replayCreates) entry = undefined;
		}
		if (!entry) {
			const exec = run(r, index);
			entries.set(scope, { t0: r.t, vacancy: r.vacancy, exec });
			outcomes.push({ kind: 'exec', exec });
			return;
		}
		const running = r.t < entry.exec.finish;
		if (running && !rules.inflightWaits) outcomes.push({ kind: 'code', code: '409' });
		else if (entry.vacancy !== r.vacancy && !rules.mismatchReplays) outcomes.push({ kind: 'code', code: '422' });
		else outcomes.push({ kind: 'replay', exec: entry.exec });
	});
	const ids = new Map<Exec, number>();
	[...execs]
		.filter((e) => !e.fails)
		.sort((a, b) => a.finish - b.finish || a.index - b.index)
		.forEach((e, i) => ids.set(e, p.firstId + i));
	const tokens = outcomes.map((o) =>
		o.kind === 'code' ? o.code : o.exec.fails ? '500' : `201:${ids.get(o.exec) ?? 0}`
	);
	const created = rules.countAttempts ? tokens.filter((t) => t.startsWith('201')).length : ids.size;
	return [...tokens, String(created)].join(' ');
}

type Timing = 'after' | 'during' | 'expiry';
type Action = 'newKeyed' | 'repeat' | 'mismatch' | 'otherClient' | 'noKey' | 'repeatNoKey';

interface Mix {
	actions: Readonly<Partial<Record<Action, number>>>;
	timing: Readonly<Partial<Record<Timing, number>>>;
	fails: number;
	duration: [number, number];
	ttl: readonly (number | null)[];
	count: [number, number];
}

const MIXES: Record<string, Mix> = {
	'intern/replay': {
		actions: { newKeyed: 2, repeat: 3, noKey: 1 },
		timing: { after: 1 },
		fails: 0,
		duration: [1, 1],
		ttl: [null],
		count: [5, 6]
	},
	'intern/no-key': {
		actions: { noKey: 2, repeatNoKey: 3, newKeyed: 1, repeat: 1 },
		timing: { after: 1 },
		fails: 0,
		duration: [1, 1],
		ttl: [null],
		count: [5, 6]
	},
	'intern/per-client': {
		actions: { otherClient: 3, newKeyed: 2, repeat: 2 },
		timing: { after: 1 },
		fails: 0,
		duration: [1, 1],
		ttl: [null],
		count: [5, 6]
	},
	'intern/server-error': {
		actions: { newKeyed: 2, repeat: 3, noKey: 1 },
		timing: { after: 1 },
		fails: 0.45,
		duration: [1, 1],
		ttl: [null],
		count: [5, 6]
	},
	'junior/body-mismatch': {
		actions: { newKeyed: 2, repeat: 2, mismatch: 3, noKey: 1 },
		timing: { after: 1 },
		fails: 0.1,
		duration: [1, 4],
		ttl: [null],
		count: [6, 8]
	},
	'junior/expiry': {
		actions: { newKeyed: 2, repeat: 4, mismatch: 1 },
		timing: { after: 1, expiry: 3 },
		fails: 0,
		duration: [1, 3],
		ttl: [10, 15, 20, 30],
		count: [6, 8]
	},
	'junior/in-flight': {
		actions: { newKeyed: 2, repeat: 4, mismatch: 1, noKey: 1 },
		timing: { during: 3, after: 2 },
		fails: 0.1,
		duration: [3, 8],
		ttl: [null],
		count: [6, 8]
	},
	'junior/mixed': {
		actions: { newKeyed: 2, repeat: 4, mismatch: 1, otherClient: 1, noKey: 1 },
		timing: { during: 2, after: 1, expiry: 2 },
		fails: 0.1,
		duration: [2, 6],
		ttl: [10, 15, 20],
		count: [7, 8]
	}
};

function weighted<K extends string>(rng: Rng, weights: Readonly<Partial<Record<K, number>>>): K {
	const entries = Object.entries(weights) as [K, number][];
	const total = entries.reduce((s, [, w]) => s + w, 0);
	let x = rng.next() * total;
	for (const [key, w] of entries) {
		if (x < w) return key;
		x -= w;
	}
	const last = entries.at(-1);
	if (!last) throw new Error('weighted: empty');
	return last[0];
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const mix = MIXES[`${grade}/${classId}`];
	if (!mix) throw new Error(`${descriptor.key}: no mix for ${grade}/${classId}`);
	const timed = grade !== 'intern';
	const ttl = rng.pick(mix.ttl);
	const vacancies = rng.sample(
		Array.from({ length: 80 }, (_, i) => i + 10),
		3
	);
	const keyNames = rng.sample(['k-7', 'k-12', 'k-31', 'k-48', 'k-55', 'k-63', 'k-80', 'k-94'], 4);
	let keyIndex = 0;
	const requests: Req[] = [];
	const count = rng.int(mix.count[0], mix.count[1]);
	let lastT = -1;
	const duration = (): number => rng.int(mix.duration[0], mix.duration[1]);
	for (let i = 0; i < count; i += 1) {
		const keyed = requests.filter((r) => r.key !== null);
		const unkeyed = requests.filter((r) => r.key === null);
		let action = weighted(rng, mix.actions);
		if ((action === 'repeat' || action === 'mismatch' || action === 'otherClient') && keyed.length === 0)
			action = 'newKeyed';
		if (action === 'repeatNoKey' && unkeyed.length === 0) action = 'noKey';
		// The time: intern feeds are sequential; timed feeds place a repeat relative to the request it repeats.
		let t = lastT + (timed ? rng.int(1, 3) : 10);
		let target: Req | undefined;
		if (action === 'repeat' || action === 'mismatch' || action === 'otherClient') target = rng.pick(keyed);
		if (action === 'repeatNoKey') target = rng.pick(unkeyed);
		if (timed && target && action !== 'otherClient') {
			const timing = weighted(rng, mix.timing);
			if (timing === 'during') t = target.t + rng.int(0, Math.max(0, target.duration - 1));
			else if (timing === 'expiry' && ttl !== null) t = target.t + ttl + rng.pick([-1, 0, 0, 0, 1, 2]);
			else t = target.t + target.duration + rng.int(0, 2);
			t = Math.max(t, lastT + 1);
		}
		const fails = rng.bool(mix.fails);
		let req: Req;
		if (action === 'newKeyed') {
			const key = keyNames[keyIndex % keyNames.length] ?? 'k-1';
			keyIndex += 1;
			req = {
				t,
				client: rng.pick(['A', 'B'] as const),
				key,
				vacancy: rng.pick(vacancies),
				duration: duration(),
				fails
			};
		} else if (action === 'noKey') {
			req = {
				t,
				client: rng.pick(['A', 'B'] as const),
				key: null,
				vacancy: rng.pick(vacancies),
				duration: duration(),
				fails
			};
		} else if (target && action === 'repeatNoKey') {
			req = { ...target, t, duration: duration(), fails };
		} else if (target && action === 'otherClient') {
			req = {
				t,
				client: target.client === 'A' ? 'B' : 'A',
				key: target.key,
				vacancy: rng.bool() ? target.vacancy : rng.pick(vacancies),
				duration: duration(),
				fails
			};
		} else if (target && action === 'mismatch') {
			const other = vacancies.filter((v) => v !== target.vacancy);
			req = { ...target, t, vacancy: rng.pick(other), duration: duration(), fails };
		} else if (target) {
			req = { ...target, t, duration: duration(), fails };
		} else throw new Error(`${descriptor.key}: no target for ${action}`);
		requests.push(req);
		lastT = t;
	}
	return { timed, ttl, firstId: rng.int(100, 900), requests };
}

/** Executed successful requests that finish at the same moment would make the numbering ambiguous. */
function finishesDistinct(p: Params): boolean {
	const finishes = p.requests.map((r) => r.t + r.duration);
	return new Set(finishes).size === finishes.length;
}

function describe(p: Params): string {
	const lines = p.requests.map((r, i) => {
		const parts = [
			...(p.timed ? [`t=${r.t} с`] : []),
			`клиент ${r.client}`,
			r.key === null ? 'без ключа' : `Idempotency-Key: ${r.key}`,
			`тело {"vacancy_id": ${r.vacancy}}`,
			...(p.timed ? [`выполнение ${r.duration} с`] : []),
			...(r.fails ? ['выполнение кончится 500'] : [])
		];
		return `${i + 1}. ${parts.join(' | ')}`;
	});
	const rules = [
		`- \`POST /api/v1/applications\` создаёт отклик на вакансию; успешный ответ — \`201\` с номером отклика. Номера выдаются по порядку завершения успешных выполнений: ${p.firstId}, ${p.firstId + 1}, ${p.firstId + 2} и так далее. Выполнение, которое кончилось \`500\`, отклик не создаёт и номер не занимает.`,
		'- Запрос без заголовка `Idempotency-Key` выполняется всегда.',
		'- Ключи у каждого клиента свои: одинаковые значения ключа у разных клиентов друг от друга не зависят.',
		'- Запрос с ключом, которого сервер не помнит, выполняется; сервер запоминает ключ, тело и итоговый ответ.',
		...(p.timed
			? [
					'- Запрос с ключом, который сервер помнит: пока выполняется запрос, с которым ключ сохранён (от момента его прихода до момента завершения, сам момент завершения уже не входит), — `409`, тело не сравнивается; после завершения с тем же телом — сохранённый ответ (тот же код и номер), ничего не создаётся; после завершения с другим телом — `422`, ничего не создаётся.'
				]
			: [
					'- Запрос с ключом, который сервер помнит: с тем же телом — сохранённый ответ (тот же код и номер), ничего не создаётся; с другим телом — `422`, ничего не создаётся.'
				]),
		'- Ответ `500` не сохраняется: в момент завершения такого выполнения сервер забывает ключ, и следующий запрос с этим ключом выполняется заново.',
		...(p.ttl !== null
			? [
					`- Ключ хранится ${p.ttl} с от прихода запроса, с которым он сохранён: запрос, пришедший через ${p.ttl} с или позже, выполняется заново и сохраняет ключ с новым отсчётом.`
				]
			: [])
	];
	return [
		'Тестировщик проверяет идемпотентность создания откликов и заранее записывает ожидаемые ответы.',
		'',
		'## Контракт',
		'',
		...rules,
		'',
		'## Запросы',
		'',
		p.timed
			? 'Для каждого запроса: момент прихода, клиент, ключ, тело, сколько длится выполнение, если запрос выполняется, и чем выполнение кончится, если не успехом.'
			: 'Запросы идут строго по очереди: следующий отправляется после ответа на предыдущий. Ключи хранятся дольше всего сценария.',
		'',
		'```',
		...lines,
		'```',
		'',
		`Введите через пробел ответ на каждый запрос по порядку — \`201:<номер отклика>\` или код ответа (\`409\`, \`422\`, \`500\`), — а последним значением сколько откликов создано за весь сценарий. Например: \`201:${p.firstId} 422 201:${p.firstId} 1\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
ttl = p["ttl"]
memory = {}
runs = []
answers = []
for i, r in enumerate(p["requests"]):
    t = r["t"]
    def execute():
        run = {"i": i, "end": t + r["duration"], "fails": r["fails"]}
        runs.append(run)
        return run
    if r["key"] is None:
        answers.append(("run", execute()))
        continue
    scope = (r["client"], r["key"])
    saved = memory.get(scope)
    if saved is not None:
        if ttl is not None and t >= saved["t0"] + ttl:
            saved = None
        elif saved["run"]["fails"] and t >= saved["run"]["end"]:
            saved = None
    if saved is None:
        run = execute()
        memory[scope] = {"t0": t, "vacancy": r["vacancy"], "run": run}
        answers.append(("run", run))
    elif t < saved["run"]["end"]:
        answers.append(("code", "409"))
    elif r["vacancy"] != saved["vacancy"]:
        answers.append(("code", "422"))
    else:
        answers.append(("run", saved["run"]))
ok = sorted((run for run in runs if not run["fails"]), key=lambda run: (run["end"], run["i"]))
number = {run["i"]: p["firstId"] + k for k, run in enumerate(ok)}
out = []
for kind, x in answers:
    if kind == "code":
        out.append(x)
    elif x["fails"]:
        out.append("500")
    else:
        out.append("201:%d" % number[x["i"]])
print(" ".join(out), len(ok))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'replay-creates': { replayCreates: true },
	'count-attempts': { countAttempts: true },
	'no-key-deduped': { noKeyDeduped: true },
	'key-global': { keyGlobal: true },
	'replay-500': { replay500: true },
	'mismatch-replays': { mismatchReplays: true },
	'no-expiry': { noExpiry: true },
	'expiry-inclusive': { expiryInclusive: true },
	'inflight-waits': { inflightWaits: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/replay': ['replay-creates', 'count-attempts'],
	'intern/no-key': ['no-key-deduped'],
	'intern/per-client': ['key-global'],
	'intern/server-error': ['replay-500'],
	'junior/body-mismatch': ['mismatch-replays'],
	'junior/expiry': ['no-expiry'],
	'junior/in-flight': ['inflight-waits'],
	'junior/mixed': ['expiry-inclusive', 'inflight-waits']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Feeds are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		if (!finishesDistinct(p)) continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
