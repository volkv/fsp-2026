// A broker with a visibility timeout and acknowledgements: consumers receive, acknowledge too late or crash, and
// messages come back. The candidate finds what every receive gets and what the handler ends with — idempotent or
// not; a level up, FIFO message groups and a dead-letter queue after N receives.
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

interface Message {
	id: string;
	amount: number;
	group: string | null;
}

interface Action {
	t: number;
	consumer: string;
	/** `extend` — the visibility timeout starts anew; `release` — the message is visible again at once. */
	kind: 'receive' | 'ack' | 'crash' | 'extend' | 'release';
}

interface Params {
	senior: boolean;
	visibilitySec: number;
	idempotent: boolean;
	fifo: boolean;
	maxReceives: number | null;
	messages: Message[];
	actions: Action[];
}

interface Rules {
	lateAckRejected: boolean;
	expiry: boolean;
	crashImmediate: boolean;
	idempotent: boolean;
	groups: 'right' | 'none' | 'global';
	dlq: 'right' | 'early' | 'never';
	extendAdds: boolean;
	releaseCounted: boolean;
	releaseToEnd: boolean;
}

const RIGHT: Rules = {
	lateAckRejected: true,
	expiry: true,
	crashImmediate: false,
	idempotent: true,
	groups: 'right',
	dlq: 'right',
	extendAdds: false,
	releaseCounted: true,
	releaseToEnd: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ack-always-accepted': { lateAckRejected: false },
	'no-visibility-expiry': { expiry: false },
	'crash-immediate': { crashImmediate: true },
	'idempotent-ignored': { idempotent: false },
	'no-group-blocking': { groups: 'none' },
	'global-blocking': { groups: 'global' },
	'dlq-off-by-one': { dlq: 'early' },
	'dlq-never': { dlq: 'never' },
	'extend-adds': { extendAdds: true },
	'release-not-counted': { releaseCounted: false },
	'release-to-end': { releaseToEnd: true }
};

interface Outcome {
	answer: string;
	/** Consumers holding a message after the actions, and whether some action had nothing to act on. */
	holding: string[];
	idle: boolean;
	/** Messages neither deleted nor moved to the DLQ. */
	remaining: number;
	/** Moments a delivery's visibility ends, for keeping actions off the boundaries. */
	edges: number[];
}

function simulate(p: Params, rules: Rules): Outcome {
	const state = p.messages.map((m) => ({
		m,
		deleted: false,
		dead: false,
		hiddenUntil: 0,
		receives: 0,
		lease: 0
	}));
	type Entry = (typeof state)[number];
	const holds = new Map<string, { s: Entry; lease: number }>();
	const done = new Set<string>();
	const got: string[] = [];
	const dead: string[] = [];
	const edges: number[] = [];
	let balance = 0;
	let idle = false;
	let leases = 0;
	const gone = (s: (typeof state)[number]): boolean => s.deleted || s.dead;
	const visible = (s: (typeof state)[number], t: number): boolean => !gone(s) && t >= s.hiddenUntil;
	for (const a of p.actions) {
		if (a.kind === 'receive') {
			if (holds.has(a.consumer)) idle = true;
			let picked: number | null = null;
			for (let i = 0; i < state.length && picked === null; i += 1) {
				const s = state[i];
				if (!s || !visible(s, a.t)) continue;
				if (p.fifo && rules.groups === 'right') {
					const blocked = state.slice(0, i).some((o) => o.m.group === s.m.group && !gone(o));
					if (blocked) continue;
				}
				if (p.fifo && rules.groups === 'global' && state.slice(0, i).some((o) => !gone(o))) break;
				const limit =
					p.maxReceives === null || rules.dlq === 'never'
						? null
						: rules.dlq === 'early'
							? p.maxReceives - 1
							: p.maxReceives;
				if (limit !== null && s.receives >= limit) {
					s.dead = true;
					dead.push(s.m.id);
					// A message moved to the DLQ no longer blocks its group: look again from the start.
					i = -1;
					continue;
				}
				picked = i;
			}
			const s = picked === null ? undefined : state[picked];
			if (picked === null || !s) {
				got.push('-');
				continue;
			}
			s.receives += 1;
			leases += 1;
			s.lease = leases;
			s.hiddenUntil = rules.expiry ? a.t + p.visibilitySec : Number.POSITIVE_INFINITY;
			if (rules.expiry) edges.push(a.t + p.visibilitySec);
			holds.set(a.consumer, { s, lease: leases });
			got.push(s.m.id);
			if (!(p.idempotent && rules.idempotent && done.has(s.m.id))) balance += s.m.amount;
			done.add(s.m.id);
			continue;
		}
		const held = holds.get(a.consumer);
		if (a.kind !== 'extend') holds.delete(a.consumer);
		if (!held) {
			idle = true;
			continue;
		}
		const s = held.s;
		const valid = s.lease === held.lease && a.t < s.hiddenUntil;
		if (a.kind === 'extend') {
			// Without expiry in mind, an extension of a message that never comes back changes nothing.
			if (valid && rules.expiry) {
				s.hiddenUntil = rules.extendAdds ? s.hiddenUntil + p.visibilitySec : a.t + p.visibilitySec;
				edges.push(s.hiddenUntil);
			}
			continue;
		}
		if (a.kind === 'release') {
			if (valid) {
				s.hiddenUntil = a.t;
				if (!rules.releaseCounted) s.receives -= 1;
				if (rules.releaseToEnd) state.push(...state.splice(state.indexOf(s), 1));
			}
			continue;
		}
		if (a.kind === 'crash') {
			if (rules.crashImmediate && s.lease === held.lease && !gone(s)) s.hiddenUntil = a.t;
			continue;
		}
		const inTime = s.lease === held.lease && a.t < s.hiddenUntil;
		if (inTime || !rules.lateAckRejected) s.deleted = true;
	}
	const tail = p.senior ? (dead.length ? dead.join(' ') : '-') : String(balance);
	return {
		answer: [...got, '|', tail].join(' '),
		holding: [...holds.keys()],
		idle,
		remaining: state.filter((s) => !gone(s)).length,
		edges
	};
}

const CONSUMERS = ['c1', 'c2', 'c3'] as const;
const GROUPS = ['user-3', 'user-7', 'user-12', 'user-21', 'user-40'] as const;

/**
 * Builds the actions of a class by construction: a core that sets the trap of the class, then the rest of the
 * messages received and acknowledged in time. Every action happens at an even second and the visibility timeout is
 * odd, so no action ever falls on the moment a delivery becomes visible again.
 */
class Plan {
	readonly p: Params;
	t: number;
	readonly #rng: Rng;

	constructor(p: Params, rng: Rng) {
		this.p = p;
		this.#rng = rng;
		this.t = rng.int(0, 2) * 2;
	}

	/** The next action `gap` steps of two seconds later, by `consumer`. */
	act(consumer: string, kind: Action['kind'], gap = 1): number {
		this.t += 2 * gap;
		const holds = simulate(this.p, RIGHT).holding.includes(consumer);
		if ((kind === 'receive') === holds) throw new Error(`${consumer} cannot ${kind} now`);
		this.p.actions.push({ t: this.t, consumer, kind });
		return this.t;
	}

	/** Moves the clock past the moment a delivery received at `from` becomes visible again, plus a few steps. */
	after(from: number, extra = this.#rng.int(0, 2)): void {
		this.t = Math.max(this.t, from + this.p.visibilitySec + 1 + 2 * extra - 2);
	}

	free(): string {
		const holding = new Set(simulate(this.p, RIGHT).holding);
		const free = CONSUMERS.filter((c) => !holding.has(c));
		return this.#rng.pick(free);
	}

	/** The rest of the messages: receive and acknowledge in time, by free consumers, until nothing is left. */
	drain(): void {
		for (let guard = 0; guard < 12 && simulate(this.p, RIGHT).remaining > 0; guard += 1) {
			const c = this.free();
			this.act(c, 'receive');
			if (simulate(this.p, RIGHT).holding.includes(c)) this.act(c, 'ack');
		}
		if (this.#rng.bool(0.4)) this.act(this.free(), 'receive');
	}
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const senior = grade === 'senior';
	const fifo = classId === 'fifo-groups' || classId === 'fifo-dlq';
	const maxReceives =
		classId === 'dead-letter' || classId === 'fifo-dlq' || classId === 'release-dlq' ? rng.int(2, 3) : null;
	// FIFO with the DLQ needs a message of the other group for every in-flight receive of the first one.
	const count = Math.max(senior ? rng.int(4, 6) : rng.int(3, 5), fifo ? 3 + (maxReceives ?? 0) : 0);
	const [g1, g2] = rng.sample(GROUPS, 2) as [string, string];
	const ids = rng.sample(
		Array.from({ length: 90 }, (_, i) => 10 + i),
		count
	);
	// FIFO: the first two messages share a group, then enough of the other group for every in-flight receive.
	const groupOf = (i: number): string | null => {
		if (!fifo) return null;
		if (i < 2) return g1;
		if (i < 2 + (maxReceives ?? 1)) return g2;
		return rng.pick([g1, g2]);
	};
	const messages: Message[] = ids.map((n, i) => ({ id: `m${n}`, amount: rng.int(1, 40) * 25, group: groupOf(i) }));
	const p: Params = {
		senior,
		visibilitySec: rng.pick([5, 7, 9]),
		idempotent: classId === 'crash-idempotent',
		fifo,
		maxReceives,
		messages,
		actions: []
	};
	const plan = new Plan(p, rng);
	const [a, b, c] = rng.shuffle(CONSUMERS) as [string, string, string];
	const V = p.visibilitySec;
	switch (classId) {
		case 'late-ack': {
			// a holds the first message past its timeout; the late ack is refused and b gets the message again.
			const r0 = plan.act(a, 'receive');
			if (rng.bool()) {
				plan.act(b, 'receive');
				plan.act(b, 'ack');
			}
			plan.after(r0);
			plan.act(a, 'ack');
			plan.act(b, 'receive');
			plan.act(b, 'ack');
			break;
		}
		case 'crash-idempotent':
		case 'mixed': {
			// a crashes with the first message: it is hidden until its timeout, then comes back to c.
			const r0 = plan.act(a, 'receive');
			plan.act(a, 'crash');
			const r1 = plan.act(b, 'receive');
			if (classId === 'crash-idempotent') plan.act(b, 'ack');
			plan.after(r0);
			plan.act(c, 'receive');
			plan.act(c, 'ack');
			if (classId === 'mixed') {
				// b acknowledges after its own timeout: refused, and the message is delivered once more.
				plan.after(r1);
				plan.act(b, 'ack');
				plan.act(a, 'receive');
				plan.act(a, 'ack');
			}
			break;
		}
		case 'extend': {
			// The extension counts from its own moment: b receives after it ran out but before «old deadline + V».
			const r0 = plan.act(a, 'receive');
			plan.act(a, 'extend', rng.int(1, (V - 3) / 2));
			const extended = plan.t;
			plan.t = Math.max(plan.t, extended + V + 1 - 2);
			const tr = plan.act(b, 'receive');
			if (tr >= r0 + 2 * V) throw new Error('extend: the receive came too late');
			plan.act(b, 'ack');
			plan.act(a, 'ack');
			break;
		}
		case 'fifo-groups': {
			plan.act(a, 'receive');
			plan.act(b, 'receive');
			plan.act(a, 'ack');
			plan.act(c, 'receive');
			plan.act(b, 'ack');
			plan.act(c, 'ack');
			break;
		}
		case 'dead-letter':
		case 'fifo-dlq':
		case 'release-dlq': {
			// The first message is received and lost (or returned) as many times as the limit allows; the next
			// receive moves it to the DLQ and gets the following message.
			const limit = maxReceives ?? 2;
			for (let k = 0; k < limit; k += 1) {
				const holder = k % 2 === 0 ? a : c;
				const r = plan.act(holder, 'receive');
				if (classId === 'fifo-dlq') {
					plan.act(b, 'receive');
					plan.act(b, 'ack');
				}
				if (classId === 'release-dlq') plan.act(holder, 'release');
				else {
					plan.act(holder, 'crash');
					plan.after(r, 0);
				}
			}
			plan.act(b, 'receive');
			plan.act(b, 'ack');
			break;
		}
	}
	// Whatever is still hidden comes back before the rest is drained.
	const last = Math.max(...p.actions.filter((x) => x.kind === 'receive').map((x) => x.t));
	plan.after(last, 0);
	plan.drain();
	return p;
}

function describe(p: Params): string {
	const queue = p.messages
		.map((m) => (p.senior ? (p.fifo ? `${m.id} (группа ${m.group})` : m.id) : `${m.id} (сумма ${m.amount})`))
		.join(', ');
	const rules = [
		`- Получение (\`receive\`) выдаёт первое по порядку очереди доступное сообщение и скрывает его на ${p.visibilitySec} с: сообщение снова доступно в момент выдачи + ${p.visibilitySec} и позже. Если доступных нет — получение пустое (\`-\`). Вернувшееся сообщение стоит на своём прежнем месте в очереди.`,
		'- Подтверждение (`ack`) относится к последнему сообщению, полученному этим потребителем. Брокер удаляет сообщение, только если подтверждение пришло раньше, чем истёк таймаут этой выдачи; позднее подтверждение отклоняется, сообщение остаётся в очереди.',
		'- Падение (`crash`): потребитель теряет полученное сообщение, не подтвердив его; брокер о падении не знает. Потребитель сразу перезапускается.'
	];
	if (p.actions.some((a) => a.kind === 'extend')) {
		rules.push(
			`- Продление (\`extend\`) относится к сообщению, которое потребитель держит: если таймаут этой выдачи ещё не истёк, сообщение скрыто до момента продления + ${p.visibilitySec} с; позднее продление не действует. Потребитель продолжает держать сообщение.`
		);
	}
	if (p.actions.some((a) => a.kind === 'release')) {
		rules.push(
			'- Возврат (`release`): потребитель отпускает сообщение, не подтверждая его; если таймаут этой выдачи ещё не истёк, сообщение сразу снова доступно на своём месте, иначе возврат ничего не меняет. Выдача уже засчитана.'
		);
	}
	if (p.fifo) {
		rules.push(
			'- Очередь FIFO с группами: сообщение доступно, только если все более ранние сообщения его группы уже удалены (подтверждены или перенесены в DLQ). Сообщения других групп выдаются независимо.'
		);
	}
	if (p.maxReceives !== null) {
		rules.push(
			`- У сообщения считаются выдачи. Если первое доступное сообщение уже выдавалось ${p.maxReceives} раза, при очередном получении брокер переносит его в DLQ (больше оно не выдаётся) и выдаёт следующее доступное.`
		);
	}
	if (!p.senior) {
		rules.push(
			p.idempotent
				? '- Обработчик выполняется в момент получения и идемпотентен: он помнит id обработанных сообщений, и повторная обработка того же сообщения сумму не меняет. Иначе прибавляет сумму сообщения к балансу.'
				: '- Обработчик выполняется в момент получения и прибавляет сумму сообщения к балансу при каждой обработке.'
		);
	}
	const answer = p.senior
		? 'Введите через пробел, что выдало каждое получение по порядку (id или `-`), затем знак `|` и id сообщений в DLQ в порядке переноса (если DLQ пуст — `-`). Например: `m1 m2 - m1 | m3`.'
		: 'Введите через пробел, что выдало каждое получение по порядку (id или `-`), затем знак `|` и итоговый баланс (вначале 0). Например: `m1 m2 - m1 | 250`.';
	return [
		`В очереди по порядку: ${queue}. Потребители ${[...new Set(p.actions.map((a) => a.consumer))].sort().join(', ')}.`,
		'',
		...rules,
		'',
		'Действия потребителей (момент — в секундах):',
		'',
		'| момент | потребитель | действие |',
		'|---|---|---|',
		...p.actions.map((a) => `| ${a.t} | ${a.consumer} | \`${a.kind}\` |`),
		'',
		answer
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
V = p["visibilitySec"]
msgs = [{"id": m["id"], "amount": m["amount"], "group": m["group"], "gone": False, "until": 0, "count": 0, "lease": 0} for m in p["messages"]]
holder = {}
handled = set()
balance = 0
answer = []
dlq = []
lease = 0


def available(i, now):
    m = msgs[i]
    if m["gone"] or now < m["until"]:
        return False
    if p["fifo"]:
        for earlier in msgs[:i]:
            if earlier["group"] == m["group"] and not earlier["gone"]:
                return False
    return True


for a in p["actions"]:
    now, who = a["t"], a["consumer"]
    if a["kind"] == "receive":
        chosen = None
        while chosen is None:
            ready = [i for i in range(len(msgs)) if available(i, now)]
            if not ready:
                break
            m = msgs[ready[0]]
            if p["maxReceives"] is not None and m["count"] >= p["maxReceives"]:
                m["gone"] = True
                dlq.append(m["id"])
                continue
            chosen = ready[0]
        if chosen is None:
            answer.append("-")
            continue
        m = msgs[chosen]
        m["count"] += 1
        lease += 1
        m["lease"] = lease
        m["until"] = now + V
        holder[who] = (chosen, lease)
        answer.append(m["id"])
        if not (p["idempotent"] and m["id"] in handled):
            balance += m["amount"]
        handled.add(m["id"])
    elif a["kind"] == "extend":
        held = holder.get(who)
        if held is not None:
            m = msgs[held[0]]
            if m["lease"] == held[1] and now < m["until"]:
                m["until"] = now + V
    else:
        held = holder.pop(who, None)
        if held is None or a["kind"] == "crash":
            continue
        m = msgs[held[0]]
        if m["lease"] == held[1] and now < m["until"]:
            if a["kind"] == "release":
                m["until"] = now
            else:
                m["gone"] = True
answer.append("|")
if p["senior"]:
    answer.append(" ".join(dlq) if dlq else "-")
else:
    answer.append(str(balance))
print(" ".join(answer))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/late-ack': ['ack-always-accepted', 'no-visibility-expiry'],
	'middle/crash-idempotent': ['crash-immediate', 'idempotent-ignored'],
	'middle/mixed': ['no-visibility-expiry', 'crash-immediate'],
	'senior/fifo-groups': ['no-group-blocking', 'global-blocking'],
	'senior/dead-letter': ['dlq-off-by-one', 'dlq-never'],
	'senior/fifo-dlq': ['no-group-blocking', 'dlq-never'],
	'middle/extend': ['extend-adds', 'no-visibility-expiry'],
	'senior/release-dlq': ['release-not-counted', 'release-to-end']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	const p = scenario(rng, input.grade, input.classId);
	const right = simulate(p, RIGHT);
	// The construction guarantees these; a failure here is a defect of the generator, not bad luck.
	if (right.idle || right.edges.some((edge) => p.actions.some((a) => a.t === edge)))
		throw new Error(`${descriptor.key}: ${input.grade}/${input.classId} built an action on nothing or on an edge`);
	const answer = right.answer;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change }).answer;
			return [id, value === answer ? null : value];
		})
	);
	const missed = required.filter((id) => wrong[id] === null);
	if (missed.length)
		throw new Error(`${descriptor.key}: ${input.grade}/${input.classId} does not expose ${missed.join(', ')}`);
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

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
