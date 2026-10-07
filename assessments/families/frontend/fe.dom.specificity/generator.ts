// Specificity of selectors by Selectors Level 4: the triple (a, b, c) of a complex selector — ids; classes, attributes
// and pseudo-classes; types and pseudo-elements; the universal selector and combinators count nothing. A level up,
// `:is()`, `:not()` and `:has()` take the most specific selector of their argument, `:where()` counts nothing, and
// `:nth-child(An+B of S)` counts as a pseudo-class plus the most specific selector of S. The generator builds selectors
// as trees and counts them; the reference parses the shown text on its own.
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

type Simple =
	| { k: 'type'; text: string }
	| { k: 'universal' }
	| { k: 'id'; text: string }
	| { k: 'class'; text: string }
	| { k: 'attr'; text: string }
	| { k: 'pclass'; text: string }
	| { k: 'pelem'; text: string }
	| { k: 'fn'; name: 'is' | 'not' | 'where' | 'has'; args: Sel[] }
	| { k: 'nth'; name: 'nth-child' | 'nth-last-child'; an: string; args: Sel[] };

/** A complex selector: compounds joined by combinators; `lead` — the leading combinator of a relative selector. */
interface Sel {
	lead: string;
	compounds: Simple[][];
	combinators: string[];
}

type Triple = [number, number, number];

/** How specificity is counted: the right way and every misconception of the family. */
interface Model {
	universalCounts: boolean;
	attrAsType: boolean;
	pclassIgnored: boolean;
	pelemAsClass: boolean;
	keyCompoundOnly: boolean;
	fn: 'max' | 'sum' | 'first';
	fnCountsItself: boolean;
	where: 'zero' | 'max';
	has: 'max' | 'zero';
	nthOf: 'right' | 'ignored';
}

const RIGHT: Model = {
	universalCounts: false,
	attrAsType: false,
	pclassIgnored: false,
	pelemAsClass: false,
	keyCompoundOnly: false,
	fn: 'max',
	fnCountsItself: false,
	where: 'zero',
	has: 'max',
	nthOf: 'right'
};

const TRIPLE_WRONG: Record<string, Partial<Model>> = {
	'universal-counts': { universalCounts: true },
	'attr-as-type': { attrAsType: true },
	'pseudo-class-ignored': { pclassIgnored: true },
	'pseudo-element-as-class': { pelemAsClass: true },
	'key-compound-only': { keyCompoundOnly: true },
	'functional-counts-itself': { fnCountsItself: true },
	'functional-sum-args': { fn: 'sum' },
	'functional-first-arg': { fn: 'first' },
	'where-like-is': { where: 'max' },
	'has-like-where': { has: 'zero' },
	'nth-of-ignored': { nthOf: 'ignored' }
};

const ORDER_WRONG = ['order-by-count', 'order-ties-earlier'] as const;

const add = (x: Triple, y: Triple): Triple => [x[0] + y[0], x[1] + y[1], x[2] + y[2]];
const cmp = (x: Triple, y: Triple): number => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const ZERO: Triple = [0, 0, 0];

function argsSpecificity(args: readonly Sel[], m: Model): Triple {
	const specs = args.map((s) => specificity(s, m));
	if (m.fn === 'sum') return specs.reduce(add, ZERO);
	if (m.fn === 'first') return specs[0] ?? ZERO;
	return specs.reduce((best, s) => (cmp(s, best) > 0 ? s : best), ZERO);
}

function simpleSpecificity(s: Simple, m: Model): Triple {
	switch (s.k) {
		case 'type':
			return [0, 0, 1];
		case 'universal':
			return m.universalCounts ? [0, 0, 1] : ZERO;
		case 'id':
			return [1, 0, 0];
		case 'class':
			return [0, 1, 0];
		case 'attr':
			return m.attrAsType ? [0, 0, 1] : [0, 1, 0];
		case 'pclass':
			return m.pclassIgnored ? ZERO : [0, 1, 0];
		case 'pelem':
			return m.pelemAsClass ? [0, 1, 0] : [0, 0, 1];
		case 'fn': {
			if (s.name === 'where' && m.where === 'zero') return ZERO;
			if (s.name === 'has' && m.has === 'zero') return ZERO;
			const inner = argsSpecificity(s.args, m);
			return m.fnCountsItself ? add(inner, [0, 1, 0]) : inner;
		}
		case 'nth':
			return m.nthOf === 'ignored' ? [0, 1, 0] : add([0, 1, 0], argsSpecificity(s.args, m));
	}
}

function specificity(sel: Sel, m: Model): Triple {
	const compounds = m.keyCompoundOnly ? sel.compounds.slice(-1) : sel.compounds;
	return compounds.flat().reduce((acc, s) => add(acc, simpleSpecificity(s, m)), ZERO);
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering.

function renderSimple(s: Simple): string {
	switch (s.k) {
		case 'type':
			return s.text;
		case 'universal':
			return '*';
		case 'id':
			return `#${s.text}`;
		case 'class':
			return `.${s.text}`;
		case 'attr':
		case 'pclass':
		case 'pelem':
			return s.text;
		case 'fn':
			return `:${s.name}(${s.args.map(render).join(', ')})`;
		case 'nth':
			return `:${s.name}(${s.an} of ${s.args.map(render).join(', ')})`;
	}
}

const RANK: Record<Simple['k'], number> = {
	type: 0,
	universal: 0,
	id: 1,
	class: 2,
	attr: 3,
	pclass: 4,
	fn: 4,
	nth: 4,
	pelem: 5
};

function render(sel: Sel): string {
	const parts = sel.compounds.map((c) =>
		[...c]
			.map((s, i) => ({ s, i }))
			.sort((x, y) => RANK[x.s.k] - RANK[y.s.k] || x.i - y.i)
			.map((x) => renderSimple(x.s))
			.join('')
	);
	let out = sel.lead ? `${sel.lead} ` : '';
	parts.forEach((p, i) => {
		if (i > 0) {
			const comb = sel.combinators[i - 1] ?? ' ';
			out += comb === ' ' ? ' ' : ` ${comb} `;
		}
		out += p;
	});
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Building selectors.

const TAGS = [
	'div',
	'ul',
	'li',
	'a',
	'p',
	'span',
	'nav',
	'button',
	'input',
	'section',
	'article',
	'header',
	'img',
	'h2'
];
/** Tags that can hold other elements: ancestors and siblings of an element that has to be matched. */
const CONTAINERS = ['div', 'ul', 'li', 'nav', 'section', 'article', 'header', 'p'];
const IDS = ['main', 'menu', 'cart', 'promo', 'login', 'sidebar', 'footer', 'search', 'profile', 'top'];
const CLASSES = [
	'item',
	'active',
	'card',
	'btn',
	'title',
	'link',
	'price',
	'hidden',
	'primary',
	'wide',
	'open',
	'note',
	'icon',
	'badge',
	'error',
	'selected'
];
const ATTRS = [
	'[type="text"]',
	'[href]',
	'[data-role="tab"]',
	'[disabled]',
	'[aria-expanded="true"]',
	'[href^="https"]',
	'[lang|="ru"]',
	'[name="email"]',
	'[data-state="open"]',
	'[target="_blank"]'
];
const PCLASSES = [
	':hover',
	':focus',
	':first-child',
	':last-child',
	':checked',
	':nth-child(2n+1)',
	':focus-visible',
	':disabled',
	':empty',
	':first-of-type',
	':nth-of-type(3)',
	':visited'
];
const PELEMS = ['::before', '::after', '::first-line', '::first-letter', '::placeholder', '::marker', '::selection'];
const NTH = ['2n+1', 'odd', 'even', '3', '2n', '-n+3'];
const COMBINATORS = [' ', ' ', '>', '+', '~'];

/**
 * A compound by a pattern: `T` type, `*` universal, `#` id, `.` class, `[` attribute, `:` pseudo-class, `E` pseudo-element.
 */
function compound(rng: Rng, pattern: string, tags: readonly string[] = TAGS): Simple[] {
	return pattern.split('').map((ch): Simple => {
		switch (ch) {
			case 'T':
				return { k: 'type', text: rng.pick(tags) };
			case '*':
				return { k: 'universal' };
			case '#':
				return { k: 'id', text: rng.pick(IDS) };
			case '.':
				return { k: 'class', text: rng.pick(CLASSES) };
			case '[':
				return { k: 'attr', text: rng.pick(ATTRS) };
			case ':':
				return { k: 'pclass', text: rng.pick(PCLASSES) };
			case 'E':
				return { k: 'pelem', text: rng.pick(PELEMS) };
			default:
				throw new Error(`unknown compound pattern ${ch}`);
		}
	});
}

/** Simple selectors of one compound have distinct texts (`.a.a` is legal, but reads as a typo). */
function distinctCompound(rng: Rng, pattern: string, tags: readonly string[] = TAGS): Simple[] {
	for (let tries = 0; tries < 20; tries += 1) {
		const c = compound(rng, pattern, tags);
		const texts = c.map(renderSimple);
		if (new Set(texts).size === texts.length) return c;
	}
	return compound(rng, pattern.replaceAll('.', '').replaceAll(':', '') || 'T', tags);
}

function complex(rng: Rng, patterns: readonly string[], count: number): Sel {
	const compounds = Array.from({ length: count }, () => distinctCompound(rng, rng.pick(patterns)));
	const combinators = Array.from({ length: count - 1 }, () => rng.pick(COMBINATORS));
	return { lead: '', compounds, combinators };
}

/** A short argument of a functional pseudo-class: one or two compounds. */
function argument(rng: Rng, relative: boolean): Sel {
	const sel = complex(rng, ['T', '.', '#', 'T.', '[', '.:', 'T#', '..', 'T['], rng.pick([1, 1, 1, 2]));
	if (relative) sel.lead = rng.pick(['', '>', '+', '~', '>']);
	return sel;
}

/** Two or three arguments whose specificities all differ, so that taking the wrong one changes the count. */
function argumentList(rng: Rng, relative: boolean): Sel[] {
	for (let tries = 0; tries < 30; tries += 1) {
		const args = Array.from({ length: rng.int(2, 3) }, () => argument(rng, relative));
		const keys = args.map((a) => specificity(a, RIGHT).join(','));
		const texts = args.map(render);
		if (new Set(keys).size === args.length && new Set(texts).size === args.length) return args;
	}
	return [
		{ lead: relative ? '>' : '', compounds: [[{ k: 'class', text: rng.pick(CLASSES) }]], combinators: [] },
		{ lead: '', compounds: [[{ k: 'id', text: rng.pick(IDS) }]], combinators: [] }
	];
}

/** Puts a functional pseudo-class into a random compound of the selector. */
function withFunctional(rng: Rng, sel: Sel, fn: Simple): Sel {
	const i = rng.int(0, sel.compounds.length - 1);
	const compounds = sel.compounds.map((c, j) => (j === i ? [...c, fn] : c));
	return { ...sel, compounds };
}

/**
 * Six selectors that can all match one element: the last compound of each names only that element's tag, id, classes,
 * attributes and pseudo-classes; the compounds before it describe ancestors or siblings freely.
 */
function orderSelectors(rng: Rng): Sel[] {
	const tag = rng.pick(['li', 'a', 'button', 'span', 'p']);
	const id = rng.pick(IDS);
	const classes = rng.sample(CLASSES, 3);
	const attr = rng.pick(['[data-role="tab"]', '[data-state="open"]', '[title]', '[lang|="ru"]']);
	const pclasses = rng.sample([':hover', ':first-child', ':last-child', ':focus', ':nth-child(2n+1)'], 2);
	const own: Simple[] = [
		...classes.map((text): Simple => ({ k: 'class', text })),
		{ k: 'attr', text: attr },
		...pclasses.map((text): Simple => ({ k: 'pclass', text }))
	];
	return Array.from({ length: 6 }, () => {
		const key: Simple[] = [];
		if (rng.bool(0.5)) key.push({ k: 'type', text: tag });
		if (rng.bool(0.2)) key.push({ k: 'id', text: id });
		key.push(...rng.sample(own, rng.int(key.length === 0 ? 1 : 0, 2)));
		const before = rng.pick([0, 1, 1, 2]);
		const compounds = [
			...Array.from({ length: before }, () => distinctCompound(rng, rng.pick(INTERN_PATTERNS.order), CONTAINERS)),
			key
		];
		const combinators = Array.from({ length: before }, () => rng.pick(COMBINATORS));
		return { lead: '', compounds, combinators };
	});
}

interface Params {
	mode: 'triples' | 'order';
	selectors: Sel[];
}

const INTERN_PATTERNS = {
	plain: ['T', 'T.', '#', 'T#', '.', '..', 'T..', '#.', 'T.'],
	attrs: ['T[', '[', 'T:', '.:', 'T.[', 'T[:', '.[', ':', 'T', '.', 'T.:'],
	order: ['T', 'T.', '#', '.', '..', 'T[', '.:', 'T:', '[', 'T#', '#.']
};

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		if (classId === 'order') return { mode: 'order', selectors: orderSelectors(rng) };
		const selectors = Array.from({ length: 5 }, (_, i): Sel => {
			const count = rng.int(1, 3);
			if (classId === 'ids-classes') {
				const sel = complex(rng, INTERN_PATTERNS.plain, count);
				// A universal selector in roughly every other selector: alone or with a class.
				if (rng.bool(0.5) || i === 0) {
					const at = rng.int(0, sel.compounds.length - 1);
					sel.compounds[at] = rng.bool(0.6) ? [{ k: 'universal' }] : [{ k: 'universal' }, ...compound(rng, '.')];
					if (sel.compounds.length === 1) {
						sel.compounds.push(distinctCompound(rng, rng.pick(INTERN_PATTERNS.plain)));
						sel.combinators.push(rng.pick(COMBINATORS));
					}
				}
				return sel;
			}
			if (classId === 'attrs-pseudo') return complex(rng, INTERN_PATTERNS.attrs, count);
			// pseudo-elements: a pseudo-element at the end of most selectors.
			const sel = complex(rng, INTERN_PATTERNS.attrs, count);
			if (i < 4 || rng.bool(0.5)) sel.compounds[sel.compounds.length - 1]?.push(compound(rng, 'E')[0] as Simple);
			return sel;
		});
		return { mode: 'triples', selectors: rng.shuffle(selectors) };
	}
	const base = ['T', 'T.', '.', '#', 'T[', '.:', 'T:', 'T#'];
	const selectors = Array.from({ length: 5 }, (_, i): Sel => {
		const sel = complex(rng, base, rng.int(1, 2));
		if (classId === 'is-not') {
			const name = rng.pick(['is', 'not'] as const);
			return withFunctional(rng, sel, { k: 'fn', name, args: argumentList(rng, false) });
		}
		if (classId === 'where') {
			const name = i < 3 ? 'where' : rng.pick(['is', 'where', 'not'] as const);
			const withFn = withFunctional(rng, sel, { k: 'fn', name, args: argumentList(rng, false) });
			return i === 4 ? withFunctional(rng, withFn, { k: 'fn', name: 'is', args: argumentList(rng, false) }) : withFn;
		}
		if (classId === 'has') {
			const withFn =
				i < 3 || rng.bool(0.5)
					? withFunctional(rng, sel, { k: 'fn', name: 'has', args: argumentList(rng, true) })
					: withFunctional(rng, sel, { k: 'fn', name: 'not', args: argumentList(rng, false) });
			if (rng.bool(0.3)) withFn.compounds[withFn.compounds.length - 1]?.push(compound(rng, 'E')[0] as Simple);
			return withFn;
		}
		// nth-of
		if (i < 3 || rng.bool(0.4)) {
			const name = rng.pick(['nth-child', 'nth-last-child'] as const);
			return withFunctional(rng, sel, { k: 'nth', name, an: rng.pick(NTH), args: argumentList(rng, false) });
		}
		return withFunctional(rng, sel, {
			k: 'fn',
			name: rng.pick(['is', 'not'] as const),
			args: argumentList(rng, false)
		});
	});
	return { mode: 'triples', selectors: rng.shuffle(selectors) };
}

// ---------------------------------------------------------------------------------------------------------------
// Answers.

function triplesAnswer(p: Params, m: Model): string {
	return p.selectors.map((s) => specificity(s, m).join(' ')).join(' ');
}

/** Rule numbers from the winner down: higher specificity first; a tie goes to the rule written later. */
function orderAnswer(p: Params, how: 'right' | 'by-count' | 'ties-earlier'): string {
	const keyed = p.selectors.map((s, i) => ({
		i,
		spec: specificity(s, RIGHT),
		count: s.compounds.flat().filter((x) => x.k !== 'universal').length
	}));
	keyed.sort((x, y) => {
		if (how === 'by-count') return y.count - x.count || y.i - x.i;
		const bySpec = cmp(y.spec, x.spec);
		if (bySpec !== 0) return bySpec;
		return how === 'ties-earlier' ? x.i - y.i : y.i - x.i;
	});
	return keyed.map((k) => String(k.i + 1)).join(' ');
}

function answers(p: Params): { answer: string; wrong: Record<string, string | null> } {
	if (p.mode === 'order') {
		const answer = orderAnswer(p, 'right');
		const byCount = orderAnswer(p, 'by-count');
		const tiesEarlier = orderAnswer(p, 'ties-earlier');
		const wrong: Record<string, string | null> = Object.fromEntries(Object.keys(TRIPLE_WRONG).map((id) => [id, null]));
		wrong['order-by-count'] = byCount === answer ? null : byCount;
		wrong['order-ties-earlier'] = tiesEarlier === answer ? null : tiesEarlier;
		return { answer, wrong };
	}
	const answer = triplesAnswer(p, RIGHT);
	const wrong: Record<string, string | null> = Object.fromEntries(
		Object.entries(TRIPLE_WRONG).map(([id, change]) => {
			const value = triplesAnswer(p, { ...RIGHT, ...change });
			return [id, value === answer ? null : value];
		})
	);
	for (const id of ORDER_WRONG) wrong[id] = null;
	return { answer, wrong };
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/ids-classes': ['universal-counts', 'key-compound-only'],
	'intern/attrs-pseudo': ['attr-as-type', 'pseudo-class-ignored'],
	'intern/order': ['order-by-count', 'order-ties-earlier'],
	'intern/pseudo-elements': ['pseudo-element-as-class', 'pseudo-class-ignored'],
	'junior/is-not': ['functional-counts-itself', 'functional-sum-args', 'functional-first-arg'],
	'junior/where': ['where-like-is', 'functional-counts-itself'],
	'junior/has': ['has-like-where', 'functional-sum-args'],
	'junior/nth-of': ['nth-of-ignored', 'functional-sum-args']
};

/** Selectors of an instance differ from one another; an order item has a tie and no two selectors of one text. */
function acceptable(p: Params): boolean {
	const texts = p.selectors.map(render);
	if (new Set(texts).size !== texts.length) return false;
	// An id names one element: a selector never mentions the same id twice.
	for (const text of texts) {
		const ids = [...text.matchAll(/#([a-z]+)/g)].map((m) => m[1]);
		if (new Set(ids).size !== ids.length) return false;
	}
	if (p.mode === 'order') {
		const specs = p.selectors.map((s) => specificity(s, RIGHT).join(','));
		if (new Set(specs).size === specs.length) return false;
		// Ties are a part of the item, not all of it: at least four distinct specificities.
		if (new Set(specs).size < 4) return false;
	}
	return true;
}

/** Hand-built fallback scenarios: used only if the random draw keeps failing, they expose every required misconception. */
function fallback(rng: Rng, grade: string, classId: string): Params {
	const T = (text: string): Simple => ({ k: 'type', text });
	const C = (text: string): Simple => ({ k: 'class', text });
	const I = (text: string): Simple => ({ k: 'id', text });
	const sel = (compounds: Simple[][], combinators: string[] = []): Sel => ({ lead: '', compounds, combinators });
	const c1 = rng.pick(CLASSES);
	const id = rng.pick(IDS);
	const base: Sel[] = [
		sel([[I(id)], [T('li'), C(c1)]], ['>']),
		sel([[T('ul')], [{ k: 'universal' }]], [' ']),
		sel([[{ k: 'universal' }, C(c1)], [T('a')]], ['+']),
		sel([[T('nav')], [T('ul')], [T('li')]], [' ', '>']),
		sel([[C(c1), C('active')]])
	];
	if (grade === 'intern') {
		if (classId === 'order') {
			return {
				mode: 'order',
				selectors: [
					sel([[T('a')], [C(c1)]], [' ']),
					sel([[I(id)]]),
					sel([[T('ul')], [T('li')], [T('a')]], [' ', '>']),
					sel([[C(c1), { k: 'attr', text: '[href]' }]]),
					sel([[T('li')], [C('link')]], ['>']),
					sel([[T('nav')], [T('a')]], [' '])
				]
			};
		}
		if (classId === 'ids-classes') return { mode: 'triples', selectors: base };
		const P = (text: string): Simple => ({ k: 'pclass', text });
		const A = (text: string): Simple => ({ k: 'attr', text });
		const E = (text: string): Simple => ({ k: 'pelem', text });
		const tail = classId === 'pseudo-elements' ? [E('::before')] : [];
		return {
			mode: 'triples',
			selectors: [
				sel([[T('input'), A('[type="text"]'), P(':focus'), ...tail]]),
				sel([[C(c1)], [T('a'), P(':hover'), ...tail]], [' ']),
				sel([[A('[data-role="tab"]')], [T('span'), ...(classId === 'pseudo-elements' ? [E('::after')] : [])]], ['>']),
				sel([[T('li'), P(':first-child'), C(c1), ...tail]]),
				sel([[T('ul')], [T('li'), A('[lang|="ru"]')]], [' '])
			]
		};
	}
	const fn = (name: 'is' | 'not' | 'where' | 'has', args: Sel[]): Simple => ({ k: 'fn', name, args });
	const args = (): Sel[] => [sel([[T('li')]]), sel([[I(id)]]), sel([[C(c1)]])];
	const rel = (): Sel[] => [
		{ lead: '>', compounds: [[T('img')]], combinators: [] },
		{ lead: '+', compounds: [[C(c1), C('active')]], combinators: [] }
	];
	const make = (f: (i: number) => Simple): Sel[] =>
		base.map((s, i) => ({ ...s, compounds: s.compounds.map((c, j) => (j === 0 ? [...c, f(i)] : c)) }));
	if (classId === 'is-not') return { mode: 'triples', selectors: make((i) => fn(i % 2 ? 'not' : 'is', args())) };
	if (classId === 'where') return { mode: 'triples', selectors: make((i) => fn(i === 4 ? 'is' : 'where', args())) };
	if (classId === 'has')
		return { mode: 'triples', selectors: make((i) => (i === 4 ? fn('not', args()) : fn('has', rel()))) };
	return {
		mode: 'triples',
		selectors: make((i) => (i === 4 ? fn('is', args()) : { k: 'nth', name: 'nth-child', an: '2n+1', args: args() }))
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

function describe(p: Params, grade: string): string {
	const list = p.selectors.map((s, i) => `${i + 1}. \`${render(s)}\``);
	if (p.mode === 'order') {
		return [
			'В таблице стилей шесть правил, все они задают `color` и все подходят к одному и тому же элементу. Правила записаны в таблице в этом порядке, `!important` и инлайн-стилей нет:',
			'',
			...list.map((line) => line.replace(/`$/, ' { color: … }`')),
			'',
			'Расположите номера правил от того, чьё значение `color` получит элемент, до самого слабого: каждое следующее проигрывает всем предыдущим, если бы они все остались.',
			'',
			'Введите номера через пробел, например: `4 1 6 2 5 3`.'
		].join('\n');
	}
	const level =
		grade === 'intern'
			? 'Селекторы записаны по Selectors Level 4.'
			: 'Селекторы записаны по Selectors Level 4; все функциональные псевдоклассы поддерживаются браузером.';
	return [
		`Вычислите специфичность каждого селектора — тройку (a, b, c) в обозначениях спецификации, как её показывают инструменты разработчика браузера. ${level}`,
		'',
		...list,
		'',
		'Введите для каждого селектора по порядку три числа a b c через пробел (можно по строке на селектор). Например, для двух селекторов: `0 1 1 1 0 2`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import sys

data = json.loads(sys.stdin.read())


class Parser:
    def __init__(self, text):
        self.s = text
        self.i = 0

    def peek(self, k=0):
        j = self.i + k
        return self.s[j] if j < len(self.s) else ""

    def ident(self):
        start = self.i
        while self.peek() and (self.peek().isalnum() or self.peek() in "-_"):
            self.i += 1
        return self.s[start:self.i]

    def selector_list(self):
        """Specificities of a comma-separated list, up to a closing parenthesis or the end."""
        specs = [self.complex_selector()]
        while self.peek() == ",":
            self.i += 1
            specs.append(self.complex_selector())
        return specs

    def complex_selector(self):
        total = (0, 0, 0)
        while True:
            ch = self.peek()
            if ch == "" or ch in ",)":
                return total
            if ch in " >+~":
                self.i += 1
                continue
            total = tuple(x + y for x, y in zip(total, self.simple()))

    def simple(self):
        ch = self.peek()
        if ch == "#":
            self.i += 1
            self.ident()
            return (1, 0, 0)
        if ch == ".":
            self.i += 1
            self.ident()
            return (0, 1, 0)
        if ch == "*":
            self.i += 1
            return (0, 0, 0)
        if ch == "[":
            quote = None
            while True:
                c = self.peek()
                self.i += 1
                if quote:
                    if c == quote:
                        quote = None
                elif c in "\\"'":
                    quote = c
                elif c == "]":
                    return (0, 1, 0)
        if ch == ":" and self.peek(1) == ":":
            self.i += 2
            self.ident()
            return (0, 0, 1)
        if ch == ":":
            self.i += 1
            name = self.ident().lower()
            if self.peek() != "(":
                return (0, 1, 0)
            self.i += 1
            if name in ("is", "not", "has", "where"):
                specs = self.selector_list()
                self.expect(")")
                return (0, 0, 0) if name == "where" else max(specs)
            if name in ("nth-child", "nth-last-child"):
                start = self.i
                while self.peek() not in ("", ")") and not self.s.startswith(" of ", self.i):
                    self.i += 1
                if self.s.startswith(" of ", self.i):
                    self.i += 4
                    specs = self.selector_list()
                    self.expect(")")
                    best = max(specs)
                    return (best[0], best[1] + 1, best[2])
                self.expect(")")
                return (0, 1, 0)
            depth = 1
            while depth:
                c = self.peek()
                self.i += 1
                depth += 1 if c == "(" else -1 if c == ")" else 0
            return (0, 1, 0)
        name = self.ident()
        if not name:
            raise ValueError("unexpected " + repr(ch) + " in " + self.s)
        return (0, 0, 1)

    def expect(self, ch):
        while self.peek() == " ":
            self.i += 1
        if self.peek() != ch:
            raise ValueError("expected " + ch + " in " + self.s)
        self.i += 1


def specificity(text):
    p = Parser(text)
    specs = p.selector_list()
    if p.i != len(text) or len(specs) != 1:
        raise ValueError("not one selector: " + text)
    return specs[0]


specs = [specificity(s) for s in data["selectors"]]
if data["mode"] == "triples":
    print(" ".join(" ".join(str(x) for x in s) for s in specs))
else:
    order = sorted(range(len(specs)), key=lambda i: (specs[i], i), reverse=True)
    print(" ".join(str(i + 1) for i in order))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | null = null;
	for (let tries = 0; tries < 400 && chosen === null; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		if (!acceptable(p)) continue;
		const { answer, wrong } = answers(p);
		if (required.some((id) => wrong[id] === null)) continue;
		chosen = { p, answer, wrong };
	}
	if (chosen === null) {
		const p = fallback(rng, input.grade, input.classId);
		chosen = { p, ...answers(p) };
	}
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p, input.grade), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ mode: p.mode, selectors: p.selectors.map(render) })
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
