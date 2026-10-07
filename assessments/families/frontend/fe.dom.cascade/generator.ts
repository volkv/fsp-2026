// The cascade of author styles (CSS Cascade 5) for a small tree: which declaration wins for an element and a property —
// importance, the style attribute, cascade layers (in the order they are first named, reversed for !important),
// specificity, order of appearance — and what happens without a winner: an inherited property takes the parent's value,
// another one its initial value; `inherit`, `initial` and `unset` a level up. The generator models the cascade on its
// tree; the reference parses the shown HTML and CSS itself and runs its own cascade.
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

type Prop = 'color' | 'background-color' | 'font-weight';
const PROPS: readonly Prop[] = ['color', 'background-color', 'font-weight'];
const INHERITED: Record<Prop, boolean> = { color: true, 'background-color': false, 'font-weight': true };
const INITIAL: Record<Prop, string> = { color: 'black', 'background-color': 'transparent', 'font-weight': '400' };
/** What the root of the tree inherits from `body`. */
const BODY: Record<Prop, string> = { color: 'black', 'background-color': 'transparent', 'font-weight': '400' };

interface Decl {
	prop: Prop;
	value: string;
	important: boolean;
}

interface El {
	tag: string;
	id: string | null;
	classes: string[];
	inline: Decl[];
	children: El[];
}

interface Compound {
	tag: string | null;
	id: string | null;
	classes: string[];
}

interface Sel {
	compounds: Compound[];
	/** Between compounds: ' ' (descendant) or '>' (child). */
	combinators: string[];
}

interface Rule {
	sel: Sel;
	decls: Decl[];
	/** The layer of the rule, or `null` — unlayered. */
	layer: string | null;
}

interface Params {
	/** The tree is a chain: each element holds the next one. */
	chain: El[];
	/** Layer names in the `@layer a, b;` statement, or `null` — no statement. */
	statement: string[] | null;
	/** Rules in the order of the style sheet. */
	rules: Rule[];
	queries: { el: number; prop: Prop }[];
}

interface Rules {
	specificityIgnored: boolean;
	inlineBeatsImportant: boolean;
	importantIgnored: boolean;
	backgroundInherits: boolean;
	ancestorCompetes: boolean;
	importantInherits: boolean;
	unsetAsInitial: boolean;
	unsetAsInherit: boolean;
	initialAsParent: boolean;
	layersIgnored: boolean;
	unlayeredLowest: boolean;
	layerOrderByBlock: boolean;
	importantNoInversion: boolean;
}

const RIGHT: Rules = {
	specificityIgnored: false,
	inlineBeatsImportant: false,
	importantIgnored: false,
	backgroundInherits: false,
	ancestorCompetes: false,
	importantInherits: false,
	unsetAsInitial: false,
	unsetAsInherit: false,
	initialAsParent: false,
	layersIgnored: false,
	unlayeredLowest: false,
	layerOrderByBlock: false,
	importantNoInversion: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'specificity-ignored': { specificityIgnored: true },
	'inline-beats-important': { inlineBeatsImportant: true },
	'important-ignored': { importantIgnored: true },
	'background-inherits': { backgroundInherits: true },
	'ancestor-rule-competes': { ancestorCompetes: true },
	'important-inherits': { importantInherits: true },
	'unset-as-initial': { unsetAsInitial: true },
	'unset-as-inherit': { unsetAsInherit: true },
	'initial-as-parent': { initialAsParent: true },
	'layers-ignored': { layersIgnored: true },
	'unlayered-lowest': { unlayeredLowest: true },
	'layer-order-by-block': { layerOrderByBlock: true },
	'important-no-inversion': { importantNoInversion: true }
};

// ---------------------------------------------------------------------------------------------------------------
// Matching and the cascade.

function matchesCompound(c: Compound, el: El): boolean {
	return (
		(c.tag === null || c.tag === el.tag) &&
		(c.id === null || c.id === el.id) &&
		c.classes.every((k) => el.classes.includes(k))
	);
}

/** Whether a selector matches the element at `index` of the chain (its ancestors are the elements before it). */
function matches(sel: Sel, chain: readonly El[], index: number): boolean {
	const go = (ci: number, ei: number): boolean => {
		const el = chain[ei];
		const c = sel.compounds[ci];
		if (!el || !c || !matchesCompound(c, el)) return false;
		if (ci === 0) return true;
		if (sel.combinators[ci - 1] === '>') return go(ci - 1, ei - 1);
		for (let up = ei - 1; up >= 0; up -= 1) if (go(ci - 1, up)) return true;
		return false;
	};
	return go(sel.compounds.length - 1, index);
}

const specificity = (sel: Sel): number =>
	sel.compounds.reduce((s, c) => s + (c.id ? 10_000 : 0) + c.classes.length * 100 + (c.tag ? 1 : 0), 0);

/** Layer names in the order the cascade ranks them. */
function layerOrder(p: Params, byBlock: boolean): string[] {
	const out: string[] = [];
	if (!byBlock) for (const name of p.statement ?? []) if (!out.includes(name)) out.push(name);
	for (const r of p.rules) if (r.layer !== null && !out.includes(r.layer)) out.push(r.layer);
	return out;
}

interface Candidate {
	key: number[];
	value: string;
	important: boolean;
}

function candidates(p: Params, index: number, prop: Prop, rules: Rules): Candidate[] {
	const layers = layerOrder(p, rules.layerOrderByBlock);
	const n = layers.length;
	const out: Candidate[] = [];
	const rank = (layer: string | null, important: boolean): number => {
		const i = layer === null || rules.layersIgnored ? -1 : layers.indexOf(layer);
		if (!important || rules.importantNoInversion) {
			if (i === -1) return rules.unlayeredLowest ? -1 : n;
			return i;
		}
		return i === -1 ? 0 : n - i;
	};
	p.rules.forEach((r, order) => {
		if (!matches(r.sel, p.chain, index)) return;
		for (const d of r.decls) {
			if (d.prop !== prop) continue;
			const important = d.important && !rules.importantIgnored;
			out.push({
				key: [important ? 1 : 0, rank(r.layer, important), rules.specificityIgnored ? 0 : specificity(r.sel), order],
				value: d.value,
				important
			});
		}
	});
	for (const d of p.chain[index]?.inline ?? []) {
		if (d.prop !== prop) continue;
		const important = (d.important && !rules.importantIgnored) || rules.inlineBeatsImportant;
		out.push({ key: [important ? 1 : 0, n + 2, 0, p.rules.length], value: d.value, important });
	}
	return out;
}

const compareKeys = (a: readonly number[], b: readonly number[]): number => {
	for (let i = 0; i < a.length; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
	return 0;
};

const best = (cs: readonly Candidate[]): Candidate | null =>
	cs.reduce<Candidate | null>((top, c) => (top === null || compareKeys(c.key, top.key) > 0 ? c : top), null);

interface Computed {
	value: string;
	/** The value came from an !important declaration, here or (under a misconception) up the tree. */
	important: boolean;
}

function computeAll(p: Params, rules: Rules): Map<string, Computed> {
	const out = new Map<string, Computed>();
	const inherited = (prop: Prop): boolean =>
		INHERITED[prop] || (prop === 'background-color' && rules.backgroundInherits);
	p.chain.forEach((_, index) => {
		for (const prop of PROPS) {
			const parent: Computed =
				index === 0 ? { value: BODY[prop], important: false } : (out.get(`${index - 1}|${prop}`) as Computed);
			let winner = best(candidates(p, index, prop, rules));
			if (rules.ancestorCompetes && INHERITED[prop]) {
				for (let up = 0; up < index; up += 1) {
					const theirs = best(candidates(p, up, prop, rules));
					if (theirs && (winner === null || compareKeys(theirs.key, winner.key) > 0)) winner = theirs;
				}
			}
			let result: Computed;
			if (winner === null) result = inherited(prop) ? parent : { value: INITIAL[prop], important: false };
			else if (rules.importantInherits && INHERITED[prop] && parent.important && !winner.important) result = parent;
			else {
				let v = winner.value;
				if (v === 'unset')
					v = rules.unsetAsInitial
						? 'initial'
						: rules.unsetAsInherit
							? 'inherit'
							: inherited(prop)
								? 'inherit'
								: 'initial';
				if (v === 'initial' && rules.initialAsParent) v = 'inherit';
				result =
					v === 'inherit'
						? { value: parent.value, important: winner.important }
						: v === 'initial'
							? { value: INITIAL[prop], important: winner.important }
							: { value: v, important: winner.important };
			}
			out.set(`${index}|${prop}`, result);
		}
	});
	return out;
}

function answerOf(p: Params, rules: Rules): string {
	const all = computeAll(p, rules);
	return p.queries.map((q) => (all.get(`${q.el}|${q.prop}`) as Computed).value).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const UPPER_TAGS = ['div', 'section', 'article', 'main', 'aside', 'nav'];
const LOWER_TAGS = ['span', 'em', 'small'];
const IDS = ['promo', 'card', 'intro', 'news', 'offer', 'about', 'hero', 'faq'];
const CLASSES = ['box', 'note', 'text', 'accent', 'muted', 'wide', 'dark', 'hl', 'lead', 'tag', 'warn', 'info'];
const COLORS = [
	'red',
	'green',
	'blue',
	'navy',
	'teal',
	'olive',
	'maroon',
	'purple',
	'orange',
	'gray',
	'crimson',
	'coral'
];
const BACKGROUNDS = ['white', 'yellow', 'pink', 'linen', 'beige', 'ivory', 'khaki', 'lavender', 'azure', 'wheat'];
const WEIGHTS = ['300', '500', '600', '700', '800', '900'];
const LAYERS = ['base', 'theme', 'components', 'reset', 'utilities', 'vendor'];

interface Config {
	depth: number;
	rules: [number, number];
	inline: boolean;
	important: number;
	keywords: number;
	layers: boolean;
	statement: boolean;
	queries: number;
}

const CONFIG: Record<string, Config> = {
	'intern/specificity-order': {
		depth: 3,
		rules: [6, 7],
		inline: false,
		important: 0,
		keywords: 0,
		layers: false,
		statement: false,
		queries: 3
	},
	'intern/important-inline': {
		depth: 3,
		rules: [5, 6],
		inline: true,
		important: 2,
		keywords: 0,
		layers: false,
		statement: false,
		queries: 3
	},
	'intern/inheritance': {
		depth: 3,
		rules: [5, 6],
		inline: false,
		important: 0,
		keywords: 0,
		layers: false,
		statement: false,
		queries: 4
	},
	'intern/important-inherits': {
		depth: 3,
		rules: [5, 6],
		inline: false,
		important: 2,
		keywords: 0,
		layers: false,
		statement: false,
		queries: 3
	},
	'junior/keywords': {
		depth: 3,
		rules: [3, 4],
		inline: false,
		important: 0,
		keywords: 0,
		layers: false,
		statement: false,
		queries: 4
	},
	'junior/layers': {
		depth: 3,
		rules: [6, 8],
		inline: false,
		important: 0,
		keywords: 0,
		layers: true,
		statement: true,
		queries: 4
	},
	'junior/layers-important': {
		depth: 3,
		rules: [6, 8],
		inline: true,
		important: 3,
		keywords: 0,
		layers: true,
		statement: false,
		queries: 4
	},
	'junior/layers-keywords': {
		depth: 4,
		rules: [7, 8],
		inline: false,
		important: 1,
		keywords: 2,
		layers: true,
		statement: true,
		queries: 4
	}
};

function chainOf(rng: Rng, depth: number): El[] {
	const upper = rng.sample(UPPER_TAGS, depth - 2);
	const tags = [...upper, 'p', rng.pick(LOWER_TAGS)];
	const ids = rng.sample(IDS, depth);
	const classes = rng.shuffle(CLASSES);
	return tags.map((tag, i) => ({
		tag,
		id: i < depth - 1 && rng.bool(0.6) ? (ids[i] as string) : null,
		classes: classes.slice(2 * i, 2 * i + rng.int(1, 2)),
		inline: [],
		children: []
	}));
}

/** A selector that matches element `i` of the chain: its own compound, sometimes after an ancestor's. */
function selectorFor(rng: Rng, chain: readonly El[], i: number): Sel {
	const el = chain[i] as El;
	const own = (e: El, rich: boolean): Compound => {
		const parts: Compound = { tag: null, id: null, classes: [] };
		const options = ['tag', ...(e.id ? ['id'] : []), ...e.classes.map((c) => `.${c}`)];
		const chosen = rng.sample(options, rng.int(1, Math.min(rich ? 3 : 2, options.length)));
		for (const o of chosen) {
			if (o === 'tag') parts.tag = e.tag;
			else if (o === 'id') parts.id = e.id;
			else parts.classes.push(o.slice(1));
		}
		return parts;
	};
	if (i > 0 && rng.bool(0.5)) {
		const up = rng.int(0, i - 1);
		const combinator = up === i - 1 && rng.bool(0.5) ? '>' : ' ';
		return { compounds: [own(chain[up] as El, false), own(el, false)], combinators: [combinator] };
	}
	return { compounds: [own(el, true)], combinators: [] };
}

/** A selector that looks related but matches no element: a wrong class, or a reversed relation. */
function decoy(rng: Rng, chain: readonly El[]): Sel {
	const i = rng.int(0, chain.length - 1);
	const el = chain[i] as El;
	const stranger = CLASSES.find((c) => !chain.some((e) => e.classes.includes(c))) ?? 'zz';
	if (i < chain.length - 1 && rng.bool(0.5)) {
		const below = chain[rng.int(i + 1, chain.length - 1)] as El;
		return {
			compounds: [
				{ tag: below.tag, id: null, classes: [] },
				{ tag: el.tag, id: null, classes: [] }
			],
			combinators: [' ']
		};
	}
	return { compounds: [{ tag: el.tag, id: null, classes: [stranger] }], combinators: [] };
}

function valueFor(rng: Rng, prop: Prop): string {
	if (prop === 'color') return rng.pick(COLORS);
	if (prop === 'background-color') return rng.pick(BACKGROUNDS);
	return rng.pick(WEIGHTS);
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const cfg = CONFIG[`${grade}/${classId}`] as Config;
	const chain = chainOf(rng, cfg.depth);
	const count = rng.int(...cfg.rules);
	const layerNames = cfg.layers ? rng.sample(LAYERS, 2) : [];
	const rules: Rule[] = Array.from({ length: count }, (_, k) => {
		const target =
			classId === 'inheritance' || classId === 'important-inherits'
				? rng.pick([0, 0, 1, 1, 2])
				: rng.int(0, chain.length - 1);
		const sel = k === count - 1 && rng.bool(0.5) ? decoy(rng, chain) : selectorFor(rng, chain, target);
		const props = rng.sample(PROPS, rng.int(1, 2));
		const decls = props.map((prop) => ({ prop, value: valueFor(rng, prop), important: false }));
		const layer = cfg.layers && rng.bool(0.65) ? rng.pick(layerNames) : null;
		return { sel, decls, layer };
	});
	const allDecls = rules.flatMap((r) => r.decls);
	for (const d of rng.sample(allDecls, Math.min(cfg.important, allDecls.length))) d.important = true;
	for (const d of rng.sample(allDecls, Math.min(cfg.keywords, allDecls.length))) {
		const options = d.prop === 'color' ? ['inherit', 'unset'] : ['inherit', 'initial', 'unset'];
		d.value = rng.pick(options);
		d.important = false;
	}
	if (cfg.inline) {
		const el = chain[rng.int(1, chain.length - 1)] as El;
		const prop = rng.pick(PROPS);
		el.inline = [{ prop, value: valueFor(rng, prop), important: rng.bool(0.25) }];
	}
	let statement: string[] | null = null;
	if (cfg.layers && cfg.statement) {
		statement = rng.shuffle(layerNames);
	}
	const pairs = chain.flatMap((_, el) => PROPS.map((prop) => ({ el, prop })));
	if (classId === 'keywords') {
		// The keywords meet values that differ from the initial ones: the top element sets all three properties, and
		// each keyword sits on a lower element, where the item asks for it.
		rules.unshift({
			sel: selectorFor(rng, chain, 0),
			decls: PROPS.map((prop) => ({ prop, value: valueFor(rng, prop), important: false })),
			layer: null
		});
		const targets: { el: number; prop: Prop; value: string }[] = [
			{ el: rng.int(1, 2), prop: rng.pick(['color', 'font-weight'] as const), value: 'unset' },
			{ el: rng.int(1, 2), prop: 'background-color', value: rng.pick(['unset', 'initial']) },
			{
				el: rng.int(1, 2),
				prop: rng.pick(['background-color', 'font-weight'] as const),
				value: rng.pick(['initial', 'inherit'])
			}
		];
		for (const t of targets) {
			const at = rng.int(1, rules.length);
			rules.splice(at, 0, {
				sel: selectorFor(rng, chain, t.el),
				decls: [{ prop: t.prop, value: t.value, important: false }],
				layer: null
			});
		}
		const asked = targets.map((t) => ({ el: t.el, prop: t.prop }));
		const unique = asked.filter((a, i) => asked.findIndex((b) => b.el === a.el && b.prop === a.prop) === i);
		const rest = rng.shuffle(pairs.filter((x) => !unique.some((u) => u.el === x.el && u.prop === x.prop)));
		return { chain, statement, rules, queries: rng.shuffle([...unique, ...rest].slice(0, cfg.queries)) };
	}
	return { chain, statement, rules, queries: rng.sample(pairs, cfg.queries) };
}

const REQUIRED: Record<string, string[]> = {
	'intern/specificity-order': ['specificity-ignored'],
	'intern/important-inline': ['inline-beats-important', 'important-ignored'],
	'intern/inheritance': ['background-inherits', 'ancestor-rule-competes'],
	'intern/important-inherits': ['important-inherits'],
	'junior/keywords': ['unset-as-initial', 'unset-as-inherit', 'initial-as-parent'],
	'junior/layers': ['layers-ignored', 'unlayered-lowest', 'layer-order-by-block'],
	'junior/layers-important': ['important-no-inversion', 'layers-ignored'],
	'junior/layers-keywords': ['layers-ignored', 'unset-as-initial']
};

interface Scenario {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

/** Selectors of one style sheet read naturally: no two rules share a selector text. */
function acceptable(p: Params): boolean {
	const texts = p.rules.map((r) => selectorText(r.sel));
	if (new Set(texts).size !== texts.length) return false;
	// A layered item shows layers in a different order than their blocks appear, when it has a statement.
	if (p.statement) {
		const byBlock = layerOrder(p, true);
		if (byBlock.length < 2 || byBlock.join() === p.statement.join()) return false;
	}
	return true;
}

function evaluate(p: Params, required: readonly string[]): Scenario | null {
	if (!acceptable(p)) return null;
	const answer = answerOf(p, RIGHT);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = answerOf(p, { ...RIGHT, ...change });
			return [id, value === answer ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { p, answer, wrong };
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

function compoundText(c: Compound): string {
	return `${c.tag ?? ''}${c.id ? `#${c.id}` : ''}${c.classes.map((k) => `.${k}`).join('')}`;
}

function selectorText(sel: Sel): string {
	return sel.compounds
		.map((c, i) => (i === 0 ? compoundText(c) : `${sel.combinators[i - 1] === '>' ? ' > ' : ' '}${compoundText(c)}`))
		.join('');
}

const declText = (d: Decl): string => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`;

function css(p: Params): string {
	const lines: string[] = [];
	if (p.statement) lines.push(`@layer ${p.statement.join(', ')};`, '');
	let open: string | null = null;
	for (const r of p.rules) {
		if (r.layer !== open) {
			if (open !== null) lines.push('}');
			if (r.layer !== null) lines.push(`@layer ${r.layer} {`);
			open = r.layer;
		}
		const pad = r.layer === null ? '' : '  ';
		lines.push(`${pad}${selectorText(r.sel)} { ${r.decls.map(declText).join('; ')}; }`);
	}
	if (open !== null) lines.push('}');
	return lines.join('\n');
}

const TEXTS = ['Скидки недели', 'Новый тариф', 'Свежие новости', 'Отзывы', 'Наши партнёры', 'Контакты'];

function html(p: Params, rng: Rng): string {
	const lines: string[] = [];
	const word = rng.pick(TEXTS);
	p.chain.forEach((el, i) => {
		const attrs = [
			...(el.id ? [`id="${el.id}"`] : []),
			...(el.classes.length ? [`class="${el.classes.join(' ')}"`] : []),
			...(el.inline.length ? [`style="${el.inline.map(declText).join('; ')}"`] : [])
		];
		const open = `<${el.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
		const pad = '  '.repeat(i);
		if (i === p.chain.length - 1) lines.push(`${pad}${open}${word}</${el.tag}>`);
		else if (el.tag === 'p') lines.push(`${pad}${open}Текст`);
		else lines.push(`${pad}${open}`);
	});
	for (let i = p.chain.length - 2; i >= 0; i -= 1) lines.push(`${'  '.repeat(i)}</${(p.chain[i] as El).tag}>`);
	return lines.join('\n');
}

function describe(p: Params, markup: string): string {
	return [
		'Разметка:',
		'',
		'```html',
		markup,
		'```',
		'',
		'Стили страницы — единственная таблица стилей автора:',
		'',
		'```css',
		css(p),
		'```',
		'',
		'Считаем: у `body` заданы `color: black` и `font-weight: 400`, фона нет; других стилей нет, стили браузера по умолчанию эти свойства у этих элементов не задают. Начальные значения: `background-color` — `transparent`, `font-weight` — `400`.',
		'',
		'Найдите итоговое (вычисленное) значение:',
		'',
		...p.queries.map((q, i) => `${i + 1}. \`${q.prop}\` у элемента \`<${(p.chain[q.el] as El).tag}>\`;`),
		'',
		`Введите ${p.queries.length} значения через пробел в порядке вопросов, так, как они записаны в CSS (имя цвета, \`transparent\`, число для \`font-weight\`), например: \`red transparent 700\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import re
import sys
from html.parser import HTMLParser

data = json.loads(sys.stdin.read())
INHERITED = {"color": True, "background-color": False, "font-weight": True}
INITIAL = {"background-color": "transparent", "font-weight": "400"}
BODY = {"color": "black", "background-color": "transparent", "font-weight": "400"}


class Tree(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.elements = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        el = {
            "tag": tag,
            "id": a.get("id"),
            "classes": (a.get("class") or "").split(),
            "style": a.get("style") or "",
            "parent": self.stack[-1] if self.stack else None,
        }
        self.elements.append(el)
        self.stack.append(el)

    def handle_endtag(self, tag):
        self.stack.pop()


tree = Tree()
tree.feed(data["html"])
elements = tree.elements


def declarations(text):
    out = []
    for part in text.split(";"):
        if not part.strip():
            continue
        prop, value = [x.strip() for x in part.split(":", 1)]
        important = value.endswith("!important")
        if important:
            value = value[: -len("!important")].strip()
        out.append((prop, value, important))
    return out


# Style sheet: rules with their layer (None when unlayered); layer order by first mention.
rules = []
layer_order = []
css = data["css"]
pos = 0
current_layer = None
while True:
    m = re.compile(r"\\s*(@layer\\s+([\\w\\s,]+);|@layer\\s+(\\w+)\\s*\\{|\\}|([^{}@]+)\\{([^}]*)\\})").match(css, pos)
    if not m or m.end() == pos:
        break
    pos = m.end()
    if m.group(2) is not None:
        for name in [x.strip() for x in m.group(2).split(",")]:
            if name not in layer_order:
                layer_order.append(name)
    elif m.group(3) is not None:
        current_layer = m.group(3)
        if current_layer not in layer_order:
            layer_order.append(current_layer)
    elif m.group(1).strip() == "}":
        current_layer = None
    else:
        rules.append((m.group(4).strip(), declarations(m.group(5)), current_layer))
if css[pos:].strip():
    raise ValueError("unparsed css: " + css[pos:])


def parse_selector(text):
    compounds, combinators = [], []
    pending = " "
    for t in re.findall(r">|[^\\s>]+", text):
        if t == ">":
            pending = ">"
            continue
        if compounds:
            combinators.append(pending)
        pending = " "
        m = re.fullmatch(r"([a-z]+)?(?:#([\\w-]+))?((?:\\.[\\w-]+)*)", t)
        compounds.append((m.group(1), m.group(2), [c for c in m.group(3).split(".") if c]))
    return compounds, combinators


def compound_matches(c, el):
    tag, ident, classes = c
    return (tag is None or tag == el["tag"]) and (ident is None or ident == el["id"]) and all(k in el["classes"] for k in classes)


def matches(sel, el):
    compounds, combinators = sel

    def rec(k, node):
        if node is None or not compound_matches(compounds[k], node):
            return False
        if k == 0:
            return True
        if combinators[k - 1] == ">":
            return rec(k - 1, node["parent"])
        anc = node["parent"]
        while anc is not None:
            if rec(k - 1, anc):
                return True
            anc = anc["parent"]
        return False

    return rec(len(compounds) - 1, el)


def spec(sel):
    a = sum(1 for c in sel[0] if c[1])
    b = sum(len(c[2]) for c in sel[0])
    c = sum(1 for x in sel[0] if x[0])
    return (a, b, c)


parsed = [(parse_selector(s), decls, layer) for s, decls, layer in rules]
L = len(layer_order)


def priority(important, layer, attached):
    # Cascade 5: importance, then element-attached styles, then layers (reversed for important), then specificity.
    if attached:
        tier = L + 1
    elif layer is None:
        tier = 0 if important else L
    else:
        i = layer_order.index(layer)
        tier = L - i if important else i
    return (1 if important else 0, tier)


computed = {}
for idx, el in enumerate(elements):
    for prop in ("color", "background-color", "font-weight"):
        parent = computed[(elements.index(el["parent"]), prop)] if el["parent"] is not None else BODY[prop]
        found = []
        for order, (sel, decls, layer) in enumerate(parsed):
            if matches(sel, el):
                for p, v, imp in decls:
                    if p == prop:
                        found.append((priority(imp, layer, False) + (spec(sel), order), v))
        for p, v, imp in declarations(el["style"]):
            if p == prop:
                found.append((priority(imp, None, True) + ((0, 0, 0), len(parsed)), v))
        if found:
            value = max(found)[1]
        else:
            value = "inherit" if INHERITED[prop] else "initial"
        if value == "unset":
            value = "inherit" if INHERITED[prop] else "initial"
        if value == "inherit":
            value = parent
        elif value == "initial":
            value = INITIAL[prop]
        computed[(idx, prop)] = value

print(" ".join(computed[(q["el"], q["prop"])] for q in data["queries"]))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let chosen: Scenario | null = null;
	for (let tries = 0; tries < 2000 && chosen === null; tries += 1)
		chosen = evaluate(scenario(rng, input.grade, input.classId), required);
	if (chosen === null) {
		const p = fallback(input.grade, input.classId);
		chosen = evaluate(p, []) ?? { p, answer: answerOf(p, RIGHT), wrong: {} };
	}
	const { p, answer, wrong } = chosen;
	const markup = html(p, rng);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p, markup), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ html: markup, css: css(p), queries: p.queries })
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

/** A hand-checked page for a seed whose random drafts keep failing; it exposes the class's misconceptions. */
function fallback(grade: string, classId: string): Params {
	const el = (tag: string, id: string | null, classes: string[], inline: Decl[] = []): El => ({
		tag,
		id,
		classes,
		inline,
		children: []
	});
	const c = (tag: string | null, id: string | null, classes: string[] = []): Compound => ({ tag, id, classes });
	const one = (comp: Compound): Sel => ({ compounds: [comp], combinators: [] });
	const d = (prop: Prop, value: string, important = false): Decl => ({ prop, value, important });
	const chain = [el('section', 'promo', ['box']), el('p', null, ['text', 'lead']), el('span', null, ['hl'])];
	if (grade === 'junior' && classId === 'layers-keywords') chain.unshift(el('div', null, ['wide']));
	const base: Rule[] = [
		{ sel: one(c(null, 'promo')), decls: [d('color', 'navy'), d('background-color', 'linen')], layer: null },
		{ sel: one(c('p', null)), decls: [d('color', 'teal')], layer: null },
		{ sel: one(c(null, null, ['text', 'lead'])), decls: [d('color', 'maroon')], layer: null },
		{
			sel: { compounds: [c('section', null), c('span', null)], combinators: [' '] },
			decls: [d('font-weight', '700')],
			layer: null
		},
		{ sel: one(c(null, null, ['hl'])), decls: [d('font-weight', '300')], layer: null }
	];
	const table: Record<string, () => Params> = {
		'intern/specificity-order': () => ({
			chain,
			statement: null,
			rules: [base[0] as Rule, base[2] as Rule, base[1] as Rule, base[3] as Rule, base[4] as Rule],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 2, prop: 'font-weight' },
				{ el: 0, prop: 'background-color' }
			]
		}),
		'intern/important-inline': () => {
			const ch = chain.map((e, i) => (i === 1 ? { ...e, inline: [d('color', 'olive')] } : e));
			const rules = base.map((r, i) => (i === 1 ? { ...r, decls: [d('color', 'teal', true)] } : r));
			rules[3] = { ...(rules[3] as Rule), decls: [d('font-weight', '700', true)] };
			return {
				chain: ch,
				statement: null,
				rules,
				queries: [
					{ el: 1, prop: 'color' },
					{ el: 2, prop: 'font-weight' },
					{ el: 2, prop: 'color' }
				]
			};
		},
		'intern/inheritance': () => ({
			chain,
			statement: null,
			rules: [base[0] as Rule, base[1] as Rule],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 2, prop: 'color' },
				{ el: 1, prop: 'background-color' },
				{ el: 0, prop: 'color' }
			]
		}),
		'intern/important-inherits': () => ({
			chain,
			statement: null,
			rules: [{ ...(base[0] as Rule), decls: [d('color', 'navy', true)] }, base[1] as Rule],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 2, prop: 'color' },
				{ el: 0, prop: 'color' }
			]
		}),
		'junior/keywords': () => ({
			chain,
			statement: null,
			rules: [
				base[0] as Rule,
				{ sel: one(c('p', null)), decls: [d('color', 'unset'), d('background-color', 'inherit')], layer: null },
				{
					sel: one(c(null, null, ['hl'])),
					decls: [d('background-color', 'unset'), d('font-weight', 'initial')],
					layer: null
				},
				{ sel: one(c(null, null, ['text'])), decls: [d('font-weight', '800')], layer: null }
			],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 1, prop: 'background-color' },
				{ el: 2, prop: 'background-color' },
				{ el: 2, prop: 'font-weight' }
			]
		}),
		'junior/layers': () => ({
			chain,
			statement: ['base', 'theme'],
			rules: [
				{ sel: one(c(null, null, ['text', 'lead'])), decls: [d('color', 'maroon')], layer: 'theme' },
				{ sel: one(c(null, 'promo')), decls: [d('background-color', 'linen')], layer: 'base' },
				{ sel: one(c('p', null)), decls: [d('color', 'olive')], layer: 'base' },
				{ sel: one(c('section', null)), decls: [d('background-color', 'pink')], layer: 'theme' },
				{ sel: one(c('span', null)), decls: [d('color', 'teal')], layer: null },
				{ sel: one(c(null, null, ['hl'])), decls: [d('color', 'navy')], layer: 'theme' }
			],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 0, prop: 'background-color' },
				{ el: 2, prop: 'color' },
				{ el: 2, prop: 'background-color' }
			]
		}),
		'junior/layers-important': () => ({
			chain,
			statement: null,
			rules: [
				{ sel: one(c('p', null)), decls: [d('color', 'olive', true)], layer: 'base' },
				{ sel: one(c(null, null, ['text', 'lead'])), decls: [d('color', 'maroon', true)], layer: 'theme' },
				{ sel: one(c(null, 'promo')), decls: [d('font-weight', '600', true)], layer: null },
				{ sel: one(c('section', null)), decls: [d('font-weight', '900', true)], layer: 'theme' },
				{ sel: one(c('span', null)), decls: [d('color', 'teal')], layer: null }
			],
			queries: [
				{ el: 1, prop: 'color' },
				{ el: 0, prop: 'font-weight' },
				{ el: 2, prop: 'color' },
				{ el: 2, prop: 'font-weight' }
			]
		}),
		'junior/layers-keywords': () => ({
			chain,
			statement: ['base', 'theme'],
			rules: [
				{ sel: one(c(null, null, ['text', 'lead'])), decls: [d('color', 'unset')], layer: 'theme' },
				{ sel: one(c('p', null)), decls: [d('color', 'olive')], layer: 'base' },
				{ sel: one(c(null, 'promo')), decls: [d('color', 'navy'), d('background-color', 'linen')], layer: 'base' },
				{ sel: one(c('section', null)), decls: [d('background-color', 'pink')], layer: null },
				{ sel: one(c(null, null, ['hl'])), decls: [d('background-color', 'unset')], layer: 'theme' },
				{ sel: one(c('span', null)), decls: [d('background-color', 'wheat')], layer: 'base' }
			],
			queries: [
				{ el: 2, prop: 'color' },
				{ el: 1, prop: 'background-color' },
				{ el: 3, prop: 'background-color' },
				{ el: 3, prop: 'color' }
			]
		})
	};
	const make = table[`${grade}/${classId}`];
	if (!make) throw new Error(`${descriptor.key}: no fallback for ${grade}/${classId}`);
	return make();
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
