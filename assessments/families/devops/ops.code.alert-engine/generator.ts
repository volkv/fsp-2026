// Practice: an evaluator of an alerting rule over a stream of metric samples. The class sets the condition (a
// threshold, a ratio of two series, absence of data on an evaluation grid, the increase of a counter with resets); a
// `for` duration moves the alert inactive → pending → firing and back, and the output is the events of the
// transitions. Senior has several labelled series, common evaluation moments and stale samples. The step «измени своё
// решение» adds keep_firing_for.
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

const SERIES = ['api', 'web-1', 'web-2', 'db', 'cache', 'queue', 'auth', 'mail'] as const;

/** `a` is the value (threshold, rate) or the errors (ratio); `b` is the total of the ratio. */
interface Sample {
	t: number;
	s: string;
	a: number;
	b: number;
}
/** `w` — the window (absent, rate), `l` — the lookback of Senior threshold and ratio, `g`/`e` — the grid of absent. */
interface Input {
	x: number;
	f: number;
	w: number;
	l: number;
	g: number;
	e: number;
	k: number | null;
	samples: Sample[];
}

const WRONG_IDS = [
	'for-strict',
	'pending-silent',
	'threshold-inclusive',
	'window-closed',
	'counter-reset-ignored',
	'no-staleness',
	'own-ticks'
] as const;
/** The wrong solutions, and edges the tests must pin: a stale sample exactly L old, the last tick of the grid. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'stale-closed' | 'grid-short';

interface Event {
	t: number;
	s: string;
	text: string;
}

/** The alert of one series: its state machine over the evaluations in time order. */
class Alert {
	state: 'inactive' | 'pending' | 'firing' = 'inactive';
	since = 0;
	falseSince: number | null = null;
	readonly name: string;
	readonly input: Input;
	readonly variant: Variant;
	readonly events: Event[];
	constructor(name: string, input: Input, variant: Variant, events: Event[]) {
		this.name = name;
		this.input = input;
		this.variant = variant;
		this.events = events;
	}
	step(t: number, cond: boolean): void {
		const { f, k } = this.input;
		const emit = (text: string): void => {
			this.events.push({ t, s: this.name, text });
		};
		if (this.state === 'firing') {
			if (cond) this.falseSince = null;
			else {
				this.falseSince ??= t;
				if (t - this.falseSince >= (k ?? 0)) {
					this.state = 'inactive';
					this.falseSince = null;
					emit('resolved');
				}
			}
		} else if (cond) {
			const fresh = this.state === 'inactive';
			if (fresh) this.since = t;
			if (this.variant === 'for-strict' ? t - this.since > f : t - this.since >= f) {
				this.state = 'firing';
				emit('firing');
			} else if (fresh) {
				this.state = 'pending';
				emit('pending');
			}
		} else if (this.state === 'pending') {
			this.state = 'inactive';
			if (this.variant !== 'pending-silent') emit('inactive');
		}
	}
}

/** The increase of a counter over samples in time order: a drop means the counter started again from zero. */
function increase(values: readonly number[], variant: Variant): number {
	let inc = 0;
	for (let i = 1; i < values.length; i += 1) {
		const prev = values[i - 1] as number;
		const cur = values[i] as number;
		inc += cur >= prev || variant === 'counter-reset-ignored' ? cur - prev : cur;
	}
	return inc;
}

/** The events of the rule; a variant other than `right` reproduces a wrong solution. */
function evaluate(cls: string, senior: boolean, input: Input, variant: Variant = 'right'): string {
	const events: Event[] = [];
	const per = new Map<string, Sample[]>();
	for (const sample of input.samples) per.set(sample.s, [...(per.get(sample.s) ?? []), sample]);
	const all = [...new Set(input.samples.map((s) => s.t))].sort((a, b) => a - b);
	const grid: number[] = [];
	for (let t = 0; t <= input.e - (variant === 'grid-short' ? input.g : 0); t += input.g) grid.push(t);
	const inclusive = variant === 'threshold-inclusive';
	const closed = variant === 'window-closed';
	for (const [name, pts] of per) {
		const alert = new Alert(name, input, variant, events);
		const ticks = cls === 'absent' ? grid : !senior || variant === 'own-ticks' ? pts.map((p) => p.t) : all;
		let p = -1;
		let lo = 0;
		for (const tau of ticks) {
			while (p + 1 < pts.length && (pts[p + 1] as Sample).t <= tau) p += 1;
			const last = pts[p];
			let cond: boolean;
			if (cls === 'absent') cond = !last || (closed ? last.t < tau - input.w : last.t <= tau - input.w);
			else if (cls === 'rate') {
				while (lo <= p && (closed ? (pts[lo] as Sample).t < tau - input.w : (pts[lo] as Sample).t <= tau - input.w))
					lo += 1;
				const inc = increase(
					pts.slice(lo, p + 1).map((x) => x.a),
					variant
				);
				cond = inclusive ? inc >= input.x : inc > input.x;
			} else {
				const fresh =
					last !== undefined &&
					(!senior ||
						variant === 'no-staleness' ||
						(variant === 'stale-closed' ? last.t >= tau - input.l : last.t > tau - input.l));
				const value = cls === 'ratio' ? 100 * (last?.a ?? 0) : (last?.a ?? 0);
				const bound = cls === 'ratio' ? input.x * (last?.b ?? 0) : input.x;
				cond = fresh && (inclusive ? value >= bound : value > bound);
			}
			alert.step(tau, cond);
		}
	}
	events.sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
	if (events.length === 0) return 'none\n';
	return `${events.map((e) => (senior ? `${e.t} ${e.s} ${e.text}` : `${e.t} ${e.text}`)).join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Input text: what each class writes, and how each class's program reads it (a malformed text is `null`).

function header(cls: string, senior: boolean, input: Input): number[] {
	const n = input.samples.length;
	const head =
		cls === 'absent'
			? [n, input.f, input.w, input.g, input.e]
			: cls === 'rate'
				? [n, input.x, input.f, input.w]
				: senior
					? [n, input.x, input.f, input.l]
					: [n, input.x, input.f];
	return input.k === null ? head : [...head, input.k];
}

function render(cls: string, senior: boolean, input: Input): string {
	const line = (s: Sample): string =>
		[s.t, ...(senior ? [s.s] : []), ...(cls === 'absent' ? [] : cls === 'ratio' ? [s.a, s.b] : [s.a])].join(' ');
	return `${[header(cls, senior, input).join(' '), ...input.samples.map(line)].join('\n')}\n`;
}

function read(cls: string, senior: boolean, withK: boolean, text: string): Input | null {
	const rows = text.split('\n');
	const head = (rows[0] ?? '').split(' ').map(Number);
	const width = (cls === 'absent' ? 5 : cls === 'rate' || senior ? 4 : 3) + (withK ? 1 : 0);
	if (head.length !== width) return null;
	const n = head[0] ?? 0;
	const input: Input = { x: 0, f: 0, w: 0, l: 0, g: 1, e: 0, k: withK ? (head[width - 1] ?? 0) : null, samples: [] };
	if (cls === 'absent') [input.f, input.w, input.g, input.e] = head.slice(1, 5) as [number, number, number, number];
	else if (cls === 'rate') [input.x, input.f, input.w] = head.slice(1, 4) as [number, number, number];
	else [input.x, input.f, input.l] = [head[1] ?? 0, head[2] ?? 0, senior ? (head[3] ?? 0) : 0];
	const fields = (senior ? 2 : 1) + (cls === 'absent' ? 0 : cls === 'ratio' ? 2 : 1);
	for (const row of rows.slice(1, n + 1)) {
		const f = row.split(' ');
		if (f.length !== fields) return null;
		const values = f.slice(senior ? 2 : 1).map(Number);
		input.samples.push({ t: Number(f[0]), s: senior ? (f[1] ?? '') : '', a: values[0] ?? 0, b: values[1] ?? 0 });
	}
	return input;
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs.

type GroupId = 'basic' | 'for' | 'edge' | 'flap' | 'series' | 'scale';

interface Shape {
	series: number;
	samples: number;
	/** A fixed step between the samples of a series (the edges of `for` and of the windows), or random steps. */
	fixed: boolean;
	/** Segment lengths of a true or false condition, in samples. */
	run: [number, number];
	/** Values exactly on the threshold. */
	equal: boolean;
	/** Senior: series pause for longer than the lookback. */
	gaps: boolean;
}

function shape(rng: Rng, group: GroupId, senior: boolean): Shape {
	const series = senior ? rng.int(2, 4) : 1;
	switch (group) {
		case 'basic':
			return { series, samples: rng.int(16, 30), fixed: false, run: [2, 6], equal: false, gaps: false };
		case 'for':
			return { series, samples: rng.int(18, 30), fixed: true, run: [2, 7], equal: false, gaps: false };
		case 'edge':
			return { series, samples: rng.int(18, 30), fixed: true, run: [2, 6], equal: true, gaps: false };
		case 'flap':
			return { series, samples: rng.int(20, 34), fixed: false, run: [1, 3], equal: false, gaps: false };
		case 'series':
			return { series: rng.int(3, 6), samples: rng.int(36, 60), fixed: false, run: [2, 6], equal: false, gaps: true };
		case 'scale':
			return {
				series: senior ? 6 : 1,
				samples: rng.int(3000, 4000),
				fixed: false,
				run: [1, 8],
				equal: true,
				gaps: senior
			};
	}
}

function makeInput(rng: Rng, cls: string, group: GroupId, senior: boolean, withK: boolean): Input {
	const sh = shape(rng, group, senior);
	const step = rng.int(5, 30);
	const input: Input = {
		x: cls === 'ratio' ? rng.pick([5, 10, 20, 25, 50]) : cls === 'rate' ? rng.int(20, 200) : rng.int(100, 900),
		f:
			group === 'for'
				? rng.pick([0, step, 2 * step, 3 * step])
				: rng.pick([0, step, 2 * step, 3 * step, rng.int(1, 4 * step)]),
		w: cls === 'absent' ? rng.int(2, 4) * step : rng.int(3, 8) * step,
		l: rng.int(1, 3) * step,
		g: rng.int(1, 3) * Math.max(1, Math.floor(step / 2)),
		e: 0,
		k: withK ? rng.int(1, 4) * step : null,
		samples: []
	};
	const names = rng.sample(SERIES, sh.series);
	const per = Math.max(4, Math.floor(sh.samples / sh.series));
	for (const name of names) {
		let t = rng.int(0, step);
		let counter = rng.int(0, 1000);
		let cond = rng.bool();
		let left = rng.int(...sh.run);
		const gap = sh.gaps && rng.bool(0.7) ? rng.int(Math.floor(per / 3), Math.floor((2 * per) / 3)) : -1;
		for (let i = 0; i < per; i += 1) {
			if (left === 0) {
				cond = !cond;
				left = rng.int(...sh.run);
			}
			left -= 1;
			const d = sh.fixed ? step : rng.int(1, 2 * step);
			// Absent: a false segment is a pause in reporting longer than the window.
			t +=
				i === 0
					? 0
					: i === gap
						? input.l + rng.int(0, 2 * step)
						: cls === 'absent' && cond
							? input.w + rng.int(0, step)
							: d;
			const equal = sh.equal && rng.bool(0.3);
			let a = 0;
			let b = 0;
			if (cls === 'threshold') a = cond ? input.x + rng.int(1, 60) : equal ? input.x : input.x - rng.int(1, 60);
			else if (cls === 'ratio') {
				const unit = 100 / gcd(100, input.x);
				b = equal ? unit * rng.int(1, 6) : rng.bool(0.08) ? 0 : rng.int(1, 300);
				const edge = (input.x * b) / 100;
				a = equal ? edge : cond && b > 0 ? rng.int(Math.floor(edge) + 1, b) : rng.int(0, Math.floor(edge));
			} else if (cls === 'rate') {
				// A run of fast or slow growth; now and then the counter restarts or stands still.
				const pace = Math.max(1, Math.floor((input.x * d) / input.w));
				if (rng.bool(0.06)) counter = rng.int(0, 10);
				else if (!(sh.equal && rng.bool(0.2)))
					counter += cond ? rng.int(pace, 3 * pace) : rng.int(0, Math.floor(pace / 2));
				a = counter;
			}
			input.samples.push({ t, s: name, a, b });
		}
	}
	input.samples.sort((p, q) => p.t - q.t || (p.s < q.s ? -1 : p.s > q.s ? 1 : 0));
	if (!senior) {
		// One series: strictly increasing moments.
		input.samples = input.samples.filter((s, i, all) => i === 0 || s.t > (all[i - 1] as Sample).t);
	} else {
		const seen = new Set<string>();
		input.samples = input.samples.filter((s) => {
			const key = `${s.s}|${s.t}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	if (group === 'edge' && (cls === 'threshold' || cls === 'rate') && input.samples.length > 0) {
		// The threshold equals the measured quantity at one moment: there the strict comparison decides.
		const at = rng.pick(input.samples);
		if (cls === 'threshold') input.x = at.a;
		else {
			const own = input.samples.filter((x) => x.s === at.s && x.t > at.t - input.w && x.t <= at.t);
			input.x = increase(
				own.map((x) => x.a),
				'right'
			);
		}
	}
	const last = input.samples[input.samples.length - 1]?.t ?? 0;
	input.e = Math.floor((last + rng.int(0, 2) * input.w) / input.g) * input.g;
	return input;
}

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

/** The wrong solutions (and edges) a group must expose on every test of the class. */
function traps(cls: string, group: GroupId, senior: boolean): Variant[] {
	switch (group) {
		case 'for':
			return ['for-strict'];
		case 'flap':
			return ['pending-silent'];
		case 'edge':
			return cls === 'absent'
				? ['window-closed']
				: cls === 'rate'
					? ['threshold-inclusive', 'window-closed', 'counter-reset-ignored']
					: ['threshold-inclusive'];
		case 'series':
			return cls === 'absent' ? [] : cls === 'rate' ? ['own-ticks'] : ['no-staleness', 'own-ticks', 'stale-closed'];
		case 'basic':
			return cls === 'absent' && !senior ? ['grid-short'] : [];
		default:
			return [];
	}
}

function groups(rng: Rng, cls: string, others: readonly string[], senior: boolean, withK: boolean): HiddenTestGroup[] {
	const ids: GroupId[] = senior
		? ['for', 'edge', 'flap', 'series', 'scale']
		: ['basic', 'for', 'edge', 'flap', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${cls}`);
			const input = makeInput(rng, cls, id, senior, withK);
			const expected = evaluate(cls, senior, input);
			// Below the output limit of the sandbox (64 KiB) with room to spare.
			if (expected.split('\n').length < 4 || expected.length > 32_000) continue;
			const stdin = render(cls, senior, input);
			if (
				others.some((other) => {
					const seen = read(other, senior, withK, stdin);
					return seen !== null && evaluate(other, senior, seen) === expected;
				})
			)
				continue;
			if (withK) {
				if (evaluate(cls, senior, { ...input, k: null }) === expected) continue;
			} else if (traps(cls, id, senior).some((v) => evaluate(cls, senior, input, v) === expected)) continue;
			tests.push({ stdin, expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

function conditionText(cls: string, senior: boolean): string {
	switch (cls) {
		case 'threshold':
			return senior
				? 'значение ряда в момент τ — последний его отсчёт с моментом t ≤ τ, если t > τ − L (иначе данных нет); условие истинно, если данные есть и значение **больше** `X`.'
				: 'условие истинно, если значение отсчёта **больше** `X` (равенство — ложь).';
		case 'ratio':
			return `${senior ? 'отсчёт ряда в момент τ — последний его отсчёт с моментом t ≤ τ, если t > τ − L (иначе данных нет и условие ложно); ' : ''}отсчёт несёт \`a\` — число ошибок и \`b\` — число запросов (0 ≤ a ≤ b); условие истинно, если доля ошибок в процентах **больше** \`X\`: 100·a > X·b (при b = 0 условие ложно). Считайте в целых числах.`;
		case 'absent':
			return `условие истинно, если у ${senior ? 'ряда' : 'метрики'} нет ни одного отсчёта с моментом в полуинтервале (τ − W, τ] — данные пропали.`;
		default:
			return `ряд — счётчик, который только растёт, но может сброситься (перезапуск процесса). Прирост в момент τ — сумма по соседним парам отсчётов ${senior ? 'ряда ' : ''}с моментами в полуинтервале (τ − W, τ]: для пары (p, q) прибавляется q − p, если q ≥ p, и q, если q < p (счётчик начат заново с нуля). Условие истинно, если прирост **больше** \`X\`.`;
	}
}

function statement(cls: string, senior: boolean): string {
	const params: Record<string, string> = {
		absent:
			'`N F W S E`: число отсчётов (1 ≤ N ≤ 10⁴), длительность for, окно, шаг сетки и её конец в секундах (1 ≤ W, S ≤ 10⁴; 0 ≤ F, E ≤ 10⁹)',
		rate: '`N X F W`: число отсчётов (1 ≤ N ≤ 10⁴), порог прироста, длительность for и окно в секундах (0 ≤ X ≤ 10⁹; 0 ≤ F ≤ 10⁹; 1 ≤ W ≤ 10⁶)',
		threshold: senior
			? '`N X F L`: число отсчётов (1 ≤ N ≤ 10⁴), порог, длительность for и срок годности отсчёта в секундах (0 ≤ X ≤ 10⁹; 0 ≤ F ≤ 10⁹; 1 ≤ L ≤ 10⁶)'
			: '`N X F`: число отсчётов (1 ≤ N ≤ 10⁴), порог и длительность for в секундах (0 ≤ X, F ≤ 10⁹)',
		ratio: senior
			? '`N X F L`: число отсчётов (1 ≤ N ≤ 10⁴), порог доли ошибок в процентах, длительность for и срок годности отсчёта в секундах (0 ≤ X ≤ 100; 0 ≤ F ≤ 10⁹; 1 ≤ L ≤ 10⁶)'
			: '`N X F`: число отсчётов (1 ≤ N ≤ 10⁴), порог доли ошибок в процентах и длительность for в секундах (0 ≤ X ≤ 100; 0 ≤ F ≤ 10⁹)'
	};
	const line =
		cls === 'absent'
			? senior
				? '`t ряд`'
				: '`t`'
			: cls === 'ratio'
				? senior
					? '`t ряд a b`'
					: '`t a b`'
				: senior
					? '`t ряд v`'
					: '`t v`';
	const ticks =
		cls === 'absent'
			? `Правило оценивается в моменты τ = 0, S, 2·S, … пока τ ≤ E${senior ? ' — для каждого ряда, который встречается во входе' : ''}.`
			: senior
				? 'Правило оценивается для каждого ряда во **все** моменты, в которые есть хоть один отсчёт любого ряда (общие моменты оценки), в порядке времени.'
				: 'Правило оценивается в момент каждого отсчёта, по порядку.';
	return [
		`Система мониторинга оценивает правило оповещения по ${senior ? 'отсчётам метрик нескольких рядов' : 'отсчётам метрики'}. Напишите программу, которая печатает события смены состояния алерта.`,
		'',
		'## Вход',
		'',
		`Первая строка — ${params[cls] ?? ''}. Все числа — целые.`,
		`Далее \`N\` строк ${line}: момент в секундах (0 ≤ t ≤ 10⁹)${senior ? ', имя ряда (латинские буквы, цифры, `-`)' : ''}${cls === 'absent' ? '' : ', значения — целые от 0 до 10⁹'}. ${senior ? 'Строки идут по неубыванию момента; у одного ряда моменты строго растут.' : 'Моменты строго растут.'}`,
		'',
		'## Правило',
		'',
		`${ticks} Условие в момент τ: ${conditionText(cls, senior)}`,
		'',
		`Алерт${senior ? ' каждого ряда (у рядов свои алерты)' : ''} — автомат из состояний \`inactive\` (в начале), \`pending\`, \`firing\`. В каждой оценке в момент τ:`,
		'',
		'- `inactive` и условие истинно: запоминается since = τ; если τ − since ≥ F (то есть сразу при F = 0), алерт переходит в `firing`, иначе в `pending`;',
		'- `pending` и условие истинно: если τ − since ≥ F — переход в `firing`; ложно — переход в `inactive`;',
		'- `firing` и условие ложно — переход в `inactive` (алерт погас); истинно — остаётся `firing`.',
		'',
		'## Выход',
		'',
		`Каждый переход — строка события: \`${senior ? '<τ> <ряд> <событие>' : '<τ> <событие>'}\`, где событие — \`pending\` (inactive → pending), \`firing\` (в firing из любого состояния), \`inactive\` (pending → inactive), \`resolved\` (firing → inactive). События — по возрастанию τ${senior ? ', при равном τ — по имени ряда в лексикографическом порядке' : ''}. Если событий нет — одна строка \`none\`. Пример: \`${senior ? '120 web-1 pending' : '120 pending'}\`.`,
		'',
		`Скрытые тесты — пять групп: ${senior ? 'длительность for на границе, значения и окна на границе, дребезг условия, много рядов и устаревшие отсчёты, большой объём' : 'обычные данные, длительность for на границе, значения и окна на границе, дребезг условия, большой объём'}. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

function changeStatement(cls: string, senior: boolean): string {
	const width = header(cls, senior, { x: 0, f: 0, w: 0, l: 0, g: 0, e: 0, k: 1, samples: [] }).length;
	return [
		'**Новое условие: keep_firing_for.** Горящий алерт не гаснет от первого же ложного условия. Пусть в состоянии `firing` условие стало ложным в оценке в момент τ₀ (первая ложная оценка подряд). Алерт остаётся `firing` и переходит в `inactive` (событие `resolved`) в первой оценке τ, где условие ложно и τ − τ₀ ≥ K. Если до этого условие снова истинно, отсчёт сбрасывается: следующая ложная оценка — новый τ₀. При K = 0 поведение прежнее; `pending` правило не затрагивает.',
		`Первая строка входа теперь содержит ${width} чисел: прежние и в конце \`K\` (1 ≤ K ≤ 10⁶). Измените решение и отправьте его снова; формат вывода прежний.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Reference programs.

function referenceSource(cls: string, senior: boolean, withK: boolean, variant: Variant): string {
	const gt = variant === 'threshold-inclusive' ? '>=' : '>';
	const old = variant === 'window-closed' ? '<' : '<=';
	const fire = variant === 'for-strict' ? 't - st[1] > f' : 't - st[1] >= f';
	const names = [
		'n',
		...(cls === 'absent'
			? ['f', 'w', 'g', 'e']
			: cls === 'rate'
				? ['x', 'f', 'w']
				: senior
					? ['x', 'f', 'l']
					: ['x', 'f']),
		...(withK ? ['keep'] : [])
	];
	const resolve = withK
		? [
				'        if cond:',
				'            st[2] = None',
				'        else:',
				'            if st[2] is None:',
				'                st[2] = t',
				'            if t - st[2] >= keep:',
				"                st[0], st[2] = 'inactive', None",
				"                events.append((t, key, 'resolved'))"
			]
		: ['        if not cond:', "            st[0] = 'inactive'", "            events.append((t, key, 'resolved'))"];
	const parse = senior
		? [
				'per = {}',
				'moments = set()',
				'for row in data[1:n + 1]:',
				'    f_ = row.split()',
				'    moments.add(int(f_[0]))',
				`    per.setdefault(f_[1], []).append(${cls === 'absent' ? 'int(f_[0])' : cls === 'ratio' ? '(int(f_[0]), int(f_[2]), int(f_[3]))' : '(int(f_[0]), int(f_[2]))'})`,
				'moments = sorted(moments)'
			]
		: [
				`pts = [${cls === 'absent' ? 'int(row)' : 'tuple(map(int, row.split()))'} for row in data[1:n + 1]]`,
				"per = {'': pts}"
			];
	let body: string[];
	if (cls === 'absent') {
		body = [
			'for key, pts in per.items():',
			'    p = -1',
			'    for tau in range(0, e + 1, g):',
			'        while p + 1 < len(pts) and pts[p + 1] <= tau:',
			'            p += 1',
			`        step(key, tau, p < 0 or pts[p] ${old} tau - w)`
		];
	} else if (cls === 'rate') {
		const add = variant === 'counter-reset-ignored' ? 'cur - prev' : 'cur - prev if cur >= prev else cur';
		body = [
			'for key, pts in per.items():',
			'    p, lo = -1, 0',
			`    for tau in ${senior && variant !== 'own-ticks' ? 'moments' : '[q[0] for q in pts]'}:`,
			'        while p + 1 < len(pts) and pts[p + 1][0] <= tau:',
			'            p += 1',
			`        while lo <= p and pts[lo][0] ${old} tau - w:`,
			'            lo += 1',
			'        values = [q[1] for q in pts[lo:p + 1]]',
			'        inc = 0',
			'        for prev, cur in zip(values, values[1:]):',
			`            inc += ${add}`,
			`        step(key, tau, inc ${gt} x)`
		];
	} else {
		const value = cls === 'ratio' ? '100 * pts[p][1]' : 'pts[p][1]';
		const bound = cls === 'ratio' ? 'x * pts[p][2]' : 'x';
		const fresh = !senior || variant === 'no-staleness' ? '' : ' and pts[p][0] > tau - l';
		body = senior
			? [
					'for key, pts in per.items():',
					'    p = -1',
					`    for tau in ${variant === 'own-ticks' ? '[q[0] for q in pts]' : 'moments'}:`,
					'        while p + 1 < len(pts) and pts[p + 1][0] <= tau:',
					'            p += 1',
					`        step(key, tau, p >= 0${fresh} and ${value} ${gt} ${bound})`
				]
			: ['for p in range(len(pts)):', `    step('', pts[p][0], ${value} ${gt} ${bound})`];
	}
	return [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		`${names.join(', ')} = map(int, data[0].split())`,
		...parse,
		'states = {}',
		'events = []',
		'',
		'',
		'def step(key, t, cond):',
		"    st = states.setdefault(key, ['inactive', 0, None])",
		"    if st[0] == 'firing':",
		...resolve,
		'    elif cond:',
		"        fresh = st[0] == 'inactive'",
		'        if fresh:',
		'            st[1] = t',
		`        if ${fire}:`,
		"            st[0] = 'firing'",
		"            events.append((t, key, 'firing'))",
		'        elif fresh:',
		"            st[0] = 'pending'",
		"            events.append((t, key, 'pending'))",
		"    elif st[0] == 'pending':",
		"        st[0] = 'inactive'",
		...(variant === 'pending-silent' ? [] : ["        events.append((t, key, 'inactive'))"]),
		'',
		'',
		...body,
		'events.sort()',
		'for t, key, text in events:',
		senior ? '    print(t, key, text)' : '    print(t, text)',
		'if not events:',
		"    print('none')"
	].join('\n');
}

function applies(id: Variant, cls: string, senior: boolean): boolean {
	switch (id) {
		case 'for-strict':
		case 'pending-silent':
			return true;
		case 'threshold-inclusive':
			return cls !== 'absent';
		case 'window-closed':
			return cls === 'absent' || cls === 'rate';
		case 'counter-reset-ignored':
			return cls === 'rate';
		case 'no-staleness':
			return senior && (cls === 'threshold' || cls === 'ratio');
		case 'own-ticks':
			return senior && cls !== 'absent';
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
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'exact' } },
		changeStep: { markdown: changeStatement(cls, senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
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
