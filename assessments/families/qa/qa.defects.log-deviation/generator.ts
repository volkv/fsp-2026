// A service's log against its behaviour specification: the tester names the request of the first record where the
// service behaves differently from the specification. Refusals the specification prescribes are not defects; a later
// refusal that only follows from an earlier wrong state is a consequence, not the cause. Junior logs deviate only in a
// combination: a repeated key within its lifetime, a client's calendar minute, a Moscow day in a UTC log, a daily sum
// per user. The rule and the system's defect are the essential class; users, amounts and times are surface.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Field = string | number;
type Out = Record<string, Field>;
type In = Record<string, Field>;

interface Scenario {
	kind: string;
	params: Record<string, number>;
	inputs: In[];
	/** What the service logged. */
	log: Out[];
	/** What the specification prescribes, replayed from the start. */
	right: Out[];
	intro: string;
	spec: string[];
	line: (i: number, id: string) => string;
	/** Record indices the misconceptions name; `null` — the misconception names nothing here. */
	wrong: Record<string, number | null>;
}

const hms = (sec: number): string =>
	[Math.floor(sec / 3600) % 24, Math.floor(sec / 60) % 60, sec % 60].map((v) => String(v).padStart(2, '0')).join(':');

const n = (v: Field | undefined): number => {
	if (typeof v !== 'number') throw new Error(`number expected, got ${String(v)}`);
	return v;
};
const s = (v: Field | undefined): string => {
	if (typeof v !== 'string') throw new Error(`string expected, got ${String(v)}`);
	return v;
};

const same = (a: Out | undefined, b: Out | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

function firstMismatch(
	a: readonly Out[],
	b: readonly Out[],
	key: (o: Out | undefined) => string = (o) => JSON.stringify(o)
): number | null {
	for (let i = 0; i < a.length; i += 1) if (key(a[i]) !== key(b[i])) return i;
	return null;
}

function firstError(log: readonly Out[]): number | null {
	const i = log.findIndex((o) => n(o.status) >= 400);
	return i < 0 ? null : i;
}

const level = (o: Out): string => (n(o.status) >= 400 ? 'WARN' : 'INFO');

// Intern: validation of the input.

function validation(rng: Rng): Scenario {
	const qmax = rng.pick([5, 10, 20]);
	const min = rng.pick([300, 500, 1000]);
	const bug = rng.pick(['qty-max', 'amount-min', 'check-order'] as const);
	const start = rng.int(1000, 8999);
	const inputs: In[] = [];
	let t = rng.int(9, 11) * 3600 + rng.int(0, 3599);
	const count = rng.int(18, 24);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(3, 90);
		const r = rng.next();
		const validQty = rng.int(1, qmax - 1);
		const validAmount = rng.int(min + 1, min * 6);
		const badQty = rng.bool() ? 0 : qmax + rng.int(1, 5);
		const badAmount = rng.int(Math.floor(min / 2), min - 1);
		if (r < 0.1) inputs.push({ t, qty: badQty, amount: validAmount });
		else if (r < 0.2) inputs.push({ t, qty: validQty, amount: badAmount });
		else if (r < 0.26) inputs.push({ t, qty: badQty, amount: badAmount });
		else if (r < 0.36)
			inputs.push(rng.bool() ? { t, qty: qmax, amount: validAmount } : { t, qty: validQty, amount: min });
		else inputs.push({ t, qty: validQty, amount: validAmount });
	}
	const sim = (rules: { qtyExclusive: boolean; minExclusive: boolean; amountFirst: boolean }): Out[] => {
		let order = start;
		return inputs.map((e): Out => {
			const qty = n(e.qty);
			const amount = n(e.amount);
			const qtyBad = qty < 1 || (rules.qtyExclusive ? qty >= qmax : qty > qmax);
			const amountBad = rules.minExclusive ? amount <= min : amount < min;
			if (qtyBad && amountBad) return { status: 422, error: rules.amountFirst ? 'below_minimum' : 'qty_out_of_range' };
			if (qtyBad) return { status: 422, error: 'qty_out_of_range' };
			if (amountBad) return { status: 422, error: 'below_minimum' };
			const out = { status: 201, order: `ord-${order}` };
			order += 1;
			return out;
		});
	};
	const right = sim({ qtyExclusive: false, minExclusive: false, amountFirst: false });
	const log = sim({
		qtyExclusive: bug === 'qty-max',
		minExclusive: bug === 'amount-min',
		amountFirst: bug === 'check-order'
	});
	return {
		kind: 'validation',
		params: { qmax, min, start },
		inputs,
		log,
		right,
		intro: 'Сервис оформления заказов. Журнал запросов `POST /orders` за утро — ниже.',
		spec: [
			`\`qty\` — от 1 до ${qmax} включительно; иначе ответ 422 с \`error=qty_out_of_range\`;`,
			`\`amount\` — не меньше ${min} рублей; иначе ответ 422 с \`error=below_minimum\`;`,
			'если нарушены оба условия, в ответе `qty_out_of_range`: количество проверяется первым;',
			`иначе ответ 201, и заказу присваивается номер: первый созданный за утро — \`ord-${start}\`, каждый следующий созданный — на единицу больше.`
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 201 ? `order=${s(o.order)}` : `error=${s(o.error)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} POST /orders qty=${n(e.qty)} amount=${n(e.amount)} -> ${n(o.status)} ${tail}`;
		},
		wrong: { 'first-error': firstError(log) }
	};
}

// Intern: computed fields of the answer.

function computed(rng: Rng): Scenario {
	const T = rng.pick([3000, 5000, 7000]);
	const F = rng.pick([1500, 2000, 2500]);
	const D = rng.pick([199, 249, 299, 349]);
	const pct = rng.pick([5, 10, 15]);
	const bug = rng.pick(['discount-boundary', 'discount-ceil', 'delivery-boundary'] as const);
	const inputs: In[] = [];
	let t = rng.int(10, 12) * 3600 + rng.int(0, 3599);
	const count = rng.int(18, 24);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(5, 120);
		const r = rng.next();
		const total = r < 0.08 ? 0 : r < 0.18 ? T : r < 0.28 ? F : rng.int(300, T * 2);
		inputs.push({ t, total });
	}
	const sim = (rules: { discountExclusive: boolean; ceil: boolean; deliveryExclusive: boolean }): Out[] =>
		inputs.map((e): Out => {
			const total = n(e.total);
			if (total <= 0) return { status: 422, error: 'empty_cart' };
			const eligible = rules.discountExclusive ? total > T : total >= T;
			const discount = eligible ? (rules.ceil ? Math.ceil((total * pct) / 100) : Math.floor((total * pct) / 100)) : 0;
			const free = rules.deliveryExclusive ? total > F : total >= F;
			const delivery = free ? 0 : D;
			return { status: 200, discount, delivery, pay: total - discount + delivery };
		});
	const right = sim({ discountExclusive: false, ceil: false, deliveryExclusive: false });
	const log = sim({
		discountExclusive: bug === 'discount-boundary',
		ceil: bug === 'discount-ceil',
		deliveryExclusive: bug === 'delivery-boundary'
	});
	// A later, unrelated slip: one total is printed without the delivery.
	const k = firstMismatch(log, right);
	const later = log
		.map((o, i) => ({ o, i }))
		.filter(({ o, i }) => k !== null && i > k + 1 && n(o.status) === 200 && n(o.delivery) > 0);
	const slip = later.length ? rng.pick(later) : null;
	if (slip) slip.o.pay = n(slip.o.pay) - n(slip.o.delivery);
	const arithmetic = log.findIndex(
		(o, i) => n(o.status) === 200 && n(o.pay) !== n(inputs[i]?.total) - n(o.discount) + n(o.delivery)
	);
	return {
		kind: 'computed',
		params: { T, F, D, pct },
		inputs,
		log,
		right,
		intro: 'Сервис оформления корзины. Журнал запросов `POST /checkout` — ниже; `total` — сумма товаров в рублях.',
		spec: [
			'`total` не больше 0 — ответ 422 с `error=empty_cart`;',
			`скидка \`discount\` — ${pct} % от \`total\` при \`total\` от ${T} рублей включительно, дробная часть рубля отбрасывается; при меньшей сумме — 0;`,
			`доставка \`delivery\` бесплатна (0) при \`total\` от ${F} рублей включительно, иначе ${D} рублей;`,
			'к оплате `pay` = `total` − `discount` + `delivery`; ответ 200.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail =
				n(o.status) === 200
					? `discount=${n(o.discount)} delivery=${n(o.delivery)} pay=${n(o.pay)}`
					: `error=${s(o.error)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} POST /checkout total=${n(e.total)} -> ${n(o.status)} ${tail}`;
		},
		wrong: { 'first-error': firstError(log), 'arithmetic-only': arithmetic < 0 ? null : arithmetic }
	};
}

// Intern: a wallet's balance.

function balance(rng: Rng): Scenario {
	const feeFrom = rng.pick([5000, 10000]);
	const b0 = rng.int(20, 80) * 100;
	const bug = rng.pick(['fee-boundary', 'fee-ceil', 'deposit-fee'] as const);
	const wallet = `w-${rng.int(100, 999)}`;
	type Rules = { feeInclusive: boolean; ceil: boolean; depositFee: boolean };
	const RIGHT: Rules = { feeInclusive: false, ceil: false, depositFee: false };
	const BUG: Rules = {
		feeInclusive: bug === 'fee-boundary',
		ceil: bug === 'fee-ceil',
		depositFee: bug === 'deposit-fee'
	};
	const fee = (amount: number, r: Rules) =>
		(r.feeInclusive ? amount >= feeFrom : amount > feeFrom)
			? r.ceil
				? Math.ceil(amount / 100)
				: Math.floor(amount / 100)
			: 0;
	const step = (bal: number, e: In, r: Rules): [number, Out] => {
		const amount = n(e.amount);
		if (e.op === 'deposit') {
			const next = bal + amount - (r.depositFee && amount >= feeFrom ? Math.floor(amount / 100) : 0);
			return [next, { status: 200, balance: next }];
		}
		const total = amount + fee(amount, r);
		if (total > bal) return [bal, { status: 409, error: 'insufficient_funds', balance: bal }];
		return [bal - total, { status: 200, balance: bal - total }];
	};
	const inputs: In[] = [];
	const right: Out[] = [];
	const log: Out[] = [];
	let rb = b0;
	let bb = b0;
	let t = rng.int(9, 12) * 3600 + rng.int(0, 3599);
	let diverged = -1;
	let consequence = false;
	const count = rng.int(18, 24);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(10, 300);
		let e: In;
		if (diverged >= 0 && !consequence && i >= diverged + 2 && rb > bb) {
			// The visible symptom: a withdrawal the right balance covers and the logged one does not.
			let amount = 0;
			for (let d = 0; d < 400; d += 1) {
				const a = rb - d;
				if (a <= 0) break;
				if (a + fee(a, RIGHT) <= rb && a + fee(a, BUG) > bb) {
					amount = a;
					break;
				}
			}
			e = { t, op: 'withdraw', amount: amount || rng.int(1, 30) * 100 };
			consequence = amount > 0;
		} else {
			const r = rng.next();
			const roundAmount = rng.int(5, 60) * 100;
			const amount =
				r < 0.3
					? feeFrom
					: r < 0.5
						? feeFrom + rng.int(1, 99) * (rng.bool() ? 1 : 37)
						: rng.bool(0.15)
							? rb + rng.int(1, 5) * 1000
							: roundAmount;
			e = { t, op: rng.bool(0.4) ? 'deposit' : 'withdraw', amount };
		}
		const [nr, or] = step(rb, e, RIGHT);
		const [nb, ob] = step(bb, e, BUG);
		inputs.push(e);
		right.push(or);
		log.push(ob);
		rb = nr;
		bb = nb;
		if (diverged < 0 && !same(or, ob)) diverged = i;
	}
	const statusOnly = firstMismatch(log, right, (o) => String(o?.status));
	return {
		kind: 'balance',
		params: { feeFrom, b0 },
		inputs,
		log,
		right,
		intro: `Сервис кошелька. Журнал операций кошелька \`${wallet}\` за день — ниже; суммы в рублях.`,
		spec: [
			`в начале дня на кошельке ${b0} рублей;`,
			'пополнение `deposit` зачисляется полностью, ответ 200;',
			`снятие \`withdraw\`: комиссия 1 % от суммы (дробная часть рубля отбрасывается) берётся только при сумме больше ${feeFrom} рублей;`,
			'если сумма снятия вместе с комиссией больше баланса — ответ 409 с `error=insufficient_funds`, баланс не меняется; иначе списываются сумма и комиссия, ответ 200;',
			'`balance` в записи — баланс после операции.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 200 ? `balance=${n(o.balance)}` : `error=${s(o.error)} balance=${n(o.balance)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} wallet=${wallet} ${s(e.op)} amount=${n(e.amount)} -> ${n(o.status)} ${tail}`;
		},
		wrong: { 'first-error': firstError(log), consequence: statusOnly }
	};
}

// Intern: order status transitions.

const ALLOWED: readonly string[] = ['new>paid', 'new>cancelled', 'paid>shipped', 'paid>cancelled', 'shipped>delivered'];
const STATUSES = ['paid', 'shipped', 'delivered', 'cancelled'];

function transitions(rng: Rng): Scenario {
	const bug = rng.pick(['shipped>cancelled', 'new>shipped', 'delivered>cancelled'] as const);
	const orders = rng.sample(
		Array.from({ length: 900 }, (_, i) => `ord-${i + 100}`),
		4
	);
	const inputs: In[] = [];
	let t = rng.int(9, 12) * 3600 + rng.int(0, 3599);
	const state = new Map<string, string>();
	const created: string[] = [];
	const count = rng.int(18, 24);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(20, 400);
		const pending = orders.filter((o) => !created.includes(o));
		// Orders mostly move forward; a closed order (delivered or cancelled) gets a request now and then.
		const open = created.filter((o) => !['delivered', 'cancelled'].includes(state.get(o) ?? 'new'));
		if (pending.length && (open.length === 0 || rng.bool(0.2))) {
			const order = pending[0] ?? '';
			created.push(order);
			state.set(order, 'new');
			inputs.push({ t, op: 'create', order });
			continue;
		}
		if (open.length === 0) break;
		const order = rng.bool(0.85) ? rng.pick(open) : rng.pick(created);
		const from = state.get(order) ?? 'new';
		const valid = STATUSES.filter((to) => ALLOWED.includes(`${from}>${to}`));
		const forward = valid.filter((to) => to !== 'cancelled');
		const [bugFrom, bugTo] = bug.split('>') as [string, string];
		const r = rng.next();
		let target: string;
		if (from === bugFrom && r < 0.4) target = bugTo;
		else if (forward.length && r < 0.75) target = rng.pick(forward);
		else if (valid.length && r < 0.82) target = rng.pick(valid);
		else target = rng.pick(STATUSES.filter((to) => to !== from));
		if (ALLOWED.includes(`${from}>${target}`)) state.set(order, target);
		inputs.push({ t, op: 'patch', order, target });
	}
	const sim = (extra: string | null, global: boolean): Out[] => {
		const st = new Map<string, string>();
		return inputs.map((e): Out => {
			const key = global ? '*' : s(e.order);
			if (e.op === 'create') {
				st.set(key, 'new');
				return { status: 201 };
			}
			const from = st.get(key) ?? 'new';
			const move = `${from}>${s(e.target)}`;
			if (ALLOWED.includes(move) || move === extra) {
				st.set(key, s(e.target));
				return { status: 200 };
			}
			return { status: 409, error: 'invalid_transition' };
		});
	};
	const right = sim(null, false);
	const log = sim(bug, false);
	return {
		kind: 'transitions',
		params: {},
		inputs,
		log,
		right,
		intro:
			'Сервис заказов. Журнал создания заказов и смены их статуса — ниже; запросы к разным заказам идут вперемешку.',
		spec: [
			'созданный заказ (`POST /orders`, ответ 201) имеет статус `new`;',
			'разрешены только переходы `new → paid`, `new → cancelled`, `paid → shipped`, `paid → cancelled`, `shipped → delivered`;',
			'разрешённый переход — ответ 200, статус заказа меняется;',
			'любой другой переход — ответ 409 с `error=invalid_transition`, статус не меняется.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			if (e.op === 'create') return `${hms(n(e.t))} INFO ${id} POST /orders -> 201 order=${s(e.order)} status=new`;
			const tail = n(o.status) === 200 ? '' : ` error=${s(o.error)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} PATCH /orders/${s(e.order)} status=${s(e.target)} -> ${n(o.status)}${tail}`;
		},
		wrong: { 'first-error': firstError(log), 'global-state': firstMismatch(log, sim(null, true)) }
	};
}

// Junior: idempotency keys.

function idempotency(rng: Rng): Scenario {
	const ttl = rng.pick([5, 10, 15]);
	const bug = rng.pick(['ttl-from-last', 'ttl-exclusive', 'amount-ignored'] as const);
	const start = rng.int(100, 899);
	type Rules = { fromLast: boolean; exclusive: boolean; ignoreAmount: boolean; ignoreTtl: boolean };
	const inputs: In[] = [];
	let t = rng.int(9, 15) * 3600 + rng.int(0, 3599);
	const keys: { key: string; first: number; amount: number }[] = [];
	const count = rng.int(24, 32);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(20, 240);
		const r = rng.next();
		if (keys.length === 0 || r < 0.35) {
			const key = `k-${rng.int(0x100, 0xfff).toString(16)}`;
			if (keys.some((k) => k.key === key)) {
				i -= 1;
				continue;
			}
			const amount = rng.int(1, 60) * 50;
			keys.push({ key, first: t, amount });
			inputs.push({ t, key, amount });
			continue;
		}
		const k = rng.pick(keys);
		// Some repeats land exactly on the end of the key's lifetime.
		const edge = k.first + ttl * 60;
		if (r < 0.5 && edge > t && edge - t < 400) t = edge;
		const amount = rng.bool(0.2) ? k.amount + rng.int(1, 10) * 50 : k.amount;
		inputs.push({ t, key: k.key, amount });
		if (t - k.first > ttl * 60) {
			k.first = t;
			k.amount = amount;
		}
	}
	const sim = (rules: Rules): Out[] => {
		const store = new Map<string, { first: number; last: number; amount: number; payment: string }>();
		let next = start;
		return inputs.map((e): Out => {
			const key = s(e.key);
			const time = n(e.t);
			const amount = n(e.amount);
			const rec = store.get(key);
			if (rec) {
				const age = time - (rules.fromLast ? rec.last : rec.first);
				const within = rules.ignoreTtl || (rules.exclusive ? age < ttl * 60 : age <= ttl * 60);
				if (within) {
					rec.last = time;
					if (rules.ignoreAmount || amount === rec.amount) return { status: 200, payment: rec.payment };
					return { status: 422, error: 'key_reused' };
				}
			}
			const payment = `pay-${next}`;
			next += 1;
			store.set(key, { first: time, last: time, amount, payment });
			return { status: 201, payment };
		});
	};
	const RIGHT: Rules = { fromLast: false, exclusive: false, ignoreAmount: false, ignoreTtl: false };
	const right = sim(RIGHT);
	const log = sim({
		...RIGHT,
		fromLast: bug === 'ttl-from-last',
		exclusive: bug === 'ttl-exclusive',
		ignoreAmount: bug === 'amount-ignored'
	});
	return {
		kind: 'idempotency',
		params: { ttl, start },
		inputs,
		log,
		right,
		intro: 'Платёжный сервис. Журнал запросов `POST /payments` с ключом идемпотентности `key` — ниже; суммы в рублях.',
		spec: [
			`запрос с ключом, которого сервис ещё не видел, создаёт платёж: ответ 201 и номер платежа; первый номер — \`pay-${start}\`, каждый следующий созданный — на единицу больше;`,
			`повтор с тем же ключом не позже чем через ${ttl} минут (включительно) после **первого** запроса с этим ключом: с той же суммой — ответ 200 и номер уже созданного платежа, новый не создаётся; с другой суммой — ответ 422 с \`error=key_reused\`;`,
			`повтор позже ${ttl} минут после первого запроса считается новым запросом: ответ 201 и новый номер; срок ключа с этого момента отсчитывается от этого запроса.`
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 422 ? `error=${s(o.error)}` : `payment=${s(o.payment)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} POST /payments key=${s(e.key)} amount=${n(e.amount)} -> ${n(o.status)} ${tail}`;
		},
		wrong: { 'first-error': firstError(log), 'ignores-ttl': firstMismatch(log, sim({ ...RIGHT, ignoreTtl: true })) }
	};
}

// Junior: a rate limit per client and calendar minute.

function rateLimit(rng: Rng): Scenario {
	const limit = rng.pick([3, 4, 5]);
	const bug = rng.pick(['off-by-one', 'second-zero'] as const);
	const clients = rng.sample(PERSON_NAMES, 3).map((p) => `c-${p}`);
	const weights = [0.5, 0.3, 0.2];
	type Rules = { extra: number; zeroPrev: boolean; shared: boolean; sliding: boolean };
	const inputs: In[] = [];
	let t = rng.int(10, 16) * 3600 + rng.int(0, 59) * 60 + rng.int(0, 40);
	const count = rng.int(28, 36);
	for (let i = 0; i < count; i += 1) {
		// Bursts: most requests are seconds apart, some land on a minute's first second.
		t += rng.bool(0.1) ? 60 - (t % 60) : rng.int(1, 12);
		const r = rng.next();
		const client =
			r < (weights[0] ?? 0) ? clients[0] : r < (weights[0] ?? 0) + (weights[1] ?? 0) ? clients[1] : clients[2];
		inputs.push({ t, client: client ?? '' });
	}
	const sim = (rules: Rules): Out[] => {
		const accepted = new Map<string, number[]>();
		const window = (x: number) => Math.floor((rules.zeroPrev ? x - 1 : x) / 60);
		return inputs.map((e): Out => {
			const key = rules.shared ? '*' : s(e.client);
			const time = n(e.t);
			const list = accepted.get(key) ?? [];
			const used = rules.sliding
				? list.filter((x) => time - x < 60).length
				: list.filter((x) => window(x) === window(time)).length;
			if (used < limit + rules.extra) {
				list.push(time);
				accepted.set(key, list);
				return { status: 200 };
			}
			return { status: 429, error: 'rate_limited' };
		});
	};
	const RIGHT: Rules = { extra: 0, zeroPrev: false, shared: false, sliding: false };
	const right = sim(RIGHT);
	const log = sim({ ...RIGHT, extra: bug === 'off-by-one' ? 1 : 0, zeroPrev: bug === 'second-zero' });
	return {
		kind: 'rate-limit',
		params: { limit },
		inputs,
		log,
		right,
		intro: 'Публичный API каталога с лимитом запросов. Журнал запросов `GET /api/catalog` — ниже.',
		spec: [
			`каждый клиент (\`client\`) может сделать не больше ${limit} успешных запросов за календарную минуту — например, с 12:03:00 по 12:03:59 включительно;`,
			'запрос сверх лимита — ответ 429 с `error=rate_limited`; отклонённые запросы в лимите не учитываются;',
			'остальные запросы — ответ 200; лимиты разных клиентов независимы.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 200 ? '' : ` error=${s(o.error)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} client=${s(e.client)} GET /api/catalog -> ${n(o.status)}${tail}`;
		},
		wrong: {
			'first-error': firstError(log),
			'shared-counter': firstMismatch(log, sim({ ...RIGHT, shared: true })),
			'sliding-window': firstMismatch(log, sim({ ...RIGHT, sliding: true }))
		}
	};
}

// Junior: a daily limit by Moscow days in a UTC log.

const DAY0 = Date.UTC(2026, 9, 5) / 1000;

function utcStamp(sec: number): string {
	return `${new Date((DAY0 + sec) * 1000).toISOString().slice(0, 19)}Z`;
}

function timezone(rng: Rng): Scenario {
	const limit = rng.pick([2, 3]);
	const users = rng.sample(PERSON_NAMES, rng.int(2, 3));
	const inputs: In[] = [];
	// From 17:00Z on 5 October to 03:00Z on 6 October: across Moscow midnight (21:00Z) and UTC midnight.
	let t = 17 * 3600 + rng.int(0, 1800);
	const count = rng.int(24, 32);
	const span = 10 * 3600;
	for (let i = 0; i < count; i += 1) {
		t += rng.int(Math.floor(span / count / 3), Math.floor((span / count) * 1.6));
		inputs.push({ t, user: rng.pick(users), amount: rng.bool(0.08) ? 0 : rng.int(1, 40) * 500 });
	}
	const sim = (utc: boolean): Out[] => {
		const counts = new Map<string, number>();
		return inputs.map((e): Out => {
			if (n(e.amount) <= 0) return { status: 422, error: 'invalid_amount' };
			const day = Math.floor((n(e.t) + (utc ? 0 : 3 * 3600)) / 86400);
			const key = `${s(e.user)}|${day}`;
			const used = counts.get(key) ?? 0;
			if (used >= limit) return { status: 429, error: 'daily_limit' };
			counts.set(key, used + 1);
			return { status: 201 };
		});
	};
	const log = sim(true);
	// A later, independent slip: one application with a zero amount is accepted.
	const k = firstMismatch(log, sim(false));
	const slips = inputs.map((e, i) => ({ e, i })).filter(({ i }) => k !== null && i > k + 1 && i < inputs.length);
	const slip = slips.length ? rng.pick(slips) : null;
	if (slip) {
		slip.e.amount = 0;
		const o = log[slip.i];
		if (o) {
			o.status = 201;
			delete o.error;
		}
	}
	const utcReplay = sim(true);
	return {
		kind: 'timezone',
		params: { limit },
		inputs,
		log,
		right: sim(false),
		intro:
			'Сервис заявок на кредитную карту. Время в журнале — UTC (суффикс `Z`). Журнал запросов `POST /applications` — ниже.',
		spec: [
			'`amount` не больше 0 — ответ 422 с `error=invalid_amount`;',
			`каждый пользователь (\`user\`) может подать не больше ${limit} принятых заявок за сутки; сутки — **московские** (UTC+3), с 00:00:00 до 23:59:59 по Москве;`,
			'заявка сверх лимита — ответ 429 с `error=daily_limit`; отклонённые заявки в лимите не учитываются;',
			'остальные заявки — ответ 201.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 201 ? '' : ` error=${s(o.error)}`;
			return `${utcStamp(n(e.t))} ${level(o)} ${id} user=${s(e.user)} POST /applications amount=${n(e.amount)} -> ${n(o.status)}${tail}`;
		},
		wrong: { 'first-error': firstError(log), 'utc-day': slip ? firstMismatch(log, utcReplay) : null }
	};
}

// Junior: a daily sum limit per user.

function dailyLimit(rng: Rng): Scenario {
	const single = rng.pick([20000, 30000]);
	const daily = rng.pick([50000, 60000, 80000]);
	const bug = rng.pick(['count-rejected', 'count-oversize', 'limit-exclusive'] as const);
	const users = rng.sample(PERSON_NAMES, rng.int(2, 3));
	type Rules = { countRejected: boolean; countOversize: boolean; exclusive: boolean; shared: boolean };
	const RIGHT: Rules = { countRejected: false, countOversize: false, exclusive: false, shared: false };
	const inputs: In[] = [];
	const used = new Map<string, number>();
	let t = rng.int(9, 11) * 3600 + rng.int(0, 3599);
	const count = rng.int(24, 32);
	for (let i = 0; i < count; i += 1) {
		t += rng.int(30, 900);
		const user = rng.pick(users);
		const have = used.get(user) ?? 0;
		const r = rng.next();
		const rest = daily - have;
		const amount =
			r < 0.12
				? single + rng.int(1, 10) * 500
				: r < 0.27 && rest > 0 && rest <= single
					? rest
					: rng.int(2, single / 500) * 500;
		if (amount <= single && have + amount <= daily) used.set(user, have + amount);
		inputs.push({ t, user, amount });
	}
	const sim = (rules: Rules): Out[] => {
		const sums = new Map<string, number>();
		return inputs.map((e): Out => {
			const key = rules.shared ? '*' : s(e.user);
			const amount = n(e.amount);
			const have = sums.get(key) ?? 0;
			if (amount > single) {
				if (rules.countOversize) sums.set(key, have + amount);
				return { status: 422, error: 'over_single_limit' };
			}
			if (rules.exclusive ? have + amount >= daily : have + amount > daily) {
				if (rules.countRejected) sums.set(key, have + amount);
				return { status: 429, error: 'daily_limit' };
			}
			sums.set(key, have + amount);
			return { status: 200, used: have + amount };
		});
	};
	const right = sim(RIGHT);
	const log = sim({
		...RIGHT,
		countRejected: bug === 'count-rejected',
		countOversize: bug === 'count-oversize',
		exclusive: bug === 'limit-exclusive'
	});
	return {
		kind: 'daily-limit',
		params: { single, daily },
		inputs,
		log,
		right,
		intro: 'Сервис выдачи наличных. Журнал операций снятия за день — ниже; суммы в рублях.',
		spec: [
			`одна операция — не больше ${single} рублей; больше — ответ 422 с \`error=over_single_limit\`;`,
			`сумма принятых снятий пользователя (\`user\`) за день вместе с текущей — не больше ${daily} рублей; больше — ответ 429 с \`error=daily_limit\`;`,
			'отклонённые операции (422 и 429) в суммах не учитываются; лимиты разных пользователей независимы;',
			'иначе ответ 200, `used` — сумма принятых снятий этого пользователя за день вместе с текущим.'
		],
		line: (i, id) => {
			const e = inputs[i] ?? {};
			const o = log[i] ?? {};
			const tail = n(o.status) === 200 ? `used=${n(o.used)}` : `error=${s(o.error)}`;
			return `${hms(n(e.t))} ${level(o)} ${id} user=${s(e.user)} withdraw amount=${n(e.amount)} -> ${n(o.status)} ${tail}`;
		},
		wrong: { 'first-error': firstError(log), 'shared-counter': firstMismatch(log, sim({ ...RIGHT, shared: true })) }
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	'intern/validation': validation,
	'intern/computed': computed,
	'intern/balance': balance,
	'intern/transitions': transitions,
	'junior/idempotency': idempotency,
	'junior/rate-limit': rateLimit,
	'junior/timezone': timezone,
	'junior/daily-limit': dailyLimit
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/validation': ['first-error'],
	'intern/computed': ['first-error', 'arithmetic-only'],
	'intern/balance': ['first-error', 'consequence'],
	'intern/transitions': ['first-error', 'global-state'],
	'junior/idempotency': ['first-error', 'ignores-ttl'],
	'junior/rate-limit': ['shared-counter', 'sliding-window'],
	'junior/timezone': ['first-error', 'utc-day'],
	'junior/daily-limit': ['first-error', 'shared-counter']
};

const WRONG_IDS = [
	'first-error',
	'arithmetic-only',
	'consequence',
	'global-state',
	'ignores-ttl',
	'shared-counter',
	'sliding-window',
	'utc-day'
];

const PYTHON_REFERENCE = `import json

data = json.loads(input())
kind = data["kind"]
p = data["params"]
entries = data["entries"]


def expected(es):
    out = []
    if kind == "validation":
        order = p["start"]
        for e in es:
            if e["qty"] < 1 or e["qty"] > p["qmax"]:
                out.append({"status": 422, "error": "qty_out_of_range"})
            elif e["amount"] < p["min"]:
                out.append({"status": 422, "error": "below_minimum"})
            else:
                out.append({"status": 201, "order": "ord-%d" % order})
                order += 1
    elif kind == "computed":
        for e in es:
            total = e["total"]
            if total <= 0:
                out.append({"status": 422, "error": "empty_cart"})
                continue
            discount = total * p["pct"] // 100 if total >= p["T"] else 0
            delivery = 0 if total >= p["F"] else p["D"]
            out.append({"status": 200, "discount": discount, "delivery": delivery, "pay": total - discount + delivery})
    elif kind == "balance":
        balance = p["b0"]
        for e in es:
            amount = e["amount"]
            if e["op"] == "deposit":
                balance += amount
                out.append({"status": 200, "balance": balance})
                continue
            fee = amount // 100 if amount > p["feeFrom"] else 0
            if amount + fee > balance:
                out.append({"status": 409, "error": "insufficient_funds", "balance": balance})
            else:
                balance -= amount + fee
                out.append({"status": 200, "balance": balance})
    elif kind == "transitions":
        allowed = {("new", "paid"), ("new", "cancelled"), ("paid", "shipped"), ("paid", "cancelled"), ("shipped", "delivered")}
        status = {}
        for e in es:
            if e["op"] == "create":
                status[e["order"]] = "new"
                out.append({"status": 201})
            elif (status[e["order"]], e["target"]) in allowed:
                status[e["order"]] = e["target"]
                out.append({"status": 200})
            else:
                out.append({"status": 409, "error": "invalid_transition"})
    elif kind == "idempotency":
        keys = {}
        number = p["start"]
        for e in es:
            rec = keys.get(e["key"])
            if rec is not None and e["t"] - rec["first"] <= p["ttl"] * 60:
                if e["amount"] == rec["amount"]:
                    out.append({"status": 200, "payment": rec["payment"]})
                else:
                    out.append({"status": 422, "error": "key_reused"})
                continue
            payment = "pay-%d" % number
            number += 1
            keys[e["key"]] = {"first": e["t"], "amount": e["amount"], "payment": payment}
            out.append({"status": 201, "payment": payment})
    elif kind == "rate-limit":
        accepted = {}
        for e in es:
            minute = e["t"] // 60
            done = accepted.setdefault((e["client"], minute), 0)
            if done < p["limit"]:
                accepted[(e["client"], minute)] = done + 1
                out.append({"status": 200})
            else:
                out.append({"status": 429, "error": "rate_limited"})
    elif kind == "timezone":
        accepted = {}
        for e in es:
            if e["amount"] <= 0:
                out.append({"status": 422, "error": "invalid_amount"})
                continue
            day = (e["t"] + 3 * 3600) // 86400
            done = accepted.get((e["user"], day), 0)
            if done >= p["limit"]:
                out.append({"status": 429, "error": "daily_limit"})
            else:
                accepted[(e["user"], day)] = done + 1
                out.append({"status": 201})
    elif kind == "daily-limit":
        used = {}
        for e in es:
            have = used.get(e["user"], 0)
            if e["amount"] > p["single"]:
                out.append({"status": 422, "error": "over_single_limit"})
            elif have + e["amount"] > p["daily"]:
                out.append({"status": 429, "error": "daily_limit"})
            else:
                used[e["user"]] = have + e["amount"]
                out.append({"status": 200, "used": have + e["amount"]})
    return out


for entry, want in zip(entries, expected(entries)):
    if entry["out"] != want:
        print(entry["id"])
        break
`;

function hexIds(rng: Rng, count: number): string[] {
	const ids = new Set<string>();
	while (ids.size < count) ids.add(`req-${rng.int(0x1000, 0xffff).toString(16)}`);
	return [...ids];
}

function describe(sc: Scenario, ids: readonly string[]): string {
	return [
		sc.intro,
		'',
		'Спецификация поведения:',
		'',
		...sc.spec.map((line) => `- ${line}`),
		'',
		'Журнал полный: в нём все запросы к сервису с начала суток (по времени, в котором считает спецификация), до первой записи запросов не было, счётчики и сохранённые ключи пусты. Одна запись — один запрос:',
		'',
		'```',
		...sc.inputs.map((_, i) => sc.line(i, ids[i] ?? '')),
		'```',
		'',
		'Найдите первую по времени запись, в которой поведение сервиса расходится со спецификацией. Введите идентификатор её запроса. Например: `req-3f9a`.'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${input.classId}`;
	const make = MAKERS[where];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${where}`);
	const required = REQUIRED[where] ?? [];
	for (let tries = 0; tries < 400; tries += 1) {
		const sc = make(rng);
		const k = firstMismatch(sc.log, sc.right);
		// The deviation needs some history before it and a record or two after it.
		if (k === null || k < 5 || k > sc.inputs.length - 2) continue;
		const wrongIndex = Object.fromEntries(
			WRONG_IDS.map((id) => {
				const i = sc.wrong[id];
				return [id, i === undefined || i === null || i === k ? null : i];
			})
		);
		if (required.some((id) => wrongIndex[id] === null)) continue;
		const ids = hexIds(rng, sc.inputs.length);
		const answer = ids[k] ?? '';
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc, ids), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			kind: sc.kind,
			params: sc.params,
			entries: sc.inputs.map((e, i) => ({ ...e, id: ids[i], out: sc.log[i] }))
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrongIndex).map(([id, i]) => [
						id,
						i === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value: ids[i] ?? '' } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${where} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
