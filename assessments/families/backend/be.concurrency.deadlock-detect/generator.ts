// Deadlock detection under strict two-phase locking: transactions take shared and exclusive row locks in a given order
// of turns, wait on conflicts, and the database aborts the youngest transaction of a cycle in the wait-for graph. The
// candidate finds on which turn each transaction commits or is rolled back.
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

type Op = { kind: 'S' | 'X'; row: string } | { kind: 'commit' };

interface Params {
	names: string[];
	/** Indices into `names`, oldest first. */
	startOrder: number[];
	programs: Op[][];
	turns: number[];
}

interface Rules {
	victim: 'youngest' | 'oldest' | 'requester' | 'youngest-waiter';
	sharedCompatible: boolean;
	upgradeChecks: boolean;
	waitAborts: boolean;
	selfConflict: boolean;
}

const RIGHT: Rules = {
	victim: 'youngest',
	sharedCompatible: true,
	upgradeChecks: true,
	waitAborts: false,
	selfConflict: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'abort-oldest': { victim: 'oldest' },
	'abort-requester': { victim: 'requester' },
	'abort-youngest-waiter': { victim: 'youngest-waiter' },
	'shared-exclusive': { sharedCompatible: false },
	'upgrade-free': { upgradeChecks: false },
	'wait-aborts': { waitAborts: true },
	'self-conflict': { selfConflict: true }
};

interface Outcome {
	/** Per transaction: `c<turn>`, `a<turn>` or `-` when the turns ran out. */
	ends: string[];
	active: number[];
	deadlocks: number;
}

function simulate(p: Params, rules: Rules): Outcome {
	const n = p.programs.length;
	const pc = p.programs.map(() => 0);
	const ends: string[] = p.programs.map(() => '-');
	const locks = new Map<string, Map<number, 'S' | 'X'>>();
	const waiting = new Map<number, { kind: 'S' | 'X'; row: string }>();
	const age = (tx: number): number => p.startOrder.indexOf(tx);
	let deadlocks = 0;
	const conflicts = (tx: number, kind: 'S' | 'X', row: string): number[] => {
		const holders = locks.get(row) ?? new Map<number, 'S' | 'X'>();
		const others = [...holders.entries()].filter(([holder]) => holder !== tx || rules.selfConflict);
		if (kind === 'X' && holders.get(tx) === 'S' && !rules.upgradeChecks) return [];
		return others
			.filter(([, mode]) => kind === 'X' || mode === 'X' || !rules.sharedCompatible)
			.map(([holder]) => holder);
	};
	const release = (tx: number): void => {
		for (const holders of locks.values()) holders.delete(tx);
		waiting.delete(tx);
	};
	p.turns.forEach((tx, i) => {
		const turn = i + 1;
		const op = p.programs[tx]?.[pc[tx] ?? 0];
		if (!op || ends[tx] !== '-') return;
		if (op.kind === 'commit') {
			release(tx);
			ends[tx] = `c${turn}`;
			pc[tx] = (pc[tx] ?? 0) + 1;
		} else if (conflicts(tx, op.kind, op.row).length === 0) {
			const holders = locks.get(op.row) ?? new Map<number, 'S' | 'X'>();
			if (holders.get(tx) !== 'X') holders.set(tx, op.kind);
			locks.set(op.row, holders);
			waiting.delete(tx);
			pc[tx] = (pc[tx] ?? 0) + 1;
		} else if (rules.waitAborts) {
			// Any wait read as a deadlock: the younger of the requester and its blockers is rolled back.
			const pair = [tx, ...conflicts(tx, op.kind, op.row)].sort((a, b) => age(a) - age(b));
			const victim = pair.at(-1) ?? tx;
			deadlocks += 1;
			release(victim);
			ends[victim] = `a${turn}`;
		} else {
			waiting.set(tx, op);
		}
		// Deadlock detection after every turn, until the wait-for graph has no cycle.
		for (;;) {
			const edges = new Map<number, number[]>();
			for (const [w, req] of waiting) edges.set(w, conflicts(w, req.kind, req.row));
			const onCycle = [...edges.keys()].filter((start) => {
				const seen = new Set<number>();
				const stack = [...(edges.get(start) ?? [])];
				while (stack.length) {
					const v = stack.pop() as number;
					if (v === start) return true;
					if (seen.has(v)) continue;
					seen.add(v);
					stack.push(...(edges.get(v) ?? []));
				}
				return false;
			});
			if (onCycle.length === 0) break;
			deadlocks += 1;
			const byAge = (list: number[]): number[] => [...list].sort((a, b) => age(a) - age(b));
			let victim: number;
			if (rules.victim === 'oldest') victim = byAge(onCycle)[0] ?? tx;
			else if (rules.victim === 'requester' && onCycle.includes(tx)) victim = tx;
			else if (rules.victim === 'youngest-waiter') victim = byAge([...waiting.keys()]).at(-1) ?? tx;
			else victim = byAge(onCycle).at(-1) ?? tx;
			release(victim);
			ends[victim] = `a${turn}`;
		}
	});
	const active = p.programs.flatMap((_, tx) => (ends[tx] === '-' ? [tx] : []));
	return { ends: ends.slice(0, n), active, deadlocks };
}

const TX_NAMES = ['pay', 'ship', 'audit', 'refund', 'stock', 'promo', 'report', 'sync'] as const;
const ROW_NAMES = ['acc:1', 'acc:2', 'acc:3', 'ord:7', 'ord:9', 'sku:4'] as const;

function middleScenario(rng: Rng, classId: string): Params {
	const names = rng.sample(TX_NAMES, 2);
	const rows = rng.sample(ROW_NAMES, rng.int(2, 3));
	const programs: Op[][] = names.map(() => {
		// Without a deadlock in sight both take rows in one global order.
		const touched = rng.sample(rows, rng.int(2, rows.length));
		if (classId === 'wait-only') touched.sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
		const ops: Op[] = touched.map((row) => ({ kind: 'X', row }));
		return [...ops, { kind: 'commit' as const }];
	});
	if (classId === 'relock') {
		const program = rng.pick(programs);
		const first = program[0];
		if (first && first.kind !== 'commit')
			program.splice(rng.int(2, program.length - 1), 0, { kind: 'X', row: first.row });
	}
	const p: Params = { names, startOrder: rng.shuffle([0, 1]), programs, turns: [] };
	for (let guard = 0; guard < 20; guard += 1) {
		const active = simulate(p, RIGHT).active;
		if (active.length === 0) break;
		p.turns.push(rng.pick(active));
	}
	return p;
}

function scenario(rng: Rng, classId: string): Params {
	const count = classId === 'chain' ? 4 : rng.int(3, 4);
	const names = rng.sample(TX_NAMES, count);
	const rows = rng.sample(ROW_NAMES, rng.int(3, 4));
	const programs: Op[][] = names.map(() => {
		const touched = rng.sample(rows, rng.int(2, 3));
		const ops: Op[] = [];
		for (const row of touched) {
			if (classId === 'upgrade' && rng.bool(0.6)) ops.push({ kind: 'S', row }, { kind: 'X', row });
			else if (classId === 'x-cycle') ops.push({ kind: 'X', row });
			else if (classId === 'shared-no-cycle') ops.push({ kind: rng.bool(0.75) ? 'S' : 'X', row });
			else ops.push({ kind: rng.pick(['S', 'X'] as const), row });
		}
		return [...ops, { kind: 'commit' as const }];
	});
	const p: Params = { names, startOrder: rng.shuffle(names.map((_, i) => i)), programs, turns: [] };
	for (let guard = 0; guard < 30; guard += 1) {
		const active = simulate(p, RIGHT).active;
		if (active.length === 0) break;
		p.turns.push(rng.pick(active));
	}
	return p;
}

function describe(p: Params): string {
	const show = (op: Op): string => (op.kind === 'commit' ? '`COMMIT`' : `\`${op.kind}(${op.row})\``);
	return [
		`Транзакции начались в таком порядке (от старой к молодой): ${p.startOrder.map((i) => p.names[i]).join(', ')}. Их шаги:`,
		'',
		...p.programs.map((program, i) => `- **${p.names[i]}**: ${program.map(show).join(' → ')}`),
		'',
		'Правила СУБД:',
		'',
		'- `S(r)` — разделяемая блокировка строки r, `X(r)` — исключительная. S совместима с чужими S; X несовместима ни с какой чужой блокировкой. Блокировки держатся до `COMMIT` или отката (строгая двухфазная блокировка).',
		'- Транзакция, которая держит `S(r)` и просит `X(r)`, повышает блокировку: это возможно, только если других держателей у r нет.',
		'- Каждый ход — следующий шаг одной транзакции. Если запрос несовместим с чужими удерживаемыми блокировками, транзакция ждёт: ход потрачен, на следующем своём ходу она пробует тот же запрос снова. Очереди нет: запрос удовлетворяется, как только совместим. Ход завершённой или откаченной транзакции пропускается.',
		'- После каждого хода СУБД строит граф ожидания (ждущая транзакция → каждая транзакция, чья блокировка мешает её запросу). Пока в графе есть цикл, откатывается самая молодая из транзакций, лежащих на циклах; откат снимает все её блокировки, и больше она не выполняется.',
		'',
		`Порядок ходов: ${p.turns.map((tx) => p.names[tx]).join(', ')}.`,
		'',
		`Введите через пробел для каждой транзакции в порядке ${p.names.join(', ')}: имя, затем \`c<номер хода>\`, если она зафиксировалась на этом ходу, или \`a<номер хода>\`, если на этом ходу её откатили (ходы нумеруются с 1). Например: \`${p.names
			.map((name, i) => `${name} ${i % 2 ? 'a' : 'c'}${i + 3}`)
			.join(' ')}\`.`
	].join('\n');
}

const answerOf = (p: Params, o: Outcome): string => p.names.flatMap((name, i) => [name, o.ends[i] ?? '-']).join(' ');

const PYTHON_REFERENCE = `import json

p = json.loads(input())
n = len(p["programs"])
rank = {tx: i for i, tx in enumerate(p["startOrder"])}
held = {}
pos = [0] * n
result = ["-"] * n
want = {}


def blockers(tx, mode, row):
    out = []
    for other, m in held.get(row, {}).items():
        if other != tx and (mode == "X" or m == "X"):
            out.append(other)
    return out


def cyclic(edges):
    found = []
    for s in edges:
        todo, seen = list(edges[s]), set()
        while todo:
            v = todo.pop()
            if v == s:
                found.append(s)
                break
            if v not in seen:
                seen.add(v)
                todo.extend(edges.get(v, []))
    return found


for turn, tx in enumerate(p["turns"], start=1):
    if result[tx] != "-":
        continue
    op = p["programs"][tx][pos[tx]]
    if op["kind"] == "commit":
        for h in held.values():
            h.pop(tx, None)
        result[tx] = "c%d" % turn
        pos[tx] += 1
    elif not blockers(tx, op["kind"], op["row"]):
        h = held.setdefault(op["row"], {})
        if h.get(tx) != "X":
            h[tx] = op["kind"]
        want.pop(tx, None)
        pos[tx] += 1
    else:
        want[tx] = op
    while True:
        edges = {w: blockers(w, r["kind"], r["row"]) for w, r in want.items()}
        ring = cyclic(edges)
        if not ring:
            break
        victim = max(ring, key=lambda t: rank[t])
        for h in held.values():
            h.pop(victim, None)
        want.pop(victim, None)
        result[victim] = "a%d" % turn
print(" ".join("%s %s" % (p["names"][i], result[i]) for i in range(n)))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/x-cycle': ['abort-oldest', 'abort-requester'],
	'senior/upgrade': ['upgrade-free', 'abort-oldest'],
	'senior/chain': ['abort-youngest-waiter', 'abort-oldest'],
	'senior/shared-no-cycle': ['shared-exclusive'],
	'middle/older-closes': ['abort-requester', 'abort-oldest'],
	'middle/younger-closes': ['abort-oldest', 'wait-aborts'],
	'middle/wait-only': ['wait-aborts'],
	'middle/relock': ['self-conflict']
};

/** Misconceptions that must give the right answer in a class: they pin which path the class takes. */
const SAME: Record<string, string[]> = {
	'middle/younger-closes': ['abort-requester']
};

/** How many deadlocks the right run of a class has. */
const DEADLOCKS: Record<string, number> = {
	'senior/shared-no-cycle': 0,
	'middle/wait-only': 0,
	'middle/relock': 0
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 2000; tries += 1) {
		const middle = input.grade === 'middle';
		const p = middle ? middleScenario(rng, input.classId) : scenario(rng, input.classId);
		const right = simulate(p, RIGHT);
		const deadlocks = DEADLOCKS[`${input.grade}/${input.classId}`] ?? 1;
		if (right.active.length > 0 || right.deadlocks !== deadlocks || p.turns.length > (middle ? 14 : 20)) continue;
		const answer = answerOf(p, right);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, simulate(p, { ...RIGHT, ...change }));
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		if ((SAME[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] !== null)) continue;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
