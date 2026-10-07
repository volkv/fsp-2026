// Optimistic updates of a list (likes, renames, deletions): the client shows its operations at once, the server
// answers later and out of order, some operations fail. The client keeps the confirmed state (the last accepted server
// data of each entity, by version) and the queue of pending operations, and shows the confirmed state with the pending
// operations applied on top in issue order — as in rebase-style sync engines. The candidate gives the list on the
// screen at the marked moments. The generator models the client and the misconceptions as variants of the model; the
// gate checks the answer with an independent program in Python.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Entity {
	title: string;
	likes: number;
	version: number;
}

type OpKind = 'like' | 'rename' | 'delete';

interface Op {
	k: number;
	kind: OpKind;
	id: string;
	title: string | null;
}

/** What the server answered to an operation: the entity after it, its deletion, or a failure. */
type Reply = { ok: true; entity: Entity | null } | { ok: false; reason: string };

type Step = { kind: 'issue'; op: Op } | { kind: 'reply'; k: number; reply: Reply };

interface Scenario {
	ids: string[];
	initial: Record<string, Entity>;
	steps: Step[];
	/** Indexes of the steps after which the list is asked for; the end is always asked for as well. */
	marks: number[];
	/** Server title limit (the server-transform class), or null. */
	titleLimit: number | null;
	/** Changes of other users the server applied, for the statement. */
	others: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// The client model.

interface Flags {
	/** A failure rolls the queue back to the snapshot before the operation: later pending operations are lost too. */
	dropLater: boolean;
	/** A failed optimistic change stays: it is taken as confirmed. */
	failKeeps: boolean;
	/** A returned entity is accepted whatever its version. */
	ignoreVersions: boolean;
	/** A success confirms what the client computed itself, not the returned entity. */
	keepOptimistic: boolean;
	/** A returned entity overwrites the entity on screen: its other pending operations are not applied on top. */
	noReplay: boolean;
	/** A returned entity brings back an entity whose deletion was confirmed. */
	resurrect: boolean;
}

const RIGHT: Flags = {
	dropLater: false,
	failKeeps: false,
	ignoreVersions: false,
	keepOptimistic: false,
	noReplay: false,
	resurrect: false
};

const WRONG_FLAGS: Record<string, Partial<Flags>> = {
	'snapshot-rollback': { dropLater: true },
	'no-rollback': { failKeeps: true },
	'ignore-versions': { ignoreVersions: true },
	'keep-optimistic': { keepOptimistic: true },
	'no-replay': { noReplay: true },
	resurrect: { resurrect: true }
};

function applyOp(e: Entity, op: Op): Entity | null {
	if (op.kind === 'delete') return null;
	if (op.kind === 'like') return { ...e, likes: e.likes + 1 };
	return { ...e, title: op.title ?? e.title };
}

class Client {
	readonly #f: Flags;
	readonly #order: string[];
	readonly #confirmed = new Map<string, Entity>();
	readonly #ops = new Map<number, Op>();
	#pending: Op[] = [];
	readonly #hidden = new Set<number>();

	constructor(s: Scenario, f: Flags) {
		this.#f = f;
		this.#order = s.ids;
		for (const id of s.ids) {
			const e = s.initial[id];
			if (e) this.#confirmed.set(id, { ...e });
		}
	}

	#confirmLocally(op: Op): void {
		const cur = this.#confirmed.get(op.id);
		if (!cur) return;
		const next = applyOp(cur, op);
		if (next) this.#confirmed.set(op.id, next);
		else this.#confirmed.delete(op.id);
	}

	issue(op: Op): void {
		this.#ops.set(op.k, op);
		this.#pending.push(op);
	}

	reply(k: number, reply: Reply): void {
		const op = this.#ops.get(k);
		if (!op) throw new Error(`reply to unknown operation ${k}`);
		const at = this.#pending.findIndex((o) => o.k === k);
		if (!reply.ok) {
			if (at !== -1)
				this.#pending = this.#f.dropLater ? this.#pending.slice(0, at) : this.#pending.filter((o) => o.k !== k);
			if (this.#f.failKeeps) this.#confirmLocally(op);
			return;
		}
		this.#pending = this.#pending.filter((o) => o.k !== k);
		if (reply.entity === null) {
			this.#confirmed.delete(op.id);
			return;
		}
		if (this.#f.keepOptimistic) {
			this.#confirmLocally(op);
			return;
		}
		const cur = this.#confirmed.get(op.id);
		if (!cur) {
			if (this.#f.resurrect) this.#confirmed.set(op.id, { ...reply.entity });
			return;
		}
		if (this.#f.ignoreVersions || reply.entity.version > cur.version) {
			this.#confirmed.set(op.id, { ...reply.entity });
			if (this.#f.noReplay) for (const o of this.#pending) if (o.id === op.id) this.#hidden.add(o.k);
		}
	}

	view(): string {
		const shown: string[] = [];
		for (const id of this.#order) {
			let e: Entity | null = this.#confirmed.get(id) ?? null;
			for (const op of this.#pending) {
				if (e === null) break;
				if (op.id === id && !this.#hidden.has(op.k)) e = applyOp(e, op);
			}
			if (e) shown.push(`${e.title}:${e.likes}`);
		}
		return shown.length ? shown.join(' ') : '-';
	}
}

function answerOf(s: Scenario, f: Flags): string {
	const client = new Client(s, f);
	const parts: string[] = [];
	s.steps.forEach((step, i) => {
		if (step.kind === 'issue') client.issue(step.op);
		else client.reply(step.k, step.reply);
		if (s.marks.includes(i)) parts.push(client.view());
	});
	parts.push(client.view());
	return parts.join(' | ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios: the server applies operations in the order it gets them (the issue order); the replies come back with
// their own delays.

const SHORT_TITLES = ['tea', 'jam', 'map', 'pen', 'cup', 'box', 'hat', 'kit', 'owl', 'fox', 'sun', 'oak'] as const;
const LONG_TITLES = ['mintleaf', 'harbor', 'lantern', 'meadow', 'pebble', 'saffron', 'thistle', 'willow'] as const;
const FAIL_REASONS = ['409 конфликт', '403 нет прав', '429 слишком часто', '500 ошибка сервера'] as const;

interface Planned {
	kind: OpKind;
	/** Index of the item (0-based). */
	item: number;
	title: string | null;
	fails: boolean;
	/** Reply delay after the issue, ms. */
	delay: number;
	/** Another user's change the server applies just before this operation. */
	other: { kind: 'like' } | { kind: 'rename'; title: string } | null;
}

function simulate(rng: Rng, plan: readonly Planned[], titleLimit: number | null, markCount: number): Scenario {
	const ids = ['a', 'b', 'c'];
	const titles = rng.sample(SHORT_TITLES, 3);
	const versions = rng.sample([1, 2, 3, 4, 5, 6], 3);
	const initial: Record<string, Entity> = {};
	ids.forEach((id, i) => {
		initial[id] = { title: titles[i] ?? 'item', likes: rng.int(0, 9), version: versions[i] ?? 1 };
	});
	const server = new Map(ids.map((id) => [id, { ...(initial[id] as Entity) }]));
	const timed: { at: number; order: number; step: Step }[] = [];
	const others: string[] = [];
	plan.forEach((p, i) => {
		const k = i + 1;
		const id = ids[p.item] ?? 'a';
		const op: Op = { k, kind: p.kind, id, title: p.title };
		const issuedAt = k * 10;
		timed.push({ at: issuedAt, order: 0, step: { kind: 'issue', op } });
		const current = server.get(id);
		if (p.other && current) {
			const o = p.other;
			const next =
				o.kind === 'like'
					? { ...current, likes: current.likes + 1, version: current.version + 1 }
					: { ...current, title: o.title, version: current.version + 1 };
			server.set(id, next);
			others.push(
				o.kind === 'like'
					? `перед операцией #${k} другой пользователь поставил лайк «${current.title}»`
					: `перед операцией #${k} другой пользователь переименовал «${current.title}» в «${o.title}»`
			);
		}
		let reply: Reply;
		const now = server.get(id);
		if (!now || p.fails) reply = { ok: false, reason: now ? rng.pick(FAIL_REASONS) : '404 не найдено' };
		else if (p.kind === 'delete') {
			server.delete(id);
			reply = { ok: true, entity: null };
		} else {
			const changed = applyOp(now, op) ?? now;
			const title = titleLimit !== null ? changed.title.slice(0, titleLimit) : changed.title;
			const entity = { ...changed, title, version: now.version + 1 };
			server.set(id, entity);
			reply = { ok: true, entity };
		}
		timed.push({ at: issuedAt + p.delay, order: k, step: { kind: 'reply', k, reply } });
	});
	timed.sort((x, y) => x.at - y.at || x.order - y.order);
	const steps = timed.map((t) => t.step);
	// Marks: after a reply, not at the very end.
	const candidates = steps.map((s, i) => (s.kind === 'reply' && i < steps.length - 1 ? i : -1)).filter((i) => i >= 0);
	const marks = rng.sample(candidates, Math.min(markCount, candidates.length)).sort((a, b) => a - b);
	return { ids, initial, steps, marks, titleLimit, others };
}

const DELAYS = [5, 15, 25, 35, 45, 55, 65, 75] as const;

function rollbackRebase(rng: Rng): Scenario {
	const x = rng.int(0, 2);
	const y = (x + rng.int(1, 2)) % 3;
	const [t1, t2] = rng.sample(SHORT_TITLES, 2) as [string, string];
	const onX: Planned[] = rng.shuffle([
		{ kind: 'like', item: x, title: null, fails: false, delay: 0, other: null },
		{ kind: 'rename', item: x, title: t1, fails: false, delay: 0, other: null },
		{ kind: 'like', item: x, title: null, fails: false, delay: 0, other: null }
	] as Planned[]);
	onX.push({ kind: 'rename', item: x, title: t2, fails: false, delay: 0, other: null });
	// One of the first operations on the item fails and its reply comes before the later ones.
	const failing = rng.int(0, 1);
	const plan: Planned[] = onX.map((p, i) => ({
		...p,
		fails: i === failing,
		delay: i === failing ? rng.pick([5, 15]) : rng.pick(DELAYS.slice(3))
	}));
	plan.splice(rng.int(1, plan.length), 0, {
		kind: rng.pick<OpKind>(['like', 'rename']),
		item: y,
		title: rng.pick(SHORT_TITLES),
		fails: rng.bool(0.3),
		delay: rng.pick(DELAYS),
		other: null
	});
	for (const p of plan) if (p.kind === 'like') p.title = null;
	return simulate(rng, plan, null, 2);
}

function outOfOrder(rng: Rng): Scenario {
	const x = rng.int(0, 2);
	const y = (x + rng.int(1, 2)) % 3;
	const plan: Planned[] = [
		{ kind: 'like', item: x, title: null, fails: false, delay: rng.pick([55, 65, 75]), other: null },
		{ kind: 'rename', item: x, title: rng.pick(SHORT_TITLES), fails: false, delay: rng.pick([5, 15]), other: null },
		{ kind: 'like', item: x, title: null, fails: false, delay: rng.pick([25, 35, 45]), other: null }
	];
	// Another user's like between the client's operations: the server's numbers are not the client's.
	const at = rng.int(1, 2);
	const planned = plan[at];
	if (planned) planned.other = { kind: 'like' };
	plan.splice(rng.int(0, plan.length), 0, {
		kind: 'like',
		item: y,
		title: null,
		fails: false,
		delay: rng.pick(DELAYS),
		other: null
	});
	return simulate(rng, plan, null, 2);
}

function deleteConflict(rng: Rng): Scenario {
	const [x, z] = rng.sample([0, 1, 2], 2) as [number, number];
	const plan: Planned[] = [
		{ kind: 'rename', item: x, title: rng.pick(SHORT_TITLES), fails: false, delay: rng.pick([35, 45]), other: null },
		{ kind: 'delete', item: x, title: null, fails: true, delay: rng.pick([5, 15, 25]), other: null }
	];
	const zOps: Planned[] = [
		{ kind: 'like', item: z, title: null, fails: false, delay: rng.pick([55, 65, 75]), other: null },
		{ kind: 'delete', item: z, title: null, fails: false, delay: rng.pick([5, 15]), other: null }
	];
	const merged = rng.bool() ? [...plan, ...zOps] : [...zOps, ...plan];
	return simulate(rng, merged, null, 2);
}

function serverTransform(rng: Rng): Scenario {
	const x = rng.int(0, 2);
	const y = (x + rng.int(1, 2)) % 3;
	const limit = 5;
	const plan: Planned[] = [
		{ kind: 'rename', item: x, title: rng.pick(LONG_TITLES), fails: false, delay: rng.pick([5, 15]), other: null },
		{ kind: 'like', item: x, title: null, fails: false, delay: rng.pick([35, 45, 55]), other: { kind: 'like' } },
		{
			kind: 'rename',
			item: y,
			title: rng.pick(LONG_TITLES),
			fails: false,
			delay: rng.pick([15, 25, 35]),
			other: null
		}
	];
	if (rng.bool()) plan.push({ kind: 'like', item: y, title: null, fails: false, delay: rng.pick(DELAYS), other: null });
	return simulate(rng, plan, limit, 2);
}

const SCENARIOS: Record<string, (rng: Rng) => Scenario> = {
	'senior/rollback-rebase': rollbackRebase,
	'senior/out-of-order': outOfOrder,
	'senior/delete-conflict': deleteConflict,
	'senior/server-transform': serverTransform
};

const REQUIRED: Record<string, string[]> = {
	'senior/rollback-rebase': ['snapshot-rollback', 'no-rollback'],
	'senior/out-of-order': ['ignore-versions', 'no-replay'],
	'senior/delete-conflict': ['no-rollback', 'resurrect'],
	'senior/server-transform': ['keep-optimistic', 'no-replay']
};

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const quoted = (t: string): string => `«${t}»`;

function replyText(k: number, r: Reply): string {
	if (!r.ok) return `ответ на #${k}: ошибка ${r.reason}`;
	if (r.entity === null) return `ответ на #${k}: успех, элемент удалён`;
	return `ответ на #${k}: успех, элемент — название ${quoted(r.entity.title)}, лайков ${r.entity.likes}, версия ${r.entity.version}`;
}

function describe(s: Scenario): string {
	const items = s.ids.map((id) => {
		const e = s.initial[id];
		return e ? `- ${id}: название ${quoted(e.title)}, лайков ${e.likes}, версия ${e.version}` : '';
	});
	const steps = s.steps.map((step, i) => {
		const text = step.kind === 'issue' ? opTextShort(step.op) : replyText(step.k, step.reply);
		return `${i + 1}. ${text}${s.marks.includes(i) ? ' **★**' : ''}`;
	});
	return [
		'Список в интерфейсе показывает элементы с названием и числом лайков. Клиент применяет свои операции оптимистично ' +
			'и устроен так:',
		'',
		'- он хранит **подтверждённое состояние** — последние принятые данные сервера по каждому элементу — и **очередь ' +
			'ожидающих операций** в порядке отправки;',
		'- на экране — подтверждённое состояние, поверх которого по порядку применены ожидающие операции: лайк ' +
			'прибавляет 1, переименование заменяет название, удаление убирает элемент; операция над элементом, которого ' +
			'на экране уже нет, ничего не делает;',
		'- ответ «успех» убирает операцию из очереди; пришедший с ним элемент принимается, только если его версия больше ' +
			'подтверждённой, иначе отбрасывается; «успех, элемент удалён» удаляет элемент из подтверждённого состояния, и ' +
			'дальнейшие ответы о нём отбрасываются;',
		'- ответ «ошибка» убирает операцию из очереди и больше ничего не меняет.',
		'',
		...(s.titleLimit !== null ? [`Сервер обрезает название до ${s.titleLimit} символов.`, ''] : []),
		...(s.others.length ? [`Сервер принимает и чужие изменения: ${s.others.join('; ')}.`, ''] : []),
		'Подтверждённое состояние в начале, порядок элементов в списке — такой:',
		'',
		...items,
		'',
		'События по порядку:',
		'',
		...steps,
		'',
		'Введите, что показывает список после каждого события со звёздочкой и в конце. Элемент записывайте как ' +
			'`название:лайки`, элементы — через пробел в порядке списка, пустой список — `-`, моменты разделяйте ' +
			'символом `|`. Например: `tea:3 jam:0 | tea:4 | -`.'
	].join('\n');
}

function opTextShort(op: Op): string {
	const what =
		op.kind === 'like'
			? `лайк элемента ${op.id}`
			: op.kind === 'rename'
				? `переименование элемента ${op.id} в ${quoted(op.title ?? '')}`
				: `удаление элемента ${op.id}`;
	return `клиент отправил операцию #${op.k}: ${what}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference in Python.

const PYTHON_REFERENCE = `import json
import sys

s = json.loads(sys.stdin.read())
confirmed = {i: dict(s["initial"][i]) for i in s["ids"]}
operations = {}
queue = []


def screen():
    parts = []
    for i in s["ids"]:
        if i not in confirmed:
            continue
        title, likes, alive = confirmed[i]["title"], confirmed[i]["likes"], True
        for k in queue:
            op = operations[k]
            if op["id"] != i or not alive:
                continue
            if op["kind"] == "like":
                likes += 1
            elif op["kind"] == "rename":
                title = op["title"]
            else:
                alive = False
        if alive:
            parts.append(f"{title}:{likes}")
    return " ".join(parts) if parts else "-"


shown = []
for index, step in enumerate(s["steps"]):
    if step["kind"] == "issue":
        operations[step["op"]["k"]] = step["op"]
        queue.append(step["op"]["k"])
    else:
        k = step["k"]
        reply = step["reply"]
        if k in queue:
            queue.remove(k)
        target = operations[k]["id"]
        if reply["ok"]:
            entity = reply["entity"]
            if entity is None:
                confirmed.pop(target, None)
            elif target in confirmed and entity["version"] > confirmed[target]["version"]:
                confirmed[target] = dict(entity)
    if index in s["marks"]:
        shown.append(screen())
shown.append(screen())
print(" | ".join(shown))
`;

// ---------------------------------------------------------------------------------------------------------------

interface Evaluated {
	scenario: Scenario;
	answer: string;
	wrong: Record<string, string | null>;
}

function evaluate(s: Scenario): Evaluated {
	const answer = answerOf(s, RIGHT);
	const wrong: Record<string, string | null> = {};
	for (const [id, change] of Object.entries(WRONG_FLAGS)) {
		const value = answerOf(s, { ...RIGHT, ...change });
		wrong[id] = value === answer ? null : value;
	}
	return { scenario: s, answer, wrong };
}

function draw(rng: Rng, key: string): Evaluated {
	const make = SCENARIOS[key];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${key}`);
	const required = REQUIRED[key] ?? [];
	const fits = (x: Evaluated): boolean => required.every((id) => x.wrong[id] !== null);
	let last: Evaluated | null = null;
	for (let tries = 0; tries < 200; tries += 1) {
		last = evaluate(make(rng));
		if (fits(last)) return last;
	}
	for (let tries = 0; tries < 200; tries += 1) {
		last = evaluate(make(new Rng(`${descriptor.key}|fallback|${key}|${tries}`)));
		if (fits(last)) return last;
	}
	if (!last) throw new Error('unreachable');
	return last;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { scenario, answer, wrong } = draw(rng, `${input.grade}/${input.classId}`);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(scenario), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(scenario) }),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const value = wrong[id] ?? null;
					return [id, value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
