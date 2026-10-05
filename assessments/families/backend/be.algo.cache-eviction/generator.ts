// Cache eviction policies on a sequence of requests: how many misses LRU, LFU (ties broken by LRU) and FIFO make, and
// what the cache holds at the end.
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

type Policy = 'lru' | 'lfu' | 'fifo' | 'clock';

interface Rules {
	lruNoRefresh: boolean;
	fifoRefresh: boolean;
	lfuTieFifo: boolean;
	lfuKeepsHistory: boolean;
	coldMissesIgnored: boolean;
	clockAsFifo: boolean;
	clockAsLru: boolean;
}

const RIGHT: Rules = {
	lruNoRefresh: false,
	fifoRefresh: false,
	lfuTieFifo: false,
	lfuKeepsHistory: false,
	coldMissesIgnored: false,
	clockAsFifo: false,
	clockAsLru: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'lru-no-refresh': { lruNoRefresh: true },
	'fifo-refresh': { fifoRefresh: true },
	'lfu-tie-fifo': { lfuTieFifo: true },
	'lfu-keeps-history': { lfuKeepsHistory: true },
	'cold-misses-ignored': { coldMissesIgnored: true },
	'clock-as-fifo': { clockAsFifo: true },
	'clock-as-lru': { clockAsLru: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/lru': ['lru-no-refresh', 'cold-misses-ignored'],
	'middle/lfu': ['lfu-tie-fifo', 'lfu-keeps-history'],
	'middle/fifo': ['fifo-refresh', 'cold-misses-ignored'],
	'middle/clock': ['clock-as-fifo', 'clock-as-lru']
};

interface Params {
	policy: Policy;
	capacity: number;
	requests: string[];
}

/** Simulates the cache: `<misses> <keys at the end in alphabetical order>`. */
function simulate(p: Params, rules: Rules): string {
	if (p.policy === 'clock') return simulateClock(p, rules);
	// Every key in the cache: when it entered, when it was last used, how many uses it has.
	const cache = new Map<string, { entered: number; used: number; count: number }>();
	const history = new Map<string, number>();
	let misses = 0;
	p.requests.forEach((key, t) => {
		const hit = cache.get(key);
		if (hit) {
			const refresh = p.policy === 'lru' ? !rules.lruNoRefresh : p.policy === 'fifo' ? rules.fifoRefresh : true;
			if (refresh) hit.used = t;
			if (p.policy === 'fifo' && rules.fifoRefresh) hit.entered = t;
			hit.count += 1;
			history.set(key, hit.count);
			return;
		}
		if (!(rules.coldMissesIgnored && cache.size < p.capacity)) misses += 1;
		if (cache.size === p.capacity) {
			const entries = [...cache.entries()];
			const victimOf = (): string => {
				if (p.policy === 'fifo') return entries.sort((a, b) => a[1].entered - b[1].entered)[0]?.[0] ?? '';
				if (p.policy === 'lru')
					return (
						entries.sort((a, b) =>
							rules.lruNoRefresh ? a[1].entered - b[1].entered : a[1].used - b[1].used
						)[0]?.[0] ?? ''
					);
				return (
					entries.sort(
						(a, b) =>
							a[1].count - b[1].count || (rules.lfuTieFifo ? a[1].entered - b[1].entered : a[1].used - b[1].used)
					)[0]?.[0] ?? ''
				);
			};
			cache.delete(victimOf());
		}
		const count = (rules.lfuKeepsHistory ? (history.get(key) ?? 0) : 0) + 1;
		cache.set(key, { entered: t, used: t, count });
		history.set(key, count);
	});
	return [misses, ...[...cache.keys()].sort()].join(' ');
}

/** The clock (second chance) policy: slots in a ring, a reference bit per slot, a hand that clears bits as it passes. */
function simulateClock(p: Params, rules: Rules): string {
	if (rules.clockAsFifo) return simulate({ ...p, policy: 'fifo' }, { ...rules, clockAsFifo: false });
	if (rules.clockAsLru) return simulate({ ...p, policy: 'lru' }, { ...rules, clockAsLru: false });
	const slots: { key: string; bit: 0 | 1 }[] = [];
	let hand = 0;
	let misses = 0;
	for (const key of p.requests) {
		const hit = slots.find((s) => s.key === key);
		if (hit) {
			hit.bit = 1;
			continue;
		}
		if (!(rules.coldMissesIgnored && slots.length < p.capacity)) misses += 1;
		if (slots.length < p.capacity) {
			slots.push({ key, bit: 0 });
			continue;
		}
		for (let guard = 0; ; guard += 1) {
			if (guard > 2 * p.capacity) throw new Error('the clock hand does not stop');
			const slot = slots[hand] as { key: string; bit: 0 | 1 };
			if (slot.bit === 0) break;
			slot.bit = 0;
			hand = (hand + 1) % p.capacity;
		}
		slots[hand] = { key, bit: 0 };
		hand = (hand + 1) % p.capacity;
	}
	return [misses, ...slots.map((s) => s.key).sort()].join(' ');
}

const PLOTS = [
	{ what: 'страницы каталога', unit: 'страница' },
	{ what: 'ответы сервиса цен', unit: 'ответ' },
	{ what: 'профили пользователей', unit: 'профиль' },
	{ what: 'сессии', unit: 'сессия' }
] as const;

const POLICY_TEXT: Record<Policy, string> = {
	lru: 'LRU: при заполненном кэше вытесняется ключ, к которому дольше всего не обращались (попадание считается обращением).',
	lfu:
		'LFU: при заполненном кэше вытесняется ключ с наименьшим числом обращений с момента его последнего попадания в кэш; ' +
		'при равенстве — тот, к которому дольше всего не обращались. Вытесненный ключ при новом попадании начинает счёт заново, с 1.',
	fifo: 'FIFO: при заполненном кэше вытесняется ключ, который попал в кэш раньше всех остальных; попадания на порядок не влияют.',
	clock:
		'«часы» (второй шанс): у кэша ячейки 1…N по кругу, у каждой ячейки бит обращения. Пока кэш не заполнен, новый ключ ' +
		'занимает первую свободную ячейку. Новый ключ кладётся с битом 0, попадание ставит бит 1. Стрелка сначала указывает на ' +
		'ячейку 1. При промахе в заполненном кэше: если у ячейки под стрелкой бит 1, он сбрасывается в 0 и стрелка сдвигается ' +
		'на следующую ячейку (после N — на 1); так до ячейки с битом 0 — её ключ вытесняется, новый ключ кладётся в эту ' +
		'ячейку, и стрелка сдвигается на следующую.'
};

function scenario(rng: Rng, policy: Policy): Params {
	const capacity = rng.int(3, 4);
	const keys = rng.sample(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'K', 'M'], capacity + rng.int(2, 3));
	const length = rng.int(14, 16);
	// Hot keys repeat often, so recency and frequency both matter.
	const hot = rng.sample(keys, 2);
	const requests: string[] = [];
	while (requests.length < length) {
		const key = rng.bool(0.4) ? rng.pick(hot) : rng.pick(keys);
		if (requests[requests.length - 1] === key) continue;
		requests.push(key);
	}
	return { policy, capacity, requests };
}

function describe(p: Params, rng: Rng): string {
	const plot = rng.pick(PLOTS);
	return [
		`Кэш хранит ${plot.what}, вмещает ${p.capacity} ключа. Изначально он пуст. Обращение к ключу, которого нет в кэше, — промах: ` +
			'ключ загружается и кладётся в кэш, при необходимости вытеснив другой. Промахом считается и первое обращение к ключу.',
		'',
		`Политика вытеснения — ${POLICY_TEXT[p.policy]}`,
		'',
		`Обращения по порядку: ${p.requests.map((k) => `\`${k}\``).join(', ')}.`,
		'',
		'Введите через пробел число промахов, а затем ключи, которые останутся в кэше после всех обращений, в алфавитном порядке. ' +
			'Например: `9 A C D`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
policy = p["policy"]
cap = p["capacity"]


def clock():
    ring = [None] * cap
    referenced = {}
    hand = 0
    misses = 0
    for key in p["requests"]:
        if key in ring:
            referenced[key] = True
            continue
        misses += 1
        if None in ring:
            ring[ring.index(None)] = key
            referenced[key] = False
            continue
        while referenced[ring[hand]]:
            referenced[ring[hand]] = False
            hand = (hand + 1) % cap
        del referenced[ring[hand]]
        ring[hand] = key
        referenced[key] = False
        hand = (hand + 1) % cap
    print(misses, *sorted(ring))


def queue_policies():
    cache = []          # keys in the order of the policy's queue
    uses = {}           # LFU: uses since the key entered the cache
    misses = 0
    for key in p["requests"]:
        if key in cache:
            if policy in ("lru", "lfu"):
                cache.remove(key)
                cache.append(key)
            uses[key] = uses.get(key, 0) + 1
            continue
        misses += 1
        if len(cache) == cap:
            if policy == "lfu":
                low = min(uses[k] for k in cache)
                victim = next(k for k in cache if uses[k] == low)
            else:
                victim = cache[0]
            cache.remove(victim)
            del uses[victim]
        cache.append(key)
        uses[key] = 1
    print(misses, *sorted(cache))


if policy == "clock":
    clock()
else:
    queue_policies()
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const policy = input.classId as Policy;
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Sequences are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 5000; tries += 1) {
		const p = scenario(rng, policy);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, rng), code: null },
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
	throw new Error(`${descriptor.key}: no sequence for ${input.grade}/${input.classId} after 5000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
