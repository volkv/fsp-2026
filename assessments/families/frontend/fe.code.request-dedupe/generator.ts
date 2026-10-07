// Practice: a client-side query cache (as in SWR or React Query) over a log of subscriptions with moments: requests in
// flight are deduplicated, a cached entry is fresh for S ms after the response. The class sets the policy
// (stale-while-revalidate, TTL, retries with an exponential delay, invalidation); Senior has a latency per key and the
// window focus refetching stale keys. The step «измени своё решение» aborts the request of a key its last subscriber left.
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
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['javascript', 'typescript'] as const;
const CHANGE_WEIGHT = 0.3;

const descriptor = readDescriptor(import.meta.url);

type Ev =
	| { t: number; op: 'sub'; id: string; key: string }
	| { t: number; op: 'unsub'; id: string }
	| { t: number; op: 'invalidate'; key: string }
	| { t: number; op: 'focus' };

interface Input {
	stale: number;
	/** The latency of every key; on Middle all are the same. */
	latency: Map<string, number>;
	retries: number;
	delay: number;
	fails: Set<number>;
	events: Ev[];
}

/** The wrong solutions and, for the boundary tests, the order of one moment reversed. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'events-first';
const WRONG_IDS = ['no-dedupe', 'fresh-from-send', 'stale-edge', 'no-cleanup', 'retry-no-backoff'] as const;

/** A response due (kind 0) or a retry to send (kind 1), with the number of its request and its attempt. */
interface Item {
	time: number;
	kind: number;
	n: number;
	key: string;
	attempt: number;
}

const before = (a: Item, b: Item): boolean =>
	a.time !== b.time ? a.time < b.time : a.kind !== b.kind ? a.kind < b.kind : a.n < b.n;

/** The cache over the log; a variant other than `right` reproduces a wrong solution. */
class Client {
	readonly subs = new Map<string, string>();
	readonly cache = new Map<string, { value: string; time: number }>();
	readonly busy = new Set<string>();
	queue: Item[] = [];
	sent = 0;
	readonly out: string[] = [];
	readonly classId: string;
	readonly input: Input;
	readonly variant: Variant;
	readonly abort: boolean;
	/** S; the class of invalidation keeps an entry fresh until it is invalidated. */
	readonly stale: number;

	constructor(classId: string, input: Input, variant: Variant, abort: boolean) {
		this.classId = classId;
		this.stale = classId === 'invalidate' ? Infinity : input.stale;
		this.input = input;
		this.variant = variant;
		this.abort = abort;
	}

	fresh(key: string, t: number): boolean {
		const c = this.cache.get(key);
		if (!c) return false;
		return this.variant === 'stale-edge' ? t - c.time <= this.stale : t - c.time < this.stale;
	}

	send(t: number, key: string, attempt: number): void {
		this.sent += 1;
		this.busy.add(key);
		this.out.push(`${t} fetch ${this.sent} ${key}`);
		this.queue.push({ time: t + (this.input.latency.get(key) ?? 1), kind: 0, n: this.sent, key, attempt });
	}

	next(): Item | undefined {
		let best: Item | undefined;
		for (const item of this.queue) if (!best || before(item, best)) best = item;
		return best;
	}

	/** Everything due up to the moment `until`, inclusive (exclusive for the reversed order of a moment). */
	settle(until: number): void {
		for (;;) {
			const item = this.next();
			if (!item || item.time > until || (this.variant === 'events-first' && item.time === until)) return;
			this.queue.splice(this.queue.indexOf(item), 1);
			const { time: t, n, key, attempt } = item;
			if (item.kind === 1) {
				this.send(t, key, attempt);
				continue;
			}
			const failed = this.input.fails.has(n);
			if (failed && this.classId === 'retry' && attempt <= this.input.retries) {
				const wait = this.input.delay * (this.variant === 'retry-no-backoff' ? 1 : 2 ** (attempt - 1));
				this.queue.push({ time: t + wait, kind: 1, n, key, attempt: attempt + 1 });
				continue;
			}
			this.busy.delete(key);
			const value = failed ? 'error' : `v${n}`;
			if (!failed) {
				const time = this.variant === 'fresh-from-send' ? t - (this.input.latency.get(key) ?? 1) : t;
				this.cache.set(key, { value, time });
			}
			for (const [id, k] of this.subs) if (k === key) this.out.push(`${t} ${id} ${value}`);
		}
	}

	refetch(t: number, key: string): void {
		if (!this.fresh(key, t) && !this.busy.has(key)) this.send(t, key, 1);
	}

	apply(e: Ev): void {
		this.settle(e.t);
		const t = e.t;
		if (e.op === 'sub') {
			this.subs.set(e.id, e.key);
			const c = this.cache.get(e.key);
			const fresh = this.fresh(e.key, t);
			const deliver = this.classId === 'ttl' ? fresh : c !== undefined;
			if (c && deliver) this.out.push(`${t} ${e.id} ${c.value}`);
			if (!fresh && (this.variant === 'no-dedupe' || !this.busy.has(e.key))) this.send(t, e.key, 1);
		} else if (e.op === 'unsub') {
			const key = this.subs.get(e.id) ?? '';
			if (this.variant !== 'no-cleanup') this.subs.delete(e.id);
			if (this.abort && ![...this.subs.values()].includes(key) && this.busy.has(key)) {
				this.busy.delete(key);
				this.queue = this.queue.filter((q) => q.key !== key);
				this.out.push(`${t} abort ${key}`);
			}
		} else if (e.op === 'invalidate') {
			// Only the class of invalidation reads these lines.
			if (this.classId !== 'invalidate') return;
			const c = this.cache.get(e.key);
			if (c) c.time = -Infinity;
			if ([...this.subs.values()].includes(e.key) && !this.busy.has(e.key)) this.send(t, e.key, 1);
		} else {
			for (const key of [...new Set(this.subs.values())].sort()) this.refetch(t, key);
		}
	}
}

function simulate(classId: string, input: Input, abort: boolean, variant: Variant = 'right'): string {
	const client = new Client(classId, input, variant, abort);
	for (const e of input.events) client.apply(e);
	client.settle(Infinity);
	return `${client.out.join('\n')}\n`;
}

function render(classId: string, senior: boolean, input: Input): string {
	const retry = classId === 'retry' ? [input.retries, input.delay] : [];
	const latencies = [...input.latency];
	const stale = classId === 'invalidate' ? [] : [input.stale];
	const head = senior
		? [input.events.length, ...stale, latencies.length, ...retry]
		: [input.events.length, ...stale, latencies[0]?.[1] ?? 1, ...retry];
	const fails = [...input.fails].sort((a, b) => a - b);
	const events = input.events.map((e) => {
		if (e.op === 'sub') return `${e.t} sub ${e.id} ${e.key}`;
		if (e.op === 'unsub') return `${e.t} unsub ${e.id}`;
		if (e.op === 'invalidate') return `${e.t} invalidate ${e.key}`;
		return `${e.t} focus`;
	});
	return `${[
		head.join(' '),
		...(senior ? latencies.map(([key, l]) => `${key} ${l}`) : []),
		[fails.length, ...fails].join(' '),
		...events
	].join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Logs.

const KEYS = ['user', 'cart', 'feed', 'posts', 'todos', 'profile', 'prices', 'stock', 'news', 'chat'];

type GroupId = 'basic' | 'dedupe' | 'stale' | 'policy' | 'scale';

function makeInput(rng: Rng, classId: string, senior: boolean, group: GroupId, size: number | null = null): Input {
	const keys = rng.sample(KEYS, group === 'scale' ? 6 : rng.int(2, 3));
	const common = rng.int(10, 120);
	const count = size ?? (group === 'scale' ? rng.int(600, 700) : rng.int(18, 28));
	const failShare = classId === 'retry' && group === 'policy' ? 0.35 : 0.12;
	const fails = new Set<number>();
	for (let n = 1; n <= count * 2; n += 1) if (rng.bool(failShare)) fails.add(n);
	const input: Input = {
		stale: rng.pick([50, 100, 200, 300, 500]),
		latency: new Map(keys.map((k) => [k, senior ? rng.int(10, 150) : common])),
		retries: rng.int(1, 3),
		delay: rng.pick([10, 20, 50]),
		fails,
		events: []
	};
	const client = new Client(classId, input, 'right', false);
	let t = rng.int(0, 100);
	let serial = 0;
	const active: string[] = [];
	const hot = rng.pick(keys);
	while (input.events.length < count) {
		// The moment: often exactly when a response is due or when an entry turns stale, so the order of a moment and
		// the edge of freshness matter.
		const due = client.next()?.time;
		const turns = [...client.cache.values()].map((c) => c.time + client.stale).filter((x) => x >= t && x < Infinity);
		const roll = rng.next();
		const edge = group === 'stale' ? 0.6 : 0.25;
		if (roll < edge / 2 && due !== undefined && due >= t) t = due;
		else if (roll < edge && turns.length > 0) t = rng.pick(turns) + rng.pick([0, 0, -1, 1]);
		else if (group === 'dedupe' && rng.bool(0.6)) t += rng.int(0, 5);
		else t += rng.int(0, Math.max(input.stale, 40));
		t = Math.max(t, input.events[input.events.length - 1]?.t ?? 0);
		const r = rng.next();
		let e: Ev;
		if (classId === 'invalidate' && r < (group === 'policy' ? 0.25 : 0.1))
			e = { t, op: 'invalidate', key: rng.pick(keys) };
		else if (senior && r < (group === 'policy' ? 0.35 : 0.18) && r >= 0.1) e = { t, op: 'focus' };
		else if (active.length > 0 && rng.bool(active.length > 6 ? 0.6 : 0.3)) {
			const id = rng.pick(active);
			active.splice(active.indexOf(id), 1);
			e = { t, op: 'unsub', id };
		} else {
			const id = `c${(serial += 1)}`;
			active.push(id);
			e = { t, op: 'sub', id, key: group === 'dedupe' && rng.bool(0.6) ? hot : rng.pick(keys) };
		}
		client.apply(e);
		input.events.push(e);
	}
	return input;
}

/** The mistakes a group must expose on every test of the main task, by class. */
function traps(classId: string, group: GroupId): Variant[] {
	if (group === 'dedupe') return ['no-dedupe', 'no-cleanup'];
	if (group === 'stale')
		return classId === 'invalidate' ? ['events-first'] : ['fresh-from-send', 'stale-edge', 'events-first'];
	if (group === 'policy' && classId === 'retry') return ['retry-no-backoff'];
	return [];
}

/** Hidden tests of the class; every test tells the class from the others, and the step's tests feel the abort. */
function groups(
	rng: Rng,
	classId: string,
	others: readonly string[],
	senior: boolean,
	abort: boolean
): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'dedupe', 'stale', 'policy', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 5;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${classId}`);
			const input = makeInput(rng, classId, senior, id);
			const expected = simulate(classId, input, abort);
			if (abort) {
				if (simulate(classId, input, false) === expected) continue;
			} else if (
				others.some((other) => simulate(other, input, false) === expected) ||
				traps(classId, id).some((v) => simulate(classId, input, false, v) === expected)
			)
				continue;
			tests.push({ stdin: render(classId, senior, input), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const POLICY: Record<string, string> = {
	swr: '`sub` — подписка: если в кэше есть запись ключа (свежая или устаревшая), подписчик сразу получает её значение; если записи нет или она устарела и запрос ключа не в работе, отправляется запрос.',
	ttl: '`sub` — подписка: если запись ключа свежая, подписчик сразу получает её значение и запрос не нужен; устаревшая запись подписчику **не** отдаётся — если записи нет или она устарела и запрос ключа не в работе, отправляется запрос, и подписчик ждёт ответа.',
	retry:
		'`sub` — подписка: если в кэше есть запись ключа (свежая или устаревшая), подписчик сразу получает её значение; если записи нет или она устарела и запрос ключа не в работе, отправляется запрос.',
	invalidate:
		'`sub` — подписка: если в кэше есть запись ключа (свежая или устаревшая), подписчик сразу получает её значение; если записи нет или она устарела и запрос ключа не в работе, отправляется запрос.'
};

function statement(classId: string, senior: boolean, example: Input): string {
	const retry = classId === 'retry';
	const timed = classId !== 'invalidate';
	const s = timed ? ' S' : '';
	const head = senior ? `\`E${s} P${retry ? ' K D' : ''}\`` : `\`E${s} L${retry ? ' K D' : ''}\``;
	return [
		'Клиентский кэш запросов (как в SWR или React Query) раздаёт данные компонентам-подписчикам и ходит в сеть только тогда, когда нужно. Напишите программу, которая по журналу событий печатает, какие запросы уйдут в сеть и что получит каждый подписчик.',
		'',
		'## Вход',
		'',
		`В первой строке — ${head}: число событий (1 ≤ E ≤ 2000)${timed ? ', время свежести `S` в мс (1 ≤ S ≤ 10⁴)' : ''}${senior ? ', число ключей `P` (1 ≤ P ≤ 20)' : ', задержка ответа `L` в мс (1 ≤ L ≤ 10⁴)'}${retry ? ', число повторов `K` (0 ≤ K ≤ 5) и базовая задержка повтора `D` в мс (1 ≤ D ≤ 10⁴)' : ''}.`,
		...(senior
			? ['Далее `P` строк `<ключ> <задержка>` — у каждого ключа своя задержка ответа в мс (1 ≤ задержка ≤ 10⁴).']
			: []),
		'Далее строка `Q n₁ n₂ … n_Q` (0 ≤ Q ≤ 4000): номера сетевых запросов, которые завершатся ошибкой, по возрастанию.',
		'Далее `E` строк событий `t <событие>` (0 ≤ t ≤ 10⁹, моменты не убывают):',
		'',
		'- `t sub <id> <ключ>` — компонент `id` подписывается на ключ (идентификаторы подписок не повторяются);',
		'- `t unsub <id>` — подписка `id` уходит (компонент размонтирован);',
		...(classId === 'invalidate' ? ['- `t invalidate <ключ>` — инвалидация ключа;'] : []),
		...(senior ? ['- `t focus` — окно браузера снова получило фокус;'] : []),
		'',
		'Ключи и `id` — латинские буквы и цифры.',
		'',
		'## Сеть',
		'',
		`Запросы нумеруются с 1 в порядке отправки. Запрос номер \`n\` ключа, отправленный в момент \`s\`, завершается в момент \`s + ${senior ? 'задержка ключа' : 'L'}\`: ошибкой, если \`n\` есть в списке, иначе успехом со значением \`v<n>\` (например, \`v7\`).`,
		'',
		'## Кэш',
		'',
		`${
			timed
				? 'Запись ключа в кэше — значение и момент **ответа**, который её записал; запись свежая в момент `t`, если `t − момент ответа < S`, иначе устаревшая.'
				: 'Запись ключа в кэше — значение последнего успешного ответа. Время свежести не ограничено (как `staleTime: Infinity`): запись свежая, пока её не инвалидировали; после `invalidate` она устаревшая, пока следующий успешный ответ не запишет новую.'
		} Запрос ключа «в работе» с отправки до ${retry ? 'окончательного итога (с учётом повторов)' : 'его завершения'}; пока он в работе, второй запрос того же ключа не отправляется.`,
		'',
		`- ${POLICY[classId] ?? ''} Если запрос ключа в работе, подписчик просто ждёт его ответа.`,
		'- `unsub` — подписка удаляется; ответы ей больше не доставляются.',
		`- Успешный ответ записывает в кэш значение и момент ответа и доставляется **всем текущим** подписчикам ключа в порядке их подписки. ${
			retry
				? 'Неудачная попытка повторяется: если это попытка номер `a` (первая отправка — попытка 1) и `a ≤ K`, через `D·2^(a−1)` мс после неудачи отправляется новый запрос этого ключа (со своим номером); подписчики ничего не получают. Если `a > K`, всем текущим подписчикам доставляется `error`.'
				: 'Неудачный ответ доставляет всем текущим подписчикам ключа `error`.'
		} Запись кэша при неудаче не меняется.`,
		...(classId === 'invalidate'
			? [
					'- `invalidate` — запись ключа (если есть) становится устаревшей; если у ключа есть подписчики и запрос ключа не в работе, отправляется запрос.'
				]
			: []),
		...(senior
			? [
					'- `focus` — для каждого ключа, у которого есть подписчики, запись устарела или её нет и запрос не в работе, отправляется запрос; ключи — по возрастанию имени (сравнение строк по кодам символов).'
				]
			: []),
		'',
		`В один момент сначала завершаются запросы, срок которых наступил (по возрастанию номера)${retry ? ', затем отправляются повторы этого момента (по возрастанию номера неудачного запроса)' : ''}, затем обрабатываются события журнала этого момента по порядку строк. После последнего события запросы в работе завершаются своим чередом.`,
		'',
		'## Выход',
		'',
		'Строки в порядке, в котором всё происходит:',
		'',
		'- `t fetch <n> <ключ>` — отправлен запрос номер `n`;',
		'- `t <id> <значение>` — подписчик `id` получил значение (`v<n>` или `error`).',
		'',
		'## Пример',
		'',
		'Вход:',
		'',
		'```',
		render(classId, senior, example).trimEnd(),
		'```',
		'',
		'Выход:',
		'',
		'```',
		simulate(classId, example, false).trimEnd(),
		'```',
		'',
		'Скрытые тесты — пять групп: обычные журналы, одновременные подписки на ключ, граница свежести и совпадение моментов, правило кэша, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

function changeStatement(classId: string): string {
	return [
		`**Новое условие.** Запрос отменяется, как через \`AbortController\`: если после \`unsub\` у ключа не осталось подписчиков, а запрос ключа в работе${classId === 'retry' ? ' (в полёте или в ожидании повтора)' : ''}, он отменяется — его ответ не наступает${classId === 'retry' ? ', повтор не отправляется' : ''}, кэш не меняется, номер запроса остаётся израсходованным. В этот момент печатается строка \`t abort <ключ>\`. Следующая подписка на ключ при необходимости отправляет новый запрос.`,
		'Формат входа прежний. Измените решение и отправьте его снова.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The reference in Python and the wrong solutions.

function referenceSource(classId: string, senior: boolean, abort: boolean, variant: Variant): string {
	const retry = classId === 'retry';
	const timed = classId !== 'invalidate';
	const head = ['e', ...(timed ? ['stale'] : []), senior ? 'p' : 'latency', ...(retry ? ['retries', 'delay'] : [])];
	const lat = senior ? 'lat[key]' : 'latency';
	const fresh = variant === 'stale-edge' ? '<=' : '<';
	const lines: string[] = [
		'import heapq',
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		`${head.join(', ')} = map(int, data[0].split())`,
		...(timed ? [] : ["stale = float('inf')"]),
		...(senior
			? ['lat = {line.split()[0]: int(line.split()[1]) for line in data[1:p + 1]}', 'pos = p + 1']
			: ['pos = 1']),
		'fails = set(data[pos].split()[1:])',
		'subs, cache, busy, queue, out = {}, {}, set(), [], []',
		'sent = 0',
		'',
		'',
		'def fresh(key, t):',
		`    return key in cache and t - cache[key][1] ${fresh} stale`,
		'',
		'',
		'def send(t, key, attempt):',
		'    global sent',
		'    sent += 1',
		'    busy.add(key)',
		"    out.append(f'{t} fetch {sent} {key}')",
		`    heapq.heappush(queue, (t + ${lat}, 0, sent, key, attempt))`,
		'',
		'',
		'def settle(until):',
		'    while queue and queue[0][0] <= until:',
		'        t, kind, n, key, attempt = heapq.heappop(queue)',
		...(retry
			? [
					'        if kind:',
					'            send(t, key, attempt)',
					'            continue',
					'        if str(n) in fails and attempt <= retries:',
					`            heapq.heappush(queue, (t + delay${variant === 'retry-no-backoff' ? '' : ' * 2 ** (attempt - 1)'}, 1, n, key, attempt + 1))`,
					'            continue'
				]
			: []),
		'        busy.discard(key)',
		'        if str(n) in fails:',
		"            value = 'error'",
		'        else:',
		"            value = f'v{n}'",
		`            cache[key] = (value, ${variant === 'fresh-from-send' ? `t - ${lat}` : 't'})`,
		'        for sid, k in subs.items():',
		'            if k == key:',
		"                out.append(f'{t} {sid} {value}')",
		'',
		'',
		'for line in data[pos + 1:pos + 1 + e]:',
		'    t, op, *args = line.split()',
		'    t = int(t)',
		'    settle(t)',
		"    if op == 'sub':",
		'        sid, key = args',
		'        subs[sid] = key',
		classId === 'ttl' ? '        if fresh(key, t):' : '        if key in cache:',
		"            out.append(f'{t} {sid} {cache[key][0]}')",
		`        if not fresh(key, t)${variant === 'no-dedupe' ? '' : ' and key not in busy'}:`,
		'            send(t, key, 1)',
		"    elif op == 'unsub':",
		...(variant === 'no-cleanup' ? ['        key = subs[args[0]]'] : ['        key = subs.pop(args[0])']),
		...(abort
			? [
					'        if key not in subs.values() and key in busy:',
					'            busy.discard(key)',
					'            queue = [q for q in queue if q[3] != key]',
					'            heapq.heapify(queue)',
					"            out.append(f'{t} abort {key}')"
				]
			: [])
	];
	if (classId === 'invalidate') {
		lines.push(
			"    elif op == 'invalidate':",
			'        key = args[0]',
			'        if key in cache:',
			"            cache[key] = (cache[key][0], float('-inf'))",
			'        if key in subs.values() and key not in busy:',
			'            send(t, key, 1)'
		);
	}
	if (senior) {
		lines.push(
			"    elif op == 'focus':",
			'        for key in sorted(set(subs.values())):',
			'            if not fresh(key, t) and key not in busy:',
			'                send(t, key, 1)'
		);
	}
	lines.push("settle(float('inf'))", "print('\\n'.join(out))");
	return lines.join('\n');
}

function applies(id: (typeof WRONG_IDS)[number], classId: string): boolean {
	if (id === 'retry-no-backoff') return classId === 'retry';
	return classId !== 'invalidate' || (id !== 'fresh-from-send' && id !== 'stale-edge');
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const classId = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== classId);
	const main = groups(rng, classId, others, senior, false);
	const step = groups(rng, classId, others, senior, true);
	const example = makeInput(rng, classId, senior, 'basic', 8);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(classId, senior, example), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(classId), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(classId, senior, false, 'right'),
			changeSource: referenceSource(classId, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, classId)
						? { kind: 'program' as const, source: referenceSource(classId, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
