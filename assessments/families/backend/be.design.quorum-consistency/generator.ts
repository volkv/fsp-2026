// Quorum replication of one key: N replicas, read and write quorums R and W, replicas failing and recovering on a
// schedule — which writes succeed and which version every read returns, under a strict quorum, a sloppy quorum with
// hinted handoff, or a strict quorum with read repair. Every rule of the model is in the statement.
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

/** A write of the reserve class X carries the timestamp of its coordinator's clock. */
type Event = { kind: 'down' | 'up'; node: string } | { kind: 'write'; ts?: number } | { kind: 'read' };

interface Params {
	key: string;
	replicas: string[];
	spares: string[];
	r: number;
	w: number;
	mode: 'strict' | 'sloppy' | 'read-repair' | 'lww';
	events: Event[];
}

interface Rules {
	downAware: boolean;
	firstR: boolean;
	sparesCount: boolean;
	handoff: boolean;
	repair: boolean;
	byTimestamp: boolean;
}

const RIGHT: Rules = {
	downAware: true,
	firstR: true,
	sparesCount: true,
	handoff: true,
	repair: true,
	byTimestamp: true
};

/** `ok`/`fail` for every write and `v<k>`/`fail` for every read, in order. */
function simulate(p: Params, rules: Rules): string {
	const version = new Map<string, number>(p.replicas.map((n) => [n, 0]));
	const up = new Set(p.replicas);
	let hints: { target: string; version: number }[] = [];
	let next = 1;
	// Last write wins by the coordinator's timestamp; without timestamps a later version is newer.
	const stamps = new Map<number, number>([[0, 0]]);
	const newer = (a: number, b: number): boolean =>
		p.mode === 'lww' && rules.byTimestamp ? (stamps.get(a) ?? 0) > (stamps.get(b) ?? 0) : a > b;
	const out: string[] = [];
	for (const e of p.events) {
		if (e.kind === 'down') up.delete(e.node);
		else if (e.kind === 'up') {
			up.add(e.node);
			if (p.mode === 'sloppy' && rules.handoff) {
				for (const h of hints.filter((x) => x.target === e.node))
					version.set(e.node, Math.max(version.get(e.node) ?? 0, h.version));
			}
			hints = hints.filter((x) => x.target !== e.node);
		} else if (e.kind === 'write') {
			const live = p.replicas.filter((n) => up.has(n));
			const reached = rules.downAware ? live : p.replicas;
			const covered =
				p.mode === 'sloppy' ? p.replicas.filter((n) => !up.has(n)).slice(0, p.spares.length) : ([] as string[]);
			const acks = live.length + (p.mode === 'sloppy' && rules.sparesCount ? covered.length : 0);
			if (acks >= p.w) {
				stamps.set(next, e.ts ?? next);
				for (const n of reached) if (newer(next, version.get(n) ?? 0)) version.set(n, next);
				if (p.mode === 'sloppy') for (const n of covered) hints.push({ target: n, version: next });
				next += 1;
				out.push('ok');
			} else out.push('fail');
		} else {
			const live = p.replicas.filter((n) => up.has(n));
			if (live.length < p.r) {
				out.push('fail');
				continue;
			}
			const asked = rules.firstR ? live.slice(0, p.r) : live;
			const newest = asked.map((n) => version.get(n) ?? 0).reduce((best, v) => (newer(v, best) ? v : best));
			if (p.mode === 'read-repair' && rules.repair) for (const n of asked) version.set(n, newest);
			out.push(`v${newest}`);
		}
	}
	return out.join(' ');
}

const KEYS = ['cart:41', 'profile:7', 'session:9f', 'stock:sku-12', 'order:1003'];

/** Quorums (R, W) by class and N. Read repair needs R ≥ 2 to repair anything and R + W ≤ N to matter. */
const QUORUMS: Record<string, [number, number][]> = {
	'strict/3': [
		[1, 2],
		[2, 2],
		[1, 3],
		[2, 1],
		[1, 1]
	],
	'strict/5': [
		[2, 3],
		[3, 3],
		[2, 4],
		[1, 3],
		[3, 2]
	],
	'sloppy/3': [
		[1, 2],
		[2, 2],
		[1, 3],
		[2, 3]
	],
	'read-repair/3': [
		[2, 1],
		[2, 2]
	],
	'read-repair/5': [
		[2, 2],
		[2, 3],
		[3, 2],
		[3, 3]
	]
};

/** A random walk of failures, recoveries, writes and reads, starting with a write and ending with a read. */
function randomSchedule(rng: Rng, replicas: readonly string[]): Event[] {
	const events: Event[] = [{ kind: 'write' }];
	const down = new Set<string>();
	const count = rng.int(10, 14);
	while (events.length < count) {
		const roll = rng.next();
		const upNodes = replicas.filter((x) => !down.has(x));
		if (roll < 0.22 && upNodes.length > 1) {
			const node = rng.pick(upNodes);
			down.add(node);
			events.push({ kind: 'down', node });
		} else if (roll < 0.36 && down.size > 0) {
			const node = rng.pick([...down]);
			down.delete(node);
			events.push({ kind: 'up', node });
		} else if (roll < 0.68) events.push({ kind: 'write' });
		else events.push({ kind: 'read' });
	}
	events.push({ kind: 'read' });
	return events;
}

/**
 * A schedule where read repair matters (R + W ≤ N): a write reaches only the first replica and the last W − 1, the
 * replicas recover, a read repairs the second one, the first fails, and the next read sees the version only through
 * the repair; and a write while the first R replicas are down, read back from them after they recover. The two
 * blocks come in random order between random writes and reads.
 */
function repairSchedule(rng: Rng, replicas: readonly string[], r: number, w: number): Event[] {
	const events: Event[] = [{ kind: 'write' }];
	const down = new Set<string>();
	const set = (node: string, isDown: boolean): void => {
		if (isDown === down.has(node)) return;
		if (isDown) down.add(node);
		else down.delete(node);
		events.push({ kind: isDown ? 'down' : 'up', node });
	};
	const recoverAll = (): void => {
		for (const node of rng.shuffle([...down])) set(node, false);
	};
	const noise = (): void => {
		for (let i = rng.int(0, 2); i > 0; i -= 1) events.push({ kind: rng.pick(['write', 'read'] as const) });
	};
	const first = replicas[0] ?? '';
	for (const block of rng.shuffle(['repair', 'stale-first'])) {
		noise();
		recoverAll();
		if (block === 'repair') {
			const keep = [first, ...replicas.slice(replicas.length - (w - 1))];
			for (const node of rng.shuffle(replicas.filter((n) => !keep.includes(n)))) set(node, true);
			events.push({ kind: 'write' });
			recoverAll();
			events.push({ kind: 'read' });
			set(first, true);
			events.push({ kind: 'read' });
		} else {
			for (const node of rng.shuffle(replicas.slice(0, r))) set(node, true);
			events.push({ kind: 'write' });
			recoverAll();
			events.push({ kind: 'read' });
		}
	}
	noise();
	return events;
}

function scenario(rng: Rng, classId: string): Params {
	const n = classId === 'sloppy' ? 3 : rng.pick([3, 3, 5]);
	const replicas = ['A', 'B', 'C', 'D', 'E'].slice(0, n);
	const [r, w] = rng.pick(QUORUMS[`${classId === 'lww' ? 'strict' : classId}/${n}`] ?? []);
	const events = classId === 'read-repair' ? repairSchedule(rng, replicas, r, w) : randomSchedule(rng, replicas);
	if (classId === 'lww') {
		// Clocks of the coordinators drift: now and then a later write carries an earlier timestamp.
		let clock = 1000;
		const used = new Set<number>();
		for (const e of events) {
			if (e.kind !== 'write') continue;
			clock += rng.int(10, 60);
			let ts = rng.bool(0.35) ? clock - rng.int(40, 120) : clock;
			while (used.has(ts)) ts += 1;
			used.add(ts);
			e.ts = ts;
		}
	}
	return {
		key: rng.pick(KEYS),
		replicas,
		spares: classId === 'sloppy' ? ['S1', 'S2'] : [],
		r,
		w,
		mode: classId === 'sloppy' || classId === 'read-repair' || classId === 'lww' ? classId : 'strict',
		events
	};
}

function describe(p: Params): string {
	const steps = p.events.map((e, i) => {
		const what =
			e.kind === 'down'
				? `отказ узла ${e.node}`
				: e.kind === 'up'
					? `узел ${e.node} восстановился`
					: e.kind === 'write'
						? e.ts === undefined
							? 'запись нового значения'
							: `запись нового значения, метка времени координатора ${e.ts}`
						: 'чтение';
		return `${i + 1}. ${what}`;
	});
	const rules = [
		'- Узлы отказывают и восстанавливаются только по событиям; отказавший узел не отвечает и ничего не получает, восстановившийся хранит ту версию, что была у него до отказа.',
		'- Каждая успешная запись получает следующий номер версии: v1, v2, … Вначале на всех репликах версия v0.'
	];
	if (p.mode === 'lww') {
		rules.push(
			'- Запись несёт метку времени своего координатора; часы координаторов расходятся, поэтому более поздняя запись может нести меньшую метку. У v0 метка 0.',
			'- Запись отправляется всем доступным репликам. Если их не меньше W, запись успешна (`ok`), иначе — `fail`: запись никуда не попадает, номер версии не расходуется. Получив успешную запись, реплика заменяет своё значение, только если метка записи больше метки хранимого значения (last write wins); иначе оставляет своё.',
			`- Чтение: если доступно меньше R реплик — \`fail\`. Иначе координатор опрашивает первые R доступных реплик по списку ${p.replicas.join(', ')} и возвращает значение с наибольшей меткой среди их ответов.`
		);
	} else if (p.mode === 'sloppy') {
		rules.push(
			`- Нестрогий кворум с hinted handoff. Запись получают все доступные реплики; кроме того, за каждую отказавшую реплику (по порядку списка) запись принимает очередной запасной узел (${p.spares.join(', ')}) — с подсказкой «для реплики X»; запасных узлов на все отказавшие реплики может не хватить. Запись успешна (\`ok\`), если узлов, принявших её (реплик и запасных), не меньше W; иначе — \`fail\`: запись никуда не попадает, номер версии не расходуется.`,
			'- Когда реплика восстанавливается, запасные узлы сразу передают ей подсказанные для неё версии; реплика оставляет наибольшую из своей и переданных. Запасные узлы не отказывают и в чтении не участвуют.'
		);
	} else {
		rules.push(
			'- Запись отправляется всем доступным репликам. Если их не меньше W, запись успешна (`ok`) и все доступные реплики сохраняют новую версию; иначе — `fail`: запись никуда не попадает, номер версии не расходуется.'
		);
	}
	if (p.mode !== 'lww')
		rules.push(
			`- Чтение: если доступно меньше R реплик — \`fail\`. Иначе координатор опрашивает первые R доступных реплик по списку ${p.replicas.join(', ')} и возвращает наибольшую версию среди их ответов.`
		);
	if (p.mode === 'read-repair')
		rules.push(
			'- Read repair: после успешного чтения опрошенные реплики с более старой версией сразу получают возвращённую версию.'
		);
	return [
		`Ключ \`${p.key}\` хранится на ${p.replicas.length} репликах ${p.replicas.join(', ')}; N = ${p.replicas.length}, R = ${p.r}, W = ${p.w}. События по порядку:`,
		'',
		...steps,
		'',
		'Правила модели:',
		'',
		...rules,
		'',
		'Введите итоги записей и чтений по порядку через пробел: для записи — `ok` или `fail`, для чтения — версию (`v0`, `v1`, …) или `fail`. Например: `ok ok v1 fail v2`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
stored = {name: 0 for name in p["replicas"]}
alive = {name: True for name in p["replicas"]}
pending = {name: [] for name in p["replicas"]}
stamp = {0: 0}
counter = 0
result = []


def rank(version):
    return stamp[version] if p["mode"] == "lww" else version


for event in p["events"]:
    kind = event["kind"]
    if kind == "down":
        alive[event["node"]] = False
    elif kind == "up":
        node = event["node"]
        alive[node] = True
        for v in pending[node]:
            stored[node] = max(stored[node], v)
        pending[node] = []
    elif kind == "write":
        live = [n for n in p["replicas"] if alive[n]]
        dead = [n for n in p["replicas"] if not alive[n]]
        helped = dead[: len(p["spares"])] if p["mode"] == "sloppy" else []
        if len(live) + len(helped) >= p["w"]:
            counter += 1
            stamp[counter] = event.get("ts", counter)
            for n in live:
                if rank(counter) > rank(stored[n]):
                    stored[n] = counter
            for n in helped:
                pending[n].append(counter)
            result.append("ok")
        else:
            result.append("fail")
    else:
        live = [n for n in p["replicas"] if alive[n]]
        if len(live) < p["r"]:
            result.append("fail")
            continue
        asked = live[: p["r"]]
        best = max((stored[n] for n in asked), key=rank)
        if p["mode"] == "read-repair":
            for n in asked:
                stored[n] = best
        result.append(f"v{best}")
print(" ".join(result))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'write-to-down': { downAware: false },
	'read-all-up': { firstR: false },
	'strict-in-sloppy': { sparesCount: false },
	'no-handoff': { handoff: false },
	'no-repair': { repair: false },
	'issue-order-wins': { byTimestamp: false }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	strict: ['write-to-down', 'read-all-up'],
	sloppy: ['strict-in-sloppy', 'no-handoff'],
	'read-repair': ['no-repair', 'read-all-up'],
	lww: ['issue-order-wins', 'write-to-down']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Schedules are drawn until every misconception of the class changes the answer.
	for (let tries = 0; tries < 5000; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		const tokens = answer.split(' ');
		if (tokens.filter((x) => x.startsWith('v')).length < 3 || !tokens.includes('ok')) continue;
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
	throw new Error(`${descriptor.key}: no schedule for ${input.grade}/${input.classId} after 5000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
