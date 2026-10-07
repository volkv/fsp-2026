// Flex layout (CSS Flexible Box Layout 1, §9.7 «Resolving Flexible Lengths»): the flex base size from `flex-basis`,
// `width` and the `flex` shorthand, the free space after `gap`, growing by `flex-grow`, shrinking by `flex-shrink`
// weighted by the base size, clamping by `min-width`/`max-width` with freezing and a new round, lines of a wrapping
// container. The generator models it with exact fractions; the reference parses the shown declarations on its own.
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
	if (d === 0) throw new Error('division by zero');
	const g = gcd(n, d) * Math.sign(d);
	return { n: n / g, d: d / g };
};
const qadd = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const qsub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const qmul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const qdiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const qcmp = (a: Q, b: Q): number => a.n * b.d - b.n * a.d;
const qsum = (xs: readonly Q[]): Q => xs.reduce(qadd, q(0));
const qmin = (a: Q, b: Q): Q => (qcmp(a, b) <= 0 ? a : b);
const qmax = (a: Q, b: Q): Q => (qcmp(a, b) >= 0 ? a : b);
const ZERO = q(0);

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** Declarations of an item in the order they are written. `flex` is the shorthand: a number, `auto` or `none`. */
interface Style {
	flex?: number | 'auto' | 'none';
	grow?: number;
	shrink?: number;
	basis?: number | 'auto';
	width?: number;
	min?: number;
	max?: number;
}

interface Item {
	name: string;
	style: Style;
}

interface Params {
	width: number;
	gap: number;
	wrap: boolean;
	items: Item[];
}

interface Rules {
	equalSplit: boolean;
	growWholeWidth: boolean;
	ignoreGap: boolean;
	flex1KeepsWidth: boolean;
	basisLosesToWidth: boolean;
	shrinkUnweighted: boolean;
	clampNoRedistribute: boolean;
	wrapAsOneLine: boolean;
}

const RIGHT: Rules = {
	equalSplit: false,
	growWholeWidth: false,
	ignoreGap: false,
	flex1KeepsWidth: false,
	basisLosesToWidth: false,
	shrinkUnweighted: false,
	clampNoRedistribute: false,
	wrapAsOneLine: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'equal-split': { equalSplit: true },
	'grow-whole-width': { growWholeWidth: true },
	'ignore-gap': { ignoreGap: true },
	'flex1-keeps-width': { flex1KeepsWidth: true },
	'flex-basis-loses-to-width': { basisLosesToWidth: true },
	'shrink-unweighted': { shrinkUnweighted: true },
	'clamp-no-redistribute': { clampNoRedistribute: true },
	'wrap-as-one-line': { wrapAsOneLine: true }
};

interface Resolved {
	base: Q;
	grow: number;
	shrink: number;
	min: Q;
	max: Q | null;
}

function resolve(style: Style, rules: Rules): Resolved {
	let grow = 0;
	let shrink = 1;
	let basis: number | 'auto' | 'zero' = 'auto';
	if (style.flex !== undefined) {
		if (style.flex === 'auto') [grow, shrink, basis] = [1, 1, 'auto'];
		else if (style.flex === 'none') [grow, shrink, basis] = [0, 0, 'auto'];
		else [grow, shrink, basis] = [style.flex, 1, rules.flex1KeepsWidth ? 'auto' : 'zero'];
	}
	if (style.grow !== undefined) grow = style.grow;
	if (style.shrink !== undefined) shrink = style.shrink;
	if (style.basis !== undefined) basis = style.basis;
	if (rules.basisLosesToWidth && style.width !== undefined) basis = style.width;
	// An empty item: its content size is zero, so `auto` falls back to `width` or 0, and the automatic minimum is 0.
	const base = basis === 'zero' ? ZERO : basis === 'auto' ? q(style.width ?? 0) : q(basis);
	return { base, grow, shrink, min: q(style.min ?? 0), max: style.max === undefined ? null : q(style.max) };
}

const clamp = (x: Q, r: Resolved): Q => qmax(r.max === null ? x : qmin(x, r.max), r.min);

/** Sizes of one line's items within `space` (the inner main size less the gaps of the line). */
function resolveLine(items: readonly Resolved[], space: Q, rules: Rules): Q[] {
	const hyp = items.map((r) => clamp(r.base, r));
	const growing = qcmp(qsum(hyp), space) < 0;
	const factor = (r: Resolved): number => (growing ? r.grow : r.shrink);
	const base = items.map((r) => (growing && rules.growWholeWidth && r.grow > 0 ? ZERO : r.base));
	const frozen = items.map(
		(r, i) =>
			factor(r) === 0 ||
			(growing && qcmp(base[i] as Q, hyp[i] as Q) > 0) ||
			(!growing && qcmp(base[i] as Q, hyp[i] as Q) < 0)
	);
	const target = items.map((_, i) => (frozen[i] ? (hyp[i] as Q) : (base[i] as Q)));
	for (let round = 0; round < items.length + 1; round += 1) {
		if (frozen.every(Boolean)) break;
		const used = qsum(items.map((_, i) => (frozen[i] ? (target[i] as Q) : (base[i] as Q))));
		const remaining = qsub(space, used);
		const open = items.map((_, i) => i).filter((i) => !frozen[i]);
		if (growing) {
			const weights = open.map((i) => (rules.equalSplit ? 1 : (items[i] as Resolved).grow));
			const total = weights.reduce((a, b) => a + b, 0);
			open.forEach((i, k) => {
				target[i] = qadd(base[i] as Q, qmul(remaining, q(weights[k] as number, total)));
			});
		} else {
			const weights = open.map((i) => {
				const r = items[i] as Resolved;
				return rules.shrinkUnweighted ? q(r.shrink) : qmul(q(r.shrink), base[i] as Q);
			});
			const total = qsum(weights);
			open.forEach((i, k) => {
				target[i] = total.n === 0 ? (base[i] as Q) : qadd(base[i] as Q, qmul(remaining, qdiv(weights[k] as Q, total)));
			});
		}
		let violation = ZERO;
		const adjust = new Map<number, Q>();
		for (const i of open) {
			const clamped = qmax(clamp(target[i] as Q, items[i] as Resolved), ZERO);
			adjust.set(i, qsub(clamped, target[i] as Q));
			violation = qadd(violation, qsub(clamped, target[i] as Q));
			target[i] = clamped;
		}
		if (rules.clampNoRedistribute) break;
		for (const i of open) {
			const a = adjust.get(i) as Q;
			if (violation.n === 0 || (violation.n > 0 && a.n > 0) || (violation.n < 0 && a.n < 0)) frozen[i] = true;
		}
	}
	return target;
}

interface Layout {
	sizes: Q[];
	lines: number[][];
}

function layout(p: Params, rules: Rules): Layout {
	const gap = rules.ignoreGap ? 0 : p.gap;
	const items = p.items.map((it) => resolve(it.style, rules));
	const lines: number[][] = [];
	if (p.wrap && !rules.wrapAsOneLine) {
		let line: number[] = [];
		let used = ZERO;
		items.forEach((r, i) => {
			const size = clamp(r.base, r);
			const next = line.length === 0 ? size : qadd(qadd(used, q(gap)), size);
			if (line.length > 0 && qcmp(next, q(p.width)) > 0) {
				lines.push(line);
				line = [i];
				used = size;
			} else {
				line.push(i);
				used = next;
			}
		});
		if (line.length) lines.push(line);
	} else lines.push(items.map((_, i) => i));
	const sizes: Q[] = new Array<Q>(items.length).fill(ZERO);
	for (const line of lines) {
		const space = q(p.width - gap * (line.length - 1));
		const got = resolveLine(
			line.map((i) => items[i] as Resolved),
			space,
			rules
		);
		line.forEach((i, k) => {
			sizes[i] = got[k] as Q;
		});
	}
	return { sizes, lines };
}

const show = (x: Q): string => (x.d === 1 ? String(x.n) : (x.n / x.d).toFixed(2));
const answerOf = (l: Layout): string => l.sizes.map(show).join(' ');

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const NAMES = ['logo', 'menu', 'search', 'cart', 'user', 'tabs', 'info', 'promo', 'help', 'feed'];

const step = (rng: Rng, lo: number, hi: number, by = 10): number =>
	by * rng.int(Math.ceil(lo / by), Math.floor(hi / by));

interface Draft {
	gap: number;
	wrap: boolean;
	styles: Style[];
	/** Container widths to try, in order. */
	widths: number[];
}

function draft(rng: Rng, grade: string, classId: string): Draft {
	const n = grade === 'intern' ? rng.int(3, 4) : rng.int(3, 5);
	const widths = (lo: number, hi: number): number[] =>
		rng.shuffle(Array.from({ length: Math.floor((hi - lo) / 10) + 1 }, (_, i) => lo + 10 * i)).slice(0, 40);
	const gap = rng.pick([0, 8, 10, 12, 16, 20]);
	if (grade === 'intern') {
		if (classId === 'grow-ratio') {
			const styles = Array.from({ length: n }, () => ({ grow: rng.int(1, 4), basis: step(rng, 40, 200) }));
			const sum = styles.reduce((s, x) => s + x.basis, 0);
			return { gap: 0, wrap: false, styles, widths: widths(sum + 30, sum + 400) };
		}
		if (classId === 'flex-shorthand') {
			const styles: Style[] = Array.from({ length: n }, (_, i) => {
				const kind = i === 0 ? 'n' : rng.pick(['n', 'n', 'auto', 'none']);
				const width = step(rng, 60, 200);
				if (kind === 'auto') return { flex: 'auto', width };
				if (kind === 'none') return { flex: 'none', width };
				return { flex: rng.int(1, 3), width };
			});
			const sum = styles.reduce((s, x) => s + (x.width ?? 0), 0);
			return { gap: 0, wrap: false, styles, widths: widths(sum + 20, sum + 400) };
		}
		if (classId === 'gap-basis') {
			const styles: Style[] = Array.from({ length: n }, (_, i) => {
				const width = step(rng, 60, 200);
				const grow = rng.int(1, 3);
				return i === 0 || rng.bool(0.5) ? { grow, width, basis: step(rng, 40, 200) } : { grow, width };
			});
			const g = rng.pick([10, 12, 16, 20, 24]);
			const sum = styles.reduce((s, x) => s + ((x.basis as number | undefined) ?? x.width ?? 0), 0) + g * (n - 1);
			return { gap: g, wrap: false, styles, widths: widths(sum + 30, sum + 400) };
		}
		// grow-zero
		const styles: Style[] = Array.from({ length: n }, (_, i) => {
			const width = step(rng, 60, 200);
			if (i === 0) return rng.bool(0.5) ? { flex: 'none', width } : { grow: 0, basis: width };
			return rng.bool(0.35) ? { grow: 0, basis: width } : { grow: rng.int(1, 3), basis: width };
		});
		const sum = styles.reduce((s, x) => s + ((x.basis as number | undefined) ?? x.width ?? 0), 0) + gap * (n - 1);
		return { gap, wrap: false, styles: rng.shuffle(styles), widths: widths(sum + 30, sum + 400) };
	}
	if (classId === 'shrink-weighted') {
		const styles: Style[] = Array.from({ length: n }, () =>
			rng.bool(0.5)
				? { shrink: rng.int(1, 3), basis: step(rng, 80, 300) }
				: { shrink: rng.int(1, 3), width: step(rng, 80, 300) }
		);
		const sum = styles.reduce((s, x) => s + ((x.basis as number | undefined) ?? x.width ?? 0), 0) + gap * (n - 1);
		return { gap, wrap: false, styles, widths: widths(Math.floor(sum * 0.55), sum - 20) };
	}
	if (classId === 'max-freeze') {
		const styles: Style[] = Array.from({ length: n }, (_, i) => {
			const basis = step(rng, 40, 160);
			const grow = rng.int(1, 3);
			return i < 1 || rng.bool(0.3) ? { grow, basis, max: basis + step(rng, 10, 80) } : { grow, basis };
		});
		const sum = styles.reduce((s, x) => s + ((x.basis as number | undefined) ?? 0), 0) + gap * (n - 1);
		return { gap, wrap: false, styles: rng.shuffle(styles), widths: widths(sum + 60, sum + 500) };
	}
	if (classId === 'min-freeze') {
		const styles: Style[] = Array.from({ length: n }, (_, i) => {
			const basis = step(rng, 100, 300);
			const shrink = rng.int(1, 3);
			return i < 1 || rng.bool(0.3) ? { shrink, basis, min: basis - step(rng, 20, 80) } : { shrink, basis };
		});
		const sum = styles.reduce((s, x) => s + ((x.basis as number | undefined) ?? 0), 0) + gap * (n - 1);
		return { gap, wrap: false, styles: rng.shuffle(styles), widths: widths(Math.floor(sum * 0.55), sum - 40) };
	}
	// wrap
	const count = rng.int(4, 6);
	const styles = Array.from({ length: count }, () => ({ grow: rng.int(0, 2), basis: step(rng, 80, 220) }));
	const sum = styles.reduce((s, x) => s + x.basis, 0);
	const wrapGap = rng.pick([0, 10, 20]);
	return {
		gap: wrapGap,
		wrap: true,
		styles,
		widths: widths(Math.max(...styles.map((s) => s.basis)) + 40, Math.floor(sum * 0.7))
	};
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/grow-ratio': ['equal-split', 'grow-whole-width'],
	'intern/flex-shorthand': ['flex1-keeps-width'],
	'intern/gap-basis': ['ignore-gap', 'flex-basis-loses-to-width'],
	'intern/grow-zero': ['equal-split', 'grow-whole-width'],
	'junior/shrink-weighted': ['shrink-unweighted'],
	'junior/max-freeze': ['clamp-no-redistribute', 'equal-split'],
	'junior/min-freeze': ['clamp-no-redistribute', 'shrink-unweighted'],
	'junior/wrap': ['wrap-as-one-line']
};

interface Scenario {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function evaluate(p: Params, required: readonly string[], classId: string): Scenario | null {
	const right = layout(p, RIGHT);
	if (right.sizes.some((s) => s.d !== 1 || s.n < 10)) return null;
	const answer = answerOf(right);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = answerOf(layout(p, { ...RIGHT, ...change }));
			return [id, value === answer ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	const items = p.items.map((it) => resolve(it.style, RIGHT));
	const sumBases = qsum(items.map((r) => clamp(r.base, r)));
	const space = q(p.width - p.gap * (p.items.length - 1));
	const shrinking = qcmp(sumBases, space) > 0;
	if (!p.wrap && (classId === 'shrink-weighted' || classId === 'min-freeze') !== shrinking) return null;
	if (p.wrap && (right.lines.length < 2 || right.lines.every((l) => l.length === 1))) return null;
	return { p, answer, wrong };
}

function attempt(rng: Rng, grade: string, classId: string): Scenario | null {
	const d = draft(rng, grade, classId);
	const required = REQUIRED[`${grade}/${classId}`] ?? [];
	const names = rng.sample(NAMES, d.styles.length);
	const items = d.styles.map((style, i) => ({ name: names[i] as string, style }));
	for (const width of d.widths) {
		const found = evaluate({ width, gap: d.gap, wrap: d.wrap, items }, required, classId);
		if (found) return found;
	}
	return null;
}

/** Hand-checked layouts for a seed whose random drafts keep failing; each exposes the class's misconceptions. */
function fallback(rng: Rng, grade: string, classId: string): Params {
	const names = rng.sample(NAMES, 5);
	const items = (styles: Style[]): Item[] => styles.map((style, i) => ({ name: names[i] as string, style }));
	const table: Record<string, Params> = {
		'intern/grow-ratio': {
			width: 600,
			gap: 0,
			wrap: false,
			items: items([
				{ grow: 1, basis: 100 },
				{ grow: 2, basis: 50 },
				{ grow: 3, basis: 150 }
			])
		},
		'intern/flex-shorthand': {
			width: 600,
			gap: 0,
			wrap: false,
			items: items([
				{ flex: 1, width: 100 },
				{ flex: 2, width: 80 },
				{ flex: 'none', width: 120 }
			])
		},
		'intern/gap-basis': {
			width: 620,
			gap: 10,
			wrap: false,
			items: items([
				{ grow: 1, width: 150, basis: 100 },
				{ grow: 2, width: 100 },
				{ grow: 1, width: 80, basis: 60 }
			])
		},
		'intern/grow-zero': {
			width: 580,
			gap: 10,
			wrap: false,
			items: items([
				{ flex: 'none', width: 100 },
				{ grow: 1, basis: 80 },
				{ grow: 3, basis: 60 }
			])
		},
		'junior/shrink-weighted': {
			width: 300,
			gap: 0,
			wrap: false,
			items: items([
				{ shrink: 1, basis: 200 },
				{ shrink: 2, basis: 100 },
				{ shrink: 1, width: 100 }
			])
		},
		'junior/max-freeze': {
			width: 600,
			gap: 0,
			wrap: false,
			items: items([
				{ grow: 1, basis: 100, max: 120 },
				{ grow: 2, basis: 100 },
				{ grow: 2, basis: 100 }
			])
		},
		'junior/min-freeze': {
			width: 400,
			gap: 0,
			wrap: false,
			items: items([
				{ shrink: 1, basis: 200, min: 190 },
				{ shrink: 1, basis: 200 },
				{ shrink: 1, basis: 100 }
			])
		},
		'junior/wrap': {
			width: 500,
			gap: 20,
			wrap: true,
			items: items([
				{ grow: 1, basis: 200 },
				{ grow: 3, basis: 180 },
				{ grow: 1, basis: 160 },
				{ grow: 0, basis: 150 }
			])
		}
	};
	return table[`${grade}/${classId}`] ?? (table['intern/grow-ratio'] as Params);
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

function declarations(style: Style): string[] {
	const out: string[] = [];
	if (style.flex !== undefined) out.push(`flex: ${style.flex}`);
	if (style.grow !== undefined) out.push(`flex-grow: ${style.grow}`);
	if (style.shrink !== undefined) out.push(`flex-shrink: ${style.shrink}`);
	if (style.basis !== undefined) out.push(`flex-basis: ${style.basis === 'auto' ? 'auto' : `${style.basis}px`}`);
	if (style.width !== undefined) out.push(`width: ${style.width}px`);
	if (style.min !== undefined) out.push(`min-width: ${style.min}px`);
	if (style.max !== undefined) out.push(`max-width: ${style.max}px`);
	return out;
}

function describe(p: Params): string {
	const container = [`display: flex`, ...(p.wrap ? ['flex-wrap: wrap'] : []), `width: ${p.width}px`];
	if (p.gap) container.push(`gap: ${p.gap}px`);
	const css = [
		`.row { ${container.join('; ')}; }`,
		...p.items.map((it) => `.${it.name} { ${declarations(it.style).join('; ')}; }`)
	];
	const html = ['<div class="row">', ...p.items.map((it) => `  <div class="${it.name}"></div>`), '</div>'];
	return [
		'Стили и разметка:',
		'',
		'```css',
		...css,
		'```',
		'',
		'```html',
		...html,
		'```',
		'',
		'Считаем: у `.row` и у её детей нет padding, border и margin; дети пустые — без текста и вложенных элементов; других стилей нет. Ширина `.row` — ширина её области содержимого.',
		'',
		`Какой будет итоговая ширина каждого из элементов ${p.items.map((it) => `\`.${it.name}\``).join(', ')}? Введите ширины в пикселях в этом порядке через пробел, целыми числами без «px», например: \`${p.items.map((_, i) => 100 + 10 * i).join(' ')}\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import sys
from fractions import Fraction as F

data = json.loads(sys.stdin.read())
W = F(data["width"])
gap = F(data["gap"])


def parse(decls):
    item = {"grow": 0, "shrink": 1, "basis": "auto", "width": None, "min": F(0), "max": None}
    for decl in decls:
        prop, value = [x.strip() for x in decl.split(":", 1)]
        px = lambda v: F(v[:-2]) if v.endswith("px") else None
        if prop == "flex":
            if value == "auto":
                item.update(grow=1, shrink=1, basis="auto")
            elif value == "none":
                item.update(grow=0, shrink=0, basis="auto")
            else:
                item.update(grow=int(value), shrink=1, basis=F(0))
        elif prop == "flex-grow":
            item["grow"] = int(value)
        elif prop == "flex-shrink":
            item["shrink"] = int(value)
        elif prop == "flex-basis":
            item["basis"] = "auto" if value == "auto" else px(value)
        elif prop == "width":
            item["width"] = px(value)
        elif prop == "min-width":
            item["min"] = px(value)
        elif prop == "max-width":
            item["max"] = px(value)
        else:
            raise ValueError(prop)
    if item["basis"] == "auto":
        item["basis"] = item["width"] if item["width"] is not None else F(0)
    return item


def clamp(x, it):
    if it["max"] is not None and x > it["max"]:
        x = it["max"]
    return max(x, it["min"])


def flex_line(line):
    inner = W - gap * (len(line) - 1)
    hypo = [clamp(it["basis"], it) for it in line]
    grow = sum(hypo) < inner
    size = {}
    flexible = []
    for k, it in enumerate(line):
        factor = it["grow"] if grow else it["shrink"]
        if factor == 0 or (grow and it["basis"] > hypo[k]) or (not grow and it["basis"] < hypo[k]):
            size[k] = hypo[k]
        else:
            flexible.append(k)
    while flexible:
        free = inner - sum(size.values()) - sum(line[k]["basis"] for k in flexible)
        if grow:
            total = sum(line[k]["grow"] for k in flexible)
            want = {k: line[k]["basis"] + free * line[k]["grow"] / total for k in flexible}
        else:
            total = sum(line[k]["shrink"] * line[k]["basis"] for k in flexible)
            want = {k: line[k]["basis"] + free * line[k]["shrink"] * line[k]["basis"] / total for k in flexible}
        fixed = {k: max(clamp(want[k], line[k]), F(0)) for k in flexible}
        excess = sum(fixed[k] - want[k] for k in flexible)
        if excess == 0:
            freeze = list(flexible)
        elif excess > 0:
            freeze = [k for k in flexible if fixed[k] > want[k]]
        else:
            freeze = [k for k in flexible if fixed[k] < want[k]]
        for k in freeze:
            size[k] = fixed[k]
        flexible = [k for k in flexible if k not in freeze]
    return [size[k] for k in range(len(line))]


items = [parse(d) for d in data["items"]]
lines = []
if data["wrap"]:
    current = []
    for it in items:
        outer = clamp(it["basis"], it)
        width_with = sum(clamp(x["basis"], x) for x in current) + gap * len(current) + outer
        if current and width_with > W:
            lines.append(current)
            current = []
        current.append(it)
    lines.append(current)
else:
    lines = [items]
result = []
for line in lines:
    result.extend(flex_line(line))
for x in result:
    if x.denominator != 1:
        raise ValueError("not an integer width: " + str(x))
print(" ".join(str(x.numerator) for x in result))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	let chosen: Scenario | null = null;
	for (let tries = 0; tries < 200 && chosen === null; tries += 1) chosen = attempt(rng, input.grade, input.classId);
	if (chosen === null) {
		const p = fallback(rng, input.grade, input.classId);
		chosen = evaluate(p, [], input.classId) ?? { p, answer: answerOf(layout(p, RIGHT)), wrong: {} };
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
				width: p.width,
				gap: p.gap,
				wrap: p.wrap,
				items: p.items.map((it) => declarations(it.style))
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
