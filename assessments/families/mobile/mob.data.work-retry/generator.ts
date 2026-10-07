// Background work by the model of WorkManager: when a worker that returns `Result.retry()` runs again under the
// backoff criteria (linear or exponential, clamped to 10 s … 5 h), the network constraint and an attempt limit; at
// Senior — unique work enqueued again with REPLACE, KEEP or APPEND while the first request waits for its retry.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildCompute, type ComputeItem, type Required } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'middle/exponential': ['exp-from-first', 'delay-from-start'],
	'middle/linear-clamp': ['no-clamp', 'linear-constant'],
	'middle/attempt-limit': ['attempt-from-one'],
	'middle/network': ['constraint-ignored'],
	'senior/replace': ['replace-keeps-attempts', 'replace-as-append'],
	'senior/keep': ['keep-blocks-finished', 'keep-as-replace'],
	'senior/append': ['append-parallel'],
	'senior/cap': ['no-cap', 'exp-from-first']
};

type Policy = 'EXPONENTIAL' | 'LINEAR';
type Existing = 'REPLACE' | 'KEEP' | 'APPEND';

/** A scenario: the times are in `unit`, from the first enqueue. */
interface Scenario {
	unit: 's' | 'min';
	policy: Policy;
	/** The backoff delay as passed to `setBackoffCriteria`, in `unit`. */
	delay: number;
	/** `setInitialDelay` of a single request: its first run; requests of unique work have none. */
	initial: number;
	/** How long every run lasts. */
	duration: number;
	/** The worker fails without calling the server once `runAttemptCount` reaches it; `null` — no limit. */
	limit: number | null;
	/** Offline intervals `[from, to)`; a request with them requires `NetworkType.CONNECTED`. */
	offline: [number, number][];
	/** Answers of the server to the calls in the order the calls are made: `true` — success. */
	responses: boolean[];
	/** Enqueues of the unique work after the first one (which is at 0): moment and policy. */
	enqueues: { at: number; policy: Existing }[];
}

interface Rules {
	expFromFirst: boolean;
	delayFromStart: boolean;
	clamp: boolean;
	linearConstant: boolean;
	attemptFromOne: boolean;
	constraint: boolean;
	cap: boolean;
	replaceKeepsAttempts: boolean;
	replaceAsAppend: boolean;
	keepBlocksFinished: boolean;
	keepAsReplace: boolean;
	appendRunsAfterFailure: boolean;
	appendParallel: boolean;
}

const RIGHT: Rules = {
	expFromFirst: false,
	delayFromStart: false,
	clamp: true,
	linearConstant: false,
	attemptFromOne: false,
	constraint: true,
	cap: true,
	replaceKeepsAttempts: false,
	replaceAsAppend: false,
	keepBlocksFinished: false,
	keepAsReplace: false,
	appendRunsAfterFailure: false,
	appendParallel: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'exp-from-first': { expFromFirst: true },
	'delay-from-start': { delayFromStart: true },
	'no-clamp': { clamp: false },
	'linear-constant': { linearConstant: true },
	'attempt-from-one': { attemptFromOne: true },
	'constraint-ignored': { constraint: false },
	'no-cap': { cap: false },
	'replace-keeps-attempts': { replaceKeepsAttempts: true },
	'replace-as-append': { replaceAsAppend: true },
	'keep-blocks-finished': { keepBlocksFinished: true },
	'keep-as-replace': { keepAsReplace: true },
	'append-runs-after-failure': { appendRunsAfterFailure: true },
	'append-parallel': { appendParallel: true }
};

const MIN_S = 10;
const MAX_S = 5 * 60 * 60;

type State = 'ENQUEUED' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'IGNORED';

interface Work {
	name: string;
	state: State;
	/** Runs made: the `runAttemptCount` the next run sees. */
	attempts: number;
	/** When the work may run next (for an enqueued one). */
	eligible: number;
}

/** A simulation step that cannot be answered within the model: the scenario is drawn again. */
class OutsideModel extends Error {}

/**
 * Runs the scenario: one line per run `<start> <work> <result>` (without the work name when there is one request),
 * then one line per request `<work> <final state>`.
 */
function simulate(s: Scenario, rules: Rules): string[] {
	const toUnit = (seconds: number): number => (s.unit === 's' ? seconds : seconds / 60);
	const fromUnit = (value: number): number => (s.unit === 's' ? value : value * 60);
	const base = (): number => {
		const seconds = fromUnit(s.delay);
		return toUnit(rules.clamp ? Math.min(MAX_S, Math.max(MIN_S, seconds)) : seconds);
	};
	const backoff = (attempts: number): number => {
		const d = base();
		const raw =
			s.policy === 'LINEAR'
				? rules.linearConstant
					? d
					: d * attempts
				: d * 2 ** (rules.expFromFirst ? attempts : attempts - 1);
		return rules.cap ? Math.min(raw, toUnit(MAX_S)) : raw;
	};
	const online = (t: number): boolean => !rules.constraint || !s.offline.some(([a, b]) => t >= a && t < b);
	const nextOnline = (t: number): number => {
		let at = t;
		for (let moved = true; moved;) {
			moved = false;
			for (const [a, b] of s.offline)
				if (rules.constraint && at >= a && at < b) {
					at = b;
					moved = true;
				}
		}
		return at;
	};
	const works: Work[] = [{ name: 'W1', state: 'ENQUEUED', attempts: 0, eligible: s.initial }];
	const parents = new Map<string, string>();
	const lines: string[] = [];
	const many = s.enqueues.length > 0;
	let calls = 0;
	const pending = [...s.enqueues];
	const active = (w: Work): boolean => w.state === 'ENQUEUED' || w.state === 'BLOCKED';
	for (let guard = 0; guard < 100; guard += 1) {
		const ready = works.filter((w) => w.state === 'ENQUEUED');
		const nextRun = ready.length === 0 ? null : Math.min(...ready.map((w) => nextOnline(w.eligible)));
		const enqueue = pending[0];
		if (enqueue && (nextRun === null || enqueue.at < nextRun)) {
			pending.shift();
			const name = `W${works.length + 1}`;
			const current = works.filter(active);
			let policy = enqueue.policy;
			if (policy === 'REPLACE' && rules.replaceAsAppend) policy = 'APPEND';
			if (policy === 'KEEP' && rules.keepAsReplace) policy = 'REPLACE';
			if (policy === 'KEEP') {
				const blocks = rules.keepBlocksFinished ? works.some((w) => w.state !== 'IGNORED') : current.length > 0;
				if (blocks) {
					works.push({ name, state: 'IGNORED', attempts: 0, eligible: 0 });
					continue;
				}
				works.push({ name, state: 'ENQUEUED', attempts: 0, eligible: enqueue.at });
				continue;
			}
			if (policy === 'REPLACE') {
				const inherited = rules.replaceKeepsAttempts ? Math.max(0, ...current.map((w) => w.attempts)) : 0;
				for (const w of current) w.state = 'CANCELLED';
				works.push({ name, state: 'ENQUEUED', attempts: inherited, eligible: enqueue.at });
				continue;
			}
			// APPEND: the new work waits for the leaf of the chain.
			const leaf = [...works].reverse().find((w) => w.state !== 'IGNORED');
			if (!leaf || rules.appendParallel) {
				works.push({ name, state: 'ENQUEUED', attempts: 0, eligible: enqueue.at });
				continue;
			}
			if (leaf.state === 'SUCCEEDED' || (leaf.state === 'FAILED' && rules.appendRunsAfterFailure)) {
				works.push({ name, state: 'ENQUEUED', attempts: 0, eligible: enqueue.at });
			} else if (leaf.state === 'FAILED' || leaf.state === 'CANCELLED') {
				works.push({ name, state: leaf.state, attempts: 0, eligible: 0 });
			} else {
				works.push({ name, state: 'BLOCKED', attempts: 0, eligible: 0 });
				parents.set(name, leaf.name);
			}
			continue;
		}
		if (nextRun === null) break;
		const work = ready.find((w) => nextOnline(w.eligible) === nextRun);
		if (!work) throw new Error('no work at the run moment');
		if (ready.filter((w) => nextOnline(w.eligible) === nextRun).length > 1) throw new OutsideModel();
		const start = nextRun;
		const end = start + s.duration;
		if (rules.constraint && (!online(start) || s.offline.some(([a]) => a > start && a < end))) throw new OutsideModel();
		if (pending[0] && pending[0].at >= start && pending[0].at < end) throw new OutsideModel();
		const seen = work.attempts + (rules.attemptFromOne ? 1 : 0);
		work.attempts += 1;
		let result: 'success' | 'retry' | 'failure';
		if (s.limit !== null && seen >= s.limit) result = 'failure';
		else {
			const ok = s.responses[calls];
			if (ok === undefined) throw new OutsideModel();
			calls += 1;
			result = ok ? 'success' : 'retry';
		}
		lines.push(many ? `${start} ${work.name} ${result}` : `${start} ${result}`);
		if (result === 'retry') {
			work.eligible = (rules.delayFromStart ? start : end) + backoff(work.attempts);
			continue;
		}
		work.state = result === 'success' ? 'SUCCEEDED' : 'FAILED';
		for (const w of works) {
			if (w.state !== 'BLOCKED' || parents.get(w.name) !== work.name) continue;
			if (work.state === 'SUCCEEDED' || rules.appendRunsAfterFailure) {
				w.state = 'ENQUEUED';
				w.eligible = end;
			} else w.state = 'FAILED';
		}
	}
	if (pending.length > 0 || works.some(active)) throw new OutsideModel();
	if (!lines.every((l) => Number.isInteger(Number(l.split(' ')[0])))) throw new OutsideModel();
	return [...lines, ...(many ? works.map((w) => `${w.name} ${w.state}`) : [works[0]?.state ?? 'ENQUEUED'])];
}

const PYTHON_REFERENCE = String.raw`import json

s = json.loads(input())
MIN_S, MAX_S = 10, 5 * 3600
scale = 1 if s["unit"] == "s" else 60
d = min(MAX_S, max(MIN_S, s["delay"] * scale)) / scale
cap = MAX_S / scale

def pause(n):
    raw = d * n if s["policy"] == "LINEAR" else d * 2 ** (n - 1)
    return min(raw, cap)

def runnable_at(t):
    changed = True
    while changed:
        changed = False
        for a, b in s["offline"]:
            if a <= t < b:
                t = b
                changed = True
    return t

# Each request: [name, state, runs, earliest, parent]
reqs = [["W1", "ENQUEUED", 0, s["initial"], None]]
events = sorted(s["enqueues"], key=lambda e: e["at"])
out = []
calls = 0
while True:
    queued = [r for r in reqs if r[1] == "ENQUEUED"]
    when = min((runnable_at(r[3]) for r in queued), default=None)
    if events and (when is None or events[0]["at"] < when):
        e = events.pop(0)
        name = "W%d" % (len(reqs) + 1)
        alive = [r for r in reqs if r[1] in ("ENQUEUED", "BLOCKED")]
        if e["policy"] == "KEEP":
            reqs.append([name, "IGNORED" if alive else "ENQUEUED", 0, e["at"], None])
        elif e["policy"] == "REPLACE":
            for r in alive:
                r[1] = "CANCELLED"
            reqs.append([name, "ENQUEUED", 0, e["at"], None])
        else:
            prev = [r for r in reqs if r[1] != "IGNORED"][-1]
            if prev[1] == "SUCCEEDED":
                reqs.append([name, "ENQUEUED", 0, e["at"], None])
            elif prev[1] in ("FAILED", "CANCELLED"):
                reqs.append([name, prev[1], 0, e["at"], None])
            else:
                reqs.append([name, "BLOCKED", 0, None, prev[0]])
        continue
    if when is None:
        break
    r = [q for q in queued if runnable_at(q[3]) == when][0]
    end = when + s["duration"]
    if s["limit"] is not None and r[2] >= s["limit"]:
        res = "failure"
    else:
        res = "success" if s["responses"][calls] else "retry"
        calls += 1
    r[2] += 1
    out.append((str(when) + " " + r[0] + " " + res) if s["enqueues"] else (str(when) + " " + res))
    if res == "retry":
        r[3] = end + pause(r[2])
        continue
    r[1] = "SUCCEEDED" if res == "success" else "FAILED"
    for c in reqs:
        if c[1] == "BLOCKED" and c[4] == r[0]:
            if r[1] == "SUCCEEDED":
                c[1], c[3] = "ENQUEUED", end
            else:
                c[1] = "FAILED"

def num(x):
    return str(int(x)) if float(x).is_integer() else str(x)

for line in out:
    head, rest = line.split(" ", 1)
    print(num(float(head)) + " " + rest)
if s["enqueues"]:
    for r in reqs:
        print(r[0] + " " + r[1])
else:
    print(reqs[0][1])
`;

function snippet(s: Scenario): string {
	const unit = s.unit === 's' ? 'SECONDS' : 'MINUTES';
	const check = s.limit === null ? [] : [`        if (runAttemptCount >= ${s.limit}) return Result.failure()`];
	const constraints =
		s.offline.length > 0
			? ['    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())']
			: [];
	return [
		'class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {',
		'    override suspend fun doWork(): Result {',
		...check,
		'        return if (api.upload()) Result.success() else Result.retry()',
		'    }',
		'}',
		'',
		'val request = OneTimeWorkRequestBuilder<UploadWorker>()',
		...(s.initial > 0 ? [`    .setInitialDelay(${s.initial}, TimeUnit.${unit})`] : []),
		`    .setBackoffCriteria(BackoffPolicy.${s.policy}, ${s.delay}, TimeUnit.${unit})`,
		...constraints,
		'    .build()',
		s.enqueues.length > 0
			? 'workManager.enqueueUniqueWork("upload", ExistingWorkPolicy.KEEP, request) // W1, момент 0'
			: 'workManager.enqueue(request) // момент 0'
	].join('\n');
}

function describe(s: Scenario): string {
	const u = s.unit === 's' ? 'с' : 'мин';
	const many = s.enqueues.length > 0;
	const responses = s.responses.map((ok) => (ok ? 'успех' : 'ошибка')).join(', ');
	const lines = [
		'Модель WorkManager (не на устройстве), по документации и исходникам `androidx.work`:',
		'',
		'- задержка из `setBackoffCriteria` приводится к границам: не меньше 10 с (`MIN_BACKOFF_MILLIS`) и не больше 5 ч (`MAX_BACKOFF_MILLIS`);',
		'- `runAttemptCount` — сколько раз работа уже запускалась: при первом запуске 0;',
		'- после `Result.retry()` работа ждёт паузу от момента окончания запуска; если до этого работа запускалась n раз (считая этот), пауза — `d · n` для LINEAR и `d · 2^(n−1)` для EXPONENTIAL, но не больше 5 ч;',
		'- первый запуск — через `setInitialDelay` после постановки (без неё — сразу); дальше работа запускается ровно тогда, когда истекла пауза и выполнены ограничения; если сети нет, а она требуется, — в момент, когда сеть появилась;',
		`- каждый запуск длится ${s.duration} ${u}; \`api.upload()\` обращается к серверу, сервер отвечает на обращения по порядку: ${responses} (лишние ответы не понадобятся).`
	];
	if (s.offline.length > 0)
		lines.push(
			`- сети нет в интервалы (начало включительно, конец — нет): ${s.offline.map(([a, b]) => `[${a}; ${b})`).join(', ')} ${u}.`
		);
	if (many) {
		lines.push(
			'- `enqueueUniqueWork` с тем же именем: REPLACE отменяет незавершённую работу и ставит новую; KEEP ничего не делает, если работа с этим именем ждёт или выполняется, иначе ставит новую; APPEND ставит новую работу после последней работы цепочки: она запустится сразу после её успеха, а если та завершилась неудачей — сразу станет FAILED; если та уже успешно завершена, новая работа ставится сразу.',
			'',
			`Дальше приложение вызывает \`enqueueUniqueWork("upload", …)\` с тем же построителем запроса: ${s.enqueues.map((e, i) => `в момент ${e.at} ${u} — W${i + 2} с \`ExistingWorkPolicy.${e.policy}\``).join('; ')}.`,
			'',
			`Введите по строке на каждый запуск — момент начала в ${u === 'с' ? 'секундах' : 'минутах'}, имя работы и результат (\`success\`, \`retry\` или \`failure\`) через пробел, например \`45 W1 retry\`; затем по строке на каждую работу W1, W2, … — имя и итоговое состояние (\`SUCCEEDED\`, \`FAILED\`, \`CANCELLED\` или \`IGNORED\`, если KEEP не поставил работу).`
		);
	} else {
		lines.push(
			'',
			`Введите по строке на каждый запуск — момент начала в ${u === 'с' ? 'секундах' : 'минутах'} и результат (\`success\`, \`retry\` или \`failure\`) через пробел, например \`45 retry\`; последней строкой — итоговое состояние работы (\`SUCCEEDED\` или \`FAILED\`).`
		);
	}
	return lines.join('\n');
}

function errors(count: number, then: boolean | null): boolean[] {
	return [...Array.from({ length: count }, () => false), ...(then === null ? [] : [then])];
}

function scenario(rng: Rng, key: string): Scenario {
	const base: Scenario = {
		unit: 's',
		policy: 'EXPONENTIAL',
		delay: rng.pick([10, 15, 20, 25, 30, 40, 45, 60]),
		duration: rng.int(1, 9),
		limit: null,
		offline: [],
		initial: 0,
		responses: errors(rng.int(2, 4), true),
		enqueues: []
	};
	switch (key) {
		case 'middle/exponential':
			return { ...base, initial: rng.int(0, 6) * 5 };
		case 'middle/linear-clamp':
			return {
				...base,
				policy: 'LINEAR',
				delay: rng.int(2, 8),
				initial: rng.int(0, 12) * 5,
				responses: errors(rng.int(2, 5), true)
			};
		case 'middle/attempt-limit': {
			const limit = rng.int(2, 4);
			return {
				...base,
				policy: rng.pick(['EXPONENTIAL', 'LINEAR'] as const),
				limit,
				initial: rng.int(0, 6) * 5,
				responses: errors(limit + 1, null)
			};
		}
		case 'middle/network': {
			const offline: [number, number][] = [];
			const initial = rng.int(0, 6) * 5;
			// Offline windows over the moments the work would wake up at.
			let t = initial + base.duration;
			for (let n = 1; n <= base.responses.length - 1; n += 1) {
				t += base.delay * 2 ** (n - 1);
				if (rng.bool(0.6)) {
					const from = t - rng.int(1, 5);
					const to = t + rng.int(3, 40);
					offline.push([from, to]);
					t = to;
				}
				t += base.duration;
			}
			return { ...base, initial, offline };
		}
		case 'senior/replace':
			return {
				...base,
				// Answers past the first success are reached only by a misconception that keeps W1 running.
				responses: [...errors(rng.int(4, 6), true), ...errors(rng.int(0, 2), true)],
				enqueues: [{ at: 0, policy: 'REPLACE' }]
			};
		case 'senior/keep': {
			const limit = rng.int(2, 3);
			return {
				...base,
				limit,
				responses: [...errors(limit, null), ...errors(rng.int(0, 2), true)],
				enqueues: [
					{ at: 0, policy: 'KEEP' },
					{ at: 0, policy: 'KEEP' }
				]
			};
		}
		case 'senior/append': {
			const limit = rng.bool() ? rng.int(2, 3) : null;
			return {
				...base,
				limit,
				responses: limit === null ? [...errors(rng.int(1, 3), true), ...errors(rng.int(0, 2), true)] : errors(8, null),
				enqueues: [{ at: 0, policy: 'APPEND' }]
			};
		}
		case 'senior/cap':
			return {
				...base,
				unit: 'min',
				delay: rng.pick([20, 30, 40, 45, 50, 60]),
				initial: rng.int(0, 12) * 5,
				duration: rng.int(1, 3),
				responses: errors(rng.int(5, 7), true)
			};
		default:
			throw new Error(`${descriptor.key}: no class ${key}`);
	}
}

/** Runs of the first request with the right rules: where a later enqueue can fall into a wait. */
function waits(s: Scenario): [number, number][] {
	const lines = simulate({ ...s, enqueues: [] }, RIGHT);
	const starts = lines.slice(0, -1).map((l) => Number(l.split(' ')[0]));
	const out: [number, number][] = [];
	for (let i = 0; i + 1 < starts.length; i += 1) out.push([(starts[i] ?? 0) + s.duration, starts[i + 1] ?? 0]);
	return out;
}

function make(rng: Rng, key: string): ComputeItem | null {
	const s = scenario(rng, key);
	if (s.enqueues.length > 0) {
		// Enqueues fall strictly inside waits of W1 (or, for the last KEEP, after W1 has finished).
		const gaps = waits(s).filter(([a, b]) => b - a >= 3);
		if (gaps.length === 0) return null;
		const inside = ([a, b]: [number, number]): number => rng.int(a + 1, b - 1);
		if (key === 'senior/keep') {
			const first = s.enqueues[0];
			const second = s.enqueues[1];
			const runs = simulate({ ...s, enqueues: [] }, RIGHT);
			const lastStart = Number(runs[runs.length - 2]?.split(' ')[0] ?? 0);
			if (!first || !second) return null;
			first.at = inside(rng.pick(gaps));
			second.at = lastStart + s.duration + rng.int(1, 30);
		} else {
			const only = s.enqueues[0];
			if (!only) return null;
			// REPLACE falls into a wait after the second run at least and before the last one: W2 still has to retry.
			const choices = key === 'senior/replace' ? gaps.slice(1, -1) : gaps;
			if (choices.length === 0) return null;
			only.at = inside(rng.pick(choices));
		}
	}
	let answer: string[];
	try {
		answer = simulate(s, RIGHT);
	} catch (error) {
		if (error instanceof OutsideModel) return null;
		throw error;
	}
	const wrong: Record<string, { kind: 'sequence'; value: string[] }> = {};
	for (const [id, change] of Object.entries(WRONG)) {
		try {
			wrong[id] = { kind: 'sequence', value: simulate(s, { ...RIGHT, ...change }) };
		} catch (error) {
			// A misconception that leaves the model (an extra call, a run in a window without network) is a wrong
			// answer only when it can be written down; here it cannot, and the misconception does not apply.
			if (!(error instanceof OutsideModel)) throw error;
		}
	}
	return {
		markdown: describe(s),
		code: { language: 'kotlin', source: snippet(s) },
		answer: { kind: 'sequence', value: answer },
		wrong,
		stdin: JSON.stringify(s)
	};
}

export function build(input: GenerateInput): Built {
	const key = `${input.grade}/${input.classId}`;
	return buildCompute(descriptor, input, REQUIRED, PYTHON_REFERENCE, (rng) => make(rng, key));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
