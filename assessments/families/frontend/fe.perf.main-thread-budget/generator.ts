// The main thread budget: a timeline of tasks that cannot be interrupted, a click at some moment, frames on a fixed
// period. The answer: the input delay, the time from the click to the end of the next frame painted after the
// handler, the number of long tasks, Total Blocking Time and the frame boundaries that fell inside a task. Splitting
// long work with `scheduler.yield()` or `setTimeout` changes who runs first and what counts as a long task.
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

interface PlainTask {
	name: string;
	arrive: number;
	dur: number;
}

interface Chain {
	name: string;
	arrive: number;
	parts: number[];
	mode: 'yield' | 'timeout';
}

interface Params {
	period: number;
	hz: number;
	tasks: PlainTask[];
	chain: Chain | null;
	input: number;
	handler: number;
	paint: number;
}

interface Rules {
	preemptive: boolean;
	fifoInput: boolean;
	latencyToHandlerEnd: boolean;
	renderImmediately: boolean;
	tbtFull: boolean;
	fiftyIsLong: boolean;
	yieldAsTimeout: boolean;
	timeoutAsYield: boolean;
	splitStillLong: boolean;
	missedByDuration: boolean;
}

const RIGHT: Rules = {
	preemptive: false,
	fifoInput: false,
	latencyToHandlerEnd: false,
	renderImmediately: false,
	tbtFull: false,
	fiftyIsLong: false,
	yieldAsTimeout: false,
	timeoutAsYield: false,
	splitStillLong: false,
	missedByDuration: false
};

const WRONG: Record<string, Partial<Rules>> = {
	preemptive: { preemptive: true },
	'fifo-input': { fifoInput: true },
	'latency-to-handler-end': { latencyToHandlerEnd: true },
	'render-immediately': { renderImmediately: true },
	'tbt-full-duration': { tbtFull: true },
	'fifty-is-long': { fiftyIsLong: true },
	'yield-as-timeout': { yieldAsTimeout: true },
	'timeout-as-yield': { timeoutAsYield: true },
	'split-still-long': { splitStillLong: true },
	'missed-by-duration': { missedByDuration: true }
};

const REQUIRED: Record<string, string[]> = {
	'long-task': ['preemptive', 'fifo-input', 'render-immediately', 'tbt-full-duration'],
	'yield-split': ['yield-as-timeout', 'split-still-long', 'fifo-input'],
	'timeout-split': ['timeout-as-yield', 'split-still-long'],
	'refresh-120': ['fifty-is-long', 'missed-by-duration', 'latency-to-handler-end', 'render-immediately']
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

interface Entry {
	name: string;
	arrive: number;
	dur: number;
	/** `input` — the click handler; `cont` — a continuation after `scheduler.yield()`; `fifo` — any other task. */
	lane: 'input' | 'cont' | 'fifo';
	seq: number;
	/** The chain part this entry runs, to queue the next one. */
	part: number | null;
}

interface Run {
	start: number;
	end: number;
	dur: number;
	chainPart: boolean;
}

/** The answer and whether two queued tasks of the same lane ever tied on their arrival. */
function simulate(p: Params, rules: Rules): { answer: string; tie: boolean } {
	let tie = false;
	let seq = 0;
	const queue: Entry[] = p.tasks.map((t) => ({ ...t, lane: 'fifo' as const, seq: seq++, part: null }));
	if (p.chain) {
		queue.push({
			name: p.chain.name,
			arrive: p.chain.arrive,
			dur: p.chain.parts[0] ?? 0,
			lane: 'fifo',
			seq: seq++,
			part: 0
		});
	}
	queue.push({
		name: 'click',
		arrive: p.input,
		dur: p.handler,
		lane: rules.fifoInput ? 'fifo' : 'input',
		seq: seq++,
		part: null
	});
	// Arrival order breaks ties of the FIFO lane; the table order breaks ties of the arrival.
	const runs: Run[] = [];
	let now = 0;
	let handlerStart = -1;
	let handlerEnd = -1;
	let paintEnd = -1;
	let paintPending = false;
	const boundaryAfter = (t: number): number => Math.ceil(t / p.period) * p.period;
	while (queue.length > 0 || paintPending) {
		const ready = queue.filter((e) => e.arrive <= now);
		const input = ready.find((e) => e.lane === 'input');
		const paintDue = paintPending && (rules.renderImmediately || boundaryAfter(handlerEnd) <= now);
		let pick: Entry | undefined;
		if (input) pick = input;
		else if (paintDue) {
			now += p.paint;
			paintEnd = now;
			paintPending = false;
			continue;
		} else {
			const conts = ready.filter((e) => e.lane === 'cont');
			const fifo = ready.filter((e) => e.lane === 'fifo').sort((a, b) => a.arrive - b.arrive || a.seq - b.seq);
			if (conts.length === 0 && fifo.length > 1 && fifo[0]?.arrive === fifo[1]?.arrive) tie = true;
			pick = conts[0] ?? fifo[0];
		}
		if (!pick) {
			const next = Math.min(
				...queue.map((e) => e.arrive),
				paintPending ? (rules.renderImmediately ? now : boundaryAfter(handlerEnd)) : Infinity
			);
			now = Math.max(now, next);
			continue;
		}
		queue.splice(queue.indexOf(pick), 1);
		const start = now;
		now += pick.dur;
		runs.push({ start, end: now, dur: pick.dur, chainPart: pick.part !== null });
		if (pick.name === 'click') {
			handlerStart = start;
			handlerEnd = now;
			paintPending = true;
		}
		if (pick.part !== null && p.chain && pick.part + 1 < p.chain.parts.length) {
			const viaYield =
				(p.chain.mode === 'yield' && !rules.yieldAsTimeout) || (p.chain.mode === 'timeout' && rules.timeoutAsYield);
			queue.push({
				name: p.chain.name,
				arrive: now,
				dur: p.chain.parts[pick.part + 1] ?? 0,
				lane: viaYield ? 'cont' : 'fifo',
				seq: seq++,
				part: pick.part + 1
			});
		}
	}
	let delay = handlerStart - p.input;
	let latency = (rules.latencyToHandlerEnd ? handlerEnd : paintEnd) - p.input;
	if (rules.preemptive) {
		// The handler is believed to interrupt the running task and the frame to follow it at the next boundary.
		delay = 0;
		const end = p.input + p.handler;
		latency = rules.latencyToHandlerEnd ? p.handler : boundaryAfter(end) + p.paint - p.input;
	}
	const durations: number[] = [];
	const chainTotal = p.chain ? p.chain.parts.reduce((a, b) => a + b, 0) : 0;
	for (const run of runs) if (!(rules.splitStillLong && run.chainPart)) durations.push(run.dur);
	if (rules.splitStillLong && p.chain) durations.push(chainTotal);
	const isLong = (d: number): boolean => (rules.fiftyIsLong ? d >= 50 : d > 50);
	const long = durations.filter(isLong);
	const tbt = long.reduce((sum, d) => sum + (rules.tbtFull ? d : d - 50), 0);
	let missed = 0;
	if (rules.missedByDuration) {
		for (const run of runs) missed += Math.floor(run.dur / p.period);
	} else {
		const last = Math.max(...runs.map((r) => r.end));
		for (let b = p.period; b < last; b += p.period) {
			if (runs.some((r) => r.start < b && b < r.end)) missed += 1;
		}
	}
	return { answer: [delay, latency, long.length, tbt, missed].join(' '), tie };
}

const solve = (p: Params, rules: Rules): string => simulate(p, rules).answer;

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const TASK_NAMES = [
	'Разбор ответа API',
	'Отправка аналитики',
	'Гидратация виджета',
	'Пересчёт фильтров',
	'Обновление кэша',
	'Подсветка синтаксиса',
	'Загрузка рекомендаций'
] as const;

const CHAIN_NAMES = ['Сортировка каталога', 'Индексация поиска', 'Построение графика', 'Импорт CSV'] as const;

function scenario(rng: Rng, classId: string): Params {
	const names = rng.shuffle(TASK_NAMES);
	const name = (i: number): string => names[i % names.length] ?? 'Задача';
	const handler = rng.int(4, 30);
	if (classId === 'long-task') {
		const longStart = rng.int(0, 30);
		const longDur = rng.int(90, 240);
		const queuedArrive = longStart + rng.int(5, Math.floor(longDur / 3));
		const input = rng.int(queuedArrive + 1, longStart + longDur - 5);
		const tasks: PlainTask[] = [
			{ name: name(0), arrive: longStart, dur: longDur },
			{ name: name(1), arrive: queuedArrive, dur: rng.int(20, 80) },
			{ name: name(2), arrive: longStart + longDur + rng.int(-3, 25), dur: rng.int(10, 120) }
		];
		if (rng.bool()) tasks.push({ name: name(3), arrive: rng.int(0, longStart + longDur + 40), dur: rng.int(10, 70) });
		return { period: 16, hz: 60, tasks, chain: null, input, handler, paint: rng.int(3, 12) };
	}
	if (classId === 'yield-split' || classId === 'timeout-split') {
		const parts = Array.from({ length: rng.int(3, 5) }, () => rng.int(20, 75));
		const arrive = rng.int(0, 20);
		const total = parts.reduce((a, b) => a + b, 0);
		const tasks: PlainTask[] = [
			{ name: name(0), arrive: arrive + rng.int(5, Math.max(6, (parts[0] ?? 20) - 2)), dur: rng.int(15, 70) },
			{ name: name(1), arrive: arrive + rng.int(10, total), dur: rng.int(10, 60) }
		];
		const input = arrive + rng.int(3, total - 5);
		return {
			period: 16,
			hz: 60,
			tasks,
			chain: { name: rng.pick(CHAIN_NAMES), arrive, parts, mode: classId === 'yield-split' ? 'yield' : 'timeout' },
			input,
			handler,
			paint: rng.int(3, 12)
		};
	}
	// 120 Hz: a task of exactly 50 ms, a long one and short ones.
	const tasks: PlainTask[] = [];
	let t = rng.int(0, 10);
	const durs = rng.shuffle([50, rng.int(60, 160), rng.int(5, 40), rng.int(5, 45)]);
	for (let i = 0; i < durs.length; i += 1) {
		tasks.push({ name: name(i), arrive: t, dur: durs[i] ?? 10 });
		t += (durs[i] ?? 10) + rng.int(-10, 12);
	}
	const busyEnd = t;
	return {
		period: 8,
		hz: 120,
		tasks,
		chain: null,
		input: rng.int(5, Math.max(6, busyEnd - 20)),
		handler,
		paint: rng.int(2, 6)
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function describe(p: Params): string {
	const rows = p.tasks.map((t) => `| ${t.name} | ${t.arrive} | ${t.dur} |`);
	const lines = [
		'Таймлайн главного потока страницы в Chromium (время — в миллисекундах от 0).',
		'',
		'| Задача | Поставлена в очередь | Длительность |',
		'|---|---|---|',
		...rows
	];
	if (p.chain) {
		const c = p.chain;
		const pause =
			c.mode === 'yield' ? '  await scheduler.yield();' : '  await new Promise((resolve) => setTimeout(resolve, 0));';
		const code = c.parts.flatMap((d, i) => [
			...(i > 0 ? [pause] : []),
			`  step${i + 1}();${' '.repeat(Math.max(1, 28 - `  step${i + 1}();`.length))}// ${d} мс`
		]);
		lines.push(
			'',
			`Кроме того, в момент ${c.arrive} в очередь ставится задача «${c.name}» — функция, разбитая на части:`,
			'',
			'```javascript',
			'async function run() {',
			...code,
			'}',
			'```',
			'',
			'Каждая часть — отдельная задача главного потока; время самих `await` не учитываем.'
		);
	}
	lines.push(
		'',
		`В момент ${p.input} пользователь нажимает кнопку; обработчик \`click\` длится ${p.handler} мс.`,
		'',
		'Считаем так:',
		'',
		'- поток выполняет задачи по одной, начатую задачу ничто не прерывает; задача, поставленная в очередь в момент x, может начаться в момент x;',
		'- когда поток свободен, он берёт обработчик ввода раньше всего остального; затем — отрисовку кадра, если она нужна и её граница уже наступила; остальные задачи — в том порядке, в каком их выполнит Chromium по спецификациям HTML и Prioritized Task Scheduling (задачи одного вида — по времени постановки, при равенстве — сверху вниз по таблице); `setTimeout(…, 0)` ставит задачу в очередь сразу, без задержки;',
		`- частота экрана ${p.hz} Гц, границы кадров — моменты, кратные ${p.period} мс (считаем ровно);`,
		`- после обработчика нужна отрисовка кадра: она начинается не раньше первой границы кадра, которая не раньше окончания обработчика, и не раньше, чем освободится поток; длится ${p.paint} мс. Другие отрисовки времени не занимают;`,
		'- если в очереди ничего нет, поток простаивает.',
		'',
		'Найдите пять чисел:',
		'',
		'1. задержку ввода — от нажатия до начала обработчика;',
		'2. задержку до отрисовки — от нажатия до окончания отрисовки кадра после обработчика;',
		'3. число длинных задач — по определению Long Tasks API;',
		'4. Total Blocking Time — по определению Lighthouse;',
		'5. сколько границ кадров пришлось на выполнение задач: граница считается, если какая-то задача началась строго раньше неё и закончилась строго позже.',
		'',
		'В пунктах 3–5 учитываются все задачи таймлайна, включая обработчик и каждую часть разбитой функции; отрисовка задачей не считается.',
		'',
		'Введите пять целых чисел через пробел в этом порядке, например: `12 47 2 85 9`.'
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json, math

p = json.loads(input())
P = p["period"]
plain = [dict(t, order=i, kind="task") for i, t in enumerate(p["tasks"])]
waiting = list(plain)
order = len(plain)
chain = p["chain"]
if chain:
    waiting.append({"name": chain["name"], "arrive": chain["arrive"], "dur": chain["parts"][0],
                    "order": order, "kind": "part", "index": 0})
    order += 1
click = {"arrive": p["input"], "dur": p["handler"], "kind": "click", "order": order}
order += 1
prio = []
clock = 0
log = []
h_start = h_end = paint_end = None
paint_wait = False
while waiting or prio or not click.get("done") or paint_wait:
    job = None
    if not click.get("done") and click["arrive"] <= clock:
        job = click
    elif paint_wait and math.ceil(h_end / P) * P <= clock:
        clock += p["paint"]
        paint_end = clock
        paint_wait = False
        continue
    elif prio:
        job = prio.pop(0)
    else:
        avail = [w for w in waiting if w["arrive"] <= clock]
        if avail:
            job = min(avail, key=lambda w: (w["arrive"], w["order"]))
            waiting.remove(job)
    if job is None:
        moments = [w["arrive"] for w in waiting]
        if not click.get("done"):
            moments.append(click["arrive"])
        if paint_wait:
            moments.append(math.ceil(h_end / P) * P)
        clock = max(clock, min(moments))
        continue
    begin = clock
    clock += job["dur"]
    log.append((begin, clock))
    if job["kind"] == "click":
        job["done"] = True
        h_start, h_end = begin, clock
        paint_wait = True
    if job["kind"] == "part" and job["index"] + 1 < len(chain["parts"]):
        nxt = {"name": chain["name"], "arrive": clock, "dur": chain["parts"][job["index"] + 1],
               "order": order, "kind": "part", "index": job["index"] + 1}
        order += 1
        if chain["mode"] == "yield":
            prio.append(nxt)
        else:
            waiting.append(nxt)
lengths = [e - b for b, e in log]
blocking = [d - 50 for d in lengths if d > 50]
finish = max(e for _, e in log)
frames = sum(1 for k in range(1, finish // P + 1) if k * P < finish and any(b < k * P < e for b, e in log))
print(h_start - p["input"], paint_end - p["input"], len(blocking), sum(blocking), frames)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | null = null;
	// Timelines are drawn until every misconception the class is built around changes the answer; the last draw
	// stands if none settles (the probes stay exact either way).
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		const { answer, tie } = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		// A draw with a tie is kept only while nothing better has come.
		if (!chosen || !tie) chosen = { p, answer, wrong };
		if (!tie && required.every((id) => wrong[id] !== null)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { p, answer, wrong } = chosen;
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

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
