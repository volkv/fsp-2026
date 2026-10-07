// Accessible names, descriptions and default roles (Accessible Name and Description Computation 1.2, HTML-AAM):
// aria-labelledby before aria-label before the host language (label, alt) before the content of roles that take their
// name from content, `title` last; hidden nodes are skipped in a traversal, but a hidden node referenced directly by
// aria-labelledby or aria-describedby still gives its text; a node reached through aria-labelledby does not follow its
// own aria-labelledby. The generator builds the markup and computes with its model; the reference parses the shown
// HTML and computes on its own.
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

interface El {
	tag: string;
	attrs: [string, string | null][];
	children: Node[];
}

type Node = string | El;

type QueryKind = 'role' | 'name' | 'description';

interface Query {
	kind: QueryKind;
	id: string;
}

interface Params {
	nodes: Node[];
	queries: Query[];
}

interface Rules {
	labelOverAriaLabel: boolean;
	placeholderAsName: boolean;
	hiddenIncluded: boolean;
	imgAltIgnored: boolean;
	ariaLabelOverLabelledby: boolean;
	hiddenRefSkipped: boolean;
	firstIdOnly: boolean;
	titleOverContent: boolean;
	labelledbyFollowed: boolean;
	selfRefContent: boolean;
	contentForAllRoles: boolean;
	sectionAlwaysRegion: boolean;
	titleIgnoredForDescription: boolean;
}

const RIGHT: Rules = {
	labelOverAriaLabel: false,
	placeholderAsName: false,
	hiddenIncluded: false,
	imgAltIgnored: false,
	ariaLabelOverLabelledby: false,
	hiddenRefSkipped: false,
	firstIdOnly: false,
	titleOverContent: false,
	labelledbyFollowed: false,
	selfRefContent: false,
	contentForAllRoles: false,
	sectionAlwaysRegion: false,
	titleIgnoredForDescription: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'label-over-aria-label': { labelOverAriaLabel: true },
	'placeholder-as-name': { placeholderAsName: true },
	'hidden-included': { hiddenIncluded: true },
	'img-alt-ignored': { imgAltIgnored: true },
	'aria-label-over-labelledby': { ariaLabelOverLabelledby: true },
	'hidden-ref-skipped': { hiddenRefSkipped: true },
	'first-id-only': { firstIdOnly: true },
	'title-over-content': { titleOverContent: true },
	'labelledby-followed': { labelledbyFollowed: true },
	'self-ref-content': { selfRefContent: true },
	'content-for-all-roles': { contentForAllRoles: true },
	'section-always-region': { sectionAlwaysRegion: true },
	'title-ignored-for-description': { titleIgnoredForDescription: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The model.

const attr = (el: El, name: string): string | null => {
	const found = el.attrs.find(([k]) => k === name);
	return found === undefined ? null : (found[1] ?? '');
};
const isEl = (n: Node): n is El => typeof n !== 'string';
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const hidden = (el: El): boolean => attr(el, 'hidden') !== null || attr(el, 'aria-hidden') === 'true';

class Doc {
	readonly byId = new Map<string, El>();
	readonly parent = new Map<El, El | null>();
	readonly labels: El[] = [];

	constructor(nodes: readonly Node[]) {
		const walk = (n: Node, up: El | null): void => {
			if (!isEl(n)) return;
			this.parent.set(n, up);
			const id = attr(n, 'id');
			if (id !== null) this.byId.set(id, n);
			if (n.tag === 'label') this.labels.push(n);
			for (const c of n.children) walk(c, n);
		};
		for (const n of nodes) walk(n, null);
	}

	/** Labels of a form control: `<label for>` and an ancestor `<label>`, in document order. */
	labelsOf(el: El): El[] {
		const id = attr(el, 'id');
		return this.labels.filter((l) => {
			if (id !== null && attr(l, 'for') === id) return true;
			for (let up = this.parent.get(el) ?? null; up; up = this.parent.get(up) ?? null) if (up === l) return true;
			return false;
		});
	}
}

const CONTROLS = new Set(['input', 'textarea']);

function role(el: El, doc: Doc, rules: Rules): string {
	const explicit = attr(el, 'role');
	if (explicit) return explicit;
	switch (el.tag) {
		case 'button':
			return 'button';
		case 'a':
			return attr(el, 'href') !== null ? 'link' : 'generic';
		case 'input':
			return attr(el, 'type') === 'checkbox' ? 'checkbox' : 'textbox';
		case 'textarea':
			return 'textbox';
		case 'img':
			return 'img';
		case 'h2':
		case 'h3':
			return 'heading';
		case 'nav':
			return 'navigation';
		case 'ul':
			return 'list';
		case 'section':
			return rules.sectionAlwaysRegion || name(el, doc, rules) !== '' ? 'region' : 'generic';
		default:
			return 'generic';
	}
}

const FROM_CONTENT = new Set(['button', 'link', 'heading']);

interface Ctx {
	/** Reached through aria-labelledby or aria-describedby: own aria-labelledby is not followed, content counts. */
	referenced: boolean;
	/** A child in a traversal of content. */
	inContent: boolean;
	/** Elements whose aria-labelledby is being followed, against cycles. */
	following: Set<El>;
}

function textAlternative(el: El, doc: Doc, rules: Rules, ctx: Ctx, self: El | null): string {
	if (ctx.inContent && hidden(el) && !rules.hiddenIncluded) return '';
	const labelledby = attr(el, 'aria-labelledby');
	const ariaLabel = squash(attr(el, 'aria-label') ?? '');
	if (labelledby !== null && (!ctx.referenced || rules.labelledbyFollowed) && !ctx.following.has(el)) {
		if (!(rules.ariaLabelOverLabelledby && ariaLabel)) {
			const ids = labelledby.split(/\s+/).filter(Boolean);
			const following = new Set(ctx.following).add(el);
			const parts = (rules.firstIdOnly ? ids.slice(0, 1) : ids).map((id) => {
				const ref = doc.byId.get(id);
				if (!ref) return '';
				if (hidden(ref) && rules.hiddenRefSkipped) return '';
				return textAlternative(
					ref,
					doc,
					rules,
					{ referenced: true, inContent: false, following },
					ref === el ? el : null
				);
			});
			const joined = squash(parts.join(' '));
			if (joined) return joined;
		}
	}
	const isSelf = self === el && rules.selfRefContent;
	const native = (): string => {
		if (CONTROLS.has(el.tag) && !ctx.inContent) {
			const placeholder = squash(attr(el, 'placeholder') ?? '');
			if (rules.placeholderAsName && placeholder) return placeholder;
			const text = squash(
				doc
					.labelsOf(el)
					.map((l) => contentOf(l, doc, rules, ctx))
					.join(' ')
			);
			if (text) return text;
			return squash(attr(el, 'title') ?? '') || placeholder;
		}
		if (el.tag === 'img') return rules.imgAltIgnored && ctx.inContent ? '' : squash(attr(el, 'alt') ?? '');
		return '';
	};
	if (rules.labelOverAriaLabel) {
		const n = native();
		if (n) return n;
	}
	if (ariaLabel && !isSelf) return ariaLabel;
	const n = native();
	if (n || CONTROLS.has(el.tag) || el.tag === 'img')
		return n || (el.tag === 'img' && !ctx.inContent ? squash(attr(el, 'title') ?? '') : '');
	// Whether the role takes its name from content; a section is a region or generic, neither of which does.
	const r = el.tag === 'section' ? 'generic' : role(el, doc, rules);
	const fromContent =
		FROM_CONTENT.has(r) || ctx.referenced || ctx.inContent || el.tag === 'label' || rules.contentForAllRoles;
	const title = squash(attr(el, 'title') ?? '');
	if (rules.titleOverContent && title && !ctx.inContent) return title;
	if (fromContent) {
		const text = contentOf(el, doc, rules, ctx);
		if (text) return text;
	}
	return ctx.inContent ? '' : title;
}

function contentOf(el: El, doc: Doc, rules: Rules, ctx: Ctx): string {
	const inner: Ctx = { ...ctx, inContent: true };
	return squash(
		el.children
			.map((c) => {
				if (!isEl(c)) return c;
				if (CONTROLS.has(c.tag)) return '';
				return textAlternative(c, doc, rules, inner, null);
			})
			.join('')
	);
}

function name(el: El, doc: Doc, rules: Rules): string {
	return textAlternative(el, doc, rules, { referenced: false, inContent: false, following: new Set() }, null);
}

function description(el: El, doc: Doc, rules: Rules): string {
	const describedby = attr(el, 'aria-describedby');
	if (describedby !== null) {
		const parts = describedby
			.split(/\s+/)
			.filter(Boolean)
			.map((id) => {
				const ref = doc.byId.get(id);
				if (!ref || (hidden(ref) && rules.hiddenRefSkipped)) return '';
				return textAlternative(ref, doc, rules, { referenced: true, inContent: false, following: new Set() }, null);
			});
		const text = squash(parts.join(' '));
		if (text) return text;
	}
	const title = squash(attr(el, 'title') ?? '');
	if (!title || rules.titleIgnoredForDescription) return '';
	// The title describes the element only when the name came from elsewhere.
	const withoutTitle = name({ ...el, attrs: el.attrs.filter(([k]) => k !== 'title') }, doc, rules);
	return withoutTitle ? title : '';
}

const EMPTY = '(пусто)';

function answerOf(p: Params, rules: Rules): string[] {
	const doc = new Doc(p.nodes);
	return p.queries.map((q) => {
		const el = doc.byId.get(q.id);
		if (!el) throw new Error(`no element #${q.id}`);
		if (q.kind === 'role') return role(el, doc, rules);
		const text = q.kind === 'name' ? name(el, doc, rules) : description(el, doc, rules);
		return text || EMPTY;
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Widgets: fragments of a page with the elements the item asks about.

const h = (tag: string, attrs: [string, string | null][], ...children: Node[]): El => ({ tag, attrs, children });

interface Widget {
	nodes: Node[];
	queries: Query[];
}

/** Unique ids for one page: a word and a counter. */
class Ids {
	#n = 0;
	readonly #rng: Rng;
	readonly #used = new Set<string>();

	constructor(rng: Rng) {
		this.#rng = rng;
	}

	next(stem: string): string {
		let id = stem;
		while (this.#used.has(id)) id = `${stem}-${(this.#n += 1)}`;
		this.#used.add(id);
		return id;
	}

	get rng(): Rng {
		return this.#rng;
	}

	/** An entry of a pool whose stem (its first field) this page has not used yet, if there is one. */
	fresh<T extends readonly [string, ...string[]]>(pool: readonly T[]): T {
		const unused = pool.filter((entry) => !this.#used.has(entry[0]));
		return this.#rng.pick(unused.length ? unused : pool);
	}
}

const FIELDS = [
	['email', 'Электронная почта', 'name@mail.ru'],
	['phone', 'Телефон', '+7 900 000-00-00'],
	['city', 'Город доставки', 'Например, Казань'],
	['promo', 'Промокод', 'SALE2026'],
	['nick', 'Имя в профиле', 'ivan_petrov']
] as const;
const CHECKS = [
	['agree', 'Согласен с', 'условиями'],
	['news', 'Подписаться на', 'рассылку'],
	['save', 'Запомнить', 'меня'],
	['gift', 'Упаковать как', 'подарок']
] as const;
const PICTURES = [
	['logo', 'Логотип магазина', 'Перейти на главную'],
	['avatar', 'Фото профиля', 'Сменить фото'],
	['map', 'Карта пунктов выдачи', 'Открыть карту'],
	['chart', 'График продаж за неделю', 'Увеличить']
] as const;
const ACTIONS = [
	['close', 'Закрыть', 'окно'],
	['send', 'Отправить', 'заявку'],
	['buy', 'Купить', 'сейчас'],
	['next', 'Далее', 'к оплате']
] as const;
const MEASURES = [
	['amount', 'Сумма', 'Сумма перевода', 'в рублях'],
	['weight', 'Вес', 'Вес посылки', 'в килограммах'],
	['term', 'Срок', 'Срок доставки', 'в днях'],
	['length', 'Длина', 'Длина отреза', 'в метрах']
] as const;
const CAPTIONS = [
	['report', 'Скачать отчёт', 'Формат PDF, 2 МБ'],
	['invoice', 'Оплатить счёт', 'Счёт № 15 от 5 октября'],
	['order', 'Открыть заказ', 'Заказ от 1 октября'],
	['ticket', 'Вернуть билет', 'Возврат до отправления']
] as const;
const TOPICS = ['Доставка', 'Отзывы', 'Тарифы', 'Вопросы и ответы', 'Контакты', 'Новинки'];

function labelFor(ids: Ids, variant: 'plain' | 'placeholder' | 'aria-label' | 'textarea'): Widget {
	const rng = ids.rng;
	const [stem, label, hint] = ids.fresh(FIELDS);
	const id = ids.next(stem);
	const attrs: [string, string | null][] = [['id', id]];
	if (variant !== 'textarea') attrs.push(['type', 'text']);
	if (variant === 'placeholder' || variant === 'aria-label') attrs.push(['placeholder', hint]);
	if (variant === 'aria-label') attrs.push(['aria-label', `${label} получателя`]);
	const control = variant === 'textarea' ? h('textarea', attrs) : h('input', attrs);
	return {
		nodes: [h('label', [['for', id]], label), ' ', control],
		queries: [{ kind: 'name', id }, ...(rng.bool(0.4) ? [{ kind: 'role' as const, id }] : [])]
	};
}

function wrappedCheckbox(ids: Ids): Widget {
	const [stem, text, bold] = ids.fresh(CHECKS);
	const id = ids.next(stem);
	return {
		nodes: [
			h(
				'label',
				[],
				h('input', [
					['type', 'checkbox'],
					['id', id]
				]),
				` ${text} `,
				h('b', [], bold)
			)
		],
		queries: [
			{ kind: 'name', id },
			{ kind: 'role', id }
		]
	};
}

function picture(ids: Ids, variant: 'alt' | 'alt-title' | 'aria-label' | 'title-only'): Widget {
	const [stem, alt, extra] = ids.fresh(PICTURES);
	const id = ids.next(stem);
	const attrs: [string, string | null][] = [
		['id', id],
		['src', `${stem}.png`]
	];
	if (variant !== 'title-only') attrs.push(['alt', alt]);
	if (variant === 'alt-title' || variant === 'title-only')
		attrs.push(['title', variant === 'title-only' ? alt : extra]);
	if (variant === 'aria-label') attrs.push(['aria-label', extra]);
	return { nodes: [h('img', attrs)], queries: [{ kind: 'name', id }] };
}

function contentButton(ids: Ids, variant: 'icon-hidden' | 'img-alt' | 'hidden-word'): Widget {
	const rng = ids.rng;
	const [stem, verb, object] = ids.fresh(ACTIONS);
	const id = ids.next(stem);
	const tag = rng.bool(0.5) ? 'button' : 'a';
	const attrs: [string, string | null][] =
		tag === 'a'
			? [
					['id', id],
					['href', `/${stem}`]
				]
			: [['id', id]];
	let children: Node[];
	if (variant === 'icon-hidden')
		children = [h('span', [['aria-hidden', 'true']], '→'), ` ${verb} `, h('span', [['hidden', null]], object)];
	else if (variant === 'img-alt')
		children = [
			h('img', [
				['src', `${stem}.svg`],
				['alt', verb]
			]),
			' ',
			h('span', [], object)
		];
	else
		children = [
			`${verb} `,
			h('span', [['aria-hidden', 'true']], object),
			' ',
			h('b', [], rng.pick(['сегодня', 'бесплатно', 'онлайн']))
		];
	return {
		nodes: [h(tag, attrs, ...children)],
		queries: [{ kind: 'name', id }, ...(rng.bool(0.3) ? [{ kind: 'role' as const, id }] : [])]
	};
}

function heading(ids: Ids): Widget {
	const rng = ids.rng;
	const id = ids.next('title');
	return {
		nodes: [
			h(
				'h2',
				[['id', id]],
				`${rng.pick(TOPICS)} `,
				h('small', [], rng.pick(['от 990 ₽', 'за 2 часа', 'по всей России']))
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function labelledButton(ids: Ids): Widget {
	const rng = ids.rng;
	const [stem, verb, object] = ids.fresh(ACTIONS);
	const id = ids.next(stem);
	const a = ids.next(`${stem}-verb`);
	const b = ids.next(`${stem}-object`);
	return {
		nodes: [
			h('span', [['id', a]], verb),
			' ',
			h(
				'span',
				[
					['id', b],
					['hidden', null]
				],
				object
			),
			' ',
			h(
				'button',
				[
					['id', id],
					['aria-label', rng.pick(['Ок', 'Готово', 'Действие'])],
					['aria-labelledby', `${a} ${b}`]
				],
				'→'
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function labelledInput(ids: Ids): Widget {
	const [stem, label, title, unit] = ids.fresh(MEASURES);
	const id = ids.next(stem);
	const a = ids.next(`${stem}-title`);
	const b = ids.next(`${stem}-unit`);
	return {
		nodes: [
			h('label', [['for', id]], label),
			' ',
			h('input', [
				['id', id],
				['type', 'text'],
				['aria-labelledby', `${a} ${b}`]
			]),
			' ',
			h('span', [['id', a]], title),
			' ',
			h('span', [['id', b]], unit)
		],
		queries: [{ kind: 'name', id }]
	};
}

function labelledSection(ids: Ids, named: boolean): Widget {
	const rng = ids.rng;
	const id = ids.next('section');
	const head = ids.next('section-title');
	const topic = rng.pick(TOPICS);
	const attrs: [string, string | null][] = named
		? [
				['id', id],
				['aria-labelledby', head]
			]
		: [['id', id]];
	return {
		nodes: [h('section', attrs, h('h3', named ? [['id', head]] : [], topic), ' ', h('p', [], 'Подробности ниже.'))],
		queries: [
			{ kind: 'role', id },
			{ kind: 'name', id }
		]
	};
}

function titled(ids: Ids, variant: 'icon-button' | 'link'): Widget {
	const rng = ids.rng;
	const [stem, verb, object] = ids.fresh(ACTIONS);
	const id = ids.next(stem);
	const tip = rng.pick(['Подсказка: горячая клавиша Enter', 'Откроется в новом окне', 'Действие нельзя отменить']);
	if (variant === 'icon-button') {
		return {
			nodes: [
				h(
					'button',
					[
						['id', id],
						['title', `${verb} ${object}`]
					],
					h('img', [
						['src', `${stem}.svg`],
						['alt', '']
					])
				)
			],
			queries: [{ kind: 'name', id }]
		};
	}
	return {
		nodes: [
			h(
				'a',
				[
					['id', id],
					['href', `/${stem}`],
					['title', tip]
				],
				`${verb} ${object}`
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function chained(ids: Ids): Widget {
	const [stem, caption, details] = ids.fresh(CAPTIONS);
	const first = ids.next(`${stem}-caption`);
	const second = ids.next(`${stem}-details`);
	const id = ids.next(stem);
	return {
		nodes: [
			h(
				'span',
				[
					['id', first],
					['aria-labelledby', second]
				],
				caption
			),
			' ',
			h('span', [['id', second]], details),
			' ',
			h(
				'button',
				[
					['id', id],
					['aria-labelledby', first]
				],
				'…'
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function selfReferenced(ids: Ids): Widget {
	const rng = ids.rng;
	const id = ids.next('remove');
	const file = ids.next('file');
	const verb = rng.pick(['Удалить', 'Скачать', 'Переименовать']);
	return {
		nodes: [
			h('span', [['id', file]], rng.pick(['отчёт.pdf', 'договор.docx', 'фото.jpg'])),
			' ',
			h(
				'button',
				[
					['id', id],
					['aria-label', verb],
					['aria-labelledby', `${id} ${file}`]
				],
				'×'
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function described(ids: Ids, hiddenHint: boolean): Widget {
	const rng = ids.rng;
	const [stem, label] = ids.fresh(FIELDS);
	const id = ids.next(stem);
	const hint = ids.next(`${stem}-hint`);
	const hintAttrs: [string, string | null][] = hiddenHint
		? [
				['id', hint],
				['hidden', null]
			]
		: [['id', hint]];
	return {
		nodes: [
			h('label', [['for', id]], label),
			' ',
			h('input', [
				['id', id],
				['type', 'text'],
				['aria-describedby', hint],
				['title', 'Поле обязательно']
			]),
			' ',
			h('span', hintAttrs, rng.pick(['Не больше 40 символов', 'Только цифры', 'Проверим перед отправкой']))
		],
		queries: [
			{ kind: 'name', id },
			{ kind: 'description', id }
		]
	};
}

function titleDescribed(ids: Ids): Widget {
	const rng = ids.rng;
	const [stem, verb, object] = ids.fresh(ACTIONS);
	const id = ids.next(stem);
	return {
		nodes: [
			h(
				'button',
				[
					['id', id],
					['title', rng.pick(['Сочетание клавиш Ctrl+S', 'Изменения сохранятся в черновик'])]
				],
				`${verb} ${object}`
			)
		],
		queries: [
			{ kind: 'name', id },
			{ kind: 'description', id }
		]
	};
}

function authorOnly(ids: Ids, kind: 'nav' | 'nav-label' | 'list' | 'dialog'): Widget {
	const rng = ids.rng;
	if (kind === 'nav' || kind === 'nav-label') {
		const id = ids.next('menu');
		const attrs: [string, string | null][] =
			kind === 'nav-label'
				? [
						['id', id],
						['aria-label', rng.pick(['Основное меню', 'Разделы сайта'])]
					]
				: [['id', id]];
		return {
			nodes: [h('nav', attrs, h('a', [['href', '/']], 'Главная'), ' ', h('a', [['href', '/catalog']], 'Каталог'))],
			queries: [
				{ kind: 'role', id },
				{ kind: 'name', id }
			]
		};
	}
	if (kind === 'list') {
		const id = ids.next('steps');
		return {
			nodes: [h('ul', [['id', id]], h('li', [], 'Выбор'), ' ', h('li', [], 'Оплата'))],
			queries: [{ kind: 'name', id }]
		};
	}
	const id = ids.next('dialog');
	return {
		nodes: [
			h(
				'div',
				[
					['id', id],
					['role', 'dialog']
				],
				h('h2', [], rng.pick(TOPICS)),
				' ',
				h('p', [], 'Текст окна.')
			)
		],
		queries: [{ kind: 'name', id }]
	};
}

function hiddenMix(ids: Ids): Widget {
	const rng = ids.rng;
	const id = ids.next('pay');
	const hiddenRef = ids.next('pay-sum');
	const visibleRef = ids.next('pay-label');
	const desc = ids.next('pay-note');
	return {
		nodes: [
			h('span', [['id', visibleRef]], 'Оплатить ', h('span', [['aria-hidden', 'true']], '★'), ' заказ'),
			' ',
			h(
				'span',
				[
					['id', hiddenRef],
					['hidden', null]
				],
				rng.pick(['1 990 ₽', '4 500 ₽', '760 ₽'])
			),
			' ',
			h(
				'span',
				[
					['id', desc],
					['aria-hidden', 'true']
				],
				rng.pick(['Комиссия 0 ₽', 'Без комиссии', 'Кешбэк 5%'])
			),
			' ',
			h(
				'button',
				[
					['id', id],
					['aria-labelledby', `${visibleRef} ${hiddenRef}`],
					['aria-describedby', desc]
				],
				'Оплата'
			)
		],
		queries: [
			{ kind: 'name', id },
			{ kind: 'description', id }
		]
	};
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const ids = new Ids(rng);
	let widgets: Widget[];
	if (grade === 'junior') {
		if (classId === 'label-sources') {
			widgets = [
				labelFor(ids, 'aria-label'),
				labelFor(ids, 'placeholder'),
				rng.bool(0.5) ? wrappedCheckbox(ids) : labelFor(ids, 'textarea'),
				picture(ids, rng.pick(['alt', 'alt-title', 'aria-label']))
			];
		} else if (classId === 'content') {
			widgets = [
				contentButton(ids, 'icon-hidden'),
				contentButton(ids, 'img-alt'),
				rng.bool(0.5) ? contentButton(ids, 'hidden-word') : heading(ids),
				rng.bool(0.5) ? heading(ids) : picture(ids, 'alt')
			];
		} else if (classId === 'labelledby') {
			widgets = [
				labelledButton(ids),
				labelledInput(ids),
				labelledSection(ids, true),
				...(rng.bool(0.5) ? [labelFor(ids, 'plain')] : [])
			];
		} else {
			widgets = [
				titled(ids, 'icon-button'),
				titled(ids, 'link'),
				picture(ids, 'title-only'),
				...(rng.bool(0.5) ? [contentButton(ids, 'icon-hidden')] : [])
			];
		}
	} else if (classId === 'labelledby-recursion') {
		widgets = [chained(ids), selfReferenced(ids), rng.bool(0.5) ? labelledButton(ids) : labelledInput(ids)];
	} else if (classId === 'describedby') {
		widgets = [described(ids, rng.bool(0.5)), titleDescribed(ids), described(ids, true)];
	} else if (classId === 'author-only') {
		widgets = [
			authorOnly(ids, rng.pick(['nav', 'nav-label'])),
			labelledSection(ids, false),
			authorOnly(ids, rng.pick(['list', 'dialog'])),
			...(rng.bool(0.5) ? [labelledSection(ids, true)] : [])
		];
	} else {
		widgets = [hiddenMix(ids), contentButton(ids, 'icon-hidden'), described(ids, true)];
	}
	widgets = rng.shuffle(widgets);
	const nodes = widgets.flatMap((w) => [h('div', [], ...w.nodes)]);
	return { nodes, queries: widgets.flatMap((w) => w.queries) };
}

const REQUIRED: Record<string, string[]> = {
	'junior/label-sources': ['label-over-aria-label', 'placeholder-as-name'],
	'junior/content': ['hidden-included', 'img-alt-ignored'],
	'junior/labelledby': ['aria-label-over-labelledby', 'hidden-ref-skipped', 'first-id-only'],
	'junior/title-fallback': ['title-over-content'],
	'middle/labelledby-recursion': ['labelledby-followed', 'self-ref-content'],
	'middle/describedby': ['hidden-ref-skipped', 'title-ignored-for-description'],
	'middle/author-only': ['content-for-all-roles', 'section-always-region'],
	'middle/hidden-mix': ['hidden-included', 'hidden-ref-skipped']
};

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

const VOID = new Set(['input', 'img']);

function render(n: Node, depth: number): string[] {
	const pad = '  '.repeat(depth);
	if (!isEl(n)) return [];
	const attrs = n.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${v}"`)).join('');
	if (VOID.has(n.tag)) return [`${pad}<${n.tag}${attrs}>`];
	const inline = (c: Node): string => {
		if (!isEl(c)) return c;
		const a = c.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${v}"`)).join('');
		return VOID.has(c.tag) ? `<${c.tag}${a}>` : `<${c.tag}${a}>${c.children.map(inline).join('')}</${c.tag}>`;
	};
	if (n.tag === 'div' && n.attrs.length === 0)
		return [`${pad}<div>`, ...n.children.flatMap((c) => (isEl(c) ? [`${pad}  ${inline(c)}`] : [])), `${pad}</div>`];
	return [`${pad}${inline(n)}`];
}

const html = (p: Params): string => p.nodes.flatMap((n) => render(n, 0)).join('\n');

const KIND_TEXT: Record<QueryKind, string> = { role: 'роль', name: 'доступное имя', description: 'доступное описание' };

function describe(p: Params): string {
	return [
		'Фрагмент страницы:',
		'',
		'```html',
		html(p),
		'```',
		'',
		'Считаем: других стилей и скриптов нет, `hidden` скрывает элемент, браузер и вспомогательные технологии следуют спецификациям Accessible Name and Description Computation 1.2 и HTML-AAM.',
		'',
		'Ответьте на вопросы по порядку:',
		'',
		...p.queries.map((q, i) => `${i + 1}. ${KIND_TEXT[q.kind]} элемента \`#${q.id}\`;`),
		'',
		`Введите ${p.queries.length} строк — по строке на вопрос. Роль — имя роли ARIA по умолчанию строчными буквами (например, \`button\`). Имя и описание — текстом без кавычек, пробелы между словами одиночные; если имени или описания нет — \`${EMPTY}\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import re
import sys
from html.parser import HTMLParser

data = json.loads(sys.stdin.read())
VOID = {"input", "img"}


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent, self.kids = tag, dict(attrs), parent, []


class Dom(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", [], None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.kids.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_endtag(self, tag):
        if tag not in VOID:
            self.cur = self.cur.parent

    def handle_data(self, text):
        self.cur.kids.append(text)


dom = Dom()
dom.feed(data["html"])
nodes = []


def collect(n):
    for k in n.kids:
        if isinstance(k, Node):
            nodes.append(k)
            collect(k)


collect(dom.root)
by_id = {n.attrs["id"]: n for n in nodes if "id" in n.attrs}


def flat(s):
    return re.sub(r"\\s+", " ", s).strip()


def is_hidden(n):
    return "hidden" in n.attrs or n.attrs.get("aria-hidden") == "true"


def labels_for(n):
    out = []
    for lab in (x for x in nodes if x.tag == "label"):
        if n.attrs.get("id") is not None and lab.attrs.get("for") == n.attrs.get("id"):
            out.append(lab)
            continue
        up = n.parent
        while up is not None:
            if up is lab:
                out.append(lab)
                break
            up = up.parent
    return out


def default_role(n):
    if "role" in n.attrs:
        return n.attrs["role"]
    t = n.tag
    if t == "button":
        return "button"
    if t == "a":
        return "link" if "href" in n.attrs else "generic"
    if t == "input":
        return "checkbox" if n.attrs.get("type") == "checkbox" else "textbox"
    if t == "textarea":
        return "textbox"
    if t == "img":
        return "img"
    if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
        return "heading"
    if t == "nav":
        return "navigation"
    if t == "ul":
        return "list"
    if t == "section":
        return "region" if accessible_name(n) else "generic"
    return "generic"


def from_children(n):
    parts = []
    for k in n.kids:
        if isinstance(k, str):
            parts.append(k)
        elif k.tag in ("input", "textarea"):
            continue
        else:
            parts.append(alt_text(k, walking=True, via_relation=False, seen=frozenset()))
    return flat("".join(parts))


def alt_text(n, walking, via_relation, seen):
    # 2A: hidden nodes do not take part in a walk over content.
    if walking and is_hidden(n):
        return ""
    # 2B: aria-labelledby, unless this node was itself reached through a relation.
    refs = n.attrs.get("aria-labelledby")
    if refs and not via_relation and n not in seen:
        texts = []
        for ref_id in refs.split():
            ref = by_id.get(ref_id)
            if ref is not None:
                texts.append(alt_text(ref, walking=False, via_relation=True, seen=seen | {n}))
        joined = flat(" ".join(texts))
        if joined:
            return joined
    # 2D: aria-label.
    label = flat(n.attrs.get("aria-label", ""))
    if label:
        return label
    # 2E: the host language.
    if n.tag in ("input", "textarea") and not walking:
        text = flat(" ".join(from_children(lab) for lab in labels_for(n)))
        return text or flat(n.attrs.get("title", "")) or flat(n.attrs.get("placeholder", ""))
    if n.tag == "img":
        return flat(n.attrs.get("alt", "")) or ("" if walking else flat(n.attrs.get("title", "")))
    # 2F: content, for roles named from content, for referenced nodes and inside a walk.
    named_by_content = n.tag in ("button", "h1", "h2", "h3", "h4", "h5", "h6") or (n.tag == "a" and "href" in n.attrs)
    if "role" in n.attrs:
        named_by_content = n.attrs["role"] in ("button", "link", "heading")
    if walking or via_relation or n.tag == "label" or named_by_content:
        text = from_children(n)
        if text:
            return text
    # 2I: the tooltip.
    return "" if walking else flat(n.attrs.get("title", ""))


def accessible_name(n):
    return alt_text(n, walking=False, via_relation=False, seen=frozenset())


def accessible_description(n):
    refs = n.attrs.get("aria-describedby")
    if refs:
        text = flat(" ".join(alt_text(by_id[r], walking=False, via_relation=True, seen=frozenset()) for r in refs.split() if r in by_id))
        if text:
            return text
    title = flat(n.attrs.get("title", ""))
    if not title:
        return ""
    attrs = dict(n.attrs)
    del n.attrs["title"]
    name_without = accessible_name(n)
    n.attrs = attrs
    return title if name_without else ""


out = []
for q in data["queries"]:
    n = by_id[q["id"]]
    if q["kind"] == "role":
        out.append(default_role(n))
    elif q["kind"] == "name":
        out.append(accessible_name(n) or "${EMPTY}")
    else:
        out.append(accessible_description(n) or "${EMPTY}")
print("\\n".join(out))
`;

interface Scenario {
	p: Params;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function evaluate(p: Params, required: readonly string[]): Scenario | null {
	const answer = answerOf(p, RIGHT);
	const key = answer.join('\n');
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = answerOf(p, { ...RIGHT, ...change });
			return [id, value.join('\n') === key ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { p, answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let chosen: Scenario | null = null;
	for (let tries = 0; tries < 200 && chosen === null; tries += 1)
		chosen = evaluate(scenario(rng, input.grade, input.classId), required);
	// Widgets are built to expose the class's misconceptions, so the draw settles at once; a further draw without the
	// requirement keeps the generator total.
	chosen ??= evaluate(scenario(rng, input.grade, input.classId), []) as Scenario;
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p), code: null },
		answer: { kind: 'sequence', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ html: html(p), queries: p.queries })
		}),
		wrong: () =>
			Object.fromEntries(
				Object.keys(WRONG).map((id) => {
					const value = wrong[id] ?? null;
					return [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
