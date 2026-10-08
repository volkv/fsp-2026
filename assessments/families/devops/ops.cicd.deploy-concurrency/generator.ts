// Deploys of a GitHub Actions workflow under a `concurrency` group: pushes to main start runs, a deploy waits for its
// build, the group holds one running and one pending job (`cancel-in-progress` decides what a newcomer does), an
// environment may hold the deploy for a reviewer's approval with a timeout, and an old run may be re-run. The
// candidate gives the commit deployed last and the status of every run.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_PIPELINE_YAML } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Params {
	commits: string[];
	pushAt: number[];
	buildMin: number;
	deployMin: number;
	cancelInProgress: boolean;
	/** Approval delays after the deploy starts waiting, per run and attempt (`run:attempt`); absent — never approved. */
	approval: { timeoutMin: number; delays: Record<string, number> } | null;
	rerun: { run: number; at: number } | null;
}

interface Rules {
	queueAll: boolean;
	cancelFalseCancels: boolean;
	cancelTrueWaits: boolean;
	waitingNotHolding: boolean;
	rerunIgnored: boolean;
	deployedLatestCommit: boolean;
}

const RIGHT: Rules = {
	queueAll: false,
	cancelFalseCancels: false,
	cancelTrueWaits: false,
	waitingNotHolding: false,
	rerunIgnored: false,
	deployedLatestCommit: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'queue-all': { queueAll: true },
	'cancel-false-cancels': { cancelFalseCancels: true },
	'cancel-true-waits': { cancelTrueWaits: true },
	'waiting-not-holding': { waitingNotHolding: true },
	'rerun-ignored': { rerunIgnored: true },
	'deployed-latest-commit': { deployedLatestCommit: true }
};

type Status = 'success' | 'failure' | 'cancelled';

interface Event {
	at: number;
	seq: number;
	kind: 'ready' | 'end' | 'approve' | 'timeout' | 'rerun';
	run: number;
	attempt: number;
}

/**
 * `<commit> <status per run>`, or `null` when two events fall on one minute. Every scheduled event counts, also one
 * dropped later as stale (the end of a job cancelled at that very minute): the order of a tie would decide the answer.
 */
function simulate(p: Params, rules: Rules): string | null {
	const events: Event[] = [];
	let seq = 0;
	const push = (at: number, kind: Event['kind'], run: number, attempt: number): void => {
		events.push({ at, seq: (seq += 1), kind, run, attempt });
	};
	p.pushAt.forEach((t, i) => {
		push(t + p.buildMin, 'ready', i, 1);
	});
	if (p.rerun && !rules.rerunIgnored) push(p.rerun.at, 'rerun', p.rerun.run, 2);
	const attempt = p.commits.map(() => 1);
	const status: (Status | null)[] = p.commits.map(() => null);
	let deployed: { run: number; at: number } | null = null;
	let running: { run: number; attempt: number; waiting: boolean } | null = null;
	const pending: { run: number; attempt: number }[] = [];
	const times: number[] = [];
	const cancelInProgress = p.cancelInProgress ? !rules.cancelTrueWaits : rules.cancelFalseCancels;
	const current = (run: number, att: number): boolean => attempt[run] === att;

	const begin = (run: number, att: number, t: number, approved: boolean): void => {
		if (p.approval && !approved) {
			running = { run, attempt: att, waiting: true };
			const delay = p.approval.delays[`${run}:${att}`];
			if (delay !== undefined && delay < p.approval.timeoutMin) push(t + delay, 'approve', run, att);
			else push(t + p.approval.timeoutMin, 'timeout', run, att);
		} else {
			running = { run, attempt: att, waiting: false };
			push(t + p.deployMin, 'end', run, att);
		}
	};
	const enterGroup = (run: number, att: number, t: number, approved: boolean): void => {
		if (running === null) begin(run, att, t, approved);
		else if (cancelInProgress) {
			status[running.run] = 'cancelled';
			for (const q of pending.splice(0)) status[q.run] = 'cancelled';
			begin(run, att, t, approved);
		} else {
			if (!rules.queueAll) for (const q of pending.splice(0)) status[q.run] = 'cancelled';
			pending.push({ run, attempt: att });
		}
	};
	const release = (t: number): void => {
		running = null;
		const next = pending.shift();
		if (next) begin(next.run, next.attempt, t, rules.waitingNotHolding && p.approval !== null);
	};

	while (events.length > 0) {
		events.sort((a, b) => a.at - b.at || a.seq - b.seq);
		const e = events.shift() as Event;
		times.push(e.at);
		if (e.kind !== 'rerun' && (!current(e.run, e.attempt) || status[e.run] === 'cancelled')) continue;
		const r = running;
		const isRunning = r !== null && r.run === e.run && r.attempt === e.attempt;
		switch (e.kind) {
			case 'rerun':
				// Only a finished run can be re-run.
				if (status[e.run] === null) return null;
				attempt[e.run] = e.attempt;
				status[e.run] = null;
				push(e.at + p.buildMin, 'ready', e.run, e.attempt);
				break;
			case 'ready':
				if (rules.waitingNotHolding && p.approval) {
					// The misconception: the deploy waits for its approval outside the group.
					const delay = p.approval.delays[`${e.run}:${e.attempt}`];
					if (delay !== undefined && delay < p.approval.timeoutMin) push(e.at + delay, 'approve', e.run, e.attempt);
					else push(e.at + p.approval.timeoutMin, 'timeout', e.run, e.attempt);
				} else enterGroup(e.run, e.attempt, e.at, false);
				break;
			case 'approve':
				if (rules.waitingNotHolding) enterGroup(e.run, e.attempt, e.at, true);
				else if (isRunning && r.waiting) {
					running = { run: e.run, attempt: e.attempt, waiting: false };
					push(e.at + p.deployMin, 'end', e.run, e.attempt);
				}
				break;
			case 'timeout':
				if (rules.waitingNotHolding) status[e.run] = 'failure';
				else if (isRunning && r.waiting) {
					status[e.run] = 'failure';
					release(e.at);
				}
				break;
			case 'end':
				if (isRunning) {
					status[e.run] = 'success';
					deployed = { run: e.run, at: e.at };
					release(e.at);
				}
				break;
		}
	}
	if (new Set(times).size !== times.length) return null;
	if (deployed === null || status.some((s) => s === null)) return null;
	const commit = rules.deployedLatestCommit
		? p.commits[p.commits.length - 1]
		: p.commits[(deployed as { run: number }).run];
	return [commit, ...status].join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const HEX = '0123456789abcdef';

interface ClassSpec {
	cancel: boolean | null;
	approval: boolean;
	rerun: boolean;
}

const SPECS: Record<string, ClassSpec> = {
	'senior/cancel-true': { cancel: true, approval: false, rerun: false },
	'senior/queue-replace': { cancel: false, approval: false, rerun: false },
	'senior/approval': { cancel: false, approval: true, rerun: false },
	'senior/rerun': { cancel: null, approval: false, rerun: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/cancel-true': ['cancel-true-waits'],
	'senior/queue-replace': ['queue-all', 'cancel-false-cancels'],
	'senior/approval': ['waiting-not-holding'],
	'senior/rerun': ['rerun-ignored', 'deployed-latest-commit']
};

function scenario(rng: Rng, spec: ClassSpec): Params {
	const n = rng.int(3, 5);
	const commits = Array.from({ length: n }, () =>
		Array.from({ length: 7 }, () => HEX[rng.int(0, HEX.length - 1)] ?? '0').join('')
	);
	const buildMin = rng.int(2, 6);
	const deployMin = rng.int(5, 12);
	const pushAt: number[] = [];
	let t = rng.int(0, 5);
	for (let i = 0; i < n; i += 1) {
		pushAt.push(t);
		t += rng.int(1, deployMin + 2);
	}
	let approval: Params['approval'] = null;
	if (spec.approval) {
		const timeoutMin = rng.int(6, 15);
		const delays: Record<string, number> = {};
		// An approval never falls on the minute of the timeout: which of the two comes first would be a guess.
		for (let i = 0; i < n; i += 1) {
			if (!rng.bool(0.75)) continue;
			const delay = rng.int(1, timeoutMin + 3);
			delays[`${i}:1`] = delay >= timeoutMin ? delay + 1 : delay;
		}
		approval = { timeoutMin, delays };
	}
	const rerun = spec.rerun
		? { run: rng.int(0, n - 2), at: (pushAt[n - 1] ?? 0) + rng.int(deployMin, 3 * deployMin) }
		: null;
	return {
		commits,
		pushAt,
		buildMin,
		deployMin,
		cancelInProgress: spec.cancel ?? rng.bool(),
		approval,
		rerun
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Text.

function workflowYaml(p: Params, rng: Rng): string {
	const lines = [
		'name: deploy',
		'on:',
		'  push:',
		'    branches: [main]',
		'jobs:',
		'  build:',
		'    runs-on: ubuntu-latest',
		'    steps:',
		'      - uses: actions/checkout@v4',
		`      - run: ${rng.pick(['make build', 'npm run build', './gradlew assemble'])}`,
		'  deploy:',
		'    needs: build',
		'    runs-on: ubuntu-latest'
	];
	if (p.approval) lines.push('    environment: production');
	lines.push(
		'    concurrency:',
		`      group: ${rng.pick(['production', 'prod-deploy', 'release-prod'])}`,
		`      cancel-in-progress: ${p.cancelInProgress}`,
		'    steps:',
		'      - uses: actions/checkout@v4',
		'      - run: ./scripts/deploy.sh'
	);
	return lines.join('\n');
}

function describe(p: Params): string {
	const pushes = p.commits.map((c, i) => `${i + 1}. минута ${p.pushAt[i]} — push коммита \`${c}\` (запуск ${i + 1})`);
	const approval = p.approval
		? [
				'',
				`Окружение \`production\` требует одобрения ревьюера. Деплой, получивший место в группе, сначала ждёт одобрения и всё это время занимает группу как выполняющийся; после одобрения он выполняется ${p.deployMin} мин. Если одобрения нет ${p.approval.timeoutMin} мин, задание завершается ошибкой (\`failure\`) и освобождает группу. Ревьюер одобряет деплой запуска через столько минут после начала его ожидания:`,
				'',
				...p.commits.map((_, i) => {
					const d = p.approval?.delays[`${i}:1`];
					return `- запуск ${i + 1} — ${d === undefined ? 'не одобряет' : `через ${d} мин`};`;
				})
			]
		: [];
	const rerun = p.rerun
		? [
				'',
				`В минуту ${p.rerun.at} запуск ${p.rerun.run + 1} перезапустили целиком (re-run all jobs): он заново выполняет \`build\` и \`deploy\` своего коммита, а статус запуска — статус этой последней попытки.`
			]
		: [];
	return [
		'Workflow ниже выкатывает ветку `main`. Каждый push в `main` создаёт запуск: задание `build` идёт ' +
			`${p.buildMin} мин, после него задание \`deploy\` готово к старту и идёт ${p.deployMin} мин (все команды успешны).`,
		'',
		'Правила группы `concurrency` (одна на все запуски):',
		'',
		'- в группе одновременно не больше одного выполняющегося задания и одного ожидающего;',
		'- готовое к старту задание при свободной группе сразу стартует; при занятой: если `cancel-in-progress: true` — выполняющееся задание отменяется (`cancelled`), а новое стартует; если `false` — новое становится ожидающим, а прежнее ожидающее, если было, отменяется (`cancelled`);',
		'- когда выполняющееся задание завершается, ожидающее стартует в ту же минуту;',
		'- никакие два события (готовность задания к старту, завершение задания, одобрение, истечение ожидания, перезапуск) в этой задаче не приходятся на одну минуту.',
		...approval,
		...rerun,
		'',
		'События (минуты от начала):',
		'',
		...pushes,
		'',
		'Статус запуска — статус его задания `deploy`. Введите через пробел: коммит, который будет выкачен последним (деплой которого успешно завершился позже всех), и статусы запусков 1, 2, … по порядку (`success`, `failure` или `cancelled`). Например: `4f2a9c1 cancelled success failure`.'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
doc = parse_yaml(data["yaml"])
deploy_job = doc["jobs"]["deploy"]
cancel = deploy_job["concurrency"]["cancel-in-progress"] == "true"
needs_approval = "environment" in deploy_job
B, D = data["build"], data["deploy"]
timeout = data.get("timeout")
delays = data.get("delays") or {}

queue = []  # (minute, order, kind, run, attempt)
order = 0


def schedule(minute, kind, run, attempt):
    global order
    order += 1
    queue.append((minute, order, kind, run, attempt))


for i, minute in enumerate(data["pushes"]):
    schedule(minute + B, "ready", i, 1)
if data.get("rerun"):
    schedule(data["rerun"]["at"], "rerun", data["rerun"]["run"], 2)

attempt = [1] * len(data["pushes"])
result = [None] * len(data["pushes"])
holder = None  # [run, attempt, waiting]
waiting_line = None  # (run, attempt)
last_success = None


def start(run, att, minute):
    global holder
    if needs_approval:
        holder = [run, att, True]
        delay = delays.get("%d:%d" % (run, att))
        if delay is not None and delay < timeout:
            schedule(minute + delay, "approve", run, att)
        else:
            schedule(minute + timeout, "timeout", run, att)
    else:
        holder = [run, att, False]
        schedule(minute + D, "end", run, att)


def free(minute):
    global holder, waiting_line
    holder = None
    if waiting_line is not None:
        run, att = waiting_line
        waiting_line = None
        start(run, att, minute)


while queue:
    queue.sort()
    minute, _, kind, run, att = queue.pop(0)
    if kind == "rerun":
        attempt[run] = att
        result[run] = None
        schedule(minute + B, "ready", run, att)
        continue
    if attempt[run] != att or result[run] == "cancelled":
        continue
    mine = holder is not None and holder[0] == run and holder[1] == att
    if kind == "ready":
        if holder is None:
            start(run, att, minute)
        elif cancel:
            result[holder[0]] = "cancelled"
            start(run, att, minute)
        else:
            if waiting_line is not None:
                result[waiting_line[0]] = "cancelled"
            waiting_line = (run, att)
    elif kind == "approve" and mine and holder[2]:
        holder[2] = False
        schedule(minute + D, "end", run, att)
    elif kind == "timeout" and mine and holder[2]:
        result[run] = "failure"
        free(minute)
    elif kind == "end" and mine:
        result[run] = "success"
        last_success = run
        free(minute)

print(data["commits"][last_success], *result)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const spec = SPECS[key];
	if (!spec) throw new Error(`${descriptor.key}: no class ${key}`);
	// Scenarios are drawn until every misconception that the class must expose changes the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, spec);
		const answer = simulate(p, RIGHT);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[key] ?? []).some((id) => wrong[id] === null)) continue;
		const yaml = workflowYaml(p, rng);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					yaml,
					commits: p.commits,
					pushes: p.pushAt,
					build: p.buildMin,
					deploy: p.deployMin,
					timeout: p.approval?.timeoutMin ?? null,
					delays: p.approval?.delays ?? null,
					rerun: p.rerun
				})
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${key} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
