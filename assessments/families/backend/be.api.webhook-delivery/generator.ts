// Webhook delivery «at least once»: deliveries come with retries, duplicates and out of order; the consumer
// deduplicates by event id, drops outdated status changes by the per-order sequence number and sums refunds once.
// The candidate finds which deliveries changed the state and what the consumer ends with.
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

const STATUSES = ['paid', 'packed', 'shipped', 'delivered'] as const;

interface Event {
	id: string;
	order: string;
	seq: number;
	kind: 'status' | 'refund';
	/** A status name or a refund amount. */
	value: string;
}

interface Delivery {
	event: string;
	failed: boolean;
}

interface Params {
	orders: string[];
	events: Event[];
	deliveries: Delivery[];
}

interface Rules {
	seqCheck: boolean;
	seqPerOrder: boolean;
	markOnFailure: boolean;
	dedup: boolean;
	refundSeq: boolean;
	dedupByContent: boolean;
}

const RIGHT: Rules = {
	seqCheck: true,
	seqPerOrder: true,
	markOnFailure: false,
	dedup: true,
	refundSeq: false,
	dedupByContent: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'apply-in-arrival-order': { seqCheck: false },
	'seq-global': { seqPerOrder: false },
	'mark-on-failure': { markOnFailure: true },
	'no-dedup': { dedup: false },
	'refund-seq-checked': { refundSeq: true },
	'reissue-detected': { dedupByContent: true }
};

function simulate(p: Params, rules: Rules): string {
	const seen = new Set<string>();
	const status = new Map(p.orders.map((o) => [o, 'created']));
	const refunds = new Map(p.orders.map((o) => [o, 0]));
	const lastSeq = new Map<string, number>();
	const applied: number[] = [];
	p.deliveries.forEach((d, i) => {
		const e = p.events.find((x) => x.id === d.event);
		if (!e) throw new Error(`no event ${d.event}`);
		const identity = rules.dedupByContent ? `${e.order}#${e.seq}` : e.id;
		if (d.failed) {
			if (rules.markOnFailure) seen.add(identity);
			return;
		}
		if (rules.dedup && seen.has(identity)) return;
		seen.add(identity);
		const scope = rules.seqPerOrder ? e.order : '*';
		const checked = e.kind === 'status' ? rules.seqCheck : rules.refundSeq;
		if (checked && e.seq <= (lastSeq.get(scope) ?? 0)) return;
		if (checked) lastSeq.set(scope, e.seq);
		if (e.kind === 'status') status.set(e.order, e.value);
		else refunds.set(e.order, (refunds.get(e.order) ?? 0) + Number(e.value));
		applied.push(i + 1);
	});
	const totals = p.orders.flatMap((o) => ['|', o, status.get(o) ?? '', String(refunds.get(o) ?? 0)]);
	return [applied.length ? applied.join(' ') : '-', ...totals].join(' ');
}

function scenario(rng: Rng, classId: string): Params {
	const orderCount = classId === 'reorder' ? rng.int(2, 3) : 2;
	const orders = rng
		.sample(
			Array.from({ length: 90 }, (_, i) => 10 + i),
			orderCount
		)
		.sort((a, b) => a - b)
		.map((n) => `ord-${n}`);
	const ids = rng.sample(
		Array.from({ length: 900 }, (_, i) => 100 + i),
		16
	);
	const events: Event[] = [];
	for (const order of orders) {
		const statuses = STATUSES.slice(0, rng.int(2, orderCount === 3 ? 3 : 4));
		const refundCount = classId === 'reorder' ? 0 : rng.int(1, 2);
		const kinds = rng.shuffle([
			...statuses.map(() => 'status' as const),
			...Array.from({ length: refundCount }, () => 'refund' as const)
		]);
		let next = 0;
		kinds.forEach((kind, i) => {
			const id = `evt_${ids[events.length] ?? i}`;
			const value = kind === 'status' ? (statuses[next++] ?? 'paid') : String(rng.int(1, 30) * 50);
			events.push({ id, order, seq: i + 1, kind, value });
		});
	}
	// Emission order: per order by sequence number, orders interleaved at random.
	const queues = orders.map((o) => events.filter((e) => e.order === o));
	const emitted: Event[] = [];
	while (queues.some((q) => q.length)) {
		const q = rng.pick(queues.filter((x) => x.length));
		const e = q.shift();
		if (e) emitted.push(e);
	}
	const deliveries: Delivery[] = emitted.map((e) => ({ event: e.id, failed: false }));
	// Reordering: a few events are delivered later than emitted.
	const moves = classId === 'reorder' ? rng.int(2, 3) : rng.int(1, 2);
	for (let m = 0; m < moves; m += 1) {
		const from = rng.int(0, deliveries.length - 2);
		const [moved] = deliveries.splice(from, 1);
		if (moved) deliveries.splice(rng.int(from + 1, deliveries.length), 0, moved);
	}
	// Failures: a delivery fails and the sender retries it later.
	if (classId === 'failures') {
		for (let f = rng.int(1, 2); f > 0; f -= 1) {
			const at = rng.int(0, deliveries.length - 2);
			const target = deliveries[at];
			if (!target || target.failed) continue;
			deliveries.splice(at, 0, { event: target.event, failed: true });
		}
	}
	// Duplicates: the sender did not get the answer and delivers the event again later.
	const duplicates = classId === 'reorder' ? rng.int(1, 2) : rng.int(2, 3);
	for (let d = 0; d < duplicates; d += 1) {
		const at = rng.int(0, deliveries.length - 1);
		const target = deliveries[at];
		if (!target || target.failed) continue;
		deliveries.splice(rng.int(at + 1, deliveries.length), 0, { event: target.event, failed: false });
	}
	// Reissues: the sender retries an event under a new id, with the same order, number and content.
	if (classId === 'reissued') {
		const spare = ids.slice(events.length);
		for (let k = rng.int(1, 2); k > 0; k -= 1) {
			const at = rng.int(0, deliveries.length - 1);
			const original = events.find((e) => e.id === deliveries[at]?.event);
			const id = spare.shift();
			if (!original || id === undefined) continue;
			const copy = { ...original, id: `evt_${id}` };
			events.push(copy);
			deliveries.splice(rng.int(at + 1, deliveries.length), 0, { event: copy.id, failed: false });
		}
	}
	return { orders, events, deliveries };
}

function describe(p: Params): string {
	const byId = new Map(p.events.map((e) => [e.id, e]));
	const rows = p.deliveries.map((d, i) => {
		const e = byId.get(d.event);
		if (!e) throw new Error(`no event ${d.event}`);
		const payload = e.kind === 'status' ? `status → ${e.value}` : `refund ${e.value}`;
		return `| ${i + 1} | ${e.id} | ${e.order} | ${e.seq} | ${payload} | ${d.failed ? 'потребитель упал, ответ 500' : '200'} |`;
	});
	return [
		`Платёжный сервис шлёт вебхуки о заказах ${p.orders.join(', ')} с гарантией «хотя бы один раз»: одно событие может прийти несколько раз и не по порядку. У события есть \`id\` и номер \`seq\` — порядковый номер события внутри своего заказа. События двух видов: смена статуса и возврат суммы.`,
		'',
		'Потребитель хранит для каждого заказа статус (вначале `created`), сумму возвратов (вначале 0) и номер последней применённой смены статуса (вначале 0), а также множество id обработанных событий. На каждую доставку:',
		'',
		'1. Если потребитель упал на этой доставке (ответ 500), ничего не записано и не изменено.',
		'2. Иначе, если id уже в множестве обработанных — доставка пропускается.',
		'3. Иначе id добавляется в множество, и событие разбирается по виду (ниже).',
		'',
		'- возврат — сумма прибавляется к возвратам заказа, номер `seq` для возвратов не проверяется;',
		'- смена статуса — если `seq` больше номера последней применённой смены статуса этого заказа, статус меняется и номер запоминается; иначе событие устарело и не применяется.',
		'',
		'Доставки в порядке прихода к потребителю:',
		'',
		'| # | id | заказ | seq | событие | итог доставки |',
		'|---|---|---|---|---|---|',
		...rows,
		'',
		`Введите через пробел номера доставок, которые изменили статус или сумму возвратов, по возрастанию (если таких нет — \`-\`), затем для каждого заказа в порядке ${p.orders.join(', ')} — знак \`|\`, номер заказа, итоговый статус и сумму возвратов. Например: \`1 4 | ord-10 paid 0 | ord-11 created 150\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
events = {e["id"]: e for e in p["events"]}
done = set()
state = {o: ["created", 0, 0] for o in p["orders"]}
changed = []
for n, d in enumerate(p["deliveries"], start=1):
    if d["failed"] or d["event"] in done:
        continue
    done.add(d["event"])
    e = events[d["event"]]
    s = state[e["order"]]
    if e["kind"] == "refund":
        s[1] += int(e["value"])
        changed.append(n)
    elif e["seq"] > s[2]:
        s[0] = e["value"]
        s[2] = e["seq"]
        changed.append(n)
out = [" ".join(map(str, changed)) if changed else "-"]
for o in p["orders"]:
    out.append("| %s %s %d" % (o, state[o][0], state[o][1]))
print(" ".join(out))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/reorder': ['apply-in-arrival-order', 'seq-global'],
	'senior/failures': ['mark-on-failure', 'no-dedup'],
	'senior/refunds': ['refund-seq-checked', 'no-dedup', 'apply-in-arrival-order'],
	'senior/reissued': ['reissue-detected', 'no-dedup']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.classId);
		if (p.deliveries.length > 14) continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
