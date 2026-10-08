// Practice: a planner of retries of background jobs. From the results of the attempts known in advance and the policy
// of the class (a linear or exponential pause, a deterministic decorrelated pause, Retry-After) it computes the moments
// of every attempt and the outcome of every job; Senior attempts last some time and are cut by an attempt timeout. The
// step «измени своё решение» adds a global budget of retries per minute: jobs stop being independent.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go'] as const;
const CHANGE_WEIGHT = 0.3;

const descriptor = readDescriptor(import.meta.url);

const RETRYABLE = new Set(['timeout', '408', '429', '500', '502', '503', '504']);
const RETRY_CODES = ['500', '502', '503', '504', '429', '408', 'timeout'] as const;
const FATAL_CODES = ['400', '401', '403', '404', '409', '422', '501'] as const;
const OK_CODES = ['200', '201', '204'] as const;
const OK = new Set<string>(OK_CODES);
const NAMES = [
	'backup',
	'report',
	'mail',
	'sync',
	'export',
	'thumb',
	'index',
	'billing',
	'cleanup',
	'webhook'
] as const;

interface Attempt {
	code: string;
	/** Retry-After of a 429 or 503 in seconds; only the class `retry-after` has it. */
	hint: number | null;
	/** Senior: how long the attempt runs. */
	dur: number;
}
interface Job {
	id: string;
	start: number;
	attempts: Attempt[];
}
interface Input {
	m: number;
	d: number;
	b: number;
	c: number;
	/** Senior: the attempt timeout T. */
	t: number;
	/** The step: the budget R of retries per minute; `null` without it. */
	r: number | null;
	jobs: Job[];
}

const WRONG_IDS = [
	'deadline-strict',
	'retries-not-attempts',
	'all-retryable',
	'delay-off-by-one',
	'hint-uncapped',
	'delay-from-start',
	'timeout-not-cut'
] as const;
/** The wrong solutions, and `cut-inclusive`: an attempt of exactly T is cut too. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'cut-inclusive';

interface State {
	times: number[];
	status: string;
	/** The last pause of the decorrelated policy. */
	prev: number;
}

/** A binary heap of pending attempts ordered by time, then by the job's place in the input. */
class Queue {
	readonly items: [number, number, number][] = [];
	readonly #less = (a: [number, number, number], b: [number, number, number]): boolean =>
		a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
	push(item: [number, number, number]): void {
		const h = this.items;
		h.push(item);
		let i = h.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.#less(h[i] as [number, number, number], h[p] as [number, number, number])) break;
			[h[i], h[p]] = [h[p] as [number, number, number], h[i] as [number, number, number]];
			i = p;
		}
	}
	pop(): [number, number, number] | undefined {
		const h = this.items;
		const top = h[0];
		const last = h.pop();
		if (h.length > 0 && last) {
			h[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < h.length && this.#less(h[l] as [number, number, number], h[m] as [number, number, number])) m = l;
				if (r < h.length && this.#less(h[r] as [number, number, number], h[m] as [number, number, number])) m = r;
				if (m === i) break;
				[h[i], h[m]] = [h[m] as [number, number, number], h[i] as [number, number, number]];
				i = m;
			}
		}
		return top;
	}
}

class Crash extends Error {}

/** The pause before the next attempt after the failed attempt `k` (1-based). */
function pause(cls: string, input: Input, state: State, k: number, hint: number | null, variant: Variant): number {
	const { b, c } = input;
	const shift = variant === 'delay-off-by-one' ? 1 : 0;
	switch (cls) {
		case 'linear':
			return Math.min(c, b * (k + shift));
		case 'exponential':
			return Math.min(c, b * 2 ** (k - 1 + shift));
		case 'decorrelated': {
			const next = Math.min(c, Math.floor((b + 3 * state.prev) / 2));
			const used = shift ? state.prev : next;
			state.prev = next;
			return used;
		}
		default:
			return hint === null ? b : variant === 'hint-uncapped' ? hint : Math.min(c, hint);
	}
}

/**
 * The plan of every job; a variant other than `right` reproduces a wrong solution. With `notes`, every attempt of job
 * `i` adds a line of its walk-through to `notes[i]` (the worked example of the statement).
 */
function simulate(cls: string, senior: boolean, input: Input, variant: Variant = 'right', notes?: string[][]): string {
	const limit = variant === 'retries-not-attempts' ? input.m + 1 : input.m;
	const states: State[] = input.jobs.map(() => ({ times: [], status: '', prev: input.b }));
	/** Makes attempt `k` of job `i` at `t`; the moment of the next attempt, or `null` when the job is over. */
	const attempt = (i: number, t: number, k: number): number | null => {
		const job = input.jobs[i] as Job;
		const state = states[i] as State;
		state.times.push(t);
		const a = job.attempts[k - 1];
		if (!a) throw new Crash();
		let code = a.code;
		let hint = a.hint;
		let dur = senior ? a.dur : 0;
		const cut =
			senior &&
			variant !== 'timeout-not-cut' &&
			(a.dur > input.t || (variant === 'cut-inclusive' && a.dur === input.t));
		if (cut) {
			code = 'timeout';
			hint = null;
			dur = input.t;
		}
		const note = [
			`t${k} = ${t}: ${token(a, false)}`,
			...(senior ? [cut ? `длится ${a.dur} > T — обрыв в ${t + dur}, \`timeout\`` : `конец в ${t + dur}`] : [])
		];
		let next: number | null = null;
		if (OK.has(code)) {
			state.status = 'ok';
			note.push('успех');
		} else if (!RETRYABLE.has(code) && variant !== 'all-retryable') {
			state.status = 'failed';
			note.push('неповторяемая ошибка');
		} else if (k >= limit) {
			state.status = 'exhausted';
			note.push(`попытка ${k} = M`);
		} else {
			const delay = pause(cls, input, state, k, hint, variant);
			const at = (variant === 'delay-from-start' ? t : t + dur) + delay;
			const late = variant === 'deadline-strict' ? at >= job.start + input.d : at > job.start + input.d;
			note.push(`пауза ${delay}`);
			if (late) {
				state.status = 'expired';
				note.push(`${at} > ${job.start} + D = ${job.start + input.d}`);
			} else next = at;
		}
		notes?.[i]?.push(note.join(', ') + (next === null ? ` → \`${state.status}\`` : ''));
		return next;
	};
	try {
		if (input.r === null) {
			input.jobs.forEach((job, i) => {
				let t: number | null = job.start;
				for (let k = 1; t !== null; k += 1) t = attempt(i, t, k);
			});
		} else {
			const used = new Map<number, number>();
			const queue = new Queue();
			input.jobs.forEach((job, i) => {
				queue.push([job.start, i, 1]);
			});
			for (let item = queue.pop(); item; item = queue.pop()) {
				const [t, i, k] = item;
				if (k > 1) {
					const w = Math.floor(t / 60);
					if ((used.get(w) ?? 0) >= input.r) {
						const moved = (w + 1) * 60;
						if (moved > (input.jobs[i] as Job).start + input.d) (states[i] as State).status = 'expired';
						else queue.push([moved, i, k]);
						continue;
					}
					used.set(w, (used.get(w) ?? 0) + 1);
				}
				const next = attempt(i, t, k);
				if (next !== null) queue.push([next, i, k + 1]);
			}
		}
	} catch (error) {
		if (error instanceof Crash) return 'crash\n';
		throw error;
	}
	return `${input.jobs.map((job, i) => `${job.id} ${states[i]?.status ?? ''} ${states[i]?.times.join(' ') ?? ''}`).join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs.

type Story = 'ok' | 'failed' | 'exhaust';

type GroupId = 'basic' | 'codes' | 'boundary' | 'growth' | 'durations' | 'scale';
/**
 * Plain groups: no deadline that binds, no job that reaches M, hints within C and, at Senior, no attempt cut by T
 * (attempts of `basic` take no time at all). A solution wrong in one edge rule passes them.
 */
const PLAIN: readonly GroupId[] = ['basic', 'codes'];

function results(rng: Rng, story: Story, input: Input, cls: string, senior: boolean, group: GroupId): Attempt[] {
	const plain = PLAIN.includes(group);
	const hard = group === 'durations' || group === 'scale';
	const count = input.m + rng.int(0, 2);
	const end = story === 'exhaust' ? input.m : rng.int(0, input.m - 1);
	const out: Attempt[] = [];
	for (let k = 0; k < count; k += 1) {
		const role = k < end ? 'retry' : k === end ? story : 'any';
		const code =
			role === 'retry'
				? rng.pick(RETRY_CODES)
				: role === 'ok'
					? rng.pick(OK_CODES)
					: role === 'failed'
						? rng.pick(FATAL_CODES)
						: rng.pick([...RETRY_CODES, ...FATAL_CODES, ...OK_CODES]);
		const hint =
			cls === 'retry-after' && (code === '429' || code === '503') && rng.bool(0.7)
				? rng.int(1, plain ? input.c : input.c * 2)
				: null;
		const t = input.t;
		const dur =
			!senior || group === 'basic'
				? 0
				: hard && rng.bool(0.35)
					? rng.pick([t, t, t + rng.int(1, t)])
					: rng.int(0, t - 1);
		out.push({ code, hint, dur });
	}
	return out;
}

function makeInput(rng: Rng, cls: string, group: GroupId, senior: boolean, withBudget: boolean): Input {
	const m = group === 'growth' ? rng.int(6, 9) : rng.int(3, 7);
	const b = withBudget ? rng.int(2, 15) : rng.int(2, 40);
	const input: Input = {
		m,
		d: 1_000_000,
		b,
		c: b * rng.int(3, 12),
		t: senior ? rng.int(10, 90) : 0,
		r: withBudget ? (group === 'scale' ? rng.int(4, 10) : rng.int(1, 3)) : null,
		jobs: []
	};
	const count: Record<GroupId, [number, number]> = {
		basic: [2, 4],
		codes: [5, 8],
		boundary: [4, 7],
		growth: [3, 5],
		durations: [4, 6],
		scale: [450, 650]
	};
	const [lo, hi] = count[group];
	const jobs = rng.int(lo, hi);
	const used = new Set<string>();
	for (let i = 0; i < jobs; i += 1) {
		let id = `${rng.pick(NAMES)}-${rng.int(1, group === 'scale' ? 99_999 : 99)}`;
		while (used.has(id)) id = `${rng.pick(NAMES)}-${rng.int(1, group === 'scale' ? 99_999 : 99)}`;
		used.add(id);
		const story: Story =
			group === 'basic'
				? 'ok'
				: group === 'growth'
					? rng.pick<Story>(['exhaust', 'exhaust', 'ok'])
					: group === 'codes'
						? rng.pick<Story>(['ok', 'failed', 'failed'])
						: rng.pick<Story>(['ok', 'failed', 'exhaust']);
		// The budget needs crowds of retries in one minute; a large log spreads them so that the queue stays short.
		const start = withBudget ? rng.int(0, group === 'scale' ? 6 * jobs : 90) : rng.int(0, 3600);
		input.jobs.push({
			id,
			start,
			attempts: results(rng, story, input, cls, senior, group)
		});
	}
	if (group === 'boundary') {
		// The deadline falls exactly on an attempt of one job: that attempt is still made.
		const plan = simulate(cls, senior, input).trim().split('\n');
		const options = plan
			.map((line, i) => ({ i, times: line.split(' ').slice(2).map(Number) }))
			.filter((x) => x.times.length >= 2);
		if (options.length > 0) {
			const x = rng.pick(options);
			const at = x.times[rng.int(1, x.times.length - 1)] ?? 0;
			input.d = at - (input.jobs[x.i] as Job).start;
		}
	} else if (group !== 'growth' && !PLAIN.includes(group)) input.d = rng.bool(0.5) ? 1_000_000 : b * rng.int(m, 4 * m);
	return input;
}

function token(a: Attempt, senior: boolean): string {
	return `${a.code}${a.hint === null ? '' : `/${a.hint}`}${senior ? `:${a.dur}` : ''}`;
}

function render(input: Input, senior: boolean): string {
	const head = [
		input.jobs.length,
		input.m,
		input.d,
		input.b,
		input.c,
		...(senior ? [input.t] : []),
		...(input.r === null ? [] : [input.r])
	];
	return `${[head.join(' '), ...input.jobs.map((j) => `${j.id} ${j.start} ${j.attempts.map((a) => token(a, senior)).join(' ')}`)].join('\n')}\n`;
}

/** The wrong solutions (and edges) a group must expose on every test of the class. */
function traps(cls: string, group: GroupId): Variant[] {
	switch (group) {
		case 'codes':
			return ['all-retryable'];
		case 'boundary':
			return ['deadline-strict', 'retries-not-attempts'];
		case 'growth':
			return [cls === 'retry-after' ? 'hint-uncapped' : 'delay-off-by-one'];
		case 'durations':
			return ['delay-from-start', 'timeout-not-cut', 'cut-inclusive'];
		default:
			return [];
	}
}

function groups(
	rng: Rng,
	cls: string,
	others: readonly string[],
	senior: boolean,
	withBudget: boolean
): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'codes', 'boundary', 'growth', senior ? 'durations' : 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${cls}`);
			const input = makeInput(rng, cls, id, senior, withBudget);
			const expected = simulate(cls, senior, input);
			if (others.some((other) => simulate(other, senior, input) === expected)) continue;
			if (withBudget) {
				if (simulate(cls, senior, { ...input, r: null }) === expected) continue;
			} else if (traps(cls, id).some((v) => simulate(cls, senior, input, v) === expected)) continue;
			tests.push({ stdin: render(input, senior), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

const POLICY: Record<string, string> = {
	linear: 'пауза = min(C, B·k).',
	exponential: 'пауза = min(C, B·2^(k−1)).',
	decorrelated:
		'пауза = d_k, где d₀ = B и d_k = min(C, ⌊(B + 3·d_(k−1)) / 2⌋) — у каждого задания своя последовательность (детерминированный вариант decorrelated jitter: вместо случайной точки отрезка [B, 3·d_(k−1)] берётся его середина).',
	'retry-after':
		'если результат попытки несёт подсказку Retry-After (запись `код/секунды`, бывает только у 429 и 503), пауза = min(C, подсказка); иначе пауза = B.'
};

/** The worked example of the statement: a fixed small log for the policy of the class. */
function exampleInput(cls: string, senior: boolean): Input {
	const hints = cls === 'retry-after';
	const at = (code: string, hint: number | null, dur: number): Attempt => ({
		code,
		hint: hints ? hint : null,
		dur: senior ? dur : 0
	});
	return {
		m: 3,
		d: senior ? 120 : 40,
		b: 10,
		c: 25,
		t: senior ? 60 : 0,
		r: null,
		jobs: [
			{ id: 'backup-7', start: 100, attempts: [at('503', 5, 4), at('503', 30, 70), at('502', null, 3)] },
			{ id: 'mail-2', start: 0, attempts: [at('500', null, 2), at('404', null, 1), at('200', null, 1)] },
			{ id: 'sync-4', start: 50, attempts: [at('429', 40, 6), at('200', null, 2), at('200', null, 1)] }
		]
	};
}

/** How to read the input, in Python. */
function parseTemplate(cls: string, senior: boolean): string {
	return [
		'```python',
		'import sys',
		'',
		"lines = sys.stdin.read().split('\\n')",
		`${senior ? 'j, m, d, b, c, t' : 'j, m, d, b, c'} = map(int, lines[0].split())`,
		'for row in lines[1:j + 1]:',
		'    name, start, *results = row.split()',
		'    start = int(start)',
		'    for result in results:',
		...(senior ? ["        result, _, dur = result.partition(':')  # dur = int(dur)"] : []),
		cls === 'retry-after'
			? "        code, _, hint = result.partition('/')  # hint == '' — подсказки нет"
			: '        code = result',
		'```'
	].join('\n');
}

function statement(cls: string, senior: boolean): string {
	const example = exampleInput(cls, senior);
	const notes: string[][] = example.jobs.map(() => []);
	const output = simulate(cls, senior, example, 'right', notes);
	return [
		'Планировщик фоновых заданий повторяет неудачные попытки по политике. Результаты всех попыток известны заранее (прогон по записанным ответам). Напишите программу, которая для каждого задания находит моменты всех попыток и итог.',
		'',
		'## Вход',
		'',
		`Первая строка — \`J M D B C${senior ? ' T' : ''}\`: число заданий (1 ≤ J ≤ 2000), лимит попыток (1 ≤ M ≤ 10), срок в секундах (1 ≤ D ≤ 10⁶), база паузы (1 ≤ B ≤ 1000), потолок паузы (B ≤ C ≤ 10⁵)${senior ? ', тайм-аут попытки (1 ≤ T ≤ 1000)' : ''}.`,
		`Далее \`J\` строк \`<задание> <старт> <r1> <r2> …\`: имя без пробелов, момент старта в секундах (0 ≤ старт ≤ 10⁶) и результаты попыток по порядку — не меньше \`M\` результатов, лишние не используются. Результат — ${senior ? '`<код>:<длительность>`, ' : ''}код ответа${cls === 'retry-after' ? ' (у `429` и `503` — возможно с подсказкой: `503/30`)' : ''}: \`200\`, \`201\`, \`204\` — успех; \`timeout\`, \`408\`, \`429\`, \`500\`, \`502\`, \`503\`, \`504\` — повторяемая ошибка; любой другой — неповторяемая ошибка.${senior ? ' Длительность — сколько секунд идёт попытка (0 ≤ длительность ≤ 2000).' : ''}`,
		'',
		'## Правило',
		'',
		`Первая попытка начинается в момент старта. Попытка k (с 1) ${senior ? 'идёт с момента t_k; если её длительность больше T, она обрывается в момент t_k + T и считается повторяемой ошибкой `timeout` независимо от кода, иначе заканчивается в t_k + длительность' + (cls === 'retry-after' ? '; подсказка оборванной попытки не действует' : '') + '. По результату' : 'по результату'}:`,
		'',
		'- успех — задание завершено с итогом `ok`;',
		'- неповторяемая ошибка — итог `failed`;',
		'- повторяемая ошибка на попытке `M` — итог `exhausted` (`M` — число попыток, включая первую);',
		`- иначе следующая попытка — в момент ${senior ? '**конца** попытки k' : 't_k'} плюс пауза; если этот момент **позже** \`старт + D\`, попытка не делается и итог — \`expired\` (попытка ровно в момент \`старт + D\` делается).`,
		'',
		`Пауза после неудачной попытки k: ${POLICY[cls] ?? ''}`,
		'',
		'## Выход',
		'',
		'По строке на задание в порядке входа: `<задание> <итог> <t1> <t2> …` — итог и моменты начала всех сделанных попыток.',
		'',
		'## Пример',
		'',
		'Вход:',
		'',
		'```',
		render(example, senior).trimEnd(),
		'```',
		'',
		'Выход:',
		'',
		'```',
		output.trimEnd(),
		'```',
		'',
		'Разбор:',
		'',
		...example.jobs.map((job, i) => `- \`${job.id}\`: ${(notes[i] ?? []).join('; ')}.`),
		'',
		'Разбор входа на Python (на Go — так же построчно):',
		'',
		parseTemplate(cls, senior),
		'',
		`Скрытые тесты — пять групп: простые данные (только повторяемые ошибки и успех${senior ? ', попытки мгновенные' : ''}) и коды ответов (успех и неповторяемые ошибки${senior ? ', без тайм-аутов' : ''}) — в обеих срок и лимит попыток не достигаются${cls === 'retry-after' ? ', подсказки не больше C' : ''}; срок и лимит попыток на границе; рост паузы и потолок; ${senior ? 'длительности и тайм-аут попыток' : 'большой объём'}. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

function changeStatement(senior: boolean): string {
	return [
		'**Новое условие.** Повторы всех заданий делят общий бюджет: в каждой минуте `[60·w, 60·(w+1))` может начаться не больше `R` повторов (первая попытка задания бюджет не тратит и не ограничена). Попытки обрабатываются по времени их начала, при равном времени — по порядку заданий во входе.',
		'Повтор, на который в его минуте бюджета нет, переносится на начало следующей минуты `60·(w+1)` и там проверяется снова (может переноситься несколько раз); если перенесённый момент позже `старт + D`, итог задания — `expired`. Сделанный повтор тратит бюджет минуты, в которую он фактически начался; следующая пауза отсчитывается от фактической попытки' +
			(senior ? ' (от её конца).' : '.'),
		`Первая строка входа теперь \`J M D B C${senior ? ' T' : ''} R\` (1 ≤ R ≤ 100). Измените решение и отправьте его снова; формат вывода прежний.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Reference programs.

function pauseSource(cls: string, variant: Variant): string[] {
	switch (cls) {
		case 'linear':
			return [`        delay = min(c, b * ${variant === 'delay-off-by-one' ? '(k + 1)' : 'k'})`];
		case 'exponential':
			return [`        delay = min(c, b * 2 ** ${variant === 'delay-off-by-one' ? 'k' : '(k - 1)'})`];
		case 'decorrelated':
			return variant === 'delay-off-by-one'
				? ['        delay = prev[i]', '        prev[i] = min(c, (b + 3 * prev[i]) // 2)']
				: ['        prev[i] = min(c, (b + 3 * prev[i]) // 2)', '        delay = prev[i]'];
		default:
			return [`        delay = ${variant === 'hint-uncapped' ? 'int(hint)' : 'min(c, int(hint))'} if hint else b`];
	}
}

/**
 * The reference in Python: `attempt(i, t, k)` makes one attempt and returns the moment of the next one or `None`;
 * without the budget every job runs alone, with it a heap orders the attempts of all jobs.
 */
function referenceSource(cls: string, senior: boolean, budget: boolean, variant: Variant): string {
	const limit = variant === 'retries-not-attempts' ? 'm + 1' : 'm';
	const late = variant === 'deadline-strict' ? '>=' : '>';
	const cut =
		variant === 'timeout-not-cut' ? [] : ['    if dur > tmax:', "        code, hint, dur = 'timeout', '', tmax"];
	const next = variant === 'delay-from-start' ? 't + delay' : senior ? 't + dur + delay' : 't + delay';
	const retryable =
		variant === 'all-retryable'
			? ''
			: ['    if code not in RETRY:', "        status[i] = 'failed'", '        return None'].join('\n');
	return [
		...(budget ? ['import heapq'] : []),
		'import sys',
		'',
		"OK = {'200', '201', '204'}",
		"RETRY = {'timeout', '408', '429', '500', '502', '503', '504'}",
		'',
		"data = sys.stdin.read().split('\\n')",
		`${senior ? 'j, m, d, b, c, tmax' : 'j, m, d, b, c'}${budget ? ', r' : ''} = map(int, data[0].split())`,
		'jobs = [row.split() for row in data[1:j + 1]]',
		'times = [[] for _ in jobs]',
		"status = [''] * j",
		'prev = [b] * j',
		'',
		'',
		'def attempt(i, t, k):',
		'    times[i].append(t)',
		'    job = jobs[i]',
		...(senior ? ["    result, dur = job[k + 1].split(':')", '    dur = int(dur)'] : ['    result = job[k + 1]']),
		"    code, _, hint = result.partition('/')",
		...(senior ? cut : []),
		'    if code in OK:',
		"        status[i] = 'ok'",
		'        return None',
		...(retryable ? [retryable] : []),
		`    if k >= ${limit}:`,
		"        status[i] = 'exhausted'",
		'        return None',
		...pauseSource(cls, variant).map((line) => line.slice(4)),
		`    nt = ${next}`,
		`    if nt ${late} int(job[1]) + d:`,
		"        status[i] = 'expired'",
		'        return None',
		'    return nt',
		'',
		'',
		...(budget
			? [
					'heap = [(int(job[1]), i, 1) for i, job in enumerate(jobs)]',
					'heapq.heapify(heap)',
					'used = {}',
					'while heap:',
					'    t, i, k = heapq.heappop(heap)',
					'    if k > 1:',
					'        w = t // 60',
					'        if used.get(w, 0) >= r:',
					'            moved = (w + 1) * 60',
					'            if moved > int(jobs[i][1]) + d:',
					"                status[i] = 'expired'",
					'            else:',
					'                heapq.heappush(heap, (moved, i, k))',
					'            continue',
					'        used[w] = used.get(w, 0) + 1',
					'    nt = attempt(i, t, k)',
					'    if nt is not None:',
					'        heapq.heappush(heap, (nt, i, k + 1))'
				]
			: [
					'for i, job in enumerate(jobs):',
					'    t, k = int(job[1]), 1',
					'    while t is not None:',
					'        t = attempt(i, t, k)',
					'        k += 1'
				]),
		'for i, job in enumerate(jobs):',
		'    print(job[0], status[i], *times[i])'
	].join('\n');
}

function applies(id: Variant, cls: string, senior: boolean): boolean {
	switch (id) {
		case 'deadline-strict':
		case 'retries-not-attempts':
		case 'all-retryable':
			return true;
		case 'delay-off-by-one':
			return cls !== 'retry-after';
		case 'hint-uncapped':
			return cls === 'retry-after';
		case 'delay-from-start':
		case 'timeout-not-cut':
			return senior;
		default:
			return false;
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const cls = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== cls);
	const main = groups(rng, cls, others, senior, false);
	const step = groups(rng, cls, others, senior, true);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(cls, senior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(cls, senior, false, 'right'),
			changeSource: referenceSource(cls, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, cls, senior)
						? { kind: 'program' as const, source: referenceSource(cls, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
