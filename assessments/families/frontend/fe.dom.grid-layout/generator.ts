// Grid layout (CSS Grid Layout 2): the widths of columns given in px, %, fr and minmax(px, fr) with gaps — «find the
// size of an fr», where a flexible track whose minimum exceeds its share leaves the flexible set — and the automatic
// placement of items (§8.5): items placed explicitly first, then items locked to a row, then the rest by the cursor,
// sparse or dense, with spans and negative line numbers. The generator models both with exact fractions; the reference
// parses the shown CSS on its own.
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

// ---------------------------------------------------------------------------------------------------------------
// Exact fractions.

interface Q {
	n: number;
	d: number;
}

const gcd = (a: number, b: number): number => {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y) [x, y] = [y, x % y];
	return x || 1;
};
const q = (n: number, d = 1): Q => {
	const g = gcd(n, d) * Math.sign(d);
	return { n: n / g, d: d / g };
};
const qadd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const qsub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const qmul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const qcmp = (a: Q, b: Q): number => a.n * b.d - b.n * a.d;
const ZERO = q(0);
const show = (x: Q): string => (x.d === 1 ? String(x.n) : (x.n / x.d).toFixed(2));

// ---------------------------------------------------------------------------------------------------------------
// Tracks.

type Track =
	{ k: 'px'; v: number } | { k: 'pct'; v: number } | { k: 'fr'; v: number } | { k: 'minmax'; min: number; fr: number };

/** A run of the template as written: one track, or `repeat(n, tracks)`. */
type Run = { track: Track } | { repeat: number; tracks: Track[] };

interface TrackRules {
	percentOfLeftover: boolean;
	frIgnoresGap: boolean;
	frIgnoresMin: boolean;
	frAddedToMin: boolean;
}

const expand = (runs: readonly Run[]): Track[] =>
	runs.flatMap((r) => ('track' in r ? [r.track] : Array.from({ length: r.repeat }, () => r.tracks).flat()));

function trackWidths(runs: readonly Run[], width: number, gap: number, rules: TrackRules): Q[] {
	const tracks = expand(runs);
	const gaps = gap * (tracks.length - 1);
	const space = q(width - gaps);
	const pctBase = rules.percentOfLeftover ? q(width - gaps) : q(width);
	const fixed = tracks.map((t): Q | null =>
		t.k === 'px' ? q(t.v) : t.k === 'pct' ? qmul(pctBase, q(t.v, 100)) : null
	);
	const factor = (t: Track): number => (t.k === 'fr' ? t.v : t.k === 'minmax' ? t.fr : 0);
	const base = (t: Track): Q => (t.k === 'minmax' ? q(t.min) : ZERO);
	const fill = rules.frIgnoresGap ? q(width) : space;
	const fixedSum = fixed.reduce((s: Q, f) => (f ? qadd(s, f) : s), ZERO);
	const out: Q[] = tracks.map((_, i) => fixed[i] ?? ZERO);
	if (rules.frAddedToMin) {
		// Minimums are laid first, then the fr share is added on top of them.
		const flexible = tracks.map((t, i) => (fixed[i] ? -1 : i)).filter((i) => i >= 0);
		const mins = flexible.reduce((s, i) => qadd(s, base(tracks[i] as Track)), ZERO);
		const total = flexible.reduce((s, i) => s + factor(tracks[i] as Track), 0);
		const unit = qmul(qsub(qsub(fill, fixedSum), mins), q(1, total));
		for (const i of flexible) out[i] = qadd(base(tracks[i] as Track), qmul(unit, q(factor(tracks[i] as Track))));
		return out;
	}
	const inflexible = new Set<number>();
	for (;;) {
		const flexible = tracks.map((_, i) => i).filter((i) => fixed[i] === null && !inflexible.has(i));
		const taken = [...inflexible].reduce((s, i) => qadd(s, base(tracks[i] as Track)), fixedSum);
		const total = Math.max(
			1,
			flexible.reduce((s, i) => s + factor(tracks[i] as Track), 0)
		);
		const unit = qmul(qsub(fill, taken), q(1, total));
		const unitOrZero = qcmp(unit, ZERO) < 0 ? ZERO : unit;
		const over = flexible.filter(
			(i) => qcmp(base(tracks[i] as Track), qmul(unitOrZero, q(factor(tracks[i] as Track)))) > 0
		);
		if (over.length === 0 || rules.frIgnoresMin) {
			for (const i of flexible) {
				const share = qmul(unitOrZero, q(factor(tracks[i] as Track)));
				const b = base(tracks[i] as Track);
				out[i] = qcmp(b, share) > 0 ? b : share;
			}
			for (const i of inflexible) out[i] = base(tracks[i] as Track);
			return out;
		}
		for (const i of over) inflexible.add(i);
	}
}

function trackText(t: Track): string {
	switch (t.k) {
		case 'px':
			return `${t.v}px`;
		case 'pct':
			return `${t.v}%`;
		case 'fr':
			return `${t.v}fr`;
		case 'minmax':
			return `minmax(${t.min}px, ${t.fr}fr)`;
	}
}

const templateText = (runs: readonly Run[]): string =>
	runs
		.map((r) => ('track' in r ? trackText(r.track) : `repeat(${r.repeat}, ${r.tracks.map(trackText).join(' ')})`))
		.join(' ');

// ---------------------------------------------------------------------------------------------------------------
// Placement.

/** A line as written: a positive or negative number. */
interface Placement {
	/** `grid-column`: start line, end line, span; `null` — not written. */
	colStart: number | null;
	colEnd: number | null;
	colSpan: number;
	/** `grid-row`: a start line, or `null` — auto. */
	row: number | null;
}

interface GridItem {
	name: string;
	place: Placement;
}

interface PlaceRules {
	spanIgnored: boolean;
	dense: 'right' | 'always' | 'never';
	rowLockedInOrder: boolean;
	explicitInOrder: boolean;
	negativeFromStart: boolean;
}

interface Placed {
	row: number;
	col: number;
}

/** Resolves the columns of an item with the explicit grid of `cols` columns: start line and span, or `null` start. */
function columns(p: Placement, cols: number, rules: PlaceRules): { start: number | null; span: number } {
	const line = (n: number): number => (n > 0 ? n : rules.negativeFromStart ? -n : cols + 2 + n);
	const span = rules.spanIgnored ? 1 : p.colSpan;
	if (p.colStart !== null && p.colEnd !== null) {
		let a = line(p.colStart);
		let b = line(p.colEnd);
		if (a > b) [a, b] = [b, a];
		return { start: a, span: rules.spanIgnored ? 1 : Math.max(1, b - a) };
	}
	if (p.colStart !== null) return { start: line(p.colStart), span };
	if (p.colEnd !== null) return { start: Math.max(1, line(p.colEnd) - span), span };
	return { start: null, span };
}

function placeAll(
	items: readonly GridItem[],
	cols: number,
	dense: boolean,
	rules: PlaceRules
): { placed: Placed[]; overflow: boolean } {
	const useDense = rules.dense === 'always' ? true : rules.dense === 'never' ? false : dense;
	const occupied = new Set<string>();
	const free = (row: number, col: number, span: number): boolean => {
		for (let c = col; c < col + span; c += 1) if (occupied.has(`${row}:${c}`)) return false;
		return true;
	};
	const take = (row: number, col: number, span: number): void => {
		for (let c = col; c < col + span; c += 1) occupied.add(`${row}:${c}`);
	};
	const placed: Placed[] = items.map(() => ({ row: 0, col: 0 }));
	let overflow = false;
	const resolved = items.map((it) => ({ ...columns(it.place, cols, rules), row: it.place.row }));
	const isExplicit = (i: number): boolean => resolved[i]?.start !== null && resolved[i]?.row !== null;
	const isRowLocked = (i: number): boolean => resolved[i]?.start === null && resolved[i].row !== null;
	const lockRow = (i: number, after: Map<number, number>): void => {
		const r = resolved[i] as { start: number | null; span: number; row: number | null };
		const row = r.row as number;
		let col = useDense ? 1 : (after.get(row) ?? 1);
		while (col + r.span - 1 <= cols && !free(row, col, r.span)) col += 1;
		if (col + r.span - 1 > cols) overflow = true;
		take(row, col, r.span);
		after.set(row, col + r.span);
		placed[i] = { row, col };
	};
	// Step 1: items with a definite row and column.
	if (!rules.explicitInOrder) {
		items.forEach((_, i) => {
			if (!isExplicit(i)) return;
			const r = resolved[i] as { start: number; span: number; row: number };
			take(r.row, r.start, r.span);
			placed[i] = { row: r.row, col: r.start };
		});
	}
	// Step 2: items locked to a row.
	const lockedAfter = new Map<number, number>();
	if (!rules.rowLockedInOrder)
		items.forEach((_, i) => {
			if (isRowLocked(i)) lockRow(i, lockedAfter);
		});
	// Step 4: the rest by the auto-placement cursor.
	let cursorRow = 1;
	let cursorCol = 1;
	items.forEach((_, i) => {
		const r = resolved[i] as { start: number | null; span: number; row: number | null };
		if (isExplicit(i)) {
			if (rules.explicitInOrder) {
				take(r.row as number, r.start as number, r.span);
				placed[i] = { row: r.row as number, col: r.start as number };
			}
			return;
		}
		if (isRowLocked(i)) {
			if (rules.rowLockedInOrder) lockRow(i, lockedAfter);
			return;
		}
		if (r.start !== null) {
			if (r.start + r.span - 1 > cols) overflow = true;
			if (useDense) cursorRow = 1;
			else if (r.start < cursorCol) cursorRow += 1;
			cursorCol = r.start;
			while (!free(cursorRow, cursorCol, r.span)) cursorRow += 1;
		} else {
			if (useDense) [cursorRow, cursorCol] = [1, 1];
			for (;;) {
				while (cursorCol + r.span - 1 <= cols && !free(cursorRow, cursorCol, r.span)) cursorCol += 1;
				if (cursorCol + r.span - 1 <= cols) break;
				cursorRow += 1;
				cursorCol = 1;
			}
		}
		take(cursorRow, cursorCol, r.span);
		placed[i] = { row: cursorRow, col: cursorCol };
	});
	return { placed, overflow };
}

function placementText(p: Placement): string[] {
	const out: string[] = [];
	if (p.colStart !== null || p.colEnd !== null || p.colSpan > 1) {
		const start = p.colStart === null ? (p.colSpan > 1 ? `span ${p.colSpan}` : 'auto') : String(p.colStart);
		const end =
			p.colEnd !== null ? String(p.colEnd) : p.colStart !== null && p.colSpan > 1 ? `span ${p.colSpan}` : null;
		out.push(`grid-column: ${end === null ? start : `${start} / ${end}`}`);
	}
	if (p.row !== null) out.push(`grid-row: ${p.row}`);
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Items of the family.

interface Params {
	mode: 'widths' | 'positions';
	width: number;
	gap: number;
	runs: Run[];
	dense: boolean;
	items: GridItem[];
}

interface Rules extends TrackRules, PlaceRules {}

const RIGHT: Rules = {
	percentOfLeftover: false,
	frIgnoresGap: false,
	frIgnoresMin: false,
	frAddedToMin: false,
	spanIgnored: false,
	dense: 'right',
	rowLockedInOrder: false,
	explicitInOrder: false,
	negativeFromStart: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'percent-of-leftover': { percentOfLeftover: true },
	'fr-ignores-gap': { frIgnoresGap: true },
	'fr-ignores-min': { frIgnoresMin: true },
	'fr-added-to-min': { frAddedToMin: true },
	'span-ignored': { spanIgnored: true },
	'backfill-sparse': { dense: 'always' },
	'dense-as-sparse': { dense: 'never' },
	'row-locked-in-order': { rowLockedInOrder: true },
	'explicit-in-order': { explicitInOrder: true },
	'negative-from-start': { negativeFromStart: true }
};

function solve(p: Params, rules: Rules): { answer: string; integral: boolean; overflow: boolean; rows: number } {
	if (p.mode === 'widths') {
		const widths = trackWidths(p.runs, p.width, p.gap, rules);
		return {
			answer: widths.map(show).join(' '),
			integral: widths.every((w) => w.d === 1 && w.n > 0),
			overflow: false,
			rows: 0
		};
	}
	const cols = expand(p.runs).length;
	const { placed, overflow } = placeAll(p.items, cols, p.dense, rules);
	return {
		answer: placed.map((x) => `${x.row} ${x.col}`).join(' '),
		integral: true,
		overflow,
		rows: Math.max(...placed.map((x) => x.row))
	};
}

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const step = (rng: Rng, lo: number, hi: number, by = 10): number =>
	by * rng.int(Math.ceil(lo / by), Math.floor(hi / by));
const auto = (span = 1): Placement => ({ colStart: null, colEnd: null, colSpan: span, row: null });

function widthsDraft(rng: Rng, classId: string): { runs: Run[]; gap: number } {
	const gap = rng.pick([8, 10, 12, 16, 20, 24]);
	const px = (): Run => ({ track: { k: 'px', v: step(rng, 60, 200) } });
	const pct = (): Run => ({ track: { k: 'pct', v: rng.pick([10, 15, 20, 25, 30]) } });
	const fr = (v = rng.int(1, 3)): Run => ({ track: { k: 'fr', v } });
	const mm = (min = step(rng, 100, 260), f = rng.int(1, 2)): Run => ({ track: { k: 'minmax', min, fr: f } });
	if (classId === 'fr-percent') {
		const runs = [pct(), fr(1), fr(rng.int(2, 3)), ...(rng.bool(0.6) ? [px()] : []), ...(rng.bool(0.4) ? [pct()] : [])];
		return { runs: rng.shuffle(runs), gap };
	}
	if (classId === 'minmax-repeat') {
		const repeated: Run = rng.bool(0.5)
			? { repeat: rng.int(2, 3), tracks: [{ k: 'minmax', min: step(rng, 120, 240), fr: 1 }] }
			: {
					repeat: 2,
					tracks: [
						{ k: 'px', v: step(rng, 60, 120) },
						{ k: 'fr', v: 1 }
					]
				};
		const withMin = 'repeat' in repeated && repeated.tracks[0]?.k === 'minmax';
		const runs = [repeated, withMin && rng.bool(0.5) ? fr(rng.int(2, 3)) : mm(), ...(rng.bool(0.5) ? [px()] : [])];
		return { runs: rng.shuffle(runs), gap };
	}
	// fr-clamp (middle): several minimums at different heights, a percentage, flexible tracks of different factors.
	const runs = [
		mm(step(rng, 140, 300), 1),
		mm(step(rng, 60, 160), rng.int(1, 3)),
		fr(rng.int(1, 3)),
		pct(),
		...(rng.bool(0.5) ? [mm()] : [px()])
	];
	return { runs: rng.shuffle(runs), gap };
}

function positionsDraft(rng: Rng, classId: string): { runs: Run[]; dense: boolean; items: GridItem[] } {
	const cols = classId === 'explicit-lines' || classId === 'row-locked' ? rng.int(3, 4) : rng.int(3, 5);
	const runs: Run[] = rng.bool(0.6)
		? [{ repeat: cols, tracks: [{ k: 'fr', v: 1 }] }]
		: Array.from({ length: cols }, (): Run => ({ track: { k: 'px', v: step(rng, 80, 160) } }));
	const n = rng.int(7, 9);
	const spanOf = (): number => (rng.bool(0.35) ? rng.int(2, Math.min(3, cols)) : 1);
	const places: Placement[] = Array.from({ length: n }, () => auto(spanOf()));
	let dense = false;
	if (classId === 'dense') dense = true;
	if (classId === 'explicit-lines') {
		for (const i of rng.sample([2, 3, 4, 5, 6], 2)) {
			const start = rng.int(1, cols - 1);
			const end = rng.int(start + 1, cols + 1);
			places[i] = { colStart: start, colEnd: end, colSpan: 1, row: rng.int(1, 3) };
		}
	}
	if (classId === 'row-locked') {
		for (const i of rng.sample([3, 4, 5, 6], 2)) places[i] = { ...auto(rng.bool(0.4) ? 2 : 1), row: rng.int(1, 2) };
	}
	if (classId === 'negative-lines') {
		const kinds: Placement[] = [
			{ colStart: 1, colEnd: -1, colSpan: 1, row: null },
			{ colStart: -3, colEnd: -1, colSpan: 1, row: null },
			{ colStart: null, colEnd: -1, colSpan: 2, row: null },
			{ colStart: -2, colEnd: null, colSpan: 1, row: null }
		];
		for (const i of rng.sample([1, 2, 3, 4, 5, 6], 2)) places[i] = rng.pick(kinds);
	}
	const names = LETTERS.slice(0, n);
	return { runs, dense, items: places.map((place, i) => ({ name: names[i] as string, place })) };
}

const REQUIRED: Record<string, string[]> = {
	'junior/fr-percent': ['percent-of-leftover', 'fr-ignores-gap'],
	'junior/minmax-repeat': ['fr-ignores-min', 'fr-added-to-min'],
	'junior/auto-span': ['span-ignored', 'backfill-sparse'],
	'junior/explicit-lines': ['explicit-in-order'],
	'middle/dense': ['dense-as-sparse', 'span-ignored'],
	'middle/fr-clamp': ['fr-ignores-min', 'fr-added-to-min', 'percent-of-leftover'],
	'middle/row-locked': ['row-locked-in-order'],
	'middle/negative-lines': ['negative-from-start']
};

const WIDTH_CLASSES = new Set(['fr-percent', 'minmax-repeat', 'fr-clamp']);

interface Scenario {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function evaluate(p: Params, required: readonly string[]): Scenario | null {
	const right = solve(p, RIGHT);
	if (!right.integral || right.overflow) return null;
	if (p.mode === 'positions' && right.rows > 5) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = solve(p, { ...RIGHT, ...change }).answer;
			return [id, value === right.answer ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { p, answer: right.answer, wrong };
}

/** For the middle fr item: the restart of «find the size of an fr» happens, and some minmax track stays flexible. */
function clampsAndFlexes(p: Params): boolean {
	const tracks = expand(p.runs);
	const widths = trackWidths(p.runs, p.width, p.gap, RIGHT);
	const atMin = tracks.filter((t, i) => t.k === 'minmax' && qcmp(widths[i] as Q, q(t.min)) === 0).length;
	const aboveMin = tracks.filter((t, i) => t.k === 'minmax' && qcmp(widths[i] as Q, q(t.min)) > 0).length;
	return atMin >= 1 && aboveMin >= 1;
}

function attempt(rng: Rng, grade: string, classId: string): Scenario | null {
	const required = REQUIRED[`${grade}/${classId}`] ?? [];
	if (WIDTH_CLASSES.has(classId)) {
		const { runs, gap } = widthsDraft(rng, classId);
		const widths = rng.shuffle(Array.from({ length: 41 }, (_, i) => 400 + 20 * i));
		for (const width of widths) {
			const p: Params = { mode: 'widths', width, gap, runs, dense: false, items: [] };
			const found = evaluate(p, required);
			if (!found) continue;
			if (classId === 'fr-clamp' && !clampsAndFlexes(p)) continue;
			return found;
		}
		return null;
	}
	const d = positionsDraft(rng, classId);
	return evaluate(
		{ mode: 'positions', width: 0, gap: rng.pick([8, 10, 16]), runs: d.runs, dense: d.dense, items: d.items },
		required
	);
}

/** Hand-checked grids for a seed whose random drafts keep failing; each exposes the class's misconceptions. */
function fallback(grade: string, classId: string): Params {
	const fr = (v: number): Run => ({ track: { k: 'fr', v } });
	const items = (places: Placement[]): GridItem[] => places.map((place, i) => ({ name: LETTERS[i] as string, place }));
	const grid3: Run[] = [{ repeat: 3, tracks: [{ k: 'fr', v: 1 }] }];
	const table: Record<string, Params> = {
		'junior/fr-percent': {
			mode: 'widths',
			width: 800,
			gap: 20,
			dense: false,
			items: [],
			runs: [{ track: { k: 'pct', v: 25 } }, fr(1), fr(2), { track: { k: 'px', v: 90 } }]
		},
		'junior/minmax-repeat': {
			mode: 'widths',
			width: 700,
			gap: 10,
			dense: false,
			items: [],
			runs: [{ repeat: 2, tracks: [{ k: 'minmax', min: 200, fr: 1 }] }, fr(2)]
		},
		'middle/fr-clamp': {
			mode: 'widths',
			width: 1000,
			gap: 20,
			dense: false,
			items: [],
			runs: [
				{ track: { k: 'minmax', min: 300, fr: 1 } },
				{ track: { k: 'minmax', min: 100, fr: 2 } },
				fr(2),
				{ track: { k: 'pct', v: 20 } }
			]
		},
		'junior/auto-span': {
			mode: 'positions',
			width: 0,
			gap: 10,
			dense: false,
			runs: grid3,
			items: items([auto(), auto(), auto(2), auto(), auto(3), auto(), auto(2)])
		},
		'junior/explicit-lines': {
			mode: 'positions',
			width: 0,
			gap: 10,
			dense: false,
			runs: grid3,
			items: items([auto(), auto(), { colStart: 1, colEnd: 3, colSpan: 1, row: 1 }, auto(), auto(2), auto(), auto()])
		},
		'middle/dense': {
			mode: 'positions',
			width: 0,
			gap: 10,
			dense: true,
			runs: grid3,
			items: items([auto(), auto(), auto(2), auto(), auto(3), auto(), auto(2)])
		},
		'middle/row-locked': {
			mode: 'positions',
			width: 0,
			gap: 10,
			dense: false,
			runs: grid3,
			items: items([auto(), auto(2), auto(), { ...auto(), row: 1 }, auto(), auto(), auto()])
		},
		'middle/negative-lines': {
			mode: 'positions',
			width: 0,
			gap: 10,
			dense: false,
			runs: grid3,
			items: items([
				auto(),
				auto(),
				{ colStart: -2, colEnd: null, colSpan: 1, row: null },
				auto(),
				{ colStart: 1, colEnd: -1, colSpan: 1, row: null },
				auto(),
				auto()
			])
		}
	};
	return table[`${grade}/${classId}`] ?? (table['junior/fr-percent'] as Params);
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

function describe(p: Params): string {
	const container = ['display: grid', `grid-template-columns: ${templateText(p.runs)}`, `gap: ${p.gap}px`];
	if (p.mode === 'widths') {
		container.splice(1, 0, `width: ${p.width}px`);
		return [
			'Стили сетки:',
			'',
			'```css',
			`.grid { ${container.join('; ')}; }`,
			'```',
			'',
			'Считаем: у `.grid` нет padding и border, `width` — ширина её области содержимого; элементы сетки пустые и не влияют на ширины колонок.',
			'',
			`Найдите ширину каждой колонки слева направо. Введите ${expand(p.runs).length} целых числа в пикселях через пробел, без «px», например: \`${expand(
				p.runs
			)
				.map((_, i) => 100 + 10 * i)
				.join(' ')}\`.`
		].join('\n');
	}
	if (p.dense) container.push('grid-auto-flow: row dense');
	const rules = p.items
		.map((it) => ({ it, decls: placementText(it.place) }))
		.filter((x) => x.decls.length)
		.map((x) => `.${x.it.name} { ${x.decls.join('; ')}; }`);
	return [
		'Стили и разметка:',
		'',
		'```css',
		`.grid { ${container.join('; ')}; }`,
		...rules,
		'```',
		'',
		'```html',
		'<div class="grid">',
		...p.items.map((it) => `  <div class="${it.name}"></div>`),
		'</div>',
		'```',
		'',
		'Считаем: других стилей нет, `order` у всех элементов по умолчанию, строки неявной сетки добавляются по мере надобности.',
		'',
		`Для каждого элемента ${p.items.map((it) => `\`.${it.name}\``).join(', ')} по порядку найдите, с какой строки и с какой колонки он начинается (номера линий сетки, считая с 1). Введите пары «строка колонка» через пробел, например для трёх элементов: \`1 1 1 2 2 1\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import re
import sys
from fractions import Fraction as F

data = json.loads(sys.stdin.read())


def split_top(text):
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == " " and depth == 0:
            if cur:
                parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        parts.append(cur)
    return parts


def tracks_of(text):
    out = []
    for part in split_top(text):
        m = re.fullmatch(r"repeat\\((\\d+),\\s*(.*)\\)", part)
        if m:
            out.extend(tracks_of(m.group(2)) * int(m.group(1)))
            continue
        m = re.fullmatch(r"minmax\\((\\d+)px,\\s*(\\d+)fr\\)", part)
        if m:
            out.append(("flex", F(int(m.group(1))), int(m.group(2))))
            continue
        m = re.fullmatch(r"(\\d+)(px|%|fr)", part)
        if not m:
            raise ValueError(part)
        v, unit = int(m.group(1)), m.group(2)
        if unit == "px":
            out.append(("fixed", F(v)))
        elif unit == "%":
            out.append(("fixed", F(data["width"]) * v / 100))
        else:
            out.append(("flex", F(0), v))
    return out


tracks = tracks_of(data["template"])
cols = len(tracks)

def column_widths():
    space = F(data["width"]) - data["gap"] * (cols - 1)
    flexible = {i for i, t in enumerate(tracks) if t[0] == "flex"}
    while True:
        leftover = space - sum(t[1] for i, t in enumerate(tracks) if i not in flexible)
        factors = max(1, sum(tracks[i][2] for i in flexible))
        fr = max(F(0), leftover / factors)
        too_big = {i for i in flexible if tracks[i][1] > fr * tracks[i][2]}
        if not too_big:
            break
        flexible -= too_big
    sizes = [max(t[1], fr * t[2]) if i in flexible else t[1] for i, t in enumerate(tracks)]
    for s in sizes:
        if s.denominator != 1:
            raise ValueError("fractional width " + str(s))
    print(" ".join(str(s.numerator) for s in sizes))


def positions():
    def line(n):
        return n if n > 0 else cols + 2 + n

    items = []
    for decls in data["items"]:
        col_start, span, row = None, 1, None
        for decl in decls:
            prop, value = [x.strip() for x in decl.split(":", 1)]
            if prop == "grid-row":
                row = int(value)
                continue
            ends = [x.strip() for x in value.split("/")]
            a = ends[0]
            b = ends[1] if len(ends) > 1 else None
            if a.startswith("span"):
                span = int(a.split()[1])
                if b is not None:
                    col_start = line(int(b)) - span
            elif a != "auto":
                col_start = line(int(a))
                if b is not None and b.startswith("span"):
                    span = int(b.split()[1])
                elif b is not None:
                    lo, hi = sorted((col_start, line(int(b))))
                    col_start, span = lo, hi - lo
        items.append({"col": col_start, "span": span, "row": row})

    grid = {}

    def fits(r, c, s):
        return c + s - 1 <= cols and all((r, x) not in grid for x in range(c, c + s))

    def put(k, r, c):
        for x in range(c, c + items[k]["span"]):
            grid[(r, x)] = k
        items[k]["at"] = (r, c)

    for k, it in enumerate(items):
        if it["col"] is not None and it["row"] is not None:
            put(k, it["row"], it["col"])
    last_in_row = {}
    for k, it in enumerate(items):
        if it["col"] is None and it["row"] is not None:
            c = 1 if data["dense"] else last_in_row.get(it["row"], 1)
            while not fits(it["row"], c, it["span"]):
                c += 1
                if c > cols:
                    raise ValueError("row-locked item does not fit")
            put(k, it["row"], c)
            last_in_row[it["row"]] = c + it["span"]
    r, c = 1, 1
    for k, it in enumerate(items):
        if it["row"] is not None:
            continue
        if data["dense"]:
            r, c = 1, 1
        if it["col"] is not None:
            if not data["dense"] and it["col"] < c:
                r += 1
            c = it["col"]
            while not fits(r, c, it["span"]):
                r += 1
        else:
            while not fits(r, c, it["span"]):
                c += 1
                if c + it["span"] - 1 > cols:
                    r, c = r + 1, 1
        put(k, r, c)
    print(" ".join("%d %d" % it["at"] for it in items))


if data["mode"] == "widths":
    column_widths()
else:
    positions()
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	let chosen: Scenario | null = null;
	for (let tries = 0; tries < 300 && chosen === null; tries += 1) chosen = attempt(rng, input.grade, input.classId);
	if (chosen === null) {
		const p = fallback(input.grade, input.classId);
		chosen = evaluate(p, []) ?? { p, answer: solve(p, RIGHT).answer, wrong: {} };
	}
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
				mode: p.mode,
				width: p.width,
				gap: p.gap,
				template: templateText(p.runs),
				dense: p.dense,
				items: p.items.map((it) => placementText(it.place))
			})
		}),
		wrong: () =>
			Object.fromEntries(
				Object.keys(WRONG).map((id) => {
					const value = wrong[id] ?? null;
					return [id, value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
