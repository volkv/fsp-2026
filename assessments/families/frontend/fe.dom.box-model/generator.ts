// The box model of block boxes in normal flow (CSS 2.2 §8 and §10.3.3, CSS Box Sizing 3): `box-sizing`, padding,
// border and margin in the used width, `width: auto` filling the containing block, percentages of the containing
// block's width; vertical margins collapsing between siblings and between a parent and its first child, and what keeps
// them apart (padding, border, a new block formatting context, a flex container). The generator lays the boxes out
// with its model; the reference is an independent layout of the same tree.
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

/** A length: pixels, or a percentage of the containing block's width. */
type Len = number | { pct: number };

interface Box {
	name: string;
	tag: string;
	display: 'block' | 'flow-root' | 'flex';
	sizing: 'content-box' | 'border-box';
	width: Len | 'auto';
	/** `null` — auto: the height of the content. */
	height: number | null;
	margin: [Len, Len, Len, Len];
	padding: [Len, Len, Len, Len];
	border: [number, number, number, number];
	children: Box[];
}

type Quantity = 'outer-width' | 'content-width' | 'top' | 'outer-height';

interface Params {
	/** The width of the page's content area; the page is the root block formatting context at y = 0. */
	page: number;
	boxes: Box[];
	queries: { box: string; what: Quantity }[];
	/** Which separation of the parent and its first child the item shows (the parent-child class only). */
	variant: string | null;
}

interface Rules {
	borderBoxIgnored: boolean;
	borderBoxExcludesBorder: boolean;
	marginCounted: boolean;
	autoAs100: boolean;
	percentOfBorderBox: boolean;
	marginNotSubtracted: boolean;
	marginsAdd: boolean;
	negativeIgnored: boolean;
	bfcHeightExcludesMargins: boolean;
	noParentChildCollapse: boolean;
	collapseThroughSeparators: boolean;
}

const RIGHT: Rules = {
	borderBoxIgnored: false,
	borderBoxExcludesBorder: false,
	marginCounted: false,
	autoAs100: false,
	percentOfBorderBox: false,
	marginNotSubtracted: false,
	marginsAdd: false,
	negativeIgnored: false,
	bfcHeightExcludesMargins: false,
	noParentChildCollapse: false,
	collapseThroughSeparators: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'border-box-ignored': { borderBoxIgnored: true },
	'border-box-excludes-border': { borderBoxExcludesBorder: true },
	'margin-counted': { marginCounted: true },
	'auto-as-100-percent': { autoAs100: true },
	'percent-of-border-box': { percentOfBorderBox: true },
	'margin-not-subtracted': { marginNotSubtracted: true },
	'margins-add': { marginsAdd: true },
	'negative-ignored': { negativeIgnored: true },
	'bfc-height-excludes-margins': { bfcHeightExcludesMargins: true },
	'parent-child-no-collapse': { noParentChildCollapse: true },
	'collapse-through-separators': { collapseThroughSeparators: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** The root box: the page itself, a block formatting context that never shares a margin with its children. */
const PAGE = '(page)';

interface Used {
	outerWidth: number;
	contentWidth: number;
	top: number;
	outerHeight: number;
}

class Layout {
	readonly used = new Map<string, Used>();
	readonly rules: Rules;

	constructor(rules: Rules) {
		this.rules = rules;
	}

	len(v: Len, cb: number, cbOuter: number): number {
		if (typeof v === 'number') return v;
		return ((this.rules.percentOfBorderBox ? cbOuter : cb) * v.pct) / 100;
	}

	/** Horizontal sizes of a box and, recursively, of its children; `cb` — the containing block's content width. */
	widths(box: Box, cb: number, cbOuter: number): void {
		const r = this.rules;
		const pad = this.len(box.padding[1], cb, cbOuter) + this.len(box.padding[3], cb, cbOuter);
		const bord = box.border[1] + box.border[3];
		const marg = this.len(box.margin[1], cb, cbOuter) + this.len(box.margin[3], cb, cbOuter);
		let content: number;
		let outer: number;
		if (box.width === 'auto') {
			outer = r.autoAs100 ? cb + pad + bord : r.marginNotSubtracted ? cb : cb - marg;
			content = outer - pad - bord;
		} else {
			const w = this.len(box.width, cb, cbOuter);
			if (box.sizing === 'border-box' && !r.borderBoxIgnored) {
				content = r.borderBoxExcludesBorder ? w - pad : w - pad - bord;
				outer = r.borderBoxExcludesBorder ? w + bord : w;
			} else {
				content = w;
				outer = w + pad + bord;
			}
		}
		this.used.set(box.name, {
			outerWidth: r.marginCounted ? outer + marg : outer,
			contentWidth: content,
			top: 0,
			outerHeight: 0
		});
		for (const child of box.children) this.widths(child, content, outer);
	}

	collapse(margins: readonly number[]): number {
		if (this.rules.marginsAdd) return margins.reduce((a, b) => a + b, 0);
		const pos = Math.max(0, ...margins);
		const neg = this.rules.negativeIgnored ? 0 : Math.min(0, ...margins);
		return pos + neg;
	}

	px(v: Len, box: Box): number {
		if (typeof v === 'number') return v;
		throw new Error(`vertical percentage on ${box.name}`);
	}

	separatedTop(box: Box): boolean {
		return this.px(box.padding[0], box) > 0 || box.border[0] > 0 || box.display !== 'block';
	}

	/** Whether the top margin of a box adjoins the top margin of its first child. */
	collapsesTop(box: Box): boolean {
		if (box.children.length === 0 || box.name === PAGE || this.rules.noParentChildCollapse) return false;
		return this.rules.collapseThroughSeparators || !this.separatedTop(box);
	}

	topMargins(box: Box): number[] {
		const own = this.px(box.margin[0], box);
		const first = box.children[0];
		return this.collapsesTop(box) && first ? [own, ...this.topMargins(first)] : [own];
	}

	/** Lays a box out below `cursor` with the margins still pending above it; returns its bottom border edge. */
	block(box: Box, cursor: number, pending: readonly number[], consumed: boolean): number {
		const top = consumed ? cursor : cursor + this.collapse([...pending, ...this.topMargins(box)]);
		const contentTop = top + box.border[0] + this.px(box.padding[0], box);
		const flexLike = box.display === 'flex' && !this.rules.collapseThroughSeparators;
		let contentBottom = contentTop;
		if (flexLike) {
			for (const child of box.children) {
				const childTop = contentTop + this.px(child.margin[0], child);
				const bottom = this.block(child, childTop, [], true);
				contentBottom = Math.max(contentBottom, bottom + this.px(child.margin[2], child));
			}
		} else {
			let c = contentTop;
			let pend: number[] = [];
			box.children.forEach((child, i) => {
				const merged = i === 0 && this.collapsesTop(box);
				c = this.block(child, c, merged ? [] : pend, merged);
				pend = [this.px(child.margin[2], child)];
			});
			const bfc = box.display !== 'block';
			const separatedBottom = this.px(box.padding[2], box) > 0 || box.border[2] > 0;
			contentBottom =
				bfc && !this.rules.bfcHeightExcludesMargins
					? c + this.collapse(pend)
					: separatedBottom && !bfc
						? c + this.collapse(pend)
						: c;
		}
		const height = box.height ?? contentBottom - contentTop;
		const bottom = contentTop + height + this.px(box.padding[2], box) + box.border[2];
		const used = this.used.get(box.name);
		if (used) {
			used.top = top;
			used.outerHeight = bottom - top;
		}
		return bottom;
	}
}

function measure(p: Params, rules: Rules): number[] {
	const layout = new Layout(rules);
	const page: Box = {
		name: PAGE,
		tag: 'body',
		display: 'flow-root',
		sizing: 'content-box',
		width: p.page,
		height: null,
		margin: [0, 0, 0, 0],
		padding: [0, 0, 0, 0],
		border: [0, 0, 0, 0],
		children: p.boxes
	};
	layout.widths(page, p.page, p.page);
	layout.block(page, 0, [], true);
	return p.queries.map((query) => {
		const u = layout.used.get(query.box);
		if (!u) throw new Error(`no box ${query.box}`);
		switch (query.what) {
			case 'outer-width':
				return u.outerWidth;
			case 'content-width':
				return u.contentWidth;
			case 'top':
				return u.top;
			case 'outer-height':
				return u.outerHeight;
		}
	});
}

const show = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const NAMES = ['card', 'panel', 'note', 'promo', 'badge', 'tile', 'hint', 'menu', 'info', 'quote'];
const even = (rng: Rng, lo: number, hi: number, by = 2): number =>
	by * rng.int(Math.ceil(lo / by), Math.floor(hi / by));

function box(name: string, over: Partial<Box>): Box {
	return {
		name,
		tag: 'div',
		display: 'block',
		sizing: 'content-box',
		width: 'auto',
		height: null,
		margin: [0, 0, 0, 0],
		padding: [0, 0, 0, 0],
		border: [0, 0, 0, 0],
		children: [],
		...over
	};
}

function scenario(rng: Rng, classId: string): Params {
	const names = rng.sample(NAMES, 4) as [string, string, string, string];
	if (classId === 'box-sizing') {
		const kinds: Box['sizing'][] = ['content-box', 'border-box'];
		const sizings = rng.shuffle([...kinds, rng.pick(kinds)]);
		const boxes = names.slice(0, 3).map((name, i) => {
			const v = even(rng, 4, 24);
			const h = even(rng, 6, 32);
			const b = rng.int(1, 6);
			const m = even(rng, 4, 30);
			return box(name, {
				sizing: sizings[i],
				width: 10 * rng.int(12, 36),
				height: 10 * rng.int(4, 12),
				padding: [v, h, v, h],
				border: [b, b, b, b],
				margin: [10, m, 10, m]
			});
		});
		return {
			page: 960,
			boxes,
			queries: boxes.flatMap((b) => [
				{ box: b.name, what: 'outer-width' as const },
				{ box: b.name, what: 'content-width' as const }
			]),
			variant: null
		};
	}
	if (classId === 'auto-width') {
		const content = 100 * rng.int(4, 9);
		const P = even(rng, 8, 40);
		const B = rng.int(1, 8);
		const m = even(rng, 6, 40);
		const p = even(rng, 6, 30);
		const b = rng.int(1, 6);
		const inner = box(names[1], {
			margin: [0, m, 12, m],
			padding: [8, p, 8, p],
			border: [b, b, b, b],
			height: 40
		});
		const note = box(names[2], {
			width: { pct: rng.pick([25, 40, 50, 60, 75]) },
			padding: [8, { pct: rng.pick([2, 3, 4, 5, 10]) }, 8, { pct: rng.pick([2, 3, 4, 5, 10]) }],
			border: [2, 2, 2, 2],
			height: 40
		});
		const wrap = box(names[0], {
			width: content,
			padding: [10, P, 10, P],
			border: [B, B, B, B],
			children: rng.bool(0.5) ? [inner, note] : [note, inner]
		});
		return {
			page: 1000,
			boxes: [wrap],
			queries: [
				{ box: inner.name, what: 'outer-width' },
				{ box: inner.name, what: 'content-width' },
				{ box: note.name, what: 'outer-width' }
			],
			variant: null
		};
	}
	if (classId === 'sibling-collapse') {
		const margins = (): [number, number] => [even(rng, 4, 40), even(rng, 4, 40)];
		const kids = names.slice(1, 4).map((name) => {
			const [t, b] = margins();
			return box(name, { height: even(rng, 20, 120, 4), margin: [t, 0, b, 0] });
		});
		if (rng.bool(0.5)) {
			const k = rng.pick([1, 2]);
			const kid = kids[k] as Box;
			kid.margin = [-even(rng, 4, 24), 0, kid.margin[2], 0];
		}
		const list = box(names[0], { display: 'flow-root', children: kids });
		return {
			page: 800,
			boxes: [list],
			queries: [
				{ box: (kids[1] as Box).name, what: 'top' },
				{ box: (kids[2] as Box).name, what: 'top' },
				{ box: list.name, what: 'outer-height' }
			],
			variant: null
		};
	}
	// parent-child-collapse
	const variant = rng.pick(['none', 'none', 'padding', 'border', 'flow-root', 'flex']);
	const first = box(names[2], { height: even(rng, 20, 100, 4), margin: [even(rng, 8, 48), 0, 0, 0] });
	const parent = box(names[1], {
		margin: [even(rng, 4, 40), 0, 0, 0],
		display: variant === 'flow-root' ? 'flow-root' : variant === 'flex' ? 'flex' : 'block',
		padding: [variant === 'padding' ? even(rng, 4, 20) : 0, 0, 0, 0],
		border: [variant === 'border' ? rng.int(1, 6) : 0, 0, 0, 0],
		children: [first]
	});
	const header = box(names[0], { height: even(rng, 40, 120, 4), margin: [0, 0, even(rng, 4, 40), 0] });
	return {
		page: 800,
		boxes: [header, parent],
		queries: [
			{ box: parent.name, what: 'top' },
			{ box: first.name, what: 'top' },
			{ box: parent.name, what: 'outer-height' }
		],
		variant
	};
}

const REQUIRED: Record<string, (p: Params) => string[]> = {
	'box-sizing': () => ['border-box-ignored', 'border-box-excludes-border', 'margin-counted'],
	'auto-width': () => ['auto-as-100-percent', 'percent-of-border-box', 'margin-not-subtracted'],
	'sibling-collapse': () => ['margins-add', 'bfc-height-excludes-margins'],
	'parent-child-collapse': (p) => [
		'margins-add',
		p.variant === 'none' ? 'parent-child-no-collapse' : 'collapse-through-separators'
	]
};

interface Scenario {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function evaluate(p: Params, classId: string): Scenario | null {
	const right = measure(p, RIGHT);
	if (right.some((x) => !Number.isInteger(x) || x < 0)) return null;
	const answer = right.map(show).join(' ');
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = measure(p, { ...RIGHT, ...change })
				.map(show)
				.join(' ');
			return [id, value === answer ? null : value];
		})
	);
	const required = REQUIRED[classId]?.(p) ?? [];
	if (required.some((id) => wrong[id] === null)) return null;
	return { p, answer, wrong };
}

/** A fixed tree for a seed whose random draws keep failing: hand-checked, it exposes the class's misconceptions. */
function fallback(classId: string): Params {
	if (classId === 'box-sizing') {
		const boxes = [
			box('card', {
				sizing: 'content-box',
				width: 200,
				height: 60,
				padding: [10, 12, 10, 12],
				border: [3, 3, 3, 3],
				margin: [10, 8, 10, 8]
			}),
			box('panel', {
				sizing: 'border-box',
				width: 240,
				height: 60,
				padding: [8, 20, 8, 20],
				border: [4, 4, 4, 4],
				margin: [10, 16, 10, 16]
			}),
			box('tile', {
				sizing: 'border-box',
				width: 180,
				height: 60,
				padding: [6, 10, 6, 10],
				border: [2, 2, 2, 2],
				margin: [10, 6, 10, 6]
			})
		];
		return {
			page: 960,
			boxes,
			queries: boxes.flatMap((b) => [
				{ box: b.name, what: 'outer-width' as const },
				{ box: b.name, what: 'content-width' as const }
			]),
			variant: null
		};
	}
	if (classId === 'auto-width') {
		const inner = box('panel', { margin: [0, 20, 12, 20], padding: [8, 16, 8, 16], border: [2, 2, 2, 2], height: 40 });
		const note = box('note', {
			width: { pct: 50 },
			padding: [8, { pct: 5 }, 8, { pct: 5 }],
			border: [2, 2, 2, 2],
			height: 40
		});
		const wrap = box('card', { width: 600, padding: [10, 24, 10, 24], border: [3, 3, 3, 3], children: [inner, note] });
		return {
			page: 1000,
			boxes: [wrap],
			queries: [
				{ box: 'panel', what: 'outer-width' },
				{ box: 'panel', what: 'content-width' },
				{ box: 'note', what: 'outer-width' }
			],
			variant: null
		};
	}
	if (classId === 'sibling-collapse') {
		const kids = [
			box('panel', { height: 40, margin: [16, 0, 24, 0] }),
			box('note', { height: 60, margin: [12, 0, 20, 0] }),
			box('tile', { height: 32, margin: [-8, 0, 10, 0] })
		];
		return {
			page: 800,
			boxes: [box('card', { display: 'flow-root', children: kids })],
			queries: [
				{ box: 'note', what: 'top' },
				{ box: 'tile', what: 'top' },
				{ box: 'card', what: 'outer-height' }
			],
			variant: null
		};
	}
	const first = box('note', { height: 40, margin: [30, 0, 0, 0] });
	return {
		page: 800,
		boxes: [
			box('card', { height: 60, margin: [0, 0, 20, 0] }),
			box('panel', { margin: [10, 0, 0, 0], children: [first] })
		],
		queries: [
			{ box: 'panel', what: 'top' },
			{ box: 'note', what: 'top' },
			{ box: 'panel', what: 'outer-height' }
		],
		variant: 'none'
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

const lenText = (v: Len): string => (typeof v === 'number' ? (v === 0 ? '0' : `${v}px`) : `${v.pct}%`);

function sides(values: readonly Len[]): string {
	const [t, r, b, l] = values.map(lenText) as [string, string, string, string];
	if (t === b && r === l) return t === r ? t : `${t} ${r}`;
	return `${t} ${r} ${b} ${l}`;
}

function css(b: Box): string {
	const out: string[] = [];
	if (b.display !== 'block') out.push(`display: ${b.display}`);
	if (b.sizing !== 'content-box' || b.width !== 'auto') out.push(`box-sizing: ${b.sizing}`);
	if (b.width !== 'auto') out.push(`width: ${lenText(b.width)}`);
	if (b.height !== null) out.push(`height: ${b.height}px`);
	if (b.margin.some((m) => m !== 0)) out.push(`margin: ${sides(b.margin)}`);
	if (b.padding.some((m) => m !== 0)) out.push(`padding: ${sides(b.padding)}`);
	const [bt, br, bb, bl] = b.border;
	if (bt === br && br === bb && bb === bl && bt > 0) out.push(`border: ${bt}px solid #333`);
	else if (bt > 0 && br === 0 && bb === 0 && bl === 0) out.push(`border-top: ${bt}px solid #333`);
	else if (b.border.some((x) => x > 0)) throw new Error('unsupported border');
	return `.${b.name} { ${out.join('; ')}; }`;
}

function all(boxes: readonly Box[]): Box[] {
	return boxes.flatMap((b) => [b, ...all(b.children)]);
}

function markup(boxes: readonly Box[], depth = 0): string[] {
	return boxes.flatMap((b) =>
		b.children.length
			? [
					`${'  '.repeat(depth)}<div class="${b.name}">`,
					...markup(b.children, depth + 1),
					`${'  '.repeat(depth)}</div>`
				]
			: [`${'  '.repeat(depth)}<div class="${b.name}"></div>`]
	);
}

const WHAT: Record<Quantity, (name: string) => string> = {
	'outer-width': (n) => `ширина \`.${n}\` по внешним краям рамки (border)`,
	'content-width': (n) => `ширина области содержимого \`.${n}\``,
	top: (n) => `расстояние от верха страницы до верхнего внешнего края рамки \`.${n}\``,
	'outer-height': (n) => `высота \`.${n}\` по внешним краям рамки (border)`
};

function describe(p: Params): string {
	const boxes = all(p.boxes);
	return [
		'Стили и разметка:',
		'',
		'```css',
		'body { margin: 0; }',
		...boxes.map(css),
		'```',
		'',
		'```html',
		'<body>',
		...markup(p.boxes, 1),
		'</body>',
		'```',
		'',
		`Считаем: ширина окна — ${p.page}px, полос прокрутки нет, у \`body\` и \`html\` нет отступов, рамок и полей; других стилей нет, у элементов нет содержимого, все элементы — блочные в обычном потоке, если \`display\` не задан иначе.`,
		'',
		'Найдите по порядку:',
		'',
		...p.queries.map((query, i) => `${i + 1}. ${WHAT[query.what](query.box)}.`),
		'',
		`Введите ${p.queries.length} числа в пикселях через пробел, целыми, без «px», например: \`${p.queries.map((_, i) => 40 + 10 * i).join(' ')}\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import sys

data = json.loads(sys.stdin.read())
info = {}


def length(v, base):
    if isinstance(v, dict):
        return base * v["pct"] / 100
    return v


def size_widths(b, avail):
    m = [length(x, avail) for x in b["margin"]]
    p = [length(x, avail) for x in b["padding"]]
    bw = b["border"]
    frame = p[1] + p[3] + bw[1] + bw[3]
    if b["width"] == "auto":
        content = avail - m[1] - m[3] - frame
    elif b["sizing"] == "border-box":
        content = length(b["width"], avail) - frame
    else:
        content = length(b["width"], avail)
    info[b["name"]] = {"content": content, "outer": content + frame, "m": m, "p": p}
    for c in b["children"]:
        size_widths(c, content)


def collapsed(margins):
    return max([0] + [x for x in margins if x > 0]) + min([0] + [x for x in margins if x < 0])


def opens_top(b):
    # A parent whose top margin runs into its first child's: a plain block without top padding or border.
    return b["children"] and b["display"] == "block" and info[b["name"]]["p"][0] == 0 and b["border"][0] == 0


def chain(b):
    out = [info[b["name"]]["m"][0]]
    while opens_top(b):
        b = b["children"][0]
        out.append(info[b["name"]]["m"][0])
    return out


def place(b, y):
    """y is the top border edge of b; returns the bottom border edge."""
    i = info[b["name"]]
    i["top"] = y
    inner_top = y + b["border"][0] + i["p"][0]
    if b["display"] == "flex":
        bottom = inner_top
        for c in b["children"]:
            ci = info[c["name"]]
            end = place(c, inner_top + ci["m"][0])
            bottom = max(bottom, end + ci["m"][2])
        inner_bottom = bottom
    else:
        y_cur = inner_top
        trailing = []
        for k, c in enumerate(b["children"]):
            if k == 0 and opens_top(b):
                top = y_cur
            else:
                top = y_cur + collapsed(trailing + chain(c))
            y_cur = place(c, top)
            trailing = [info[c["name"]]["m"][2]]
        if b["display"] != "block" or i["p"][2] > 0 or b["border"][2] > 0:
            inner_bottom = y_cur + collapsed(trailing)
        else:
            inner_bottom = y_cur
    height = b["height"] if b["height"] is not None else inner_bottom - inner_top
    end = inner_top + height + i["p"][2] + b["border"][2]
    i["height"] = end - y
    return end


root = {
    "name": "(page)", "display": "flow-root", "sizing": "content-box", "width": data["page"], "height": None,
    "margin": [0, 0, 0, 0], "padding": [0, 0, 0, 0], "border": [0, 0, 0, 0], "children": data["boxes"],
}
size_widths(root, data["page"])
place(root, 0)
out = []
for q in data["queries"]:
    i = info[q["box"]]
    value = {"outer-width": i["outer"], "content-width": i["content"], "top": i["top"], "outer-height": i["height"]}[q["what"]]
    if value != int(value):
        raise ValueError("not an integer: " + str(value))
    out.append(str(int(value)))
print(" ".join(out))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	let chosen: Scenario | null = null;
	for (let tries = 0; tries < 300 && chosen === null; tries += 1)
		chosen = evaluate(scenario(rng, input.classId), input.classId);
	if (chosen === null) {
		const p = fallback(input.classId);
		chosen = evaluate(p, input.classId) ?? { p, answer: measure(p, RIGHT).map(show).join(' '), wrong: {} };
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
			stdin: JSON.stringify({ page: p.page, boxes: p.boxes, queries: p.queries })
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
