// Measuring a layout: the widths and positions of the children of a horizontal LinearLayout (weights, weightSum,
// wrap_content with a weight, GONE and INVISIBLE, padding and margins) and the sizes a chain of Compose modifiers gives
// (the order of padding, size and background; two sizes; a Row with spacedBy, weights and fillMaxWidth(fraction)).
// The model here uses closed formulas and a two-pass walk of the chain; the Python reference re-implements the
// measuring passes the documentation describes: LinearLayout's two passes with sequential shares, the recursive
// measurement of a modifier chain under constraints and Row's measure policy.
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

type Vis = 'visible' | 'invisible' | 'gone';

/** A child of the LinearLayout: a fixed width, 0dp with a weight, or wrap_content (its content `wrap` dp wide). */
interface Child {
	id: string;
	view: string;
	width: number | 'wrap';
	wrap: number;
	weight: number;
	ml: number;
	mr: number;
	vis: Vis;
}

interface Linear {
	kind: 'linear';
	width: number;
	padL: number;
	padR: number;
	weightSum: number | null;
	children: Child[];
	ask: 'width' | 'x';
}

type Op = { op: 'padding'; v: number } | { op: 'size'; v: number } | { op: 'background' };

/** A Box with a chain of modifiers around a content that fills the space; the parent allows up to `limit` dp. */
interface Chain {
	kind: 'chain';
	limit: number;
	ops: Op[];
}

/** Row(width, horizontal padding, spacedBy) { icon (fixed) ; title (weight) { progress (fillMaxWidth) } ; action (weight) }. */
interface RowScene {
	kind: 'row';
	width: number;
	pad: number;
	gap: number;
	icon: number;
	w1: number;
	w2: number;
	fraction: number;
}

type Scene = Linear | Chain | RowScene;

interface Rules {
	padding: boolean;
	margins: boolean;
	weightOfTotal: boolean;
	invisibleNoSpace: boolean;
	goneKeepsSpace: boolean;
	orderIrrelevant: boolean;
	backgroundWhole: boolean;
	weightSum: boolean;
	wrapCounts: boolean;
	fractionOfRow: boolean;
	spacing: boolean;
	lastSizeWins: boolean;
}

const RIGHT: Rules = {
	padding: true,
	margins: true,
	weightOfTotal: false,
	invisibleNoSpace: false,
	goneKeepsSpace: false,
	orderIrrelevant: false,
	backgroundWhole: false,
	weightSum: true,
	wrapCounts: true,
	fractionOfRow: false,
	spacing: true,
	lastSizeWins: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ignore-padding': { padding: false },
	'ignore-margins': { margins: false },
	'weight-of-total': { weightOfTotal: true },
	'invisible-no-space': { invisibleNoSpace: true },
	'gone-keeps-space': { goneKeepsSpace: true },
	'order-irrelevant': { orderIrrelevant: true },
	'background-whole': { backgroundWhole: true },
	'ignore-weight-sum': { weightSum: false },
	'wrap-ignored': { wrapCounts: false },
	'fraction-of-row': { fractionOfRow: true },
	'spacing-ignored': { spacing: false },
	'last-size-wins': { lastSizeWins: true }
};

const num = (x: number): string => (Number.isInteger(x) ? String(x) : String(Math.floor(x)));

function measureLinear(s: Linear, r: Rules): string {
	const takes = (c: Child): boolean =>
		c.vis === 'visible' || (c.vis === 'invisible' && !r.invisibleNoSpace) || (c.vis === 'gone' && r.goneKeepsSpace);
	const margin = (c: Child): number => (r.margins ? c.ml + c.mr : 0);
	const base = (c: Child): number => (c.width === 'wrap' ? (c.weight === 0 || r.wrapCounts ? c.wrap : 0) : c.width);
	const kids = s.children.filter(takes);
	const weights = kids.reduce((sum, c) => sum + c.weight, 0);
	const pads = r.padding ? s.padL + s.padR : 0;
	const used = kids.reduce((sum, c) => sum + margin(c) + (r.weightOfTotal ? 0 : base(c)), 0);
	const rest = s.width - pads - used;
	const divisor = r.weightSum && s.weightSum !== null ? s.weightSum : weights;
	const width = (c: Child): number => base(c) + (c.weight > 0 ? (rest * c.weight) / divisor : 0);
	if (s.ask === 'width') return s.children.map((c) => (takes(c) ? num(width(c)) : '-')).join(' ');
	let x = r.padding ? s.padL : 0;
	return s.children
		.map((c) => {
			if (!takes(c)) return '-';
			x += r.margins ? c.ml : 0;
			const at = x;
			x += width(c) + (r.margins ? c.mr : 0);
			return num(at);
		})
		.join(' ');
}

/** The chain walked twice: constraints going in from the outside, sizes coming back from the content. */
function measureChain(s: Chain, r: Rules): string {
	let ops = s.ops;
	if (r.lastSizeWins) {
		const last = ops.filter((o) => o.op === 'size').at(-1);
		ops = ops.filter((o) => o.op !== 'size' || o === last);
	}
	if (r.orderIrrelevant) {
		const first = ops.find((o) => o.op === 'size');
		ops = [
			...(first ? [first] : []),
			...ops.filter((o) => o.op === 'background'),
			...ops.filter((o) => o.op === 'padding')
		];
	}
	const incoming: { fixed: boolean; max: number }[] = [];
	let fixed = false;
	let max = s.limit;
	for (const o of ops) {
		incoming.push({ fixed, max });
		if (o.op === 'padding') max -= 2 * o.v;
		else if (o.op === 'size' && !fixed) {
			max = Math.min(o.v, max);
			fixed = true;
		}
	}
	const content = max;
	let size = content;
	let background = 0;
	for (let i = ops.length - 1; i >= 0; i -= 1) {
		const o = ops[i];
		const c = incoming[i];
		if (!o || !c) continue;
		if (o.op === 'padding') size = c.fixed ? c.max : Math.min(size + 2 * o.v, c.max);
		else if (o.op === 'size') size = c.fixed ? c.max : Math.min(o.v, c.max);
		else background = size;
	}
	return [size, r.backgroundWhole ? size : background, content].map(num).join(' ');
}

function measureRow(s: RowScene, r: Rules): string {
	const content = s.width - (r.padding ? 2 * s.pad : 0);
	const spacing = r.spacing ? 2 * s.gap : 0;
	const rest = content - spacing - (r.weightOfTotal ? 0 : s.icon);
	const title = (rest * s.w1) / (s.w1 + s.w2);
	const action = (rest * s.w2) / (s.w1 + s.w2);
	const progress = (r.fractionOfRow ? content : title) * s.fraction;
	return [s.icon, title, progress, action].map((x) => String(Math.round(x))).join(' ');
}

function measure(s: Scene, r: Rules): string {
	return s.kind === 'linear' ? measureLinear(s, r) : s.kind === 'chain' ? measureChain(s, r) : measureRow(s, r);
}

const PYTHON_REFERENCE = `import json
from fractions import Fraction

sc = json.loads(input())


def linear(s):
    # LinearLayout.measureHorizontal: the first pass measures what has a size of its own, the second hands out the
    # excess by weight, share by share.
    kids = [c for c in s["children"] if c["vis"] != "gone"]
    total = s["padL"] + s["padR"]
    weight_total = 0
    measured = {}
    for c in kids:
        weight_total += c["weight"]
        if c["width"] == 0 and c["weight"] > 0:
            total += c["ml"] + c["mr"]
        else:
            w = c["wrap"] if c["width"] == "wrap" else c["width"]
            measured[c["id"]] = w
            total += w + c["ml"] + c["mr"]
    excess = Fraction(s["width"] - total)
    weight_left = Fraction(s["weightSum"]) if s["weightSum"] else Fraction(weight_total)
    final = {}
    for c in kids:
        if c["weight"] > 0:
            share = int(c["weight"] * excess / weight_left)
            excess -= share
            weight_left -= c["weight"]
            final[c["id"]] = share if c["width"] == 0 else measured[c["id"]] + share
        else:
            final[c["id"]] = measured[c["id"]]
    if s["ask"] == "width":
        return [str(final[c["id"]]) if c["id"] in final else "-" for c in s["children"]]
    out = []
    x = s["padL"]
    for c in s["children"]:
        if c["id"] not in final:
            out.append("-")
            continue
        x += c["ml"]
        out.append(str(x))
        x += final[c["id"]] + c["mr"]
    return out


def chain(s):
    found = {}

    def measure(i, lo, hi):
        if i == len(s["ops"]):
            found["content"] = hi
            return hi
        op = s["ops"][i]
        if op["op"] == "padding":
            p = op["v"]
            inner = measure(i + 1, max(lo - 2 * p, 0), max(hi - 2 * p, 0))
            return min(max(inner + 2 * p, lo), hi)
        if op["op"] == "size":
            t = min(max(op["v"], lo), hi)
            measure(i + 1, t, t)
            return t
        inner = measure(i + 1, lo, hi)
        found["background"] = inner
        return inner

    total = measure(0, 0, s["limit"])
    return [str(total), str(found["background"]), str(found["content"])]


def row(s):
    inner_width = s["width"] - 2 * s["pad"]
    children = [("icon", s["icon"], 0), ("title", None, s["w1"]), ("action", None, s["w2"])]
    fixed = sum(w for _, w, weight in children if weight == 0)
    space = inner_width - fixed - s["gap"] * (len(children) - 1)
    unit = Fraction(space, s["w1"] + s["w2"])
    sizes = {}
    for name, w, weight in children:
        sizes[name] = w if weight == 0 else round(unit * weight)
    progress = round(Fraction(sizes["title"]) * Fraction(s["fraction"]).limit_denominator(100))
    return [str(sizes["icon"]), str(sizes["title"]), str(progress), str(sizes["action"])]


kind = sc["kind"]
print(" ".join(linear(sc) if kind == "linear" else chain(sc) if kind == "chain" else row(sc)))
`;

// --- Scenes -----------------------------------------------------------------------------------------------------

const WIDTHS = [320, 360, 400, 412];
const PADS = [8, 12, 16, 20, 24];
const MARGINS = [4, 6, 8, 12, 16];
const IDS: readonly (readonly [string, string])[] = [
	['icon', 'ImageView'],
	['title', 'TextView'],
	['subtitle', 'TextView'],
	['badge', 'TextView'],
	['price', 'TextView'],
	['action', 'Button'],
	['avatar', 'ImageView'],
	['counter', 'TextView']
];

interface Made {
	scene: Scene;
	required: string[];
}

function child(rng: Rng, id: readonly [string, string], width: number | 'wrap', weight: number): Child {
	return {
		id: id[0],
		view: id[1],
		width,
		wrap: width === 'wrap' ? rng.int(6, 18) * 4 : 0,
		weight,
		ml: 0,
		mr: 0,
		vis: 'visible'
	};
}

const fixedWidth = (rng: Rng): number => rng.int(6, 24) * 4;

function addMargins(rng: Rng, children: Child[], count: number): void {
	for (const c of rng.sample(children, count)) {
		if (rng.bool()) c.ml = rng.pick(MARGINS);
		else c.mr = rng.pick(MARGINS);
	}
}

function linearScene(
	rng: Rng,
	children: Child[],
	ask: 'width' | 'x',
	weightSum: number | null = null,
	padded = true
): Linear {
	return {
		kind: 'linear',
		width: rng.pick(WIDTHS),
		padL: padded ? rng.pick(PADS) : rng.pick([0, ...PADS]),
		padR: rng.pick([0, ...PADS]),
		weightSum,
		children,
		ask
	};
}

/** The excess the weights share in the right model, or null when it is not a positive multiple of the divisor. */
function fits(s: Linear): boolean {
	const kids = s.children.filter((c) => c.vis !== 'gone');
	const used = kids.reduce(
		(sum, c) => sum + c.ml + c.mr + (c.width === 'wrap' ? c.wrap : c.width === 0 && c.weight > 0 ? 0 : c.width),
		0
	);
	const rest = s.width - s.padL - s.padR - used;
	const divisor = s.weightSum ?? kids.reduce((sum, c) => sum + c.weight, 0);
	if (divisor === 0) return rest >= 0;
	return rest > 4 * divisor && rest % divisor === 0;
}

function internScene(rng: Rng, classId: string): Made | null {
	const ids = rng.sample(IDS, 5);
	const id = (i: number): readonly [string, string] => ids[i] ?? ['view', 'View'];
	if (classId === 'weights') {
		const n = rng.int(3, 4);
		const weighted = new Set(rng.sample([0, 1, 2, 3].slice(0, n), 2));
		const children = Array.from({ length: n }, (_, i) =>
			weighted.has(i) ? child(rng, id(i), 0, rng.int(1, 3)) : child(rng, id(i), fixedWidth(rng), 0)
		);
		addMargins(rng, children, rng.int(1, 2));
		const s = linearScene(rng, children, 'width');
		return fits(s) ? { scene: s, required: ['ignore-padding', 'ignore-margins', 'weight-of-total'] } : null;
	}
	if (classId === 'gone-invisible') {
		const n = rng.int(4, 5);
		const children = Array.from({ length: n }, (_, i) => child(rng, id(i), fixedWidth(rng), 0));
		const [gone, invisible] = rng.sample(
			Array.from({ length: n - 1 }, (_, i) => i),
			2
		);
		const g = children[gone ?? 0];
		const v = children[invisible ?? 1];
		if (g) g.vis = 'gone';
		if (v) v.vis = 'invisible';
		addMargins(rng, children, rng.int(1, 2));
		const s = linearScene(rng, children, 'x');
		return s.children.reduce(
			(sum, c) => sum + (c.width === 'wrap' ? c.wrap : c.width) + c.ml + c.mr,
			s.padL + s.padR
		) <= s.width
			? { scene: s, required: ['invisible-no-space', 'gone-keeps-space'] }
			: null;
	}
	if (classId === 'weight-sum') {
		const n = rng.int(2, 3);
		const children = Array.from({ length: n }, (_, i) =>
			i === n - 1 && n === 3 ? child(rng, id(i), fixedWidth(rng), 0) : child(rng, id(i), 0, rng.int(1, 3))
		);
		const order = rng.shuffle(children);
		const weights = order.reduce((sum, c) => sum + c.weight, 0);
		addMargins(rng, order, rng.int(0, 1));
		const s = linearScene(rng, order, 'width', weights + rng.int(1, 4), false);
		return fits(s) ? { scene: s, required: ['ignore-weight-sum'] } : null;
	}
	// modifier-order: one size, one background, one or two paddings in any order.
	const ops: Op[] = rng.shuffle<Op>([
		{ op: 'size', v: rng.int(8, 25) * 8 },
		{ op: 'background' },
		{ op: 'padding', v: rng.pick([4, 8, 12, 16, 20, 24]) },
		...(rng.bool() ? [{ op: 'padding' as const, v: rng.pick([6, 10, 14, 18]) }] : [])
	]);
	return chainScene(ops, ['order-irrelevant']);
}

function chainScene(ops: Op[], required: string[]): Made | null {
	const s: Chain = { kind: 'chain', limit: 360, ops };
	// The content must keep a positive size, and the parent's limit must not bind.
	const pads = ops.reduce((sum, o) => sum + (o.op === 'padding' ? 2 * o.v : 0), 0);
	const sizes = ops.filter((o) => o.op === 'size').map((o) => o.v);
	if (Math.max(...sizes) + pads >= s.limit) return null;
	const [, , content] = measureChain(s, RIGHT).split(' ').map(Number);
	return content !== undefined && content > 0 ? { scene: s, required } : null;
}

function juniorScene(rng: Rng, classId: string): Made | null {
	const ids = rng.sample(IDS, 5);
	const id = (i: number): readonly [string, string] => ids[i] ?? ['view', 'View'];
	if (classId === 'wrap-plus-weight') {
		const n = rng.int(3, 4);
		const kinds = rng.shuffle(['wrap', 'zero', 'fixed', ...(n === 4 ? [rng.pick(['wrap', 'zero', 'fixed'])] : [])]);
		const children = kinds.map((k, i) =>
			k === 'wrap'
				? child(rng, id(i), 'wrap', rng.int(1, 2))
				: k === 'zero'
					? child(rng, id(i), 0, rng.int(1, 3))
					: child(rng, id(i), fixedWidth(rng), 0)
		);
		addMargins(rng, children, rng.int(1, 2));
		const s = linearScene(rng, children, 'width');
		return fits(s) ? { scene: s, required: ['wrap-ignored', 'ignore-padding', 'ignore-margins'] } : null;
	}
	if (classId === 'gone-weights') {
		const n = rng.int(4, 5);
		const children = Array.from({ length: n }, (_, i) =>
			i < 3 ? child(rng, id(i), 0, rng.int(1, 3)) : child(rng, id(i), fixedWidth(rng), 0)
		);
		const g = children[0];
		const v = children[1];
		if (g) g.vis = 'gone';
		if (v) v.vis = 'invisible';
		const order = rng.shuffle(children);
		addMargins(rng, order, rng.int(1, 2));
		const s = linearScene(rng, order, 'width');
		return fits(s) ? { scene: s, required: ['invisible-no-space', 'gone-keeps-space'] } : null;
	}
	if (classId === 'compose-row') {
		const s: RowScene = {
			kind: 'row',
			width: rng.pick(WIDTHS),
			pad: rng.pick(PADS),
			gap: rng.pick([4, 6, 8, 12]),
			icon: rng.int(8, 16) * 4,
			w1: rng.int(1, 3),
			w2: rng.int(1, 3),
			fraction: rng.pick([0.25, 0.5, 0.75, 0.2, 0.4, 0.6, 0.8])
		};
		const rest = s.width - 2 * s.pad - 2 * s.gap - s.icon;
		if (rest % (s.w1 + s.w2) !== 0) return null;
		const title = (rest * s.w1) / (s.w1 + s.w2);
		if (!Number.isInteger(title * s.fraction)) return null;
		return { scene: s, required: ['fraction-of-row', 'spacing-ignored', 'ignore-padding'] };
	}
	// modifier-chain: two sizes, one background, one or two paddings.
	const ops: Op[] = rng.shuffle<Op>([
		{ op: 'size', v: rng.int(10, 25) * 8 },
		{ op: 'size', v: rng.int(5, 20) * 8 },
		{ op: 'background' },
		{ op: 'padding', v: rng.pick([4, 8, 12, 16, 20]) },
		...(rng.bool() ? [{ op: 'padding' as const, v: rng.pick([6, 10, 14, 18]) }] : [])
	]);
	return chainScene(ops, ['last-size-wins', 'order-irrelevant']);
}

// --- Statements ---------------------------------------------------------------------------------------------------

function linearXml(s: Linear): string {
	const attrs = (c: Child): string[] => {
		const width = c.width === 'wrap' ? 'wrap_content' : `${c.width}dp`;
		const a = [`android:id="@+id/${c.id}"`, `android:layout_width="${width}"`, 'android:layout_height="48dp"'];
		if (c.weight > 0) a.push(`android:layout_weight="${c.weight}"`);
		if (c.ml > 0) a.push(`android:layout_marginLeft="${c.ml}dp"`);
		if (c.mr > 0) a.push(`android:layout_marginRight="${c.mr}dp"`);
		if (c.vis !== 'visible') a.push(`android:visibility="${c.vis}"`);
		return a;
	};
	const root = [
		`android:layout_width="${s.width}dp"`,
		'android:layout_height="wrap_content"',
		'android:orientation="horizontal"'
	];
	if (s.padL > 0) root.push(`android:paddingLeft="${s.padL}dp"`);
	if (s.padR > 0) root.push(`android:paddingRight="${s.padR}dp"`);
	if (s.weightSum !== null) root.push(`android:weightSum="${s.weightSum}"`);
	/** Attribute lines of a tag, the last one closing it. */
	const tag = (indent: string, items: string[], close: string): string[] =>
		items.map((a, i) => `${indent}${a}${i === items.length - 1 ? close : ''}`);
	const lines = ['<LinearLayout', ...tag('    ', root, '>')];
	for (const c of s.children) lines.push('', `    <${c.view}`, ...tag('        ', attrs(c), ' />'));
	lines.push('', '</LinearLayout>');
	return lines.join('\n');
}

function linearStatement(s: Linear): string {
	const wraps = s.children.filter((c) => c.width === 'wrap');
	const order = s.children.map((c) => `\`${c.id}\``).join(', ');
	const ask =
		s.ask === 'width'
			? `Какой ширины (dp) окажется каждый ребёнок после измерения? Введите ширины через пробел в порядке разметки: ${order}; для ребёнка, который не участвует в разметке, введите \`-\`.`
			: `Какая левая координата x (dp, от левого края LinearLayout) окажется у каждого ребёнка? Введите координаты через пробел в порядке разметки: ${order}; для ребёнка, который не участвует в разметке, введите \`-\`.`;
	return [
		'По модели измерения View-системы Android (не на устройстве). Направление — слева направо; размеры в dp, все деления в правильном ответе нацело.',
		'',
		'```xml',
		linearXml(s),
		'```',
		'',
		...(wraps.length > 0
			? [`Содержимое при \`wrap_content\` занимает: ${wraps.map((c) => `\`${c.id}\` — ${c.wrap} dp`).join(', ')}.`, '']
			: []),
		ask
	].join('\n');
}

function chainCode(s: Chain): string {
	const mod = (o: Op): string =>
		o.op === 'padding' ? `.padding(${o.v}.dp)` : o.op === 'size' ? `.size(${o.v}.dp)` : '.background(Color.LightGray)';
	return [
		'Box(',
		'    Modifier',
		...s.ops.map((o) => `        ${mod(o)}`),
		') {',
		'    Box(Modifier.fillMaxSize())',
		'}'
	].join('\n');
}

function chainStatement(s: Chain): string {
	return [
		'По модели измерения Jetpack Compose (не на устройстве): модификаторы применяются по цепочке слева направо, ограничения идут снаружи внутрь.',
		'',
		`Элемент из кода ниже лежит в родителе, который разрешает ему любой размер от 0 до ${s.limit} dp по каждой стороне. Все размеры — квадраты, в dp.`,
		'',
		'Введите три числа через пробел: сторону места, которое элемент займёт в родителе; сторону закрашенного фона; сторону внутреннего `Box(Modifier.fillMaxSize())`.'
	].join('\n');
}

function rowCode(s: RowScene): string {
	const tagged = (code: string, tag: string): string => `${code.padEnd(42)}// ${tag}`;
	return [
		'Row(',
		`    Modifier.width(${s.width}.dp).padding(horizontal = ${s.pad}.dp),`,
		`    horizontalArrangement = Arrangement.spacedBy(${s.gap}.dp)`,
		') {',
		tagged(`    Box(Modifier.width(${s.icon}.dp))`, 'icon'),
		tagged(`    Box(Modifier.weight(${s.w1}f)) {`, 'title'),
		tagged(`        Box(Modifier.fillMaxWidth(${s.fraction}f))`, 'progress'),
		'    }',
		tagged(`    Box(Modifier.weight(${s.w2}f))`, 'action'),
		'}'
	].join('\n');
}

function rowStatement(): string {
	return [
		'По модели измерения Jetpack Compose (не на устройстве). Размеры в dp, все деления в правильном ответе нацело.',
		'',
		'Введите ширины четырёх элементов через пробел в порядке: `icon`, `title`, `progress`, `action`.'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenes are drawn until the numbers divide and every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const made = input.grade === 'intern' ? internScene(rng, input.classId) : juniorScene(rng, input.classId);
		if (!made) continue;
		const answer = measure(made.scene, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = measure(made.scene, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (made.required.some((id) => wrong[id] === null)) continue;
		const s = made.scene;
		const statement =
			s.kind === 'linear'
				? { markdown: linearStatement(s), code: null }
				: s.kind === 'chain'
					? { markdown: chainStatement(s), code: { language: 'kotlin', source: chainCode(s) } }
					: { markdown: rowStatement(), code: { language: 'kotlin', source: rowCode(s) } };
		const instance = makeInstance(descriptor, input, { statement, answer: { kind: 'tokens', value: answer } });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scene for ${input.grade}/${input.classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
