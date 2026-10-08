// Frame budget on Android: on a timeline of vsync signals at 60, 90 or 120 Hz, the main thread draws a frame at a
// vsync only when it is free, a frame shows on the first vsync after its work ends, and any other work on the main
// thread (a click handler parsing data, the continuation of a coroutine, a periodic task) runs between frames. The
// candidate counts vsyncs without a new frame, slow frames, and when a result reaches the screen — with heavy work on
// the main thread or moved to a background dispatcher. Times are integers of milliseconds kept at least 1 ms off every
// vsync, so the rounding of the period never matters. The answer is computed by the model below and proved by an
// independent Python program over exact fractions.
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

/** A piece of main-thread work: released at a moment, lasting `ms`; a background job may follow it. */
interface Task {
	at: number;
	ms: number;
	label: 'tap' | 'apply' | 'periodic';
	/** Work moved to `Dispatchers.Default` after this task: its length; then an `apply` task of `applyMs` follows. */
	background: { ms: number; applyMs: number } | null;
	/** Whether the result is in the state once this task finishes. */
	result: boolean;
}

interface Scenario {
	classId: string;
	hz: number;
	/** The work of an animation frame on the main thread. */
	frameMs: number;
	/** The extra work of the first frame that draws the result. */
	resultMs: number;
	tasks: Task[];
	/** Scroll: the rows each successive frame binds, and the price of one binding. */
	plan: { base: number; perRow: number; rows: number[] } | null;
	/** The last vsync of the counting window (from vsync 1). */
	window: number;
}

interface Rules {
	hz60: boolean;
	backgroundBlocks: boolean;
	presentSameVsync: boolean;
	noCascade: boolean;
	shortTaskHarmless: boolean;
}
const RIGHT: Rules = {
	hz60: false,
	backgroundBlocks: false,
	presentSameVsync: false,
	noCascade: false,
	shortTaskHarmless: false
};

interface Outcome {
	/** Vsync numbers at which a new frame shows. */
	shown: number[];
	/** The vsync at which the result shows; null without a result. */
	resultAt: number | null;
	slow: number;
	lastShown: number;
	/** Whether some compared moment lies within 1 ms of a vsync. */
	close: boolean;
}

/**
 * Time runs in units of 1/hz ms: vsync k is at k·1000, and a moment of t ms is at t·hz — all integers.
 */
function run(sc: Scenario, r: Rules): Outcome {
	const hz = r.hz60 ? 60 : sc.hz;
	const ms = (x: number): number => x * hz;
	const budget = 1000;
	let close = false;
	const near = (a: number, b: number): void => {
		if (Math.abs(a - b) < hz) close = true;
	};
	// Main-thread work in time units: `at` and `ms` scaled by hz.
	const queue: Task[] = sc.tasks.map((t) => ({ ...t, at: ms(t.at) }));
	if (r.backgroundBlocks) {
		for (const t of queue) {
			if (t.background) {
				t.ms += t.background.ms + t.background.applyMs;
				t.result = true;
				t.background = null;
			}
		}
	}
	const pending = (): Task[] => queue.sort((a, b) => a.at - b.at);
	if (queue.some((t) => t.at === 0)) close = true;
	let busy = 0;
	let resultReady = false;
	let resultDrawn = false;
	let resultAt: number | null = null;
	const shown: number[] = [];
	let slow = 0;
	let planIndex = 0;
	const frames = sc.plan ? sc.plan.rows.length : Number.POSITIVE_INFINITY;
	const horizon = sc.plan ? 400 : sc.window + 40;
	for (let k = 0; k <= horizon && planIndex < frames; k += 1) {
		const v = k * budget;
		for (;;) {
			const next = pending()[0];
			if (!next) break;
			const start = Math.max(busy, next.at);
			near(start, v);
			if (start >= v) break;
			queue.shift();
			const harmless = r.shortTaskHarmless && next.ms * hz < budget;
			const end = harmless ? start : start + ms(next.ms);
			if (!harmless) busy = end;
			near(busy, v);
			if (next.result) resultReady = true;
			if (next.background) {
				queue.push({
					at: end + ms(next.background.ms),
					ms: next.background.applyMs,
					label: 'apply',
					background: null,
					result: true
				});
			}
		}
		if (k > 0) near(busy, v);
		if (busy > v && !r.noCascade) continue;
		let cost: number;
		if (sc.plan) {
			cost = sc.plan.base + (sc.plan.rows[planIndex] ?? 0) * sc.plan.perRow;
			planIndex += 1;
		} else cost = sc.frameMs;
		const drawsResult = resultReady && !resultDrawn;
		if (drawsResult) {
			cost += sc.resultMs;
			resultDrawn = true;
		}
		if (cost * hz > budget) slow += 1;
		const start = Math.max(v, r.noCascade ? v : busy);
		const end = start + ms(cost);
		busy = Math.max(busy, end);
		near(end, Math.round(end / budget) * budget);
		const at = Math.floor(end / budget) + (r.presentSameVsync ? 0 : 1);
		shown.push(at);
		if (drawsResult) resultAt = at;
	}
	return { shown, resultAt, slow, lastShown: shown[shown.length - 1] ?? 0, close };
}

function answerOf(sc: Scenario, o: Outcome): string {
	if (sc.plan) return `${o.slow} ${o.lastShown}`;
	const seen = new Set(o.shown);
	let missed = 0;
	let first: number | null = null;
	let last: number | null = null;
	for (let j = 1; j <= sc.window; j += 1) {
		if (!seen.has(j)) {
			missed += 1;
			first ??= j;
			last = j;
		}
	}
	if (sc.classId === 'periodic-task') return `${missed} ${first ?? '-'} ${last ?? '-'}`;
	return `${missed} ${o.resultAt ?? '-'}`;
}

// Scenarios.

function scenario(rng: Rng, classId: string): Scenario {
	const hz = rng.pick([60, 90, 120]);
	const period = 1000 / hz;
	const frameMs = rng.int(2, Math.floor(period * 0.5));
	const base: Scenario = { classId, hz, frameMs, resultMs: 0, tasks: [], plan: null, window: 0 };
	if (classId === 'main-thread-work' || classId === 'background-work') {
		const tap = frameMs + rng.int(1, Math.floor(period - frameMs) - 1);
		const heavy = classId === 'main-thread-work' ? rng.int(20, 320) : rng.int(20, 240);
		const resultMs = rng.int(2, Math.floor(period * 1.6));
		const task: Task =
			classId === 'main-thread-work'
				? { at: tap, ms: heavy, label: 'tap', background: null, result: true }
				: {
						at: tap,
						ms: rng.int(1, 3),
						label: 'tap',
						background: { ms: heavy, applyMs: rng.int(1, 2) },
						result: false
					};
		return { ...base, resultMs, tasks: [task] };
	}
	if (classId === 'scroll-binding') {
		const perRow = rng.int(2, 6);
		const baseMs = rng.int(2, 4);
		const rows = Array.from({ length: rng.int(6, 9) }, () => rng.int(0, Math.ceil((period * 1.8) / perRow)));
		return { ...base, plan: { base: baseMs, perRow, rows } };
	}
	// periodic-task: a task every few tens of milliseconds on the main thread between animation frames.
	const every = rng.pick([25, 35, 45, 55, 70]);
	const taskMs = rng.int(Math.max(3, Math.floor(period * 0.4)), Math.floor(period * 1.3));
	const first = rng.int(5, 60);
	const window = rng.int(14, 30);
	// The timer runs on forever; a task arriving after vsync `window` cannot change any vsync up to `window`, so the
	// tasks are listed up to that moment (with one period of margin).
	const tasks: Task[] = [];
	for (let at = first; at <= ((window + 1) * 1000) / hz + every; at += every)
		tasks.push({ at, ms: taskMs, label: 'periodic', background: null, result: false });
	return { ...base, tasks, window };
}

// Rendering.

const periodText = (hz: number): string =>
	hz === 60 ? '1000/60 мс (≈ 16,67 мс)' : hz === 90 ? '1000/90 мс (≈ 11,11 мс)' : '1000/120 мс (≈ 8,33 мс)';

function describe(sc: Scenario): string {
	const common = [
		`Модель отрисовки (не замер на устройстве). Экран ${sc.hz} Гц: vsync номер k наступает в момент k · T, T = ${periodText(sc.hz)}; vsync 0 — момент 0.`,
		'',
		'- Главный поток выполняет по одной работе за раз и не прерывает начатую.',
		'- Кадр начинается только на vsync и только если главный поток в этот момент свободен; если занят — этот vsync пропадает, кадр начнётся на первом vsync, где поток свободен.',
		'- Готовый кадр появляется на экране на первом vsync после окончания его работы на главном потоке.',
		'- Другая работа главного потока (обработчик нажатия, продолжение корутины, задача по таймеру) начинается, как только поток свободен и работа поступила; несколько поступивших — в порядке поступления.',
		'- Все моменты в задаче отстоят от любого vsync не меньше чем на 1 мс, поэтому округление T на ответ не влияет.',
		''
	];
	if (sc.plan) {
		const p = sc.plan;
		return [
			...common,
			`Пользователь прокручивает список. Каждый кадр на главном потоке стоит ${p.base} мс плюс ${p.perRow} мс на каждую строку, которую он привязывает (\`onBindViewHolder\`). Кадры идут подряд, первый начинается на vsync 0; по порядку они привязывают строк: ${p.rows.join(', ')}. Другой работы на главном потоке нет.`,
			'',
			'Медленный кадр — кадр, чья работа длится дольше T.',
			'Введите два числа через пробел: сколько кадров медленные и номер vsync, на котором появится последний кадр прокрутки (тот, что привязывает последнее число строк из списка, — медленный он или нет). Например: `2 11`.'
		].join('\n');
	}
	const animation = `На экране идёт анимация: она требует новый кадр на каждом vsync, работа такого кадра на главном потоке — ${sc.frameMs} мс.`;
	if (sc.classId === 'periodic-task') {
		const t = sc.tasks[0] as Task;
		const every = (sc.tasks[1]?.at ?? 0) - t.at;
		return [
			...common,
			animation,
			`Кроме кадров, на главном потоке работает задача по таймеру: она поступает в моменты ${t.at}, ${t.at + every}, ${t.at + 2 * every} мс и далее каждые ${every} мс, каждый раз — ${t.ms} мс работы.`,
			'',
			`Пропущенный vsync — vsync, на котором на экране не появилось нового кадра. Рассмотрите vsync с 1-го по ${sc.window}-й.`,
			'Введите три значения через пробел: число пропущенных vsync, номер первого и номер последнего из них (если пропусков нет — `0 - -`). Например: `3 5 17`.'
		].join('\n');
	}
	const task = sc.tasks[0] as Task;
	const work =
		task.background === null
			? `В момент ${task.at} мс пользователь нажимает «Обновить». Обработчик нажатия на главном потоке разбирает ответ сервера и записывает результат в состояние экрана — всего ${task.ms} мс.`
			: `В момент ${task.at} мс пользователь нажимает «Обновить». Обработчик на главном потоке за ${task.ms} мс запускает корутину в \`viewModelScope\`; она разбирает ответ сервера в \`withContext(Dispatchers.Default)\` — ${task.background.ms} мс на фоновом потоке, затем продолжение на главном потоке записывает результат в состояние экрана за ${task.background.applyMs} мс (продолжение поступает на главный поток в момент окончания фоновой работы).`;
	return [
		...common,
		animation,
		work,
		`Первый кадр, который начнётся после записи результата, рисует его: этот кадр стоит на ${sc.resultMs} мс больше обычного.`,
		'',
		`Пропущенный vsync — vsync, на котором на экране не появилось нового кадра. Рассмотрите vsync с 1-го по ${sc.window}-й.`,
		'Введите два числа через пробел: число пропущенных vsync и номер vsync, на котором результат появится на экране. Например: `4 9`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
from fractions import Fraction

sc = json.loads(input())
T = Fraction(1000, sc["hz"])


def vsync(k):
    return k * T


def first_vsync_after(t):
    k = int(t // T) + 1
    return k


tasks = [dict(t, at=Fraction(t["at"])) for t in sc["tasks"]]
free_at = Fraction(0)
ready = False
drawn = False
result_at = None
shown = []
slow = 0
plan = sc["plan"]
total = len(plan["rows"]) if plan else None
k = 0
while (plan and len(shown) < total) or (not plan and k <= sc["window"] + 40):
    v = vsync(k)
    # Work that can begin before this vsync begins and runs to its end.
    progress = True
    while progress:
        progress = False
        waiting = sorted((t for t in tasks if not t.get("done")), key=lambda t: t["at"])
        if waiting and max(free_at, waiting[0]["at"]) < v:
            t = waiting[0]
            t["done"] = True
            free_at = max(free_at, t["at"]) + t["ms"]
            if t["result"]:
                ready = True
            if t["background"]:
                tasks.append({"at": free_at + t["background"]["ms"], "ms": t["background"]["applyMs"],
                              "result": True, "background": None})
            progress = True
    if free_at < v or k == 0 and free_at == 0:
        if plan:
            cost = plan["base"] + plan["rows"][len(shown)] * plan["perRow"]
        else:
            cost = sc["frameMs"]
        first_with_result = ready and not drawn
        if first_with_result:
            cost += sc["resultMs"]
            drawn = True
        if cost > T:
            slow += 1
        free_at = v + cost
        shown.append(first_vsync_after(free_at))
        if first_with_result:
            result_at = shown[-1]
    k += 1

if plan:
    print(slow, shown[-1])
else:
    missing = [j for j in range(1, sc["window"] + 1) if j not in set(shown)]
    if sc["classId"] == "periodic-task":
        print(len(missing), missing[0] if missing else "-", missing[-1] if missing else "-")
    else:
        print(len(missing), result_at if result_at is not None else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'budget-60': { hz60: true },
	'background-blocks': { backgroundBlocks: true },
	'present-same-vsync': { presentSameVsync: true },
	'no-cascade': { noCascade: true },
	'short-task-harmless': { shortTaskHarmless: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/main-thread-work': ['present-same-vsync'],
	'middle/background-work': ['background-blocks'],
	'middle/scroll-binding': ['no-cascade'],
	'middle/periodic-task': ['short-task-harmless']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const sc = scenario(rng, input.classId);
		const probe = run({ ...sc, window: 1 }, RIGHT);
		if (probe.close) continue;
		if (!sc.plan && sc.classId !== 'periodic-task') {
			if (probe.resultAt === null) continue;
			sc.window = probe.resultAt + rng.int(1, 4);
		}
		const outcome = run(sc, RIGHT);
		if (outcome.close) continue;
		const answer = answerOf(sc, outcome);
		if (sc.classId === 'periodic-task' && answer.startsWith('0 ')) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(sc, run(sc, { ...RIGHT, ...change }));
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			classId: sc.classId,
			hz: sc.hz,
			frameMs: sc.frameMs,
			resultMs: sc.resultMs,
			tasks: sc.tasks,
			plan: sc.plan,
			window: sc.window
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
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
