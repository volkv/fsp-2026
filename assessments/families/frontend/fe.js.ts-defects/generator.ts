// A TypeScript module of a frontend client, each function with its specification in a doc comment; exactly one line
// breaks its function's specification, and the types do not catch it: an `as` cast of server data, a `!`, an index
// without a check, the order of spreads, `Object.keys`, dates compared as objects. On the senior level the defect sits
// at the boundary of two modules or shows up only on a rare combination of data. The candidate names the line. The
// gate erases the types, runs the module with the checks of every function appended: it fails, passes with the defect
// line fixed, and still fails when a trap line is changed instead.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeDefectProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** A change of one line: the exact original text and what replaces it. */
interface Change {
	from: string;
	to: string;
}

interface Defect extends Change {
	kind: string;
	/** Another line of the same function and the change a candidate would make there. */
	neighbour: Change;
	/** A line of another function of the unit where the defect shows up, with the change that treats the symptom. */
	symptom?: Change;
	/** Other lines whose one-instruction change also restores the specification: accepted answers. */
	alternatives?: Change[];
}

/** A group of declarations and functions with the checks of their specifications. */
interface Unit {
	lines: string[];
	/** JavaScript statements that throw when the specification is broken; `__eq` compares JSON forms. */
	checks: string[];
	defects: Defect[];
	/** A correct line that looks suspicious, with a plausible change: the trap when the unit is shown without a defect. */
	decoy: Change;
}

const MIDDLE: Unit[] = [
	{
		lines: [
			'/** Цены последних просмотренных товаров из localStorage: JSON-массив строк вида "1290"; результат — числа. */',
			'function recentPrices(stored: string): number[] {',
			'  return (JSON.parse(stored) as string[]).map(Number);',
			'}',
			'',
			'/** Средняя цена; для пустого списка — 0. */',
			'function averagePrice(prices: number[]): number {',
			'  if (prices.length === 0) return 0;',
			'  return prices.reduce((sum, p) => sum + p, 0) / prices.length;',
			'}'
		],
		checks: [
			'__eq(recentPrices(\'["1290","990"]\'), [1290, 990]);',
			'__eq(averagePrice(recentPrices(\'["100","300"]\')), 200);',
			'__eq(averagePrice([]), 0);'
		],
		defects: [
			{
				kind: 'cast',
				from: '  return (JSON.parse(stored) as string[]).map(Number);',
				to: '  return JSON.parse(stored) as number[];',
				neighbour: {
					from: 'function recentPrices(stored: string): number[] {',
					to: "function recentPrices(stored: string = '[]'): number[] {"
				},
				symptom: {
					from: '  return prices.reduce((sum, p) => sum + p, 0) / prices.length;',
					to: '  return prices.reduce((sum, p) => sum + Number(p), 0) / prices.length;'
				}
			}
		],
		decoy: { from: '  if (prices.length === 0) return 0;', to: '  if (!prices.length) return 0;' }
	},
	{
		lines: [
			'interface Pager {',
			'  page: number;',
			'  size: number;',
			'}',
			'',
			'/**',
			' * Пагинация из sessionStorage. Прежняя версия записывала поля строками: {"page":"2","size":"20"};',
			' * результат — числа.',
			' */',
			'function restorePager(raw: string): Pager {',
			"  return JSON.parse(raw, (key, value) => (key === '' ? value : Number(value))) as Pager;",
			'}',
			'',
			'/** Номер следующей страницы. */',
			'function nextPage(p: Pager): number {',
			'  return p.page + 1;',
			'}',
			'',
			'/** Смещение первой записи страницы. */',
			'function offsetOf(p: Pager): number {',
			'  return (p.page - 1) * p.size;',
			'}'
		],
		checks: [
			'const pager = restorePager(\'{"page":"2","size":"20"}\');',
			'__eq(pager, { page: 2, size: 20 });',
			'__eq(nextPage(pager), 3);',
			'__eq(offsetOf(pager), 20);',
			'__eq(pager.size + 1, 21);'
		],
		defects: [
			{
				kind: 'cast',
				from: "  return JSON.parse(raw, (key, value) => (key === '' ? value : Number(value))) as Pager;",
				to: "  return JSON.parse(raw, (key, value) => (key === 'page' ? Number(value) : value)) as Pager;",
				neighbour: {
					from: 'function restorePager(raw: string): Pager {',
					to: "function restorePager(raw: string = '{}'): Pager {"
				},
				symptom: { from: '  return p.page + 1;', to: '  return Number(p.page) + 1;' }
			}
		],
		decoy: { from: '  return (p.page - 1) * p.size;', to: '  return p.page * p.size - p.size;' }
	},
	{
		lines: [
			'interface User {',
			'  id: number;',
			'  name: string;',
			'  roles: string[];',
			'}',
			'',
			'/** Пользователь из ответа API; поле roles может отсутствовать — тогда пустой список. */',
			'function parseUser(body: string): User {',
			'  const data = JSON.parse(body) as Partial<User>;',
			"  return { id: data.id ?? 0, name: data.name ?? '', roles: data.roles ?? [] };",
			'}',
			'',
			'/** Есть ли у пользователя роль admin. */',
			'function isAdmin(user: User): boolean {',
			"  return user.roles.includes('admin');",
			'}'
		],
		checks: [
			'__eq(parseUser(\'{"id":5,"name":"Ann"}\'), { id: 5, name: \'Ann\', roles: [] });',
			'__eq(isAdmin(parseUser(\'{"id":5,"name":"Ann"}\')), false);',
			'__eq(isAdmin(parseUser(\'{"id":1,"name":"Bo","roles":["admin"]}\')), true);'
		],
		defects: [
			{
				kind: 'non-null',
				from: "  return { id: data.id ?? 0, name: data.name ?? '', roles: data.roles ?? [] };",
				to: '  return { id: data.id!, name: data.name!, roles: data.roles! };',
				neighbour: {
					from: 'function parseUser(body: string): User {',
					to: "function parseUser(body: string = '{}'): User {"
				},
				alternatives: [
					{
						from: '  const data = JSON.parse(body) as Partial<User>;',
						to: "  const data = { id: 0, name: '', roles: [], ...JSON.parse(body) } as Partial<User>;"
					}
				],
				symptom: {
					from: "  return user.roles.includes('admin');",
					to: "  return user.roles?.includes('admin') ?? false;"
				}
			}
		],
		decoy: { from: "  return user.roles.includes('admin');", to: "  return user.roles.indexOf('admin') > 0;" }
	},
	{
		lines: [
			'interface Order {',
			'  id: string;',
			"  status: 'new' | 'paid' | 'shipped';",
			'  total: number;',
			'}',
			'',
			'/** Последний оплаченный заказ или null, если оплаченных нет. */',
			'function lastPaid(orders: Order[]): Order | null {',
			"  const paid = orders.filter((o) => o.status === 'paid');",
			'  return paid.length > 0 ? paid[paid.length - 1] : null;',
			'}',
			'',
			'/** Сумма заказа по id; неизвестный id — 0. */',
			'function orderTotal(orders: Order[], id: string): number {',
			'  return orders.find((o) => o.id === id)?.total ?? 0;',
			'}'
		],
		checks: [
			"const orders = [{ id: 'a1', status: 'paid', total: 300 }, { id: 'b2', status: 'new', total: 150 }, { id: 'c3', status: 'paid', total: 80 }];",
			"__eq(lastPaid(orders).id, 'c3');",
			'__eq(lastPaid([orders[1]]), null);',
			"__eq(orderTotal(orders, 'b2'), 150);",
			"__eq(orderTotal(orders, 'zz'), 0);"
		],
		defects: [
			{
				kind: 'non-null',
				from: '  return paid.length > 0 ? paid[paid.length - 1] : null;',
				to: '  return paid[paid.length - 1];',
				neighbour: {
					from: 'function lastPaid(orders: Order[]): Order | null {',
					to: 'function lastPaid(orders: readonly Order[]): Order | null {'
				},
				alternatives: [
					{
						from: "  const paid = orders.filter((o) => o.status === 'paid');",
						to: "  const paid = [null, ...orders.filter((o) => o.status === 'paid')];"
					}
				]
			},
			{
				kind: 'non-null',
				from: '  return orders.find((o) => o.id === id)?.total ?? 0;',
				to: '  return orders.find((o) => o.id === id)!.total;',
				neighbour: {
					from: 'function orderTotal(orders: Order[], id: string): number {',
					to: "function orderTotal(orders: Order[], id: string = ''): number {"
				}
			}
		],
		decoy: {
			from: '  return paid.length > 0 ? paid[paid.length - 1] : null;',
			to: '  return paid.length > 0 ? paid[0] : null;'
		}
	},
	{
		lines: [
			'interface Draft {',
			'  id?: string;',
			'  title: string;',
			'  tags: string[];',
			'}',
			'',
			'interface Saved {',
			'  id: string;',
			'  title: string;',
			'  tags: string[];',
			'  createdAt: string;',
			'}',
			'',
			'/** Сохранённая запись: новый id и дата создания; id черновика (скопированного с другой записи) не сохраняется. */',
			'function save(draft: Draft, id: string, now: string): Saved {',
			'  return { ...draft, id, createdAt: now };',
			'}',
			'',
			'/** Черновик для редактирования копии: только название и теги (новый массив), без id и даты. */',
			'function toDraft(saved: Saved): Draft {',
			'  return { title: saved.title, tags: [...saved.tags] };',
			'}'
		],
		checks: [
			"__eq(save({ id: 'old', title: 'T', tags: [] }, 'new', '2026-10-05'), { id: 'new', title: 'T', tags: [], createdAt: '2026-10-05' });",
			"const saved = save({ title: 'A', tags: ['x'] }, 'n1', '2026-01-01');",
			'const draft = toDraft(saved);',
			"__eq(draft, { title: 'A', tags: ['x'] });",
			"draft.tags.push('y');",
			"__eq(saved.tags, ['x']);",
			"__eq(save(saved, 'n2', '2026-02-02'), { id: 'n2', title: 'A', tags: ['x'], createdAt: '2026-02-02' });",
			"const extended = { id: 'o', title: 'B', tags: [], createdAt: 'd', pinned: true };",
			"__eq(toDraft(extended), { title: 'B', tags: [] });"
		],
		defects: [
			{
				kind: 'spread',
				from: '  return { ...draft, id, createdAt: now };',
				to: '  return { id, createdAt: now, ...draft };',
				neighbour: { from: '  id?: string;', to: '  readonly id?: string;' },
				// Taking the stale id and date out of the draft in the parameter leaves only its own fields to spread.
				alternatives: [
					{
						from: 'function save(draft: Draft, id: string, now: string): Saved {',
						to: 'function save({ id: oldId, createdAt: oldDate, ...draft }: Draft & { createdAt?: string }, id: string, now: string): Saved {'
					}
				]
			},
			{
				kind: 'spread',
				from: '  return { title: saved.title, tags: [...saved.tags] };',
				to: '  return { ...saved, tags: [...saved.tags] };',
				neighbour: { from: '  createdAt: string;', to: '  readonly createdAt: string;' }
			}
		],
		decoy: {
			from: '  return { title: saved.title, tags: [...saved.tags] };',
			to: '  return { title: saved.title, tags: saved.tags };'
		}
	},
	{
		lines: [
			'interface ListOptions {',
			'  pageSize: number;',
			"  sort: 'date' | 'price';",
			'  dense: boolean;',
			'}',
			'',
			"const DEFAULT_LIST: ListOptions = { pageSize: 20, sort: 'date', dense: false };",
			'',
			'/**',
			' * Настройки списка: сохранённые пользователем значения поверх значений по умолчанию.',
			' * Несохранённой настройки в saved нет; полей со значением undefined в saved не бывает.',
			' */',
			'function listOptions(saved: Partial<ListOptions>): ListOptions {',
			'  return { ...DEFAULT_LIST, ...saved };',
			'}',
			'',
			'/** Сколько строк показать: pageSize, в плотном режиме — вдвое больше. */',
			'function visibleRows(options: ListOptions): number {',
			'  return options.dense ? options.pageSize * 2 : options.pageSize;',
			'}'
		],
		checks: [
			"__eq(listOptions({ sort: 'price', dense: true }), { pageSize: 20, sort: 'price', dense: true });",
			'__eq(visibleRows(listOptions({ dense: true })), 40);',
			"__eq(listOptions({}), { pageSize: 20, sort: 'date', dense: false });"
		],
		defects: [
			{
				kind: 'spread',
				from: '  return { ...DEFAULT_LIST, ...saved };',
				to: '  return { ...saved, ...DEFAULT_LIST };',
				neighbour: {
					from: 'function listOptions(saved: Partial<ListOptions>): ListOptions {',
					to: 'function listOptions(saved: Partial<ListOptions> = {}): ListOptions {'
				},
				symptom: {
					from: '  return options.dense ? options.pageSize * 2 : options.pageSize;',
					to: '  return options.pageSize * (options.dense ? 2 : 1);'
				}
			}
		],
		decoy: {
			from: '  return options.dense ? options.pageSize * 2 : options.pageSize;',
			to: '  return options.pageSize * (options.dense ? 2 : 1);'
		}
	},
	{
		lines: [
			'interface Totals {',
			'  base: number;',
			'  tax: number;',
			'  shipping: number;',
			'}',
			'',
			'/** Сумма полей base, tax и shipping; другие поля объекта не учитываются. */',
			'function sumTotals(t: Totals): number {',
			"  return (['base', 'tax', 'shipping'] as const).reduce((s, k) => s + t[k], 0);",
			'}',
			'',
			'/** Итог заказа; кроме полей Totals в заказе есть id и валюта. */',
			'function orderSum(order: Totals & { id: number; currency: string }): number {',
			'  return sumTotals(order);',
			'}'
		],
		checks: [
			"__eq(orderSum({ id: 7, base: 1000, tax: 200, shipping: 300, currency: 'RUB' }), 1500);",
			"__eq(sumTotals({ base: 1, tax: 2, shipping: 3, note: 'x' }), 6);"
		],
		defects: [
			{
				kind: 'keys-dates',
				from: "  return (['base', 'tax', 'shipping'] as const).reduce((s, k) => s + t[k], 0);",
				to: '  return (Object.keys(t) as (keyof Totals)[]).reduce((s, k) => s + t[k], 0);',
				neighbour: {
					from: 'function sumTotals(t: Totals): number {',
					to: 'function sumTotals(t: Readonly<Totals>): number {'
				},
				symptom: {
					from: '  return sumTotals(order);',
					to: '  return sumTotals({ base: order.base, tax: order.tax, shipping: order.shipping });'
				}
			}
		],
		decoy: { from: '  return sumTotals(order);', to: '  return sumTotals({ ...order });' }
	},
	{
		lines: [
			'interface Slot {',
			'  start: Date;',
			'  title: string;',
			'}',
			'',
			'/** Занято ли время at: есть слот, начинающийся в тот же момент. */',
			'function isBooked(slots: Slot[], at: Date): boolean {',
			'  return slots.some((s) => s.start.getTime() === at.getTime());',
			'}',
			'',
			'/** Ближайший слот, начинающийся не раньше from, или null. */',
			'function nextSlot(slots: Slot[], from: Date): Slot | null {',
			'  const later = slots.filter((s) => s.start >= from);',
			'  later.sort((a, b) => a.start.getTime() - b.start.getTime());',
			'  return later[0] ?? null;',
			'}'
		],
		checks: [
			"const slots = [{ start: new Date('2026-10-05T12:00:00Z'), title: 'b' }, { start: new Date('2026-10-05T10:00:00Z'), title: 'a' }];",
			"__eq(isBooked(slots, new Date('2026-10-05T10:00:00Z')), true);",
			"__eq(isBooked(slots, new Date('2026-10-05T11:00:00Z')), false);",
			"__eq(nextSlot(slots, new Date('2026-10-05T09:00:00Z')).title, 'a');",
			"__eq(nextSlot(slots, new Date('2026-10-05T12:00:00Z')).title, 'b');"
		],
		defects: [
			{
				kind: 'keys-dates',
				from: '  return slots.some((s) => s.start.getTime() === at.getTime());',
				to: '  return slots.some((s) => s.start === at);',
				neighbour: {
					from: 'function isBooked(slots: Slot[], at: Date): boolean {',
					to: 'function isBooked(slots: readonly Slot[], at: Date): boolean {'
				}
			},
			{
				kind: 'keys-dates',
				from: '  const later = slots.filter((s) => s.start >= from);',
				to: '  const later = slots.filter((s) => s.start > from || s.start === from);',
				neighbour: {
					from: '  later.sort((a, b) => a.start.getTime() - b.start.getTime());',
					to: '  later.sort((a, b) => (a.start > b.start ? 1 : -1));'
				}
			}
		],
		decoy: { from: '  return later[0] ?? null;', to: '  return later.at(0) ?? null;' }
	}
];

const SENIOR: Unit[] = [
	{
		lines: [
			'// --- storage.ts ---',
			'interface Session {',
			'  user: string;',
			'  expiresAt: Date;',
			'}',
			'',
			'/** Сессия строкой для localStorage. */',
			'function saveSession(s: Session): string {',
			'  return JSON.stringify(s);',
			'}',
			'',
			'/** Сессия из строки saveSession; expiresAt — снова Date. */',
			'function loadSession(raw: string): Session {',
			"  return JSON.parse(raw, (key, value) => (key === 'expiresAt' ? new Date(value) : value)) as Session;",
			'}',
			'',
			'// --- auth.ts ---',
			'/** Сессия действует, пока now раньше expiresAt. */',
			'function isActive(s: Session, now: Date): boolean {',
			'  return now.getTime() < s.expiresAt.getTime();',
			'}',
			'',
			'/** Пользователь сохранённой сессии или null, если сессия истекла. */',
			'function currentUser(raw: string, now: Date): string | null {',
			'  const s = loadSession(raw);',
			'  return isActive(s, now) ? s.user : null;',
			'}'
		],
		checks: [
			"const raw = saveSession({ user: 'ann', expiresAt: new Date('2026-10-05T12:00:00Z') });",
			'__eq(loadSession(raw).expiresAt instanceof Date, true);',
			"__eq(currentUser(raw, new Date('2026-10-05T11:00:00Z')), 'ann');",
			"__eq(currentUser(raw, new Date('2026-10-05T13:00:00Z')), null);"
		],
		defects: [
			{
				kind: 'module-boundary',
				from: "  return JSON.parse(raw, (key, value) => (key === 'expiresAt' ? new Date(value) : value)) as Session;",
				to: "  return JSON.parse(raw, (key, value) => (key === 'expiresAt' ? Date.parse(value) : value)) as Session;",
				neighbour: {
					from: 'function loadSession(raw: string): Session {',
					to: "function loadSession(raw: string = '{}'): Session {"
				},
				symptom: {
					from: '  return now.getTime() < s.expiresAt.getTime();',
					to: '  return now.getTime() < new Date(s.expiresAt).getTime();'
				}
			}
		],
		decoy: { from: '  const s = loadSession(raw);', to: '  const s = loadSession(raw.trim());' }
	},
	{
		lines: [
			'// --- api.ts ---',
			'interface Offer {',
			'  title: string;',
			'  priceKopecks: number;',
			'}',
			'',
			'/** Предложения из ответа API; цены — в копейках. */',
			'function parseOffers(body: string): Offer[] {',
			'  return JSON.parse(body) as Offer[];',
			'}',
			'',
			'// --- format.ts ---',
			"/** Цена в рублях с двумя знаками после запятой: 1234.5 → '1234,50 ₽'. */",
			'function formatRubles(rubles: number): string {',
			"  return rubles.toFixed(2).replace('.', ',') + ' ₽';",
			'}',
			'',
			'// --- view.ts ---',
			'/** Подписи предложений: «название — цена». */',
			'function offerLabels(body: string): string[] {',
			"  return parseOffers(body).map((o) => o.title + ' — ' + formatRubles(o.priceKopecks / 100));",
			'}'
		],
		checks: [
			"__eq(formatRubles(1234.5), '1234,50 ₽');",
			'__eq(offerLabels(\'[{"title":"Чай","priceKopecks":12990}]\'), [\'Чай — 129,90 ₽\']);'
		],
		defects: [
			{
				kind: 'module-boundary',
				from: "  return parseOffers(body).map((o) => o.title + ' — ' + formatRubles(o.priceKopecks / 100));",
				to: "  return parseOffers(body).map((o) => o.title + ' — ' + formatRubles(o.priceKopecks));",
				neighbour: {
					from: 'function offerLabels(body: string): string[] {',
					to: 'function offerLabels(body: string): readonly string[] {'
				},
				symptom: {
					from: "  return rubles.toFixed(2).replace('.', ',') + ' ₽';",
					to: "  return (rubles / 100).toFixed(2).replace('.', ',') + ' ₽';"
				}
			}
		],
		decoy: {
			from: "  return rubles.toFixed(2).replace('.', ',') + ' ₽';",
			to: "  return rubles.toFixed(2).replaceAll('.', ',') + ' ₽';"
		}
	},
	{
		lines: [
			'// --- api.ts ---',
			'interface Product {',
			'  id: number;',
			'  price: number;',
			'}',
			'',
			'/** Товары из ответа API; id и цены — числа. */',
			'function parseProducts(body: string): Product[] {',
			'  return JSON.parse(body) as Product[];',
			'}',
			'',
			'// --- url.ts ---',
			'/**',
			' * Id выбранных товаров из строки запроса ?ids=3,12,7 — числами, в том же порядке;',
			' * id в адресе — десятичные целые без ведущих нулей и пробелов.',
			' */',
			'function selectedIds(search: string): number[] {',
			"  const raw = new URLSearchParams(search).get('ids') ?? '';",
			"  return raw === '' ? [] : raw.split(',').map(Number);",
			'}',
			'',
			'// --- view.ts ---',
			'/** Сумма цен выбранных товаров. */',
			'function selectedTotal(body: string, search: string): number {',
			'  const ids = selectedIds(search);',
			'  return parseProducts(body)',
			'    .filter((p) => ids.includes(p.id))',
			'    .reduce((sum, p) => sum + p.price, 0);',
			'}'
		],
		checks: [
			'const body = \'[{"id":3,"price":100},{"id":12,"price":40},{"id":7,"price":5}]\';',
			"__eq(selectedIds('?ids=3,12,7'), [3, 12, 7]);",
			"__eq(selectedIds(''), []);",
			"__eq(selectedTotal(body, '?ids=12,3'), 140);"
		],
		defects: [
			{
				kind: 'rare-data',
				from: "  return raw === '' ? [] : raw.split(',').map(Number);",
				to: "  return raw === '' ? [] : raw.split(',').map(Number.parseInt);",
				neighbour: {
					from: "  const raw = new URLSearchParams(search).get('ids') ?? '';",
					to: "  const raw = new URLSearchParams(search).get('ids') || '';"
				},
				symptom: {
					from: '    .filter((p) => ids.includes(p.id))',
					to: '    .filter((p) => ids.map(Number).includes(p.id))'
				}
			}
		],
		decoy: { from: '  return JSON.parse(body) as Product[];', to: '  return (JSON.parse(body) as Product[]).slice();' }
	},
	{
		lines: [
			'interface Cart {',
			'  counts: Record<string, number>;',
			'  order: string[];',
			'}',
			'',
			'/** Добавляет товар id (или увеличивает его количество); порядок товаров — порядок первого добавления. */',
			'function addItem(cart: Cart, id: string): Cart {',
			'  const order = id in cart.counts ? cart.order : [...cart.order, id];',
			'  return { counts: { ...cart.counts, [id]: (cart.counts[id] ?? 0) + 1 }, order };',
			'}',
			'',
			'/** Строки корзины «id × количество» в порядке первого добавления. */',
			'function cartRows(cart: Cart): string[] {',
			"  return cart.order.map((id) => id + ' × ' + cart.counts[id]);",
			'}'
		],
		checks: [
			'let cart = { counts: {}, order: [] };',
			"for (const id of ['sku-5', '42', 'b7', '7', '42']) cart = addItem(cart, id);",
			"__eq(cartRows(cart), ['sku-5 × 1', '42 × 2', 'b7 × 1', '7 × 1']);"
		],
		defects: [
			{
				kind: 'rare-data',
				from: "  return cart.order.map((id) => id + ' × ' + cart.counts[id]);",
				to: "  return Object.keys(cart.counts).map((id) => id + ' × ' + cart.counts[id]);",
				neighbour: {
					from: 'function cartRows(cart: Cart): string[] {',
					to: 'function cartRows(cart: Readonly<Cart>): string[] {'
				},
				symptom: {
					from: '  const order = id in cart.counts ? cart.order : [...cart.order, id];',
					to: '  const order = cart.order.includes(id) ? cart.order : [...cart.order, id];'
				}
			}
		],
		decoy: {
			from: '  return { counts: { ...cart.counts, [id]: (cart.counts[id] ?? 0) + 1 }, order };',
			to: '  return { order, counts: { ...cart.counts, [id]: (cart.counts[id] ?? 0) + 1 } };'
		}
	},
	{
		lines: [
			"/** День в виде 'YYYY-MM-DD' по UTC: месяц и день — двумя цифрами; год даты — от 1900 до 2100. */",
			'function dayKey(d: Date): string {',
			"  const month = String(d.getUTCMonth() + 1).padStart(2, '0');",
			"  const day = String(d.getUTCDate()).padStart(2, '0');",
			"  return d.getUTCFullYear() + '-' + month + '-' + day;",
			'}',
			'',
			"/** Записи журнала с днём от dayKey(from) до dayKey(to) включительно; day записей — строки 'YYYY-MM-DD'. */",
			'function entriesBetween(entries: { day: string }[], from: Date, to: Date): { day: string }[] {',
			'  const [a, b] = [dayKey(from), dayKey(to)];',
			'  return entries.filter((e) => e.day >= a && e.day <= b);',
			'}'
		],
		checks: [
			"__eq(dayKey(new Date('2026-11-25T08:00:00Z')), '2026-11-25');",
			"__eq(dayKey(new Date('2026-03-04T08:00:00Z')), '2026-03-04');",
			"const log = [{ day: '2026-09-30' }, { day: '2026-10-02' }, { day: '2026-10-15' }];",
			"__eq(entriesBetween(log, new Date('2026-09-28T00:00:00Z'), new Date('2026-10-05T00:00:00Z')).length, 2);"
		],
		defects: [
			{
				kind: 'rare-data',
				from: "  const month = String(d.getUTCMonth() + 1).padStart(2, '0');",
				to: '  const month = String(d.getUTCMonth() + 1);',
				alternatives: [
					{
						from: "  return d.getUTCFullYear() + '-' + month + '-' + day;",
						to: "  return d.getUTCFullYear() + '-' + month.padStart(2, '0') + '-' + day;"
					}
				],
				neighbour: {
					from: "  const day = String(d.getUTCDate()).padStart(2, '0');",
					to: '  const day = String(d.getUTCDate()).padStart(2);'
				},
				symptom: {
					from: '  return entries.filter((e) => e.day >= a && e.day <= b);',
					to: '  return entries.filter((e) => e.day.localeCompare(a) >= 0 && e.day.localeCompare(b) <= 0);'
				}
			},
			{
				kind: 'rare-data',
				from: "  const day = String(d.getUTCDate()).padStart(2, '0');",
				to: '  const day = String(d.getUTCDate());',
				alternatives: [
					{
						from: "  return d.getUTCFullYear() + '-' + month + '-' + day;",
						to: "  return d.getUTCFullYear() + '-' + month + '-' + day.padStart(2, '0');"
					}
				],
				neighbour: {
					from: "  const month = String(d.getUTCMonth() + 1).padStart(2, '0');",
					to: "  const month = String(d.getUTCMonth()).padStart(2, '0');"
				},
				symptom: {
					from: '  return entries.filter((e) => e.day >= a && e.day <= b);',
					to: '  return entries.filter((e) => e.day.localeCompare(a) >= 0 && e.day.localeCompare(b) <= 0);'
				}
			}
		],
		decoy: { from: '  const [a, b] = [dayKey(from), dayKey(to)];', to: '  const [a, b] = [dayKey(to), dayKey(from)];' }
	},
	{
		lines: [
			'interface Profile {',
			'  name: string;',
			'  city: string;',
			'  bio: string;',
			'}',
			'',
			'/** Копия объекта без полей со значением undefined. */',
			'function definedOnly<T extends object>(obj: T): Partial<T> {',
			'  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;',
			'}',
			'',
			'/** Правка профиля из формы: поле, которое форма не трогала, приходит как undefined и профиль не меняет. */',
			'function applyPatch(profile: Profile, patch: Partial<Profile>): Profile {',
			'  return { ...profile, ...definedOnly(patch) };',
			'}',
			'',
			'/** Сколько полей профиля меняет правка из формы. */',
			'function changedCount(patch: Partial<Profile>): number {',
			'  return Object.keys(definedOnly(patch)).length;',
			'}'
		],
		checks: [
			"const profile = { name: 'Ann', city: 'Omsk', bio: 'hi' };",
			"__eq(applyPatch(profile, { city: 'Tver', bio: undefined }), { name: 'Ann', city: 'Tver', bio: 'hi' });",
			"__eq(applyPatch(profile, { bio: '' }), { name: 'Ann', city: 'Omsk', bio: '' });",
			"__eq(changedCount({ city: 'Tver', bio: '', name: undefined }), 2);",
			'__eq(definedOnly({ a: 1, b: undefined, c: null }), { a: 1, c: null });'
		],
		defects: [
			{
				kind: 'spread-undefined',
				from: '  return { ...profile, ...definedOnly(patch) };',
				to: '  return { ...profile, ...patch };',
				neighbour: {
					from: 'function applyPatch(profile: Profile, patch: Partial<Profile>): Profile {',
					to: 'function applyPatch(profile: Readonly<Profile>, patch: Partial<Profile>): Profile {'
				},
				symptom: {
					from: '  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;',
					to: '  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null)) as Partial<T>;'
				}
			},
			{
				kind: 'spread-undefined',
				from: '  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;',
				to: '  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v)) as Partial<T>;',
				neighbour: {
					from: 'function definedOnly<T extends object>(obj: T): Partial<T> {',
					to: 'function definedOnly<T extends object>(obj: Readonly<T>): Partial<T> {'
				},
				symptom: {
					from: '  return { ...profile, ...definedOnly(patch) };',
					to: '  return { ...profile, ...definedOnly({ ...patch }) };'
				}
			}
		],
		decoy: {
			from: '  return { ...profile, ...definedOnly(patch) };',
			to: '  return Object.assign({}, profile, definedOnly(patch));'
		}
	},
	{
		lines: [
			'interface Query {',
			'  page: number;',
			'  sort: string;',
			'  q: string;',
			'}',
			'',
			"const DEFAULT_QUERY: Query = { page: 1, sort: 'date', q: '' };",
			'',
			'/** Параметры из строки адреса; отсутствующий параметр — undefined. */',
			'function fromSearch(search: string): Partial<Query> {',
			'  const p = new URLSearchParams(search);',
			"  const page = p.get('page');",
			"  return { page: page === null ? undefined : Number(page), sort: p.get('sort') ?? undefined, q: p.get('q') ?? undefined };",
			'}',
			'',
			'/** Только заданные параметры: без значений undefined. */',
			'function given(query: Partial<Query>): Partial<Query> {',
			'  const result: Partial<Query> = {};',
			'  if (query.page !== undefined) result.page = query.page;',
			'  if (query.sort !== undefined) result.sort = query.sort;',
			'  if (query.q !== undefined) result.q = query.q;',
			'  return result;',
			'}',
			'',
			'/** Итоговые параметры: заданные в адресе поверх значений по умолчанию. */',
			'function resolveQuery(search: string): Query {',
			'  return { ...DEFAULT_QUERY, ...given(fromSearch(search)) };',
			'}',
			'',
			'/** Задан ли в адресе хотя бы один параметр запроса. */',
			'function hasFilters(search: string): boolean {',
			'  return Object.keys(given(fromSearch(search))).length > 0;',
			'}'
		],
		checks: [
			"__eq(resolveQuery('?sort=price'), { page: 1, sort: 'price', q: '' });",
			"__eq(resolveQuery('?page=3&q=tea'), { page: 3, sort: 'date', q: 'tea' });",
			"__eq(fromSearch('?q=x').page, undefined);",
			"__eq(hasFilters('?utm=1'), false);",
			"__eq(hasFilters('?q=x'), true);"
		],
		defects: [
			{
				kind: 'spread-undefined',
				from: '  return { ...DEFAULT_QUERY, ...given(fromSearch(search)) };',
				to: '  return { ...DEFAULT_QUERY, ...fromSearch(search) };',
				neighbour: {
					from: 'function resolveQuery(search: string): Query {',
					to: "function resolveQuery(search: string = ''): Query {"
				},
				symptom: {
					from: '  if (query.page !== undefined) result.page = query.page;',
					to: '  if (query.page != null) result.page = query.page;'
				}
			},
			{
				kind: 'spread-undefined',
				from: "  return { page: page === null ? undefined : Number(page), sort: p.get('sort') ?? undefined, q: p.get('q') ?? undefined };",
				to: "  return { page: Number(page), sort: p.get('sort') ?? undefined, q: p.get('q') ?? undefined };",
				neighbour: { from: "  const page = p.get('page');", to: "  const page = p.get('page') ?? '1';" },
				symptom: {
					from: '  if (query.page !== undefined) result.page = query.page;',
					to: '  if (query.page) result.page = query.page;'
				}
			}
		],
		decoy: {
			from: '  const p = new URLSearchParams(search);',
			to: "  const p = new URLSearchParams(search.replace('?', ''));"
		}
	},
	{
		lines: [
			'/**',
			' * Изменение цены за n дней: последняя цена минус цена n дней назад;',
			' * если история короче — минус первая цена. Пустая история — 0; n — целое от 0.',
			' */',
			'function priceChange(history: number[], n: number): number {',
			'  if (history.length === 0) return 0;',
			'  const last = history[history.length - 1];',
			'  const base = history[Math.max(0, history.length - 1 - n)];',
			'  return last - base;',
			'}',
			'',
			"/** Подпись тренда: '+5', '-3' или '0'. */",
			'function trendLabel(history: number[], n: number): string {',
			'  const change = priceChange(history, n);',
			"  return change > 0 ? '+' + change : String(change);",
			'}'
		],
		checks: [
			'__eq(priceChange([10, 12, 15, 11], 2), -1);',
			'__eq(priceChange([10, 12], 7), 2);',
			'__eq(priceChange([10, 12], 0), 0);',
			'__eq(priceChange([], 3), 0);',
			"__eq(trendLabel([5, 9], 1), '+4');"
		],
		defects: [
			{
				kind: 'short-data',
				from: '  const base = history[Math.max(0, history.length - 1 - n)];',
				to: '  const base = history[history.length - 1 - n];',
				neighbour: { from: '  const last = history[history.length - 1];', to: '  const last = history.at(-1) ?? 0;' },
				symptom: {
					from: '  const change = priceChange(history, n);',
					to: '  const change = priceChange(history, n) || 0;'
				},
				alternatives: [{ from: '  return last - base;', to: '  return last - (base ?? history[0]);' }]
			}
		],
		decoy: {
			from: "  return change > 0 ? '+' + change : String(change);",
			to: "  return (change > 0 ? '+' : '') + change;"
		}
	},
	{
		lines: [
			'/** Отсчёт ряда; value — конечное число от 0. */',
			'interface Sample {',
			'  t: number;',
			'  value: number;',
			'}',
			'',
			'/** Пик ряда — наибольшее значение; для пустого ряда — 0. */',
			'function peak(samples: Sample[]): number {',
			'  return samples.length > 0 ? Math.max(...samples.map((s) => s.value)) : 0;',
			'}',
			'',
			'/** Значения, делённые на пик, с двумя знаками после запятой; при нулевом пике — нули. */',
			'function normalized(samples: Sample[]): number[] {',
			'  const top = peak(samples);',
			'  return samples.map((s) => (top === 0 ? 0 : Math.round((s.value / top) * 100) / 100));',
			'}'
		],
		checks: [
			'__eq(peak([]), 0);',
			'__eq(peak([{ t: 1, value: 0 }]), 0);',
			'__eq(normalized([{ t: 1, value: 5 }, { t: 2, value: 10 }]), [0.5, 1]);',
			'__eq(normalized([]), []);',
			'__eq(normalized([{ t: 1, value: 0 }, { t: 2, value: 0 }]), [0, 0]);'
		],
		defects: [
			{
				kind: 'short-data',
				from: '  return samples.length > 0 ? Math.max(...samples.map((s) => s.value)) : 0;',
				to: '  return Math.max(...samples.map((s) => s.value));',
				neighbour: {
					from: 'function peak(samples: Sample[]): number {',
					to: 'function peak(samples: readonly Sample[]): number {'
				},
				symptom: { from: '  const top = peak(samples);', to: '  const top = Math.max(peak(samples), 0);' }
			},
			{
				kind: 'short-data',
				from: '  return samples.map((s) => (top === 0 ? 0 : Math.round((s.value / top) * 100) / 100));',
				to: '  return samples.map((s) => Math.round((s.value / top) * 100) / 100);',
				// Values are not negative, so a zero peak means zero values and dividing them by 1 gives the zeros.
				alternatives: [{ from: '  const top = peak(samples);', to: '  const top = peak(samples) || 1;' }],
				neighbour: {
					from: 'function normalized(samples: Sample[]): number[] {',
					to: 'function normalized(samples: readonly Sample[]): number[] {'
				},
				symptom: {
					from: '  return samples.length > 0 ? Math.max(...samples.map((s) => s.value)) : 0;',
					to: '  return samples.length > 0 ? Math.max(1, ...samples.map((s) => s.value)) : 0;'
				}
			}
		],
		decoy: { from: '  const top = peak(samples);', to: '  const top = peak([...samples]);' }
	}
];

/** The index of the only line of a unit equal to `text`; a library that breaks this is a programming error. */
function lineIndex(unit: Unit, text: string): number {
	const found = unit.lines.flatMap((line, i) => (line === text ? [i] : []));
	if (found.length !== 1)
		throw new Error(`${descriptor.key}: line ${JSON.stringify(text)} occurs ${found.length} times`);
	return found[0] ?? 0;
}

for (const unit of [...MIDDLE, ...SENIOR]) {
	lineIndex(unit, unit.decoy.from);
	for (const d of unit.defects) {
		const at = lineIndex(unit, d.from);
		const traps = [d.neighbour, ...(d.symptom ? [d.symptom] : [])].map((c) => lineIndex(unit, c.from));
		if (traps.includes(at)) throw new Error(`${descriptor.key}: a trap on the defect line ${d.from}`);
		for (const a of d.alternatives ?? []) {
			const alt = lineIndex(unit, a.from);
			if (alt === at || traps.includes(alt))
				throw new Error(`${descriptor.key}: an accepted line ${a.from} is the defect or a trap`);
		}
	}
}

const MODULE_TITLES = [
	'Клиентский слой витрины',
	'Модули личного кабинета',
	'Клиент каталога и корзины',
	'Сервисный слой интерфейса'
];
const HEADER_CONSTANTS = [
	"const API_BASE = '/api/v3';",
	'const REQUEST_TIMEOUT_MS = 8000;',
	"const LOCALE = 'ru-RU';",
	'const CACHE_TTL_S = 60;',
	"const STORAGE_PREFIX = 'shop:';",
	'const MAX_RETRIES = 2;'
];

const CHECK_PRELUDE = [
	// Objects are compared regardless of the order of their keys; arrays keep their order.
	'function __norm(value) {',
	'  if (Array.isArray(value)) return value.map(__norm);',
	"  if (value === null || typeof value !== 'object' || value instanceof Date) return value;",
	'  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, __norm(value[key])]));',
	'}',
	'function __eq(actual, expected) {',
	'  const a = JSON.stringify(__norm(actual));',
	'  const e = JSON.stringify(__norm(expected));',
	"  if (a !== e) throw new Error(a + ' !== ' + e);",
	'}'
];

interface Composed {
	source: string;
	check: string;
	line: number;
	fix: string;
	neighbour: { line: number; replacement: string };
	other: { line: number; replacement: string };
	symptom: { line: number; replacement: string } | null;
	alternatives: { line: number; fix: string }[];
}

function compose(rng: Rng, library: readonly Unit[], kind: string, contextCount: number): Composed {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((u) => u !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A header of random length: a comment and constants, so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	const lines: string[] = [`// ${rng.pick(MODULE_TITLES)}.`, ...(constants.length ? ['', ...constants] : []), ''];
	const offsets = new Map<Unit, number>();
	for (const unit of order) {
		offsets.set(unit, lines.length);
		unit.lines.forEach((line, i) =>
			lines.push(unit === buggy && i === lineIndex(buggy, defect.from) ? defect.to : line)
		);
		lines.push('');
	}
	lines.pop();
	const at = (unit: Unit, text: string) => (offsets.get(unit) ?? 0) + lineIndex(unit, text) + 1;
	const firstContext = order.find((u) => u !== buggy) ?? buggy;
	const checks = order.flatMap((unit) => ['  {', ...unit.checks.map((c) => `    ${c}`), '  }']);
	const check = [
		...CHECK_PRELUDE,
		'try {',
		...checks,
		"  console.log('ok');",
		'} catch (error) {',
		"  console.log('fail', error.message);",
		'}'
	].join('\n');
	return {
		source: lines.join('\n'),
		check,
		line: at(buggy, defect.from),
		fix: defect.from,
		neighbour: { line: at(buggy, defect.neighbour.from), replacement: defect.neighbour.to },
		other: { line: at(firstContext, firstContext.decoy.from), replacement: firstContext.decoy.to },
		symptom: defect.symptom ? { line: at(buggy, defect.symptom.from), replacement: defect.symptom.to } : null,
		alternatives: (defect.alternatives ?? []).map((c) => ({ line: at(buggy, c.from), fix: c.to }))
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = compose(rng, input.grade === 'middle' ? MIDDLE : SENIOR, input.classId, 2);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль клиентской части на TypeScript; он компилируется без ошибок (`strict`, без ' +
				'`noUncheckedIndexedAccess`). У каждой функции в комментарии записана её спецификация. Строковые ключи и id в ' +
				'данных — обычные имена: не совпадают с именами свойств `Object.prototype` (`__proto__`, `constructor`, ' +
				'`toString` и т. п.). В модуле один ' +
				'дефект: одна строка нарушает спецификацию своей функции. Введите номер строки, замена которой одной ' +
				'инструкцией восстанавливает спецификацию всех функций (нумерация с 1). Если исправить можно в нескольких ' +
				'строках — засчитывается любая из них, где замена одной инструкцией восстанавливает спецификацию. ' +
				'Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте конструкций, ' +
				'которых в ней нет (стрелочные функции, циклы, обёртки, новые функции), и не переносите в неё логику из ' +
				'другой строки.',
			code: { language: 'typescript', source: p.source }
		},
		answer: {
			kind: 'line_no',
			value: p.line,
			...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
		}
	});
	const traps = [p.neighbour, p.other, ...(p.symptom ? [p.symptom] : [])];
	const lineAnswer = (line: number) => ({ kind: 'answer' as const, answer: { kind: 'line_no' as const, value: line } });
	return {
		instance,
		reference: () => {
			const main = nodeDefectProbe({
				source: p.source,
				language: 'typescript',
				check: p.check,
				line: p.line,
				fix: p.fix,
				distractors: traps
			});
			// Each accepted alternative is proven by its own probe (the defect fails, the alternative fix passes); the
			// probes run one after another and the last one prints the defect line.
			const proofs = p.alternatives.map((a) => {
				const probe = nodeDefectProbe({
					source: p.source,
					language: 'typescript',
					check: p.check,
					line: a.line,
					fix: a.fix,
					distractors: []
				});
				if (probe.kind !== 'output') throw new Error(`${descriptor.key}: a defect probe prints its line`);
				const body = probe.source.split('\n');
				if (body.at(-1) !== `print(${a.line})`) throw new Error(`${descriptor.key}: unexpected defect probe`);
				return body.slice(0, -1).join('\n');
			});
			return main.kind === 'output' && proofs.length ? { ...main, source: [...proofs, main.source].join('\n') } : main;
		},
		wrong: () => ({
			'neighbour-line': lineAnswer(p.neighbour.line),
			'other-function': lineAnswer(p.other.line),
			'symptom-line': p.symptom ? lineAnswer(p.symptom.line) : null
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
