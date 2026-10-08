// Practice: a warehouse keeps the free stock of goods and reserves it for orders over a log of events; the class sets
// how a reservation is met (whole or nothing, partial, whole with expiry, whole from a first-come queue of backorders);
// Senior has several warehouses taken in priority order, except the queue class, which keeps one warehouse. Two of the
// five groups of hidden tests are short logs of reservations and restocks only; three check the whole life cycle. The
// step «измени своё решение» adds a limit on the active reservations of a client.
// The safety stock, the term of a reservation, the words of the answers and the order of the final numbers are the
// instance's own (`Spec`): they are given only in the statement, never in the input, and every group of hidden tests
// fails a program with a neighbouring specification, so a program written for another instance of the class fails here.
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

/** One warehouse is never named in the input. */
interface Input {
	warehouses: string[];
	products: string[];
	stock: number[][];
	limit: number | null;
	events: Ev[];
}

/** The answers a solution prints. */
interface Words {
	ok: string;
	reject: string;
	ignore: string;
	wait: string;
}

/** The constants of the instance's specification, stated in the text only. */
interface Spec {
	/** The safety stock: so many units of every product on every warehouse are never reserved. */
	safety: number;
	/** The term of a reservation, seconds; 0 outside the expiring class. */
	ttl: number;
	words: Words;
	/** The final rows give the reserved quantity before the free one. */
	swap: boolean;
}

const SAFETY = [1, 2, 3, 4] as const;
const TTLS = [20, 30, 45, 60, 90, 120] as const;
/** No word is shared by two sets. */
const WORDS: readonly Words[] = [
	{ ok: 'ok', reject: 'reject', ignore: 'ignore', wait: 'wait' },
	{ ok: 'accepted', reject: 'declined', ignore: 'skipped', wait: 'queued' },
	{ ok: 'yes', reject: 'no', ignore: 'noop', wait: 'hold' },
	{ ok: 'done', reject: 'fail', ignore: 'none', wait: 'pending' },
	{ ok: 'granted', reject: 'refused', ignore: 'unchanged', wait: 'waiting' }
];

function drawSpec(rng: Rng, kind: string): Spec {
	return {
		safety: rng.pick(SAFETY),
		ttl: kind === 'expiring' ? rng.pick(TTLS) : 0,
		words: rng.pick(WORDS),
		swap: rng.bool()
	};
}

/** The specifications one constant away from the instance's (other words are told apart by any test). */
function neighbours(kind: string, spec: Spec): Spec[] {
	const list: Spec[] = [{ ...spec, swap: !spec.swap }];
	for (const safety of SAFETY) if (safety !== spec.safety) list.push({ ...spec, safety });
	if (kind === 'expiring') for (const ttl of TTLS) if (ttl !== spec.ttl) list.push({ ...spec, ttl });
	return list;
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
	readonly spec: Spec;
	readonly multi: boolean;
	readonly variant: Variant;

	constructor(kind: string, input: Input, spec: Spec, multi: boolean, variant: Variant) {
		this.kind = kind;
		this.input = input;
		this.spec = spec;
		this.multi = multi;
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

	/** What a reservation may take: the free stock over the safety stock. */
	available(w: string, p: string): number {
		return Math.max(0, this.get(this.free, w, p) - this.spec.safety);
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
			const free = this.available(x, product);
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
		if (this.input.limit !== null && owed + e.qty > this.input.limit) return this.spec.words.reject;
		this.owed.set(e.client, owed + e.qty);
		this.waiting.set(e.id, { product: e.product, qty: e.qty, client: e.client });
		const line = this.lines.get(e.product) ?? [];
		if (this.variant === 'queue-jump' && this.place(e.product, e.qty) !== undefined) line.unshift(e.id);
		else line.push(e.id);
		this.serve(e.product);
		const h = this.held.get(e.id);
		if (!h) return this.spec.words.wait;
		return this.multi ? `${this.spec.words.ok} ${h.parts[0]?.[0] ?? ''}` : this.spec.words.ok;
	}

	/** The warehouses a reservation may take from, in priority order. */
	candidates(product: string): string[] {
		const all = this.input.warehouses;
		if (this.variant !== 'single-warehouse') return all;
		return all.filter((w) => this.available(w, product) > 0).slice(0, 1);
	}

	reserve(e: Extract<Ev, { op: 'reserve' }>): string {
		const room = this.input.limit === null ? Infinity : this.input.limit - (this.owed.get(e.client) ?? 0);
		let parts: [string, number][] = [];
		if (this.kind === 'partial') {
			let need = Math.min(e.qty, room);
			for (const w of this.candidates(e.product)) {
				const take = Math.min(need, this.available(w, e.product));
				if (take > 0) {
					parts.push([w, take]);
					need -= take;
				}
			}
		} else if (e.qty <= room) {
			const w = this.place(e.product, e.qty);
			if (w !== undefined) parts = [[w, e.qty]];
		}
		if (parts.length === 0) return this.spec.words.reject;
		const total = parts.reduce((s, [, q]) => s + q, 0);
		this.take(e.id, e.product, e.client, parts, total);
		if (this.variant === 'release-requested') {
			// The hold remembers the requested quantity instead of the one given.
			const [w] = parts[0] ?? [''];
			this.held.set(e.id, { product: e.product, client: e.client, parts: [[w, e.qty]], total: e.qty });
		}
		const recorded = this.variant === 'release-requested' ? e.qty : total;
		this.owed.set(e.client, (this.owed.get(e.client) ?? 0) + recorded);
		if (this.kind === 'expiring') this.queue.push({ deadline: e.t + this.spec.ttl, id: e.id });
		const { ok } = this.spec.words;
		if (this.kind === 'partial') return `${ok} ${total}`;
		return this.multi ? `${ok} ${parts[0]?.[0] ?? ''}` : ok;
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
			return this.spec.words.ok;
		}
		return this.drop(e.id, e.op === 'release' || this.variant === 'confirm-returns')
			? this.spec.words.ok
			: this.spec.words.ignore;
	}

	final(): string[] {
		const stock = this.input.warehouses.flatMap((w) =>
			this.input.products.map((p) =>
				[
					...(this.multi ? [w] : []),
					p,
					...(this.spec.swap
						? [this.get(this.busy, w, p), this.get(this.free, w, p)]
						: [this.get(this.free, w, p), this.get(this.busy, w, p)])
				].join(' ')
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

function simulate(kind: string, input: Input, spec: Spec, multi: boolean, variant: Variant = 'right'): string {
	const store = new Store(kind, input, spec, multi, variant);
	const out = input.events.map((e) => store.apply(e));
	return `${[...out, ...store.final()].join('\n')}\n`;
}

function render(input: Input, multi: boolean): string {
	const head = [
		...(multi ? [input.warehouses.length] : []),
		input.products.length,
		input.events.length,
		...(input.limit === null ? [] : [input.limit])
	].join(' ');
	const stock = multi
		? [input.products.join(' '), ...input.warehouses.map((w, i) => [w, ...(input.stock[i] ?? [])].join(' '))]
		: input.products.map((p, j) => `${p} ${input.stock[0]?.[j] ?? 0}`);
	const events = input.events.map((e) => {
		if (e.op === 'reserve') return `${e.t} reserve ${e.id} ${e.client} ${e.product} ${e.qty}`;
		if (e.op === 'restock') return `${e.t} restock ${multi ? `${e.warehouse} ` : ''}${e.product} ${e.qty}`;
		return `${e.t} ${e.op} ${e.id}`;
	});
	return `${[head, ...stock, ...events].join('\n')}\n`;
}

type GroupId = 'reserve' | 'exact' | 'release' | 'lifecycle' | 'scale';

/** The groups of short logs with reservations and restocks only. */
const SIMPLE: ReadonlySet<GroupId> = new Set(['reserve', 'exact']);

/** Whether the instance has several warehouses: Senior, except the queue class. */
function multiOf(kind: string, senior: boolean): boolean {
	return senior && kind !== 'backorder';
}

/** The numbers of the first line of the main task: the classes with the same count read each other's input. */
function arity(kind: string, senior: boolean): number {
	return multiOf(kind, senior) ? 3 : 2;
}

const PRODUCTS = ['apple', 'pear', 'milk', 'bread', 'cheese', 'rice', 'tea', 'soap', 'salt', 'sugar', 'honey', 'juice'];
const WAREHOUSES = ['north', 'south', 'east', 'west', 'central', 'river', 'port', 'hill'];

function distinct(rng: Rng, pool: readonly string[], count: number): string[] {
	const names = new Set<string>(rng.sample(pool, Math.min(count, pool.length)));
	while (names.size < count) names.add(`${rng.pick(pool)}${rng.int(1, 99)}`);
	return [...names];
}

function makeInput(rng: Rng, kind: string, group: GroupId, multi: boolean, withLimit: boolean, spec: Spec): Input {
	const scale = group === 'scale';
	const simple = SIMPLE.has(group);
	const warehouses = multi ? distinct(rng, WAREHOUSES, scale ? rng.int(4, 6) : rng.int(2, 4)) : ['main'];
	const products = distinct(rng, PRODUCTS, scale ? rng.int(15, 30) : rng.int(2, multi ? 3 : 4));
	// Over the safety stock, as much as a reservation may take as without it.
	const stock = warehouses.map(() => products.map(() => (rng.bool(0.2) ? 0 : rng.int(1, 8) + spec.safety)));
	const clients = distinct(rng, PERSON_NAMES, scale ? 16 : rng.int(2, 4));
	const unit = kind === 'expiring' ? Math.floor(spec.ttl / 3) : rng.pick([5, 10, 20]);
	const input: Input = { warehouses, products, stock, limit: withLimit ? rng.int(4, 10) : null, events: [] };
	const store = new Store(kind, input, spec, multi, 'right');
	const issued: string[] = [];
	let serial = rng.int(1, 900);
	let t = rng.int(0, 100);
	const count = scale ? rng.int(1000, 1500) : simple ? rng.int(8, 14) : rng.int(14, 24);
	while (input.events.length < count) {
		const due = store.queue[store.head]?.deadline;
		// The short logs last less than any term of a reservation: nothing expires there.
		if (simple) t += rng.int(0, 1);
		else if (group === 'lifecycle' && due !== undefined && due >= t && rng.bool(0.4)) t = due;
		else if (group === 'release') t += rng.bool(0.6) ? 0 : rng.int(1, 2 * unit);
		else t += rng.int(0, unit);
		store.advance(t);
		const roll = rng.next();
		// The lifecycle tests confirm reservations often and then check the stock by restocks.
		const [reserves, settles] = simple ? [0.65, 0.65] : group === 'lifecycle' ? [0.35, 0.7] : [0.4, 0.75];
		let e: Ev;
		if (roll < reserves || issued.length === 0) {
			const product = rng.pick(products);
			const most = Math.max(...warehouses.map((w) => store.available(w, product)));
			const exact = group === 'exact' && most > 0 && rng.bool(0.6);
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
		if (group === 'release' && e.op !== 'restock' && e.op !== 'reserve' && rng.bool(0.5)) {
			// The same reservation released or confirmed again in the same moment.
			const again: Ev = { t, op: rng.bool(0.5) ? 'release' : 'confirm', id: e.id };
			store.apply(again);
			input.events.push(again);
		}
	}
	return input;
}

/** The wrong solutions a group must expose on every test, by class; the short logs keep to the reservation rule. */
function traps(kind: string, group: GroupId, multi: boolean): Variant[] {
	const list: Variant[] = [];
	if (group === 'reserve' && multi) list.push('single-warehouse');
	if (group === 'exact' && kind !== 'partial') list.push('exact-stock');
	if (group === 'release') list.push('stale-release');
	if (group === 'release' && kind === 'partial' && !multi) list.push('release-requested');
	if (group === 'release' && kind === 'backorder') list.push('queue-jump');
	if (group === 'lifecycle') list.push('confirm-returns');
	if (group === 'lifecycle' && kind === 'expiring') list.push('late-expiry');
	if (group === 'lifecycle' && kind === 'backorder') list.push('skip-ahead');
	return list;
}

/**
 * Hidden tests of the class; every test tells the class from the others, the step's tests feel the limit, and every
 * group fails a program with a neighbouring specification: each neighbour is told apart by some test of the group,
 * every test tells apart one not told yet. Nothing expires in the short logs, so there the term is not felt.
 */
function groups(
	rng: Rng,
	kind: string,
	others: readonly string[],
	senior: boolean,
	withLimit: boolean,
	spec: Spec
): HiddenTestGroup[] {
	const multi = multiOf(kind, senior);
	const ids: GroupId[] = ['reserve', 'exact', 'release', 'lifecycle', 'scale'];
	// A class with another first line reads a test of this class as garbage, so only the same shape is compared.
	const comparable = others.filter((other) => arity(other, senior) === arity(kind, senior));
	// The expiring class is compared with its shortest term; in the short logs nothing expires, so there it answers as
	// the class without expiry by design.
	const otherSpec = (other: string): Spec => (other === 'expiring' ? { ...spec, ttl: TTLS[0] } : spec);
	const sameInShortLogs = new Set(['expiring', 'all-or-nothing']);
	const distinctIn = (other: string, id: GroupId): boolean =>
		!SIMPLE.has(id) || !(sameInShortLogs.has(kind) && sameInShortLogs.has(other));
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 4;
		const open = neighbours(kind, spec).filter((n) => !SIMPLE.has(id) || n.ttl === spec.ttl);
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000)
				throw new Error(
					`${descriptor.key}: no distinguishing ${id} test for ${kind}${open.length > 0 ? ` (${JSON.stringify(spec)} not told from ${JSON.stringify(open)})` : ''}`
				);
			const input = makeInput(rng, kind, id, multi, withLimit, spec);
			const expected = simulate(kind, input, spec, multi);
			if (
				comparable.some(
					(other) => distinctIn(other, id) && simulate(other, input, otherSpec(other), multi) === expected
				)
			)
				continue;
			if (withLimit && simulate(kind, { ...input, limit: null }, spec, multi) === expected) continue;
			if (!withLimit && traps(kind, id, multi).some((v) => simulate(kind, input, spec, multi, v) === expected))
				continue;
			const told = open.filter((n) => simulate(kind, input, n, multi) !== expected);
			if (open.length > 0 && told.length === 0) continue;
			if (tests.length === count - 1 && told.length < open.length) continue;
			for (const n of told) open.splice(open.indexOf(n), 1);
			tests.push({ stdin: render(input, multi), expected });
		}
		return { id, tests };
	});
}

const RULE: Record<string, (multi: boolean) => string[]> = {
	'all-or-nothing': (multi) => [
		multi
			? 'Резерв удовлетворяется целиком с одного склада — первого по приоритету, где доступный остаток товара не меньше `q`: свободный остаток этого склада уменьшается на `q`, резерв становится активным. Если такого склада нет, резерв отклоняется и ничего не меняет.'
			: 'Резерв удовлетворяется целиком, если доступный остаток товара не меньше `q`: свободный остаток уменьшается на `q`, резерв становится активным. Иначе резерв отклоняется и ничего не меняет.'
	],
	partial: (multi) => [
		multi
			? 'Резерв набирается по складам в порядке приоритета: с каждого склада берётся `min(сколько ещё не хватает, доступный остаток товара на складе)`, пока не наберётся `q` или не кончатся склады. Выдано — сумма взятого; если выдано 0, резерв отклоняется и ничего не меняет, иначе резерв становится активным с выданным количеством. Снятый резерв возвращает товар на те склады и в тех количествах, с которых он взят.'
			: 'Резерв получает `min(q, доступный остаток товара)` единиц. Если это 0, резерв отклоняется и ничего не меняет; иначе свободный остаток уменьшается на выданное количество и резерв становится активным с этим количеством.'
	],
	expiring: (multi) => [
		...(RULE['all-or-nothing']?.(multi) ?? []),
		`Активный резерв, принятый в момент \`t₀\`, истекает в момент \`t₀ + T\`, если до этого его не сняли и не подтвердили: товар возвращается в свободный остаток${multi ? ' того склада, с которого взят' : ''}, резерв перестаёт быть активным. Истечения момента обрабатываются **до** событий этого момента: событие в момент \`t₀ + T\` уже видит возвращённый товар, а снять или подтвердить истёкший резерв нельзя.`
	],
	backorder: () => [
		'Заявки на товар обслуживаются строго в порядке поступления. Новый резерв встаёт в конец очереди своего товара, после чего очередь обслуживается: пока первой заявке очереди хватает доступного остатка (доступный остаток не меньше её `q`), она удовлетворяется целиком — свободный остаток уменьшается на `q`, заявка становится активным резервом и уходит из очереди. Заявка, которой не хватает, ждёт и не пропускает вперёд следующие, даже если им товара хватило бы; поэтому новый резерв при непустой очереди тоже ждёт.',
		'Очередь товара обслуживается так же после каждой поставки этого товара, после снятия активного резерва этого товара и после снятия ожидающей заявки. `release` ожидающей заявки убирает её из очереди (ответ — как на снятие активного резерва); `confirm` ожидающей заявки ничего не меняет (ответ — как на событие, которое ничего не меняет).'
	]
};

/** A ready parser of the input in Python, so the candidate writes the rules, not the reading. */
function parseSnippet(multi: boolean): string[] {
	const head = [...(multi ? ['s'] : []), 'p', 'e'];
	const n = head.length;
	return [
		'```python',
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		`${head.join(', ')} = map(int, data[:${n}])`,
		...(multi
			? [
					`names = data[${n}:${n} + p]  # товары в порядке второй строки`,
					`pos = ${n} + p`,
					'stock = {}  # склад -> {товар: остаток}, склады в порядке приоритета',
					'for _ in range(s):',
					'    stock[data[pos]] = dict(zip(names, map(int, data[pos + 1:pos + 1 + p])))',
					'    pos += 1 + p'
				]
			: [
					`stock = {data[${n} + 2 * i]: int(data[${n + 1} + 2 * i]) for i in range(p)}  # товар -> остаток`,
					`pos = ${n} + 2 * p`
				]),
		'# события: (t, операция, поля строками)',
		`# reserve: id, клиент, товар, q; restock: ${multi ? 'склад, ' : ''}товар, q; release и confirm: id`,
		'events = []',
		'for _ in range(e):',
		'    t, op = int(data[pos]), data[pos + 1]',
		`    n = {'reserve': 4, 'restock': ${multi ? 3 : 2}}.get(op, 1)`,
		'    events.append((t, op, *data[pos + 2:pos + 2 + n]))',
		'    pos += 2 + n',
		'```'
	];
}

function statement(kind: string, multi: boolean, spec: Spec): string {
	const expiring = kind === 'expiring';
	const backorder = kind === 'backorder';
	const { ok, reject, ignore, wait } = spec.words;
	const head = multi
		? '`S P E`: число складов (1 ≤ S ≤ 10), число товаров (1 ≤ P ≤ 50), число событий (1 ≤ E ≤ 1500)'
		: '`P E`: число товаров (1 ≤ P ≤ 50), число событий (1 ≤ E ≤ 1500)';
	const numbers = spec.swap
		? '<количество в активных резервах> <свободный остаток>'
		: '<свободный остаток> <количество в активных резервах>';
	return [
		multi
			? 'Сеть складов интернет-магазина резервирует товар под заказы. Напишите программу, которая обрабатывает журнал событий и печатает решение по каждому событию и итоговые остатки.'
			: 'Склад интернет-магазина резервирует товар под заказы. Напишите программу, которая обрабатывает журнал событий склада и печатает решение по каждому событию и итоговые остатки.',
		'',
		`**Страховой запас R = ${spec.safety}**: ${multi ? 'на каждом складе ' : ''}${spec.safety} ${spec.safety === 1 ? 'единица' : 'единицы'} каждого товара под резервы не ${spec.safety === 1 ? 'отдаётся' : 'отдаются'}. **Доступный остаток** товара${multi ? ' на складе' : ''} — \`max(0, свободный остаток − R)\`; резерв берёт только из доступного остатка.${expiring ? ` **Срок резерва T = ${spec.ttl} с.**` : ''} Во входе ${expiring ? 'R и T' : 'R'} нет.`,
		'',
		'## Вход',
		'',
		`В первой строке — ${head}.`,
		...(multi
			? [
					'Во второй строке — `P` различных названий товаров. Далее `S` строк `<склад> q₁ … q_P` — свободные остатки товаров на складе в порядке второй строки (0 ≤ qᵢ ≤ 10⁶). Склады перечислены в порядке приоритета: первый — самый приоритетный.'
				]
			: ['Далее `P` строк `<товар> <остаток>` — различные товары и их свободные остатки (0 ≤ остаток ≤ 10⁶).']),
		'Далее `E` строк событий, каждая — одного из видов:',
		'',
		'- `t reserve <id> <клиент> <товар> <q>` — резерв `q` единиц товара (1 ≤ q ≤ 1000) под номером `id`; номера резервов не повторяются;',
		'- `t release <id>` — снять резерв: товар возвращается в свободный остаток;',
		'- `t confirm <id>` — подтвердить резерв: товар уходит со склада и в остаток не возвращается;',
		`- \`t restock ${multi ? '<склад> ' : ''}<товар> <q>\` — поставка: свободный остаток товара${multi ? ' на складе' : ''} растёт на \`q\` (1 ≤ q ≤ 1000).`,
		'',
		'`t` — момент в секундах (0 ≤ t ≤ 10⁹), моменты не убывают, события одного момента обрабатываются в порядке строк. Номера, клиенты, товары и склады — латинские буквы и цифры.',
		'',
		'Разбор входа можно взять готовым (на Python; на другом языке — тем же порядком):',
		'',
		...parseSnippet(multi),
		'',
		'## Правило',
		'',
		...(RULE[kind]?.(multi) ?? []),
		backorder
			? 'В остальном `release` и `confirm` действуют только на активный резерв; для уже снятого или подтверждённого резерва событие ничего не меняет.'
			: `\`release\` и \`confirm\` действуют только на активный резерв; для отклонённого, уже снятого${expiring ? ', истёкшего' : ''} или подтверждённого резерва событие ничего не меняет.`,
		'',
		'## Выход',
		'',
		'По строке на каждое событие, по порядку:',
		'',
		`- \`reserve\` — ${kind === 'partial' ? `\`${ok} <выдано>\`` : multi ? `\`${ok} <склад>\`` : `\`${ok}\``} или ${backorder ? `\`${wait}\`, если заявка встала в очередь (о её удовлетворении позже ничего не печатается)` : `\`${reject}\``};`,
		`- \`release\`, \`confirm\` — \`${ok}\`, если резерв был активен${backorder ? ' (или снята ожидающая заявка)' : ''}, иначе \`${ignore}\`;`,
		`- \`restock\` — свободный остаток товара${multi ? ' на этом складе' : ''} после поставки${backorder ? ' и обслуживания очереди' : ''}.`,
		'',
		multi
			? `Затем \`S·P\` строк \`<склад> <товар> ${numbers}\`: склады в порядке приоритета, внутри склада — товары в порядке второй строки.`
			: `Затем \`P\` строк \`<товар> ${numbers}\` в порядке товаров во входе.`,
		...(expiring
			? [
					'Итог — сразу после последнего события: резервы, срок которых наступает позже последнего момента журнала, остаются активными.'
				]
			: []),
		...(backorder
			? [
					`Затем \`P\` строк \`<товар> <число ожидающих заявок> <сумма их q>\` в порядке товаров ${multi ? 'второй строки' : 'во входе'}.`
				]
			: []),
		'',
		`Скрытые тесты — пять групп разной сложности. Две простые — короткие журналы только из \`reserve\` и \`restock\`: обычные запросы и запросы ровно на доступный остаток. Три полные: снятия и подтверждения, в том числе повторные в один момент; весь жизненный цикл резервов${expiring ? ' с событиями точно в момент истечения' : ''}; большой объём (до 1500 событий). Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

function changeStatement(kind: string, multi: boolean, spec: Spec): string {
	const header = `${multi ? 'S ' : ''}P E C`;
	if (kind === 'backorder') {
		return [
			`**Новое условие.** У каждого клиента сумма количеств в его активных резервах и ожидающих заявках (по всем товарам${multi ? ' и складам' : ''}) не может превышать \`C\`.`,
			`Заявка, после которой сумма превысила бы \`C\`, отклоняется (ответ \`${spec.words.reject}\`) и в очередь не встаёт; удовлетворение заявки из очереди сумму не меняет.`,
			'Снятие и подтверждение активного резерва и снятие ожидающей заявки освобождают лимит клиента.',
			`Первая строка входа теперь \`${header}\` (1 ≤ C ≤ 10⁶). Измените решение и отправьте его снова; формат вывода прежний.`
		].join('\n');
	}
	return [
		`**Новое условие.** У каждого клиента сумма количеств в его активных резервах (по всем товарам${multi ? ' и складам' : ''}) не может превышать \`C\`.`,
		kind === 'partial'
			? `Резерв клиента, у которого в активных резервах уже \`h\` единиц, получает не больше \`C − h\`: ${multi ? 'набирается не больше `min(q, C − h)` по прежнему правилу' : 'выдаётся `min(q, доступный остаток, C − h)`'}; если выдано 0 — резерв отклоняется.`
			: 'Резерв, после которого сумма превысила бы `C`, отклоняется, даже если товара хватает.',
		`${kind === 'expiring' ? 'Снятие, подтверждение и истечение' : 'Снятие и подтверждение'} резерва освобождают лимит клиента; отклонённый резерв лимит не занимает.`,
		`Первая строка входа теперь \`${header}\` (1 ≤ C ≤ 10⁶). Измените решение и отправьте его снова; формат вывода прежний.`
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, multi: boolean, withLimit: boolean, spec: Spec, variant: Variant): string {
	const expiring = kind === 'expiring';
	const { ok, reject, ignore } = spec.words;
	const head = [...(multi ? ['s'] : []), 'p', 'e', ...(withLimit ? ['cap'] : [])];
	const take = variant === 'stale-release' ? 'held.get' : 'held.pop';
	const fits = variant === 'exact-stock' ? '<' : '<=';
	// A hold is (product, parts) and with the limit also (client, total); parts are (warehouse, quantity) pairs on
	// several warehouses and the quantity with one.
	const giveBack = multi
		? [
				'        for w, q in r[1]:',
				'            busy[w][r[0]] -= q',
				'            if back:',
				'                free[w][r[0]] += q'
			]
		: ['        busy[r[0]] -= r[1]', '        if back:', '            free[r[0]] += r[1]'];
	if (kind === 'backorder') return backorderSource(multi, withLimit, spec, variant);
	const lines: string[] = [
		'import sys',
		...(expiring ? ['from collections import deque'] : []),
		'',
		`SAFETY = ${spec.safety}`,
		...(expiring ? [`TTL = ${spec.ttl}`] : []),
		...parseStock(multi, head)
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
		...(expiring ? ['            queue.append((t + TTL, rid))'] : []),
		`            print(${answer})`
	];
	if (kind === 'partial' && !multi) {
		const kept = variant === 'release-requested' ? 'qty' : 'got';
		lines.push(
			`        got = min(qty, max(0, free[product] - SAFETY)${withLimit ? ', room' : ''})`,
			'        if got > 0:',
			'            free[product] -= got',
			'            busy[product] += got',
			...accept(kept, kept, `'${ok}', got`),
			'        else:',
			`            print('${reject}')`
		);
	} else if (kind === 'partial') {
		const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > SAFETY][:1]' : 'free';
		lines.push(
			`        need, parts = ${withLimit ? 'min(qty, room)' : 'qty'}, []`,
			`        for w in ${order}:`,
			'            got = min(need, max(0, free[w][product] - SAFETY))',
			'            if got > 0:',
			'                free[w][product] -= got',
			'                busy[w][product] += got',
			'                parts.append((w, got))',
			'                need -= got',
			'        if parts:',
			'            total = sum(q for w, q in parts)',
			...accept('parts', 'total', `'${ok}', total`),
			'        else:',
			`            print('${reject}')`
		);
	} else if (multi) {
		const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > SAFETY][:1]' : 'free';
		lines.push(
			`        for w in ${order}:`,
			`            if qty ${fits} free[w][product] - SAFETY${withLimit ? ' and qty <= room' : ''}:`,
			'                free[w][product] -= qty',
			'                busy[w][product] += qty',
			...accept('[(w, qty)]', 'qty', `'${ok}', w`).map((l) => `    ${l}`),
			'                break',
			'        else:',
			`            print('${reject}')`
		);
	} else {
		lines.push(
			`        if qty ${fits} free[product] - SAFETY${withLimit ? ' and qty <= room' : ''}:`,
			'            free[product] -= qty',
			'            busy[product] += qty',
			...accept('qty', 'qty', `'${ok}'`),
			'        else:',
			`            print('${reject}')`
		);
	}
	const at = multi ? 'free[data[pos + 2]][data[pos + 3]]' : 'free[data[pos + 2]]';
	lines.push(
		"    elif op == 'restock':",
		`        ${at} += int(data[pos + ${multi ? 4 : 3}])`,
		`        print(${at})`,
		`        pos += ${multi ? 5 : 4}`,
		'    else:',
		`        print('${ok}' if drop(data[pos + 2], ${variant === 'confirm-returns' ? 'True' : "op == 'release'"}) else '${ignore}')`,
		'        pos += 3',
		...finalRows(multi, spec)
	);
	return lines.join('\n');
}

/** The final rows of the stock, in the order of the numbers the instance sets. */
function finalRows(multi: boolean, spec: Spec): string[] {
	const pair = (free: string, busy: string): string => (spec.swap ? `${busy}, ${free}` : `${free}, ${busy}`);
	return multi
		? ['for w in free:', '    for name in names:', `        print(w, name, ${pair('free[w][name]', 'busy[w][name]')})`]
		: ['for product in free:', `    print(product, ${pair('free[product]', 'busy[product]')})`];
}

/** The header and the stock of the input, parsed the same way by every class. */
function parseStock(multi: boolean, head: readonly string[]): string[] {
	const lines = [
		'data = sys.stdin.read().split()',
		`${head.join(', ')} = ${head.map((_, i) => `int(data[${i}])`).join(', ')}`
	];
	if (multi) {
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
function backorderSource(multi: boolean, withLimit: boolean, spec: Spec, variant: Variant): string {
	const { ok, reject, ignore, wait } = spec.words;
	const head = [...(multi ? ['s'] : []), 'p', 'e', ...(withLimit ? ['cap'] : [])];
	const fits = variant === 'exact-stock' ? '<' : '<=';
	const order = variant === 'single-warehouse' ? '[w for w in free if free[w][product] > SAFETY][:1]' : 'free';
	const extra = withLimit ? ', client, qty' : '';
	const pop = withLimit ? 'qty, client = waiting.pop(rid)[1:]' : 'qty = waiting.pop(rid)[1]';
	// Activating a waiting reservation `rid` of `product` for `qty`, with several warehouses from the warehouse `w`.
	const activate = (indent: string): string[] =>
		(multi
			? [
					'w = place(product, qty)',
					'free[w][product] -= qty',
					'busy[w][product] += qty',
					`held[rid] = (product, [(w, qty)]${extra})`
				]
			: ['free[product] -= qty', 'busy[product] += qty', `held[rid] = (product, qty${extra})`]
		).map((l) => indent + l);
	const ready = (qty: string): string =>
		multi ? `place(product, ${qty}) is not None` : `${qty} ${fits} free[product] - SAFETY`;
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
	const giveBack = multi
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
	const answer = multi
		? `f'${ok} {held[rid][1][0][0]}' if rid in held else '${wait}'`
		: `'${ok}' if rid in held else '${wait}'`;
	const admit = [
		...(withLimit ? ['owed[client] = owed.get(client, 0) + qty'] : []),
		`waiting[rid] = (product, qty${withLimit ? ', client' : ''})`,
		enqueue,
		'serve(product)',
		`print(${answer})`
	];
	const at = multi ? 'free[data[pos + 2]][data[pos + 3]]' : 'free[data[pos + 2]]';
	return [
		'import sys',
		'',
		`SAFETY = ${spec.safety}`,
		...parseStock(multi, head),
		'held = {}',
		'waiting = {}',
		`queue = {product: [] for product in ${multi ? 'names' : 'free'}}`,
		...(withLimit ? ['owed = {}'] : []),
		'',
		'',
		...(multi
			? [
					'def place(product, qty):',
					`    for w in ${order}:`,
					`        if qty ${fits} free[w][product] - SAFETY:`,
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
					`            print('${reject}')`,
					'        else:',
					...admit.map((l) => `            ${l}`)
				]
			: admit.map((l) => `        ${l}`)),
		"    elif op == 'restock':",
		`        ${at} += int(data[pos + ${multi ? 4 : 3}])`,
		`        serve(data[pos + ${multi ? 3 : 2}])`,
		`        print(${at})`,
		`        pos += ${multi ? 5 : 4}`,
		'    else:',
		'        rid = data[pos + 2]',
		'        pos += 3',
		"        if op == 'release' and rid in waiting:",
		`            product${withLimit ? ', qty, client' : ''} = waiting.pop(rid)${withLimit ? '' : '[0]'}`,
		...(withLimit ? ['            owed[client] -= qty'] : []),
		'            queue[product].remove(rid)',
		'            serve(product)',
		`            print('${ok}')`,
		'        else:',
		`            print('${ok}' if drop(rid, ${variant === 'confirm-returns' ? 'True' : "op == 'release'"}) else '${ignore}')`,
		...finalRows(multi, spec),
		...(multi
			? ['for name in names:', '    print(name, len(queue[name]), sum(waiting[rid][1] for rid in queue[name]))']
			: [
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

function applies(id: (typeof WRONG_IDS)[number], kind: string, multi: boolean): boolean {
	switch (id) {
		case 'stale-release':
			return true;
		case 'exact-stock':
			return kind !== 'partial';
		case 'release-requested':
			return kind === 'partial' && !multi;
		case 'late-expiry':
			return kind === 'expiring';
		case 'single-warehouse':
			return multi;
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
	const multi = multiOf(kind, senior);
	const spec = drawSpec(rng, kind);
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const main = groups(rng, kind, others, senior, false, spec);
	const step = groups(rng, kind, others, senior, true, spec);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, multi, spec), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: {
			markdown: changeStatement(kind, multi, spec),
			weight: CHANGE_WEIGHT,
			answer: null,
			groups: step,
			qa: null
		}
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(kind, multi, false, spec, 'right'),
			changeSource: referenceSource(kind, multi, true, spec, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, kind, multi)
						? { kind: 'program' as const, source: referenceSource(kind, multi, false, spec, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
