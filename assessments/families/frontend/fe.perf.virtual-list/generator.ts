// Virtualized lists: which rows a virtual list keeps in the DOM for a scroll position — the visible rows by the strict
// overlap with the window, overscan above and below clamped to the list, the heights of the two spacers, the browser's
// clamp of scrollTop and a header above the list. A level up: rows of different heights, measured or estimated,
// scroll anchoring after the rendered rows are measured, and scrolling to a row with an alignment.
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

type Align = 'start' | 'end' | 'center';

interface Params {
	/** `fixed` — every row has the same height; `variable` — a table of heights. */
	shape: 'fixed' | 'variable';
	n: number;
	viewport: number;
	header: number;
	/** Heights the library knows when it lays out: measured rows; `null` — not measured, the estimate is used. */
	known: (number | null)[];
	estimate: number | null;
	/** Anchoring: the real heights of the rows not measured yet (revealed when a row is rendered). */
	real: number[] | null;
	/** The value the script assigns to scrollTop; `null` when scrolling to a row instead. */
	scrollTop: number | null;
	scrollTo: { index: number; align: Align } | null;
	before: number;
	after: number;
	/** What the answer starts with: the final scrollTop (anchoring, scrolling to a row) or not. */
	reportScroll: boolean;
}

interface Rules {
	bottomInclusive: boolean;
	endInclusive: boolean;
	noScrollClamp: boolean;
	noIndexClamp: boolean;
	overscanSwapped: boolean;
	spacerFromFirst: boolean;
	ignoreHeader: boolean;
	countFromHeight: boolean;
	ignoreMeasured: boolean;
	noAnchor: boolean;
	anchorAllDelta: boolean;
	alignStart: boolean;
}

const RIGHT: Rules = {
	bottomInclusive: false,
	endInclusive: false,
	noScrollClamp: false,
	noIndexClamp: false,
	overscanSwapped: false,
	spacerFromFirst: false,
	ignoreHeader: false,
	countFromHeight: false,
	ignoreMeasured: false,
	noAnchor: false,
	anchorAllDelta: false,
	alignStart: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'bottom-inclusive': { bottomInclusive: true },
	'end-inclusive': { endInclusive: true },
	'no-scroll-clamp': { noScrollClamp: true },
	'no-index-clamp': { noIndexClamp: true },
	'overscan-swapped': { overscanSwapped: true },
	'spacer-from-first': { spacerFromFirst: true },
	'ignore-header': { ignoreHeader: true },
	'count-from-height': { countFromHeight: true },
	'ignore-measured': { ignoreMeasured: true },
	'no-anchor': { noAnchor: true },
	'anchor-all-delta': { anchorAllDelta: true },
	'align-start': { alignStart: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

interface Range {
	start: number;
	end: number;
	first: number;
	top: number;
	bottom: number;
}

/** The rendered range for heights `h` at scroll position `s`. */
function range(p: Params, h: readonly number[], s: number, rules: Rules): Range {
	const header = rules.ignoreHeader ? 0 : p.header;
	const tops: number[] = [];
	let y = header;
	for (const height of h) {
		tops.push(y);
		y += height;
	}
	let first = -1;
	let last = -1;
	for (let i = 0; i < p.n; i += 1) {
		const top = tops[i] ?? 0;
		const bottom = top + (h[i] ?? 0);
		const below = rules.endInclusive ? top <= s + p.viewport : top < s + p.viewport;
		const above = rules.bottomInclusive ? bottom >= s : bottom > s;
		if (below && above) {
			if (first === -1) first = i;
			last = i;
		}
	}
	if (rules.countFromHeight && p.shape === 'fixed') {
		last = Math.min(p.n - 1, first + Math.ceil(p.viewport / (h[0] ?? 1)) - 1);
	}
	const before = rules.overscanSwapped ? p.after : p.before;
	const after = rules.overscanSwapped ? p.before : p.after;
	const start = rules.noIndexClamp ? first - before : Math.max(0, first - before);
	const end = rules.noIndexClamp ? last + after : Math.min(p.n - 1, last + after);
	const sum = (from: number, to: number): number => {
		let total = 0;
		for (let i = Math.max(0, from); i < Math.min(p.n, to); i += 1) total += h[i] ?? 0;
		return total;
	};
	return {
		start,
		end,
		first,
		top: sum(0, rules.spacerFromFirst ? first : start),
		bottom: sum(end + 1, p.n)
	};
}

function clampScroll(p: Params, h: readonly number[], s: number, rules: Rules): number {
	if (rules.noScrollClamp) return s;
	const content = p.header + h.reduce((a, b) => a + b, 0);
	return Math.min(Math.max(0, s), Math.max(0, content - p.viewport));
}

/** The answer: `[scrollTop] start end rows top bottom`. */
function solve(p: Params, rules: Rules): string {
	const fallback = p.estimate ?? 0;
	let h = p.known.map((k) => (k === null || (rules.ignoreMeasured && p.estimate !== null) ? fallback : k));
	let s: number;
	if (p.scrollTo) {
		const tops = (rules.ignoreHeader ? 0 : p.header) + h.slice(0, p.scrollTo.index).reduce((a, b) => a + b, 0);
		const height = h[p.scrollTo.index] ?? 0;
		const align = rules.alignStart ? 'start' : p.scrollTo.align;
		const raw =
			align === 'start' ? tops : align === 'end' ? tops + height - p.viewport : tops + (height - p.viewport) / 2;
		s = clampScroll(p, h, raw, rules);
	} else s = clampScroll(p, h, p.scrollTop ?? 0, rules);
	let r = range(p, h, s, rules);
	if (p.real) {
		// The rendered rows are measured; the anchor (the first visible row) keeps its place in the window.
		const real = p.real;
		const measured = h.map((height, i) =>
			i >= r.start && i <= r.end && p.known[i] === null ? (real[i] ?? 0) : height
		);
		let delta = 0;
		const upTo = rules.anchorAllDelta ? r.end + 1 : r.first;
		for (let i = Math.max(0, r.start); i < upTo; i += 1) delta += (measured[i] ?? 0) - (h[i] ?? 0);
		if (rules.noAnchor) delta = 0;
		h = measured;
		s = clampScroll(p, h, s + delta, rules);
		r = range(p, h, s, rules);
	}
	const values = [r.start, r.end, r.end - r.start + 1, r.top, r.bottom];
	return (p.reportScroll ? [s, ...values] : values).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const ROW_HEIGHTS = [24, 28, 32, 36, 40, 44, 48, 56] as const;
const VARIABLE_HEIGHTS = [32, 40, 48, 56, 64, 72, 80, 96, 112, 120] as const;

function fixedRows(n: number, h: number): number[] {
	return Array.from({ length: n }, () => h);
}

function variableRows(rng: Rng, n: number): number[] {
	return Array.from({ length: n }, () => rng.pick(VARIABLE_HEIGHTS));
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const base = {
		header: 0,
		estimate: null,
		real: null,
		scrollTo: null,
		reportScroll: false
	};
	if (grade === 'middle') {
		const h = rng.pick(ROW_HEIGHTS);
		const n = rng.int(40, 400) * 5;
		const o = rng.int(2, 5);
		if (classId === 'exact-boundary') {
			const k = rng.int(6, 16);
			const m = rng.int(10, n - k - 10);
			return {
				...base,
				shape: 'fixed',
				n,
				viewport: k * h,
				known: fixedRows(n, h),
				scrollTop: m * h,
				before: o,
				after: o
			};
		}
		if (classId === 'clamped') {
			const viewport = rng.int(12, 36) * 20;
			const smallN = rng.int(40, 120);
			const max = smallN * h - viewport;
			return {
				...base,
				shape: 'fixed',
				n: smallN,
				viewport,
				known: fixedRows(smallN, h),
				scrollTop: max + rng.int(1, 3) * h + rng.int(1, h - 1),
				before: o,
				after: o
			};
		}
		if (classId === 'asymmetric') {
			const viewport = rng.int(12, 36) * 20 + rng.int(1, 3) * 6;
			const before = rng.int(1, 3);
			const after = before + rng.int(2, 5);
			const swap = rng.bool();
			return {
				...base,
				shape: 'fixed',
				n,
				viewport,
				known: fixedRows(n, h),
				scrollTop: rng.int(20, n - 40) * h + rng.int(1, h - 1),
				before: swap ? after : before,
				after: swap ? before : after
			};
		}
		// A header above the list in the same scroll container.
		const header = rng.int(30, 200) + 1;
		const viewport = rng.int(12, 36) * 20;
		const s = rng.bool(0.3) ? rng.int(1, header - 1) : header + rng.int(4, n - 40) * h + rng.int(0, h - 1);
		return {
			...base,
			shape: 'fixed',
			n,
			viewport,
			header,
			known: fixedRows(n, h),
			scrollTop: s,
			before: o,
			after: o
		};
	}
	const before = rng.int(1, 3);
	const after = rng.int(1, 3);
	if (classId === 'measured') {
		const n = rng.int(18, 24);
		const heights = variableRows(rng, n);
		const viewport = rng.int(10, 20) * 20;
		const content = heights.reduce((a, b) => a + b, 0);
		// Half of the time the window starts exactly where a row ends.
		const lo = heights[0] ?? 0;
		let s = rng.int(lo, Math.max(lo, content - viewport - 100));
		if (rng.bool()) {
			let y = 0;
			for (const height of heights) {
				if (y >= s) break;
				y += height;
			}
			s = Math.min(y, content - viewport);
		}
		return {
			...base,
			shape: 'variable',
			n,
			viewport,
			known: heights,
			scrollTop: s,
			before,
			after: before === after ? after + 1 : after
		};
	}
	if (classId === 'estimated') {
		const n = rng.int(30, 60);
		const m = rng.int(6, 10);
		const estimate = rng.pick([48, 50, 60, 64, 80]);
		const heights = variableRows(rng, m);
		const known = [...heights, ...Array.from({ length: n - m }, () => null)];
		const measuredTop = heights.reduce((a, b) => a + b, 0);
		const viewport = rng.int(10, 20) * 20;
		return {
			...base,
			shape: 'variable',
			n,
			viewport,
			known,
			estimate,
			scrollTop: measuredTop + rng.int(2, n - m - 15) * estimate + rng.int(0, estimate - 1),
			before,
			after
		};
	}
	if (classId === 'anchoring') {
		const n = rng.int(30, 45);
		const m = rng.int(4, 8);
		const estimate = rng.pick([48, 50, 60, 64, 80]);
		const heights = variableRows(rng, m);
		const known = [...heights, ...Array.from({ length: n - m }, () => null)];
		const real = [...heights, ...variableRows(rng, n - m)];
		const measuredTop = heights.reduce((a, b) => a + b, 0);
		const viewport = rng.int(10, 18) * 20;
		return {
			...base,
			shape: 'variable',
			n,
			viewport,
			known,
			estimate,
			real,
			scrollTop: measuredTop + rng.int(5, n - m - 15) * estimate + rng.int(1, estimate - 1),
			before: rng.int(2, 3),
			after,
			reportScroll: true
		};
	}
	// Scrolling to a row with an alignment.
	const n = rng.int(18, 26);
	const heights = variableRows(rng, n);
	const viewport = rng.int(10, 20) * 20;
	const align: Align = rng.pick(['start', 'end', 'center'] as const);
	const index =
		align === 'center'
			? rng.bool()
				? rng.int(0, 1)
				: rng.int(n - 2, n - 1)
			: align === 'start'
				? rng.int(3, n - 1)
				: rng.int(1, n - 4);
	return {
		...base,
		shape: 'variable',
		n,
		viewport,
		known: heights,
		scrollTop: null,
		scrollTo: { index, align },
		before,
		after,
		reportScroll: true
	};
}

/** The misconceptions an instance must expose; the class and its draw decide which. */
function required(p: Params, grade: string, classId: string): string[] {
	if (grade === 'middle') {
		return (
			{
				'exact-boundary': ['bottom-inclusive', 'end-inclusive'],
				clamped: ['no-scroll-clamp', 'no-index-clamp'],
				asymmetric: ['overscan-swapped', 'spacer-from-first'],
				header: ['ignore-header']
			}[classId] ?? []
		);
	}
	if (classId === 'scroll-to-index') {
		const align = p.scrollTo?.align;
		if (align === 'start') return ['bottom-inclusive'];
		if (align === 'end') return ['end-inclusive', 'align-start'];
		return ['no-scroll-clamp', 'align-start'];
	}
	return (
		{
			measured: ['overscan-swapped', 'spacer-from-first'],
			estimated: ['ignore-measured', 'spacer-from-first'],
			anchoring: ['no-anchor', 'anchor-all-delta']
		}[classId] ?? []
	);
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function heightTable(values: readonly (number | null)[], from: number): string {
	const width = Math.min(10, values.length);
	const rows: string[] = [];
	for (let i = 0; i < values.length; i += 10) {
		const chunk = values.slice(i, i + 10);
		// The last row is padded with empty cells: every row of a table has as many cells as its header.
		const cells = [
			...chunk.map((v) => (v === null ? '—' : String(v))),
			...Array.from({ length: width - chunk.length }, () => '')
		];
		rows.push(`| Строки ${from + i}–${from + i + chunk.length - 1} | ${cells.join(' | ')} |`);
	}
	return [
		`| Индексы | ${Array.from({ length: width }, (_, i) => `+${i}`).join(' | ')} |`,
		`|---|${Array.from({ length: width }, () => '---').join('|')}|`,
		...rows
	].join('\n');
}

function describe(p: Params): string {
	const lines: string[] = [];
	lines.push(
		`Список из ${p.n} строк (индексы с 0) выводится виртуально: в DOM есть только строки, попадающие в окно прокрутки, и ещё несколько строк запаса (overscan); место остальных строк занимают два распорных блока — над отрисованными строками и под ними.`,
		''
	);
	if (p.shape === 'fixed') lines.push(`- Все строки одной высоты — ${p.known[0] ?? 0} px.`);
	else if (p.real) {
		const m = p.known.findIndex((k) => k === null);
		lines.push(
			`- Строки 0–${m - 1} уже отрисовывались, их высоты измерены (таблица 1). Строки ${m}–${p.n - 1} ещё не отрисовывались: пока строка не измерена, библиотека считает её высоту равной ${p.estimate ?? 0} px. Реальные высоты этих строк (станут известны библиотеке только после их отрисовки) — в таблице 2.`
		);
	} else if (p.estimate !== null) {
		const m = p.known.findIndex((k) => k === null);
		lines.push(
			`- Строки 0–${m - 1} уже отрисовывались, их высоты измерены (таблица). Строки ${m}–${p.n - 1} ещё не отрисовывались: их высоты неизвестны, библиотека считает каждую равной ${p.estimate} px.`
		);
	} else lines.push('- Высоты строк, px, — в таблице (все строки уже измерены).');
	lines.push(
		`- Высота окна прокрутки (clientHeight контейнера) — ${p.viewport} px.`,
		p.header > 0
			? `- В том же контейнере прокрутки над списком — шапка высотой ${p.header} px; список начинается сразу под ней.`
			: '- Список начинается у самого верха контейнера прокрутки, других элементов в контейнере нет.',
		'- Строка считается видимой, если хоть какая-то часть её высоты (больше 0 px) попадает в окно.',
		`- Overscan: строк запаса выше первой видимой — ${p.before}, ниже последней видимой — ${p.after} (если в списке столько есть).`,
		'- Распорные блоки занимают ровно высоту неотрисованных строк (по тем высотам, которые известны библиотеке); других отступов нет.'
	);
	if (p.scrollTo) {
		const alignText = {
			start: 'верх строки совпадает с верхом окна',
			end: 'низ строки совпадает с низом окна',
			center: 'середина строки совпадает с серединой окна'
		}[p.scrollTo.align];
		lines.push(
			'',
			`Скрипт вызывает \`list.scrollToIndex(${p.scrollTo.index}, { align: '${p.scrollTo.align}' })\`: библиотека вычисляет scrollTop, при котором ${alignText}, и присваивает его \`scroller.scrollTop\`. Затем отрисовывает строки для получившейся прокрутки.`
		);
	} else {
		lines.push(
			'',
			`Скрипт выполняет \`scroller.scrollTop = ${p.scrollTop ?? 0}\`, после чего библиотека отрисовывает строки для получившейся прокрутки.`
		);
	}
	if (p.real) {
		lines.push(
			'',
			'После отрисовки библиотека измеряет реальные высоты отрисованных строк и сохраняет положение якоря — первой видимой строки, найденной при этой отрисовке: меняет scrollTop так, чтобы якорь остался на том же месте в окне. Затем отрисовывает строки заново для нового scrollTop — с новыми измерениями; строки, которые ещё ни разу не отрисовывались, по-прежнему считаются по оценке. На этом изменения заканчиваются.'
		);
	}
	if (p.shape === 'variable') {
		if (p.real) {
			const m = p.known.findIndex((k) => k === null);
			lines.push('', 'Таблица 1 — измеренные высоты, px:', '', heightTable(p.known.slice(0, m), 0));
			lines.push('', 'Таблица 2 — реальные высоты, px:', '', heightTable(p.real.slice(m), m));
		} else if (p.estimate !== null) {
			const m = p.known.findIndex((k) => k === null);
			lines.push('', 'Измеренные высоты, px:', '', heightTable(p.known.slice(0, m), 0));
		} else lines.push('', 'Высоты строк, px:', '', heightTable(p.known, 0));
	}
	lines.push(
		'',
		p.reportScroll
			? 'Для итогового состояния введите через пробел шесть целых чисел: scrollTop контейнера, индекс первой и последней отрисованной строки, число строк в DOM, высоту верхнего и нижнего распорного блока в px. Например: `1200 18 31 14 980 1540`.'
			: 'Введите через пробел пять целых чисел: индекс первой и последней отрисованной строки, число строк в DOM, высоту верхнего и нижнего распорного блока в px. Например: `18 31 14 980 1540`.'
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: a row-by-row walk instead of prefix sums.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
n = p["n"]
win = p["viewport"]


def heights_now(sizes):
    return [p["estimate"] if v is None else v for v in sizes]


def clamp(sizes, s):
    total = p["header"] + sum(sizes)
    return max(0, min(s, max(0, total - win)))


def window_rows(sizes, s):
    shown = []
    y = p["header"]
    for i in range(n):
        if y < s + win and y + sizes[i] > s:
            shown.append(i)
        y += sizes[i]
    lo = max(0, shown[0] - p["before"])
    hi = min(n - 1, shown[-1] + p["after"])
    return shown[0], lo, hi


def answer(sizes, s):
    _, lo, hi = window_rows(sizes, s)
    return [lo, hi, hi - lo + 1, sum(sizes[:lo]), sum(sizes[hi + 1:])]


sizes = heights_now(p["known"])
if p["scrollTo"] is not None:
    k = p["scrollTo"]["index"]
    row_top = p["header"] + sum(sizes[:k])
    a = p["scrollTo"]["align"]
    if a == "start":
        target = row_top
    elif a == "end":
        target = row_top + sizes[k] - win
    else:
        target = row_top + (sizes[k] - win) // 2
    s = clamp(sizes, target)
else:
    s = clamp(sizes, p["scrollTop"])
if p["real"] is not None:
    anchor, lo, hi = window_rows(sizes, s)
    old_anchor_top = p["header"] + sum(sizes[:anchor])
    for i in range(lo, hi + 1):
        if p["known"][i] is None:
            sizes[i] = p["real"][i]
    new_anchor_top = p["header"] + sum(sizes[:anchor])
    s = clamp(sizes, s + new_anchor_top - old_anchor_top)
out = answer(sizes, s)
if p["reportScroll"]:
    out = [s] + out
print(" ".join(str(v) for v in out))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | null = null;
	// Draws repeat until every misconception the class is built around changes the answer; the last draw stands if
	// none settles (the probes stay exact either way).
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { p, answer, wrong };
		if (required(p, input.grade, input.classId).every((id) => wrong[id] !== null)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({
				n: p.n,
				viewport: p.viewport,
				header: p.header,
				known: p.known,
				estimate: p.estimate,
				real: p.real,
				scrollTop: p.scrollTop,
				scrollTo: p.scrollTo,
				before: p.before,
				after: p.after,
				reportScroll: p.reportScroll
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

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
