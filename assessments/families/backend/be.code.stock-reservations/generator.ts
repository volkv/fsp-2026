// Practice: a warehouse keeps the free stock of goods and reserves it for orders over a log of events; the class sets
// how a reservation is met (whole or nothing, partial, whole with expiry, whole from a first-come queue of backorders);
// Senior has several warehouses taken in priority order. The step «измени своё решение» adds a limit on the active reservations of a client.
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
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go', 'java21', 'javascript', 'typescript', 'cpp17'] as const;
const CHANGE_WEIGHT = 0.3;

const descriptor = readDescriptor(import.meta.url);

type Ev =
	| { t: number; op: 'reserve'; id: string; client: string; product: string; qty: number }
	| { t: number; op: 'release' | 'confirm'; id: string }
	| { t: number; op: 'restock'; warehouse: string; product: string; qty: number };

/** Middle has one warehouse, never named in the input. `ttl` is 0 outside the expiring class. */
interface Input {
	warehouses: string[];
	products: string[];
	stock: number[][];
	ttl: number;
	limit: number | null;
	events: Ev[];
}

type Variant = 'right' | (typeof WRONG_IDS)[number];

interface Hold {
	product: string;
	client: string;
	parts: [string, number][];
	total: number;
}

/** The state of the warehouses over the log; a variant other than `right` reproduces a wrong solution. */
class Store {
	readonly free = new Map<string, Map<string, number>>();
	readonly busy = new Map<string, Map<string, number>>();
	readonly held = new Map<string, Hold>();
	readonly owed = new Map<string, number>();
	readonly queue: { deadline: number; id: string }[] = [];
	head = 0;
	/** The backorder class: the waiting reservations and the queue of each product. */
	readonly waiting = new Map<string, { product: string; qty: number; client: string }>();
	readonly lines = new Map<string, string[]>();
	readonly kind: string;
	readonly input: Input;
	readonly senior: boolean;
	readonly variant: Variant;

	constructor(kind: string, input: Input, senior: boolean, variant: Variant) {
		this.kind = kind;
		this.input = input;
		this.senior = senior;
		this.variant = variant;
		input.warehouses.forEach((w, i) => {
			this.free.set(w, new Map(input.products.map((p, j) => [p, input.stock[i]?.[j] ?? 0])));
			this.busy.set(w, new Map(input.products.map((p) => [p, 0])));
		});
		for (const p of input.products) this.lines.set(p, []);
	}

	get(map: Map<string, Map<string, number>>, w: string, p: string): number {
		return map.get(w)?.get(p) ?? 0;
	}

	add(map: Map<string, Map<string, number>>, w: string, p: string, q: number): void {
		map.get(w)?.set(p, this.get(map, w, p) + q);
	}

	/** Expiries due by the moment `t`, before the events of the moment. */
	advance(t: number): void {
		const late = this.variant === 'late-expiry';
		for (let next = this.queue[this.head]; next && (late ? next.deadline < t : next.deadline <= t);) {
			this.drop(next.id, true);
			this.head += 1;
			next = this.queue[this.head];
		}
	}

	drop(id: string, back: boolean): boolean {
		const h = this.held.get(id);
		if (!h) return false;
		if (this.variant !== 'stale-release') this.held.delete(id);
		for (const [w, q] of h.parts) {
			this.add(this.busy, w, h.product, -q);
			if (back) this.add(this.free, w, h.product, q);
		}
		this.owed.set(h.client, (this.owed.get(h.client) ?? 0) - h.total);
		if (back) this.serve(h.product);
		return true;
	}

	/** The first warehouse a whole reservation fits in. */
	place(product: string, qty: number): string | undefined {
		const exact = this.variant === 'exact-stock';
		return this.candidates(product).find((x) => {
			const free = this.get(this.free, x, product);
			return exact ? qty < free : qty <= free;
		});
	}

	take(id: string, product: string, client: string, parts: [string, number][], total: number): void {
		for (const [w, q] of parts) {
			this.add(this.free, w, product, -q);
			this.add(this.busy, w, product, q);
		}
		this.held.set(id, { product, client, parts, total });
	}

	/** The backorder queue of a product, served from its head while the head fits (or any that fits, wrongly). */
	serve(product: string): void {
		if (this.kind !== 'backorder') return;
		const line = this.lines.get(product) ?? [];
		const skip = this.variant === 'skip-ahead';
		for (let i = 0; i < line.length;) {
			const id = line[i] ?? '';
			const order = this.waiting.get(id);
			const w = order ? this.place(product, order.qty) : undefined;
			if (order && w !== undefined) {
				line.splice(i, 1);
				this.waiting.delete(id);
				this.take(id, product, order.client, [[w, order.qty]], order.qty);
			} else if (skip) i += 1;
			else break;
		}
	}

	backorder(e: Extract<Ev, { op: 'reserve' }>): string {
		const owed = this.owed.get(e.client) ?? 0;
		if (this.input.limit !== null && owed + e.qty > this.input.limit) return 'reject';
		this.owed.set(e.client, owed + e.qty);
		this.waiting.set(e.id, { product: e.product, qty: e.qty, client: e.client });
		const line = this.lines.get(e.product) ?? [];
		if (this.variant === 'queue-jump' && this.place(e.product, e.qty) !== undefined) line.unshift(e.id);
		else line.push(e.id);
		this.serve(e.product);
		const h = this.held.get(e.id);
		if (!h) return 'wait';
		return this.senior ? `ok ${h.parts[0]?.[0] ?? ''}` : 'ok';
	}

	/** The warehouses a reservation may take from, in priority order. */
	candidates(product: string): string[] {
		const all = this.input.warehouses;
		if (this.variant !== 'single-warehouse') return all;
		return all.filter((w) => this.get(this.free, w, product) > 0).slice(0, 1);
	}

	reserve(e: Extract<Ev, { op: 'reserve' }>): string {
		const room = this.input.limit === null ? Infinity : this.input.limit - (this.owed.get(e.client) ?? 0);
		let parts: [string, number][] = [];
		if (this.kind === 'partial') {
			let need = Math.min(e.qty, room);
			for (const w of this.candidates(e.product)) {
				const take = Math.min(need, this.get(this.free, w, e.product));
				if (take > 0) {
					parts.push([w, take]);
					need -= take;
				}
			}
		} else if (e.qty <= room) {
			const w = this.place(e.product, e.qty);
			if (w !== undefined) parts = [[w, e.qty]];
		}
		if (parts.length === 0) return 'reject';
		const total = parts.reduce((s, [, q]) => s + q, 0);
		this.take(e.id, e.product, e.client, parts, total);
		if (this.variant === 'release-requested') {
			// The hold remembers the requested quantity instead of the one given.
			const [w] = parts[0] ?? [''];
			this.held.set(e.id, { product: e.product, client: e.client, parts: [[w, e.qty]], total: e.qty });
		}
		const recorded = this.variant === 'release-requested' ? e.qty : total;
		this.owed.set(e.client, (this.owed.get(e.client) ?? 0) + recorded);
		if (this.kind === 'expiring') this.queue.push({ deadline: e.t + this.input.ttl, id: e.id });
		if (this.kind === 'partial') return `ok ${total}`;
		return this.senior ? `ok ${parts[0]?.[0] ?? ''}` : 'ok';
	}

	apply(e: Ev): string {
		this.advance(e.t);
		if (e.op === 'reserve') return this.kind === 'backorder' ? this.backorder(e) : this.reserve(e);
		if (e.op === 'restock') {
			this.add(this.free, e.warehouse, e.product, e.qty);
			this.serve(e.product);
			return String(this.get(this.free, e.warehouse, e.product));
		}
		const order = this.waiting.get(e.id);
		if (e.op === 'release' && order) {
			this.waiting.delete(e.id);
			const line = this.lines.get(order.product) ?? [];
			line.splice(line.indexOf(e.id), 1);
			this.owed.set(order.client, (this.owed.get(order.client) ?? 0) - order.qty);
			this.serve(order.product);
			return 'ok';
		}
		return this.drop(e.id, e.op === 'release' || this.variant === 'confirm-returns') ? 'ok' : 'ignore';
	}

	final(): string[] {
		const stock = this.input.warehouses.flatMap((w) =>
			this.input.products.map((p) =>
				[...(this.senior ? [w] : []), p, this.get(this.free, w, p), this.get(this.busy, w, p)].join(' ')
			)
		);
		if (this.kind !== 'backorder') return stock;
		const waits = this.input.products.map((p) => {
			const line = this.lines.get(p) ?? [];
			return `${p} ${line.length} ${line.reduce((sum, id) => sum + (this.waiting.get(id)?.qty ?? 0), 0)}`;
		});
		return [...stock, ...waits];
	}
}

function simulate(kind: string, input: Input, senior: boolean, variant: Variant = 'right'): string {
	const store = new Store(kind, input, senior, variant);
	const out = input.events.map((e) => store.apply(e));
	return `${[...out, ...store.final()].join('\n')}\n`;
}

function render(kind: string, input: Input, senior: boolean): string {
	const head = [
		...(senior ? [input.warehouses.length] : []),
		input.products.length,
		input.events.length,
		...(kind === 'expiring' ? [input.ttl] : []),
		...(input.limit === null ? [] : [input.limit])
	].join(' ');
	const stock = senior
		? [input.products.join(' '), ...input.warehouses.map((w, i) => [w, ...(input.stock[i] ?? [])].join(' '))]
		: input.products.map((p, j) => `${p} ${input.stock[0]?.[j] ?? 0}`);
	const events = input.events.map((e) => {
		if (e.op === 'reserve') return `${e.t} reserve ${e.id} ${e.client} ${e.product} ${e.qty}`;
		if (e.op === 'restock') return `${e.t} restock ${senior ? `${e.warehouse} ` : ''}${e.product} ${e.qty}`;
		return `${e.t} ${e.op} ${e.id}`;
	});
	return `${[head, ...stock, ...events].join('\n')}\n`;
}

type GroupId = 'basic' | 'boundary' | 'burst' | 'lifecycle' | 'scale';

const PRODUCTS = ['apple', 'pear', 'milk', 'bread', 'cheese', 'rice', 'tea', 'soap', 'salt', 'sugar', 'honey', 'juice'];
const WAREHOUSES = ['north', 'south', 'east', 'west', 'central', 'river', 'port', 'hill'];

function distinct(rng: Rng, pool: readonly string[], count: number): string[] {
	const names = new Set<string>(rng.sample(pool, Math.min(count, pool.length)));
	while (names.size < count) names.add(`${rng.pick(pool)}${rng.int(1, 99)}`);
	return [...names];
}

function makeInput(rng: Rng, kind: string, group: GroupId, senior: boolean, withLimit: boolean): Input {
	const scale = group === 'scale';
	const warehouses = senior ? distinct(rng, WAREHOUSES, scale ? rng.int(4, 6) : rng.int(2, 4)) : ['main'];
	const products = distinct(rng, PRODUCTS, scale ? rng.int(15, 30) : rng.int(2, senior ? 3 : 4));
	const stock = warehouses.map(() => products.map(() => (rng.bool(0.2) ? 0 : rng.int(1, 8))));
	const clients = distinct(rng, PERSON_NAMES, scale ? 16 : rng.int(2, 4));
	const ttl = kind === 'expiring' ? rng.pick([20, 30, 45, 60, 90]) : 0;
	const unit = kind === 'expiring' ? Math.floor(ttl / 3) : rng.pick([5, 10, 20]);
	const input: Input = { warehouses, products, stock, ttl, limit: withLimit ? rng.int(4, 10) : null, events: [] };
	const store = new Store(kind, input, senior, 'right');
	const issued: string[] = [];
	let serial = rng.int(1, 900);
	let t = rng.int(0, 100);
	const count = scale ? rng.int(1500, 2000) : rng.int(14, 24);
	while (input.events.length < count) {
		const due = store.queue[store.head]?.deadline;
		if (group === 'boundary' && due !== undefined && due >= t && rng.bool(0.4)) t = due;
		else if (group === 'burst') t += rng.bool(0.6) ? 0 : rng.int(1, 2 * unit);
		else t += rng.int(0, unit);
		store.advance(t);
		const roll = rng.next();
		// The lifecycle tests confirm reservations often and then check the stock by restocks.
		const [reserves, settles] = group === 'lifecycle' ? [0.35, 0.7] : [0.4, 0.75];
		let e: Ev;
		if (roll < reserves || issued.length === 0) {
			const product = rng.pick(products);
			const most = Math.max(...warehouses.map((w) => store.get(store.free, w, product)));
			const exact = group === 'boundary' && most > 0 && rng.bool(0.6);
			const qty = exact ? most : rng.int(1, 6);
			e = { t, op: 'reserve', id: `r${(serial += 1)}`, client: rng.pick(clients), product, qty };
			issued.push(e.id);
		} else if (roll < settles) {
			const active = [...store.held.keys()];
			const id = active.length > 0 && rng.bool(0.6) ? rng.pick(active) : rng.pick(issued);
			e = { t, op: rng.bool(group === 'lifecycle' ? 0.25 : 0.55) ? 'release' : 'confirm', id };
		} else {
			e = { t, op: 'restock', warehouse: rng.pick(warehouses), product: rng.pick(products), qty: rng.int(1, 8) };
		}
		store.apply(e);
		input.events.push(e);
		if (group === 'burst' && e.op !== 'restock' && e.op !== 'reserve' && rng.bool(0.5)) {
			// The same reservation released or confirmed again in the same moment.
			const again: Ev = { t, op: rng.bool(0.5) ? 'release' : 'confirm', id: e.id };
			store.apply(again);
			input.events.push(again);
		}
	}
	return input;
}

/** The wrong solutions a group must expose on every test, by class and grade. */
function traps(kind: string, group: GroupId, senior: boolean): Variant[] {
	const list: Variant[] = [];
	if (group === 'basic' || group === 'burst') list.push('stale-release');
	if (group === 'basic' && senior) list.push('single-warehouse');
	if (group === 'basic' && kind === 'partial' && !senior) list.push('release-requested');
	if (group === 'basic' && kind === 'backorder') list.push('queue-jump');
	if (group === 'boundary' && kind !== 'partial') list.push('exact-stock');
	if (group === 'boundary' && kind === 'expiring') list.push('late-expiry');
	if (group === 'lifecycle') list.push('confirm-returns');
	if (group === 'lifecycle' && kind === 'backorder') list.push('skip-ahead');
	return list;
}

/** Hidden tests of the class; every test tells the class from the others, and the step's tests feel the limit. */
function groups(
	rng: Rng,
	kind: string,
	others: readonly string[],
	senior: boolean,
	withLimit: boolean
): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'boundary', 'burst', 'lifecycle', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${kind}`);
			const input = makeInput(rng, kind, id, senior, withLimit);
			const expected = simulate(kind, input, senior);
			// The expiring class reads one more number in the header, so its tests already break the other programs.
			const comparable = others.filter((other) => (other === 'expiring') === (kind === 'expiring'));
			if (comparable.some((other) => simulate(other, input, senior) === expected)) continue;
			if (withLimit && simulate(kind, { ...input, limit: null }, senior) === expected) continue;
			if (!withLimit && traps(kind, id, senior).some((v) => simulate(kind, input, senior, v) === expected)) continue;
			tests.push({ stdin: render(kind, input, senior), expected });
		}
		return { id, tests };
	});
}

const RULE: Record<string, (senior: boolean) => string[]> = {
	'all-or-nothing': (senior) => [
		senior
			? 'Резерв удовлетворяется целиком с одного склада — первого по приоритету, где свободный остаток товара не меньше `q`: остаток этого склада уменьшается на `q`, резерв становится активным. Если такого склада нет, резерв отклоняется и ничего не меняет.'
			: 'Резерв удовлетворяется целиком, если свободный остаток товара не меньше `q`: остаток уменьшается на `q`, резерв становится активным. Иначе резерв отклоняется и ничего не меняет.'
	],
	partial: (senior) => [
		senior
			? 'Резерв набирается по складам в порядке приоритета: с каждого склада берётся `min(сколько ещё не хватает, свободный остаток товара на складе)`, пока не наберётся `q` или не кончатся склады. Выдано — сумма взятого; если выдано 0, резерв отклоняется и ничего не меняет, иначе резерв становится активным с выданным количеством. Снятый резерв возвращает товар на те склады и в тех количествах, с которых он взят.'
			: 'Резерв получает `min(q, свободный остаток товара)` единиц. Если это 0, резерв отклоняется и ничего не меняет; иначе остаток уменьшается на выданное количество и резерв становится активным с этим количеством.'
	],
	expiring: (senior) => [
		...(RULE['all-or-nothing']?.(senior) ?? []),
		`Активный резерв, принятый в момент \`t₀\`, истекает в момент \`t₀ + T\`, если до этого его не сняли и не подтвердили: товар возвращается в свободный остаток${senior ? ' того склада, с которого взят' : ''}, резерв перестаёт быть активным. Истечения момента обрабатываются **до** событий этого момента: событие в момент \`t₀ + T\` уже видит возвращённый товар, а снять или подтвердить истёкший резерв нельзя.`
	],
	backorder: (senior) => [
		`Заявки на товар обслуживаются строго в порядке поступления. Новый резерв встаёт в конец очереди своего товара, после чего очередь обслуживается: пока первой заявке очереди хватает товара${senior ? ' хотя бы на одном складе' : ''}, она удовлетворяется целиком — ${senior ? 'с первого по приоритету склада, где свободный остаток не меньше её `q`, остаток этого склада уменьшается на `q`' : 'свободный остаток не меньше её `q` и уменьшается на `q`'} — становится активным резервом и уходит из очереди. Заявка, которой не хватает, ждёт и не пропускает вперёд следующие, даже если им товара хватило бы; поэтому новый резерв при непустой очереди тоже ждёт.`,
		`Очередь товара обслуживается так же после каждой поставки этого товара${senior ? ' на любой склад' : ''}, после снятия активного резерва этого товара и после снятия ожидающей заявки. \`release\` ожидающей заявки убирает её из очереди (ответ \`ok\`); \`confirm\` ожидающей заявки ничего не меняет (\`ignore\`). Снятый резерв возвращает товар${senior ? ' на тот склад, с которого взят' : ''}.`
	]
};

function statement(kind: string, senior: boolean): string {
	const expiring = kind === 'expiring';
	const backorder = kind === 'backorder';
	const head = senior
		? `\`S P E${expiring ? ' T' : ''}\`: число складов (1 ≤ S ≤ 10), число товаров (1 ≤ P ≤ 50), число событий (1 ≤ E ≤ 5000)`
		: `\`P E${expiring ? ' T' : ''}\`: число товаров (1 ≤ P ≤ 50), число событий (1 ≤ E ≤ 5000)`;
	return [
		senior
			? 'Сеть складов интернет-магазина резервирует товар под заказы. Напишите программу, которая обрабатывает журнал событий и печатает решение по каждому событию и итоговые остатки.'
			: 'Склад интернет-магазина резервирует товар под заказы. Напишите программу, которая обрабатывает журнал событий склада и печатает решение по каждому событию и итоговые остатки.',
		'',
		'## Вход',
		'',
		`В первой строке — ${head}${expiring ? ', срок резерва в секундах (1 ≤ T ≤ 10⁶)' : ''}.`,
		...(senior
			? [
					'Во второй строке — `P` различных названий товаров. Далее `S` строк `<склад> q₁ … q_P` — свободные остатки товаров на складе в порядке второй строки (0 ≤ qᵢ ≤ 10⁶). Склады перечислены в порядке приоритета: первый — самый приоритетный.'
				]
			: ['Далее `P` строк `<товар> <остаток>` — различные товары и их свободные остатки (0 ≤ остаток ≤ 10⁶).']),
		'Далее `E` строк событий, каждая — одного из видов:',
		'',
		'- `t reserve <id> <клиент> <товар> <q>` — резерв `q` единиц товара (1 ≤ q ≤ 1000) под номером `id`; номера резервов не повторяются;',
		'- `t release <id>` — снять резерв: товар возвращается в свободный остаток;',
		'- `t confirm <id>` — подтвердить резерв: товар уходит со склада и в остаток не возвращается;',
		`- \`t restock ${senior ? '<склад> ' : ''}<товар> <q>\` — поставка: свободный остаток товара${senior ? ' на складе' : ''} растёт на \`q\` (1 ≤ q ≤ 1000).`,
		'',
		'`t` — момент в секундах (0 ≤ t ≤ 10⁹), моменты не убывают, события одного момента обрабатываются в порядке строк. Номера, клиенты, товары и склады — латинские буквы и цифры.',
		'',
		'## Правило',
		'',
		...(RULE[kind]?.(senior) ?? []),
		backorder
			? 'В остальном `release` и `confirm` действуют только на активный резерв; для уже снятого или подтверждённого резерва событие ничего не меняет.'
			: `\`release\` и \`confirm\` действуют только на активный резерв; для отклонённого, уже снятого${expiring ? ', истёкшего' : ''} или подтверждённого резерва событие ничего не меняет.`,
		'',
		'## Выход',
		'',
		'По строке на каждое событие, по порядку:',
		'',
		`- \`reserve\` — ${kind === 'partial' ? '`ok <выдано>`' : senior ? '`ok <склад>`' : '`ok`'} или ${backorder ? '`wait`, если заявка встала в очередь (о её удовлетворении позже ничего не печатается)' : '`reject`'};`,
		`- \`release\`, \`confirm\` — \`ok\`, если резерв был активен${backorder ? ' (или снята ожидающая заявка)' : ''}, иначе \`ignore\`;`,
		`- \`restock\` — свободный остаток товара${senior ? ' на этом складе' : ''} после поставки${backorder ? ' и обслуживания очереди' : ''}.`,
		'',
		senior
			? 'Затем `S·P` строк `<склад> <товар> <свободный остаток> <количество в активных резервах>`: склады в порядке приоритета, внутри склада — товары в порядке второй строки.'
			: 'Затем `P` строк `<товар> <свободный остаток> <количество в активных резервах>` в порядке товаров во входе.',
		...(expiring
			? [
					'Итог — сразу после последнего события: резервы, срок которых наступает позже последнего момента журнала, остаются активными.'
				]
			: []),
		...(backorder
			? [
					`Затем \`P\` строк \`<товар> <число ожидающих заявок> <сумма их q>\` в порядке товаров ${senior ? 'второй строки' : 'во входе'}.`
				]
			: []),
		'',
		`Скрытые тесты — пять групп: обычные данные, запросы ровно на остаток${expiring ? ' и события точно в момент истечения' : ''}, повторные события в один момент, подтверждения резервов, большой объём. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

function changeStatement(kind: string, senior: boolean): string {
	const header = `${senior ? 'S ' : ''}P E${kind === 'expiring' ? ' T' : ''} C`;
	if (kind === 'backorder') {
		return [
			`**Новое условие.** У каждого клиента сумма количеств в его активных резервах и ожидающих заявках (по всем товарам${senior ? ' и складам' : ''}) не может превышать \`C\`.`,
			'Заявка, после которой сумма превысила бы `C`, отклоняется (ответ `reject`) и в очередь не встаёт; удовлетворение заявки из очереди сумму не меняет.',
			'Снятие и подтверждение активного резерва и снятие ожидающей заявки освобождают лимит клиента.',
			`Первая строка входа теперь \`${header}\` (1 ≤ C ≤ 10⁶). Измените решение и отправьте его снова; формат вывода прежний.`
		].join('\n');
	}
	return [
		`**Новое условие.** У каждого клиента сумма количеств в его активных резервах (по всем товарам${senior ? ' и складам' : ''}) не может превышать \`C\`.`,
		kind === 'partial'
			? `Резерв клиента, у которого в активных резервах уже \`h\` единиц, получает не больше \`C − h\`: ${senior ? 'набирается не больше `min(q, C − h)` по прежнему правилу' : 'выдаётся `min(q, свободный остаток, C − h)`'}; если выдано 0 — резерв отклоняется.`
			: 'Резерв, после которого сумма превысила бы `C`, отклоняется, даже если товара хватает.',
		`${kind === 'expiring' ? 'Снятие, подтверждение и истечение' : 'Снятие и подтверждение'} резерва освобождают лимит клиента; отклонённый резерв лимит не занимает.`,
		`Первая строка входа теперь \`${header}\` (1 ≤ C ≤ 10⁶). Измените решение и отправьте его снова; формат вывода прежний.`
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, senior: boolean, withLimit: boolean, variant: Variant): string {
	const expiring = kind === 'expiring';
	const head = [...(senior ? ['s'] : []), 'p', 'e', ...(expiring ? ['ttl'] : []), ...(withLimit ? ['cap'] : [])];
	const take = variant === 'stale-release' ? 'held.get' : 'held.pop';
	const fits = variant === 'exact-stock' ? '<' : '<=';
	// A hold is (product, parts) and with the limit also (client, total); parts are (warehouse, quantity) pairs on
	// Senior and the quantity on Middle.
	const giveBack = senior
		? [
				'        for w, q in r[1]:',
				'            busy[w][r[0]] -= q',
				'            if back:',
				'                free[w][r[0]] += q'
			]
		: ['        busy[r[0]] -= r[1]', '        if back:', '            free[r[0]] += r[1]'];
	if (kind === 'backorder') return backorderSource(senior, withLimit, variant);
	const lines: string[] = [
		'import sys',
		...(expiring ? ['from collections import deque'] : []),
		'',
		...parseStock(senior, head)
	];
	lines.push(
		'held = {}',
		...(withLimit ? ['owed = {}'] : []),
		...(expiring ? ['queue = deque()'] : []),
		'',
		'',
		'def drop(rid, back):',
		`    r = ${take}(rid, None)`,
		'    if r is not None:',
		...giveBack,
		...(withLimit ? ['        owed[r[2]] -= r[3]'] : []),
		'    return r is not None',
		'',
		'',
		'for i in range(e):',
		'    t, op = int(data[pos]), data[pos + 1]'
	);
	if (expiring) {
		lines.push(
			`    while queue and queue[0][0] ${variant === 'late-expiry' ? '<' : '<='} t:`,
			'        drop(queue.popleft()[1], True)'
		);
	}
	lines.push(
		"    if op == 'reserve':",
		withLimit
			? '        rid, client, product, qty = data[pos + 2], data[pos + 3], data[pos + 4], int(data[pos + 5])'
			: '        rid, product, qty = data[pos + 2], data[pos + 4], int(data[pos + 5])',
		'        pos += 6',
		...(withLimit ? ['        room = cap - owed.get(client, 0)'] : [])
	);
	const accept = (parts: string, total: string, answer: string): string[] => [
		`            held[rid] = (product, ${parts}${withLimit ? `, client, ${total}` : ''})`,
		...(withLimit ? [`            owed[client] = owed.get(client, 0) + ${total}`] : []),
		...(expiring ? ['            queue.append((t + ttl, rid))'] : []),
		`            print(${answer})`
	];
	if (kind === 'partial' && !senior) {
		const kept = variant === 'release-requested' ? 'qty' : 'got';
		lines.push(
			`        got = min(qty, free[product]${withLimit ? ', room' : ''})`,
			'        if got > 0:',
			'            free[product] -= got',
			'            busy[product] += got',
			...accept(kept, kept, "'ok', got"),
			'        else:',
			"            print('reject')"
		);
	} else if (kind === 'partial') {
		const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > 0][:1]' : 'free';
		lines.push(
			`        need, parts = ${withLimit ? 'min(qty, room)' : 'qty'}, []`,
			`        for w in ${order}:`,
			'            got = min(need, free[w][product])',
			'            if got > 0:',
			'                free[w][product] -= got',
			'                busy[w][product] += got',
			'                parts.append((w, got))',
			'                need -= got',
			'        if parts:',
			'            total = sum(q for w, q in parts)',
			...accept('parts', 'total', "'ok', total"),
			'        else:',
			"            print('reject')"
		);
	} else if (senior) {
		const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > 0][:1]' : 'free';
		lines.push(
			`        for w in ${order}:`,
			`            if qty ${fits} free[w][product]${withLimit ? ' and qty <= room' : ''}:`,
			'                free[w][product] -= qty',
			'                busy[w][product] += qty',
			...accept('[(w, qty)]', 'qty', "'ok', w").map((l) => `    ${l}`),
			'                break',
			'        else:',
			"            print('reject')"
		);
	} else {
		lines.push(
			`        if qty ${fits} free[product]${withLimit ? ' and qty <= room' : ''}:`,
			'            free[product] -= qty',
			'            busy[product] += qty',
			...accept('qty', 'qty', "'ok'"),
			'        else:',
			"            print('reject')"
		);
	}
	const at = senior ? 'free[data[pos + 2]][data[pos + 3]]' : 'free[data[pos + 2]]';
	lines.push(
		"    elif op == 'restock':",
		`        ${at} += int(data[pos + ${senior ? 4 : 3}])`,
		`        print(${at})`,
		`        pos += ${senior ? 5 : 4}`,
		'    else:',
		`        print('ok' if drop(data[pos + 2], ${variant === 'confirm-returns' ? 'True' : "op == 'release'"}) else 'ignore')`,
		'        pos += 3',
		...(senior
			? ['for w in free:', '    for name in names:', '        print(w, name, free[w][name], busy[w][name])']
			: ['for product in free:', '    print(product, free[product], busy[product])'])
	);
	return lines.join('\n');
}

/** The header and the stock of the input, parsed the same way by every class. */
function parseStock(senior: boolean, head: readonly string[]): string[] {
	const lines = [
		'data = sys.stdin.read().split()',
		`${head.join(', ')} = ${head.map((_, i) => `int(data[${i}])`).join(', ')}`
	];
	if (senior) {
		lines.push(
			`names = data[${head.length}:${head.length} + p]`,
			`pos = ${head.length} + p`,
			'free, busy = {}, {}',
			'for i in range(s):',
			'    free[data[pos]] = dict(zip(names, map(int, data[pos + 1:pos + 1 + p])))',
			'    busy[data[pos]] = dict.fromkeys(names, 0)',
			'    pos += 1 + p'
		);
	} else {
		lines.push(
			`pos = ${head.length}`,
			'free, busy = {}, {}',
			'for i in range(p):',
			'    free[data[pos]], busy[data[pos]] = int(data[pos + 1]), 0',
			'    pos += 2'
		);
	}
	return lines;
}

/** The reference of the backorder class: whole reservations served from a strict first-come queue per product. */
function backorderSource(senior: boolean, withLimit: boolean, variant: Variant): string {
	const head = [...(senior ? ['s'] : []), 'p', 'e', ...(withLimit ? ['cap'] : [])];
	const fits = variant === 'exact-stock' ? '<' : '<=';
	const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > 0][:1]' : 'free';
	const extra = withLimit ? ', client, qty' : '';
	const pop = withLimit ? 'qty, client = waiting.pop(rid)[1:]' : 'qty = waiting.pop(rid)[1]';
	// Activating a waiting reservation `rid` of `product` for `qty`, on Senior from the warehouse `w`.
	const activate = (indent: string): string[] =>
		(senior
			? [
					'w = place(product, qty)',
					'free[w][product] -= qty',
					'busy[w][product] += qty',
					`held[rid] = (product, [(w, qty)]${extra})`
				]
			: ['free[product] -= qty', 'busy[product] += qty', `held[rid] = (product, qty${extra})`]
		).map((l) => indent + l);
	const ready = (qty: string): string =>
		senior ? `place(product, ${qty}) is not None` : `${qty} ${fits} free[product]`;
	const serve =
		variant === 'skip-ahead'
			? [
					'def serve(product):',
					'    for rid in list(queue[product]):',
					`        if ${ready('waiting[rid][1]')}:`,
					'            queue[product].remove(rid)',
					`            ${pop}`,
					...activate('            ')
				]
			: [
					'def serve(product):',
					'    line = queue[product]',
					`    while line and ${ready('waiting[line[0]][1]')}:`,
					'        rid = line.pop(0)',
					`        ${pop}`,
					...activate('        ')
				];
	const giveBack = senior
		? [
				'        for w, q in r[1]:',
				'            busy[w][r[0]] -= q',
				'            if back:',
				'                free[w][r[0]] += q',
				'        if back:',
				'            serve(r[0])'
			]
		: ['        busy[r[0]] -= r[1]', '        if back:', '            free[r[0]] += r[1]', '            serve(r[0])'];
	const enqueue =
		variant === 'queue-jump'
			? `queue[product].insert(0 if ${ready('qty')} else len(queue[product]), rid)`
			: 'queue[product].append(rid)';
	const answer = senior ? "f'ok {held[rid][1][0][0]}' if rid in held else 'wait'" : "'ok' if rid in held else 'wait'";
	const admit = [
		...(withLimit ? ['owed[client] = owed.get(client, 0) + qty'] : []),
		`waiting[rid] = (product, qty${withLimit ? ', client' : ''})`,
		enqueue,
		'serve(product)',
		`print(${answer})`
	];
	const at = senior ? 'free[data[pos + 2]][data[pos + 3]]' : 'free[data[pos + 2]]';
	return [
		'import sys',
		'',
		...parseStock(senior, head),
		'held = {}',
		'waiting = {}',
		`queue = {product: [] for product in ${senior ? 'names' : 'free'}}`,
		...(withLimit ? ['owed = {}'] : []),
		'',
		'',
		...(senior
			? [
					'def place(product, qty):',
					`    for w in ${order}:`,
					`        if qty ${fits} free[w][product]:`,
					'            return w',
					'    return None',
					'',
					''
				]
			: []),
		...serve,
		'',
		'',
		'def drop(rid, back):',
		`    r = ${variant === 'stale-release' ? 'held.get' : 'held.pop'}(rid, None)`,
		'    if r is not None:',
		...(withLimit ? ['        owed[r[2]] -= r[3]'] : []),
		...giveBack,
		'    return r is not None',
		'',
		'',
		'for i in range(e):',
		'    op = data[pos + 1]',
		"    if op == 'reserve':",
		withLimit
			? '        rid, client, product, qty = data[pos + 2], data[pos + 3], data[pos + 4], int(data[pos + 5])'
			: '        rid, product, qty = data[pos + 2], data[pos + 4], int(data[pos + 5])',
		'        pos += 6',
		...(withLimit
			? [
					'        if owed.get(client, 0) + qty > cap:',
					"            print('reject')",
					'        else:',
					...admit.map((l) => `            ${l}`)
				]
			: admit.map((l) => `        ${l}`)),
		"    elif op == 'restock':",
		`        ${at} += int(data[pos + ${senior ? 4 : 3}])`,
		`        serve(data[pos + ${senior ? 3 : 2}])`,
		`        print(${at})`,
		`        pos += ${senior ? 5 : 4}`,
		'    else:',
		'        rid = data[pos + 2]',
		'        pos += 3',
		"        if op == 'release' and rid in waiting:",
		`            product${withLimit ? ', qty, client' : ''} = waiting.pop(rid)${withLimit ? '' : '[0]'}`,
		...(withLimit ? ['            owed[client] -= qty'] : []),
		'            queue[product].remove(rid)',
		'            serve(product)',
		"            print('ok')",
		'        else:',
		`            print('ok' if drop(rid, ${variant === 'confirm-returns' ? 'True' : "op == 'release'"}) else 'ignore')`,
		...(senior
			? [
					'for w in free:',
					'    for name in names:',
					'        print(w, name, free[w][name], busy[w][name])',
					'for name in names:',
					'    print(name, len(queue[name]), sum(waiting[rid][1] for rid in queue[name]))'
				]
			: [
					'for product in free:',
					'    print(product, free[product], busy[product])',
					'for product in free:',
					'    print(product, len(queue[product]), sum(waiting[rid][1] for rid in queue[product]))'
				])
	].join('\n');
}

const WRONG_IDS = [
	'stale-release',
	'exact-stock',
	'release-requested',
	'late-expiry',
	'single-warehouse',
	'confirm-returns',
	'queue-jump',
	'skip-ahead'
] as const;

function applies(id: (typeof WRONG_IDS)[number], kind: string, senior: boolean): boolean {
	switch (id) {
		case 'stale-release':
			return true;
		case 'exact-stock':
			return kind !== 'partial';
		case 'release-requested':
			return kind === 'partial' && !senior;
		case 'late-expiry':
			return kind === 'expiring';
		case 'single-warehouse':
			return senior;
		case 'confirm-returns':
			return true;
		case 'queue-jump':
		case 'skip-ahead':
			return kind === 'backorder';
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const kind = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const main = groups(rng, kind, others, senior, false);
	const step = groups(rng, kind, others, senior, true);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, senior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'exact' } },
		changeStep: { markdown: changeStatement(kind, senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(kind, senior, false, 'right'),
			changeSource: referenceSource(kind, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, kind, senior)
						? { kind: 'program' as const, source: referenceSource(kind, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
