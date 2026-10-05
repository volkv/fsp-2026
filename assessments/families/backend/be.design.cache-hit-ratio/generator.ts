// A cache in front of a database: given a trace of reads and writes, which reads hit. The cache expires entries by
// TTL, evicts the least recently used one when full, and handles writes by write-through or by invalidation
// (write-around). Every rule of the model is in the statement.
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

interface Op {
	t: number;
	kind: 'GET' | 'PUT';
	key: string;
}

interface Params {
	capacity: number | null;
	ttl: number | null;
	policy: 'through' | 'around';
	ops: Op[];
}

interface Rules {
	sliding: boolean;
	inclusive: boolean;
	lruOnHit: boolean;
	writeEffect: boolean;
	aroundAsThrough: boolean;
	expiredFirst: boolean;
}

const RIGHT: Rules = {
	sliding: false,
	inclusive: false,
	lruOnHit: true,
	writeEffect: true,
	aroundAsThrough: false,
	expiredFirst: false
};

/** H or M for every GET, in order. */
function simulate(p: Params, rules: Rules): string {
	const entries = new Map<string, { storedAt: number; used: number }>();
	let tick = 0;
	const place = (key: string, t: number): void => {
		if (rules.expiredFirst && p.ttl !== null && p.capacity !== null && entries.size >= p.capacity) {
			for (const [k, e] of [...entries]) if (t >= e.storedAt + p.ttl) entries.delete(k);
		}
		if (!entries.has(key) && p.capacity !== null && entries.size >= p.capacity) {
			let victim = '';
			let oldest = Infinity;
			for (const [k, e] of entries) {
				if (e.used < oldest) {
					oldest = e.used;
					victim = k;
				}
			}
			entries.delete(victim);
		}
		tick += 1;
		entries.set(key, { storedAt: t, used: tick });
	};
	const out: string[] = [];
	for (const op of p.ops) {
		if (op.kind === 'GET') {
			const e = entries.get(op.key);
			const valid =
				e !== undefined &&
				(p.ttl === null || (rules.inclusive ? op.t <= e.storedAt + p.ttl : op.t < e.storedAt + p.ttl));
			if (e && valid) {
				out.push('H');
				if (rules.lruOnHit) {
					tick += 1;
					e.used = tick;
				}
				if (rules.sliding) e.storedAt = op.t;
			} else {
				out.push('M');
				entries.delete(op.key);
				place(op.key, op.t);
			}
		} else if (rules.writeEffect) {
			if (p.policy === 'through' || rules.aroundAsThrough) {
				entries.delete(op.key);
				place(op.key, op.t);
			} else entries.delete(op.key);
		}
	}
	return out.join(' ');
}

const KEYS = ['user:7', 'user:12', 'cart:3', 'item:41', 'item:58', 'promo:2'];

function scenario(rng: Rng, classId: string): Params {
	const keyCount = classId === 'ttl' ? rng.int(3, 4) : rng.int(4, 5);
	const keys = rng.sample(KEYS, keyCount);
	// A skewed choice of keys: the first ones are hot, so hits happen.
	const pickKey = (): string => keys[Math.min(keys.length - 1, Math.floor(rng.next() ** 1.3 * keys.length))] ?? '';
	const count = rng.int(14, 18);
	const ops: Op[] = [];
	let t = 0;
	for (let i = 0; i < count; i += 1) {
		t += classId === 'ttl' ? rng.int(1, 3) * 5 : rng.int(1, 3);
		ops.push({ t, kind: i > 1 && rng.bool(0.22) ? 'PUT' : 'GET', key: pickKey() });
	}
	if (classId === 'ttl') return { capacity: null, ttl: rng.pick([15, 20, 25, 30]), policy: 'through', ops };
	if (classId === 'lru-ttl') return { capacity: rng.int(2, 3), ttl: rng.pick([6, 8, 10, 12]), policy: 'through', ops };
	if (classId === 'lru') return { capacity: rng.int(2, 3), ttl: null, policy: 'through', ops };
	return { capacity: rng.int(3, 4), ttl: null, policy: 'around', ops };
}

function describe(p: Params): string {
	const rules = [
		'- GET: если в кэше есть действующая запись ключа — попадание (H); иначе промах (M): значение читается из базы и помещается в кэш.'
	];
	rules.push(
		p.capacity === null
			? '- Размер кэша не ограничен.'
			: `- В кэше не больше ${p.capacity} записей. Если кэш полон, перед помещением новой записи вытесняется запись, которая использовалась раньше всех остальных (LRU). Использование записи — её помещение в кэш и попадание по ней.`
	);
	if (p.ttl !== null) {
		rules.push(
			`- Запись действует ${p.ttl} с с момента помещения в кэш: при чтении в момент t она действующая, только если t < (момент помещения + ${p.ttl}). Попадание срок не продлевает. Просроченная запись при чтении — промах, после которого запись помещается заново.`
		);
	} else rules.push('- Срок жизни записей не ограничен.');
	if (p.ttl !== null && p.capacity !== null) {
		rules.push(
			'- Просроченная запись удаляется из кэша только при чтении её ключа или при вытеснении; до этого она занимает место. При выборе вытесняемой записи срок не учитывается — только давность использования.'
		);
	}
	rules.push(
		p.policy === 'through'
			? '- PUT пишет новое значение в базу и сразу помещает его в кэш (write-through): запись ключа помещается заново, как при промахе.'
			: '- PUT пишет новое значение в базу и удаляет запись ключа из кэша, если она там есть (write-around с инвалидацией); новое значение в кэш не помещается.'
	);
	return [
		'Перед базой данных стоит кэш, вначале пустой. Обращения к сервису (время — в секундах от начала):',
		'',
		...p.ops.map((op, i) => `${i + 1}. t = ${op.t}: \`${op.kind} ${op.key}\``),
		'',
		'Правила кэша:',
		'',
		...rules,
		'',
		'Введите для каждого GET по порядку `H` (попадание) или `M` (промах) через пробел. Например: `M M H M`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
from collections import OrderedDict

p = json.loads(input())
cache = OrderedDict()


def place(key, t):
    if p["capacity"] is not None and len(cache) >= p["capacity"]:
        cache.popitem(last=False)
    cache[key] = t


out = []
for op in p["ops"]:
    t, key = op["t"], op["key"]
    if op["kind"] == "GET":
        if key in cache and (p["ttl"] is None or t < cache[key] + p["ttl"]):
            out.append("H")
            cache.move_to_end(key)
        else:
            out.append("M")
            cache.pop(key, None)
            place(key, t)
    else:
        cache.pop(key, None)
        if p["policy"] == "through":
            place(key, t)
print(" ".join(out))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'ttl-sliding': { sliding: true },
	'ttl-inclusive': { inclusive: true },
	fifo: { lruOnHit: false },
	'write-ignored': { writeEffect: false },
	'around-as-through': { aroundAsThrough: true },
	'expired-first': { expiredFirst: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	ttl: ['ttl-sliding', 'ttl-inclusive', 'write-ignored'],
	lru: ['fifo', 'write-ignored'],
	invalidate: ['write-ignored', 'around-as-through'],
	'lru-ttl': ['expired-first', 'fifo']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Traces are drawn until every misconception of the class changes the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		const hits = answer.split(' ').filter((x) => x === 'H').length;
		if (hits < 3 || answer.split(' ').length - hits < 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)) continue;
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
	throw new Error(`${descriptor.key}: no trace for ${input.grade}/${input.classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
