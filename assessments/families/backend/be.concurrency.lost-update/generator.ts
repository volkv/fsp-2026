// Lost updates under an explicit schedule: threads read shared values, compute and write them back step by step in a
// given order of turns, with and without a lock; a level up, compare-and-set loops and a lock-free stack where
// compare-and-set by value misses an A→B→A change and a tagged head does not.
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

const THREADS = ['T1', 'T2', 'T3'] as const;

// Middle: read and write steps with an optional lock.

type Step =
	| { op: 'read'; v: string }
	| { op: 'write'; v: string; d: number }
	/** `if r_v >= k: v = r_v - k` — a reservation that succeeds when the copy shows enough. */
	| { op: 'reserve'; v: string; k: number }
	| { op: 'lock' }
	| { op: 'unlock' };

interface MiddleParams {
	initial: Record<string, number>;
	programs: Step[][];
	turns: number[];
}

interface MiddleRules {
	atomic: boolean;
	lock: 'right' | 'ignore' | 'guards-data';
	checkAtWrite: boolean;
}

const MIDDLE_RIGHT: MiddleRules = { atomic: false, lock: 'right', checkAtWrite: false };

interface MiddleOutcome {
	values: Record<string, number>;
	/** Reservations that succeeded. */
	reserved: number;
	active: number[];
}

function runMiddle(p: MiddleParams, rules: MiddleRules): MiddleOutcome {
	const values = { ...p.initial };
	let reserved = 0;
	if (rules.atomic) {
		for (const program of p.programs) {
			for (const s of program) {
				if (s.op === 'write') values[s.v] = (values[s.v] ?? 0) + s.d;
				if (s.op === 'reserve' && (values[s.v] ?? 0) >= s.k) {
					values[s.v] = (values[s.v] ?? 0) - s.k;
					reserved += 1;
				}
			}
		}
		return { values, reserved, active: [] };
	}
	const pc = p.programs.map(() => 0);
	const locals = p.programs.map(() => new Map<string, number>());
	let holder: number | null = null;
	for (const t of p.turns) {
		const step = p.programs[t]?.[pc[t] ?? 0];
		if (!step) continue;
		const advance = (): void => {
			pc[t] = (pc[t] ?? 0) + 1;
		};
		if (step.op === 'lock') {
			if (rules.lock === 'ignore') advance();
			else if (holder === null) {
				holder = t;
				advance();
			}
			continue;
		}
		if (step.op === 'unlock') {
			if (holder === t) holder = null;
			advance();
			continue;
		}
		if (rules.lock === 'guards-data' && holder !== null && holder !== t) continue;
		if (step.op === 'read') locals[t]?.set(step.v, values[step.v] ?? 0);
		else if (step.op === 'write') values[step.v] = (locals[t]?.get(step.v) ?? 0) + step.d;
		else {
			const seen = rules.checkAtWrite ? (values[step.v] ?? 0) : (locals[t]?.get(step.v) ?? 0);
			if (seen >= step.k) {
				values[step.v] = seen - step.k;
				reserved += 1;
			}
		}
		advance();
	}
	return { values, reserved, active: activeThreads(p.programs, pc) };
}

/** Threads that still have steps to make. */
const activeThreads = (programs: readonly (readonly unknown[])[], pc: readonly number[]): number[] =>
	programs.flatMap((program, t) => ((pc[t] ?? 0) < program.length ? [t] : []));

const COUNTERS = ['views', 'likes', 'stock', 'seats', 'hits', 'credits'] as const;

function increments(v: string, d: number, locked: boolean): Step[] {
	const body: Step[] = [
		{ op: 'read', v },
		{ op: 'write', v, d }
	];
	return locked ? [{ op: 'lock' }, ...body, { op: 'unlock' }] : body;
}

function middleScenario(rng: Rng, classId: string): MiddleParams {
	const delta = (): number => rng.pick([-1, 1]) * rng.int(1, 9) * rng.pick([1, 10]);
	let initial: Record<string, number>;
	let programs: Step[][];
	if (classId === 'transfer') {
		const [a, b] = rng.sample(['acc_a', 'acc_b', 'wallet', 'reserve', 'main', 'bonus'], 2) as [string, string];
		initial = { [a]: rng.int(20, 90) * 10, [b]: rng.int(20, 90) * 10 };
		const transfer = (from: string, to: string, k: number): Step[] => [
			{ op: 'read', v: from },
			{ op: 'read', v: to },
			{ op: 'write', v: from, d: -k },
			{ op: 'write', v: to, d: k }
		];
		programs = [transfer(a, b, rng.int(1, 30) * 10), transfer(b, a, rng.int(1, 30) * 10)];
		if (rng.bool()) programs.push(increments(rng.pick([a, b]), rng.int(1, 20) * 10, false));
	} else if (classId === 'check-then-act') {
		const v = rng.pick(['stock', 'seats', 'slots', 'tickets']);
		initial = { [v]: rng.int(10, 45) };
		programs = Array.from({ length: 3 }, () =>
			Array.from({ length: rng.int(1, 2) }, (): Step[] => [
				{ op: 'read', v },
				{ op: 'reserve', v, k: rng.int(3, 16) }
			]).flat()
		);
	} else {
		const vars = rng.sample(COUNTERS, classId === 'no-lock' ? rng.int(1, 2) : 1);
		initial = Object.fromEntries(vars.map((v) => [v, rng.int(10, 500)]));
		const threads = rng.int(2, 3);
		programs = Array.from({ length: classId === 'partial-lock' ? 3 : threads }, (_, t) => {
			const locked = classId === 'partial-lock' && t < 2;
			const count = rng.int(1, 2);
			return Array.from({ length: count }, () => increments(rng.pick(vars), delta(), locked)).flat();
		});
	}
	const turns = randomTurns(rng, (ts) => runMiddle({ initial, programs, turns: ts }, MIDDLE_RIGHT).active);
	return { initial, programs, turns };
}

/** A random order of turns among the threads with work left, grown until no thread has any. */
function randomTurns(rng: Rng, active: (turns: number[]) => number[]): number[] {
	const turns: number[] = [];
	for (let guard = 0; guard < 40; guard += 1) {
		const left = active(turns);
		if (left.length === 0) break;
		turns.push(rng.pick(left));
	}
	return turns;
}

function describeStep(s: Step): string {
	switch (s.op) {
		case 'read':
			return `\`r_${s.v} = ${s.v}\``;
		case 'write':
			return `\`${s.v} = r_${s.v} ${s.d < 0 ? '-' : '+'} ${Math.abs(s.d)}\``;
		case 'reserve':
			return `\`if r_${s.v} >= ${s.k}: ${s.v} = r_${s.v} - ${s.k}\``;
		case 'lock':
			return '`lock(m)`';
		case 'unlock':
			return '`unlock(m)`';
	}
}

function describeMiddle(p: MiddleParams): string {
	const vars = Object.keys(p.initial);
	return [
		`Общие переменные: ${vars.map((v) => `\`${v} = ${p.initial[v]}\``).join(', ')}. Потоки выполняют свои шаги по порядку; каждый шаг неделим и занимает один ход:`,
		'',
		...p.programs.map((program, t) => `- **${THREADS[t]}**: ${program.map(describeStep).join(' → ')}`),
		'',
		'`r_x = x` — поток читает переменную в свою локальную копию; `x = r_x + d` — записывает значение, посчитанное по своей копии. `lock(m)` — взять блокировку `m`: если её держит другой поток, ход потрачен на ожидание, и на следующем своём ходу поток пытается снова. `unlock(m)` — отпустить блокировку. Ход потока, у которого шаги кончились, пропускается.',
		'',
		`Порядок ходов: ${p.turns.map((t) => THREADS[t]).join(', ')}.`,
		'',
		...(p.programs.some((program) => program.some((s) => s.op === 'reserve'))
			? [
					'`if r_x >= k: x = r_x - k` — один неделимый шаг брони: условие проверяется по локальной копии; если оно выполнено, бронь удалась и поток записывает значение, иначе бронь не удалась и ничего не записано.',
					''
				]
			: []),
		p.programs.some((program) => program.some((s) => s.op === 'reserve'))
			? `Введите через пробел итоговое значение \`${vars[0] ?? ''}\` и число удавшихся броней. Например: \`4 2\`.`
			: vars.length === 1
				? `Введите итоговое значение \`${vars[0] ?? ''}\`. Например: \`100\`.`
				: `Введите через пробел итоговые значения ${vars.map((v) => `\`${v}\``).join(', ')}. Например: \`${vars.map((_, i) => 100 + i * 7).join(' ')}\`.`
	].join('\n');
}

const MIDDLE_REFERENCE = `import json

p = json.loads(input())
mem = dict(p["initial"])
pos = [0] * len(p["programs"])
copies = [{} for _ in p["programs"]]
owner = None
booked = 0
for t in p["turns"]:
    prog = p["programs"][t]
    if pos[t] == len(prog):
        continue
    s = prog[pos[t]]
    if s["op"] == "lock":
        if owner is not None:
            continue
        owner = t
    elif s["op"] == "unlock":
        owner = None
    elif s["op"] == "read":
        copies[t][s["v"]] = mem[s["v"]]
    elif s["op"] == "write":
        mem[s["v"]] = copies[t][s["v"]] + s["d"]
    else:
        if copies[t][s["v"]] >= s["k"]:
            mem[s["v"]] = copies[t][s["v"]] - s["k"]
            booked += 1
    pos[t] += 1
out = [mem[v] for v in p["initial"]]
if any(s["op"] == "reserve" for prog in p["programs"] for s in prog):
    out.append(booked)
print(*out)
`;

// Senior: compare-and-set.

interface CounterParams {
	kind: 'counter';
	initial: number;
	/** Per thread: how many increments and by how much. */
	adds: { times: number; d: number }[];
	turns: number[];
}

type StackOp = { op: 'pop' } | { op: 'push'; node: string; reuse: number | null };

interface StackParams {
	kind: 'stack';
	tagged: boolean;
	nodes: string[];
	programs: StackOp[][];
	turns: number[];
}

/** Transfers between two accounts, each a debit and a credit by compare-and-set; an auditor sums snapshots. */
interface TransferParams {
	kind: 'transfer';
	a: number;
	b: number;
	programs: TransferStep[][];
	turns: number[];
}

type TransferStep = { op: 'move'; v: 'a' | 'b'; d: number } | { op: 'snap' };

type SeniorParams = CounterParams | StackParams | TransferParams;

interface CasRules {
	cas: 'right' | 'write' | 'no-retry';
	tagged: boolean | null;
	/** Each transfer and each snapshot happens at once. */
	atomic?: boolean;
}

interface CasOutcome {
	answer: string;
	active: number[];
	/** A push of a node the thread never got: the scenario is broken for this model. */
	broken: boolean;
}

function runCounter(p: CounterParams, rules: CasRules): CasOutcome {
	let x = p.initial;
	const done = p.adds.map(() => 0);
	const failures = p.adds.map(() => 0);
	const read: (number | null)[] = p.adds.map(() => null);
	for (const t of p.turns) {
		const add = p.adds[t];
		if (!add || (done[t] ?? 0) >= add.times) continue;
		const v = read[t];
		if (v === null || v === undefined) {
			read[t] = x;
			continue;
		}
		read[t] = null;
		if (x === v || rules.cas === 'write') {
			x = v + add.d;
			done[t] = (done[t] ?? 0) + 1;
		} else {
			failures[t] = (failures[t] ?? 0) + 1;
			if (rules.cas === 'no-retry') done[t] = (done[t] ?? 0) + 1;
		}
	}
	return {
		answer: [x, ...failures].join(' '),
		active: p.adds.flatMap((a, t) => ((done[t] ?? 0) < a.times ? [t] : [])),
		broken: false
	};
}

function runStack(p: StackParams, rules: CasRules): CasOutcome {
	const tagged = rules.tagged ?? p.tagged;
	const next = new Map<string, string | null>();
	p.nodes.forEach((n, i) => next.set(n, p.nodes[i + 1] ?? null));
	let head: string | null = p.nodes[0] ?? null;
	let tag = 0;
	const pc = p.programs.map(() => 0);
	const popped: string[][] = p.programs.map(() => []);
	const reads: ({ head: string | null; tag: number; next: string | null } | null)[] = p.programs.map(() => null);
	let broken = false;
	for (const t of p.turns) {
		const op = p.programs[t]?.[pc[t] ?? 0];
		if (!op) continue;
		const r = reads[t];
		const advance = (): void => {
			pc[t] = (pc[t] ?? 0) + 1;
		};
		const node = op.op === 'push' ? (op.reuse === null ? op.node : (popped[t]?.[op.reuse] ?? null)) : null;
		if (op.op === 'push' && (node === null || node === 'empty' || node === '-')) {
			broken = true;
			advance();
			continue;
		}
		if (!r) {
			if (op.op === 'pop' && head === null) {
				popped[t]?.push('empty');
				advance();
				continue;
			}
			if (op.op === 'push' && node !== null) next.set(node, head);
			reads[t] = { head, tag, next: head === null ? null : (next.get(head) ?? null) };
			continue;
		}
		reads[t] = null;
		const matches = head === r.head && (!tagged || tag === r.tag);
		if (matches || rules.cas === 'write') {
			head = op.op === 'pop' ? r.next : node;
			tag += 1;
			if (op.op === 'pop') popped[t]?.push(r.head ?? 'empty');
			advance();
		} else if (rules.cas === 'no-retry') {
			if (op.op === 'pop') popped[t]?.push('-');
			advance();
		}
	}
	const stack: string[] = [];
	for (let n = head, guard = 0; n !== null && guard < 12; n = next.get(n) ?? null, guard += 1) stack.push(n);
	const results = popped.map((list) => (list.length ? list.join(' ') : '-'));
	return {
		answer: [stack.length ? stack.join(' ') : 'empty', ...results.flatMap((r) => ['|', r])].join(' '),
		active: activeThreads(p.programs, pc),
		broken
	};
}

function runTransfer(p: TransferParams, rules: CasRules): CasOutcome {
	const money = { a: p.a, b: p.b };
	const sums: number[] = [];
	if (rules.atomic) {
		for (const program of p.programs)
			for (const s of program) {
				if (s.op === 'move') money[s.v] += s.d;
				else sums.push(p.a + p.b);
			}
		return { answer: [money.a, money.b, '|', ...sums].join(' '), active: [], broken: false };
	}
	const pc = p.programs.map(() => 0);
	const seen: (number | null)[] = p.programs.map(() => null);
	for (const t of p.turns) {
		const step = p.programs[t]?.[pc[t] ?? 0];
		if (!step) continue;
		const advance = (): void => {
			pc[t] = (pc[t] ?? 0) + 1;
		};
		const v = seen[t];
		if (step.op === 'snap') {
			if (v === null || v === undefined) seen[t] = money.a;
			else {
				sums.push(v + money.b);
				seen[t] = null;
				advance();
			}
			continue;
		}
		if (v === null || v === undefined) {
			seen[t] = money[step.v];
			continue;
		}
		seen[t] = null;
		if (money[step.v] === v || rules.cas === 'write') {
			money[step.v] = v + step.d;
			advance();
		} else if (rules.cas === 'no-retry') advance();
	}
	return {
		answer: [money.a, money.b, '|', ...sums].join(' '),
		active: activeThreads(p.programs, pc),
		broken: false
	};
}

const runSenior = (p: SeniorParams, rules: CasRules): CasOutcome =>
	p.kind === 'counter' ? runCounter(p, rules) : p.kind === 'stack' ? runStack(p, rules) : runTransfer(p, rules);

const SENIOR_RIGHT: CasRules = { cas: 'right', tagged: null };

function seniorScenario(rng: Rng, classId: string): SeniorParams {
	if (classId === 'split-transfer') {
		const k1 = rng.int(1, 30) * 10;
		const k2 = rng.int(1, 30) * 10;
		const programs: TransferStep[][] = [
			[
				{ op: 'move', v: 'a', d: -k1 },
				{ op: 'move', v: 'b', d: k1 }
			],
			rng.bool()
				? [
						{ op: 'move', v: 'b', d: -k2 },
						{ op: 'move', v: 'a', d: k2 }
					]
				: [{ op: 'move', v: 'a', d: k2 }],
			[{ op: 'snap' }, { op: 'snap' }]
		];
		const p: TransferParams = {
			kind: 'transfer',
			a: rng.int(30, 90) * 10,
			b: rng.int(30, 90) * 10,
			programs,
			turns: []
		};
		p.turns = randomTurns(rng, (ts) => runTransfer({ ...p, turns: ts }, SENIOR_RIGHT).active);
		return p;
	}
	if (classId === 'cas-counter') {
		const threads = rng.int(2, 3);
		const adds = Array.from({ length: threads }, () => ({
			times: rng.int(1, 2),
			d: rng.int(1, 9) * rng.pick([1, 5, 10])
		}));
		const p: CounterParams = { kind: 'counter', initial: rng.int(0, 300), adds, turns: [] };
		p.turns = randomTurns(rng, (ts) => runCounter({ ...p, turns: ts }, SENIOR_RIGHT).active);
		return p;
	}
	// The stack: T1 pops once; T2 pops twice and pushes back the first node it popped; T3, if any, pushes a new node
	// or pops. T1 reads the head first and is overtaken by T2 before its compare-and-set.
	const letters = rng.sample(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'K', 'M', 'N', 'P'], 6);
	const nodes = letters.slice(0, rng.int(3, 5));
	const spare = letters[5] ?? 'Z';
	const programs: StackOp[][] = [
		[{ op: 'pop' }, ...(rng.bool(0.4) ? [{ op: 'pop' } as StackOp] : [])],
		[{ op: 'pop' }, { op: 'pop' }, { op: 'push', node: '', reuse: 0 }]
	];
	if (rng.bool(0.6)) programs.push([rng.bool() ? { op: 'push', node: spare, reuse: null } : { op: 'pop' }]);
	const p: StackParams = {
		kind: 'stack',
		tagged: classId === 'tagged-stack',
		nodes,
		programs,
		turns: [0, 1, 1, 1, 1, 1, 1, 0]
	};
	// Other threads' turns are sprinkled in, and the rest is a random order.
	const third = programs.length === 3;
	if (third) p.turns.splice(rng.int(0, p.turns.length), 0, 2);
	if (third && rng.bool()) p.turns.splice(rng.int(0, p.turns.length), 0, 2);
	const tail = randomTurns(rng, (ts) => runStack({ ...p, turns: [...p.turns, ...ts] }, SENIOR_RIGHT).active);
	p.turns.push(...tail);
	return p;
}

function describeTransfer(p: TransferParams): string {
	const describeThread = (program: TransferStep[]): string => {
		if (program.every((s) => s.op === 'snap')) return `аудитор: ${program.length} снимка подряд`;
		const moves = program.filter((s): s is Extract<TransferStep, { op: 'move' }> => s.op === 'move');
		const [debit, credit] = moves;
		if (debit && credit)
			return `перевод ${credit.d} со счёта \`${debit.v}\` на \`${credit.v}\`: списание, затем зачисление`;
		return debit ? `зачисление ${debit.d} на \`${debit.v}\`` : '';
	};
	return [
		`Счета \`a = ${p.a}\`, \`b = ${p.b}\`. \`CAS(x, expected, new)\` неделимо сравнивает счёт с \`expected\`: если равны — записывает \`new\`, иначе ничего не меняет и сообщает о неудаче.`,
		'',
		'- Списание или зачисление d на счёт x: ход 1 — `v = x`; ход 2 — `CAS(x, v, v + d)` (для списания d отрицательно); при неудаче поток делает эту операцию заново со следующего хода. Перевод — списание, а после его успеха зачисление.',
		'- Снимок аудитора: ход 1 — `s = a`; ход 2 — сумма `s + b` записывается в отчёт.',
		'- Ход потока, закончившего свои операции, пропускается.',
		'',
		...p.programs.map((program, t) => `- **${THREADS[t]}**: ${describeThread(program)}.`),
		'',
		`Порядок ходов: ${p.turns.map((t) => THREADS[t]).join(', ')}.`,
		'',
		'Введите через пробел итоговые `a` и `b`, затем знак `|` и суммы из снимков аудитора по порядку. Например: `500 700 | 1200 1150`.'
	].join('\n');
}

function describeSenior(p: SeniorParams): string {
	if (p.kind === 'transfer') return describeTransfer(p);
	if (p.kind === 'counter') {
		return [
			`Общий счётчик \`x = ${p.initial}\`. \`CAS(x, expected, new)\` неделимо сравнивает \`x\` с \`expected\`: если равны — записывает \`new\` и сообщает об успехе, иначе ничего не меняет и сообщает о неудаче.`,
			'',
			'Каждое прибавление поток делает так: ход 1 — `v = x`; ход 2 — `CAS(x, v, v + d)`; если CAS неудачен, поток начинает это прибавление заново (снова `v = x` следующим ходом). Ход потока, закончившего все прибавления, пропускается.',
			'',
			...p.adds.map(
				(a, t) =>
					`- **${THREADS[t]}**: ${a.times === 1 ? 'одно прибавление' : `${a.times} прибавления подряд`}, d = ${a.d}.`
			),
			'',
			`Порядок ходов: ${p.turns.map((t) => THREADS[t]).join(', ')}.`,
			'',
			`Введите через пробел итоговое \`x\`, затем число неудачных CAS у ${p.adds.map((_, t) => THREADS[t]).join(', ')}. Например: \`${p.initial + 1} 0 2${p.adds.length === 3 ? ' 1' : ''}\`.`
		].join('\n');
	}
	const describeOp = (op: StackOp): string =>
		op.op === 'pop'
			? '`pop`'
			: op.reuse === null
				? `\`push\` нового узла ${op.node}`
				: `\`push\` узла, который вернул его ${op.reuse + 1}-й \`pop\``;
	const head = p.tagged
		? 'Вершина хранится вместе с меткой версии: `(head, tag)`; каждый успешный CAS записывает новую вершину и `tag + 1`. `CAS` сравнивает и вершину, и метку.'
		: '`CAS(head, expected, new)` сравнивает только узел-вершину: если `head` — тот же узел, что `expected`, записывает `new`.';
	return [
		`Стек без блокировок — односвязный список узлов, \`head\` указывает на вершину. Сейчас в стеке сверху вниз: ${p.nodes.join(' → ')}.`,
		'',
		head,
		'',
		'- `pop`: ход 1 — прочитать `h = head` (и метку) и `n = h.next`; если стек пуст, `pop` сразу возвращает `empty`. Ход 2 — `CAS`: при успехе `head = n`, и `pop` возвращает `h`; при неудаче — заново с хода 1.',
		'- `push(x)`: ход 1 — прочитать `h = head` (и метку) и записать `x.next = h`. Ход 2 — `CAS`: при успехе `head = x`; при неудаче — заново с хода 1.',
		'',
		'Узлы не копируются: снятый узел остаётся тем же объектом со своим полем `next`, и его можно положить обратно. Операции потока идут по порядку, ход потока, закончившего свои операции, пропускается.',
		'',
		...p.programs.map((program, t) => `- **${THREADS[t]}**: ${program.map(describeOp).join(', затем ')}.`),
		'',
		`Порядок ходов: ${p.turns.map((t) => THREADS[t]).join(', ')}.`,
		'',
		`Введите через пробел содержимое стека после всех ходов сверху вниз (пустой — \`empty\`), обходя \`next\` от \`head\`; затем для каждого потока по порядку — знак \`|\` и узлы, которые вернули его \`pop\` (если \`pop\` у потока нет — \`-\`). Например: \`${p.nodes.slice(0, 2).join(' ')} | ${p.nodes[2] ?? 'empty'} ${p.programs
			.slice(1)
			.map(() => '| -')
			.join(' ')}\`.`
	].join('\n');
}

const SENIOR_REFERENCE = `import json

p = json.loads(input())

if p["kind"] == "transfer":
    acc = {"a": p["a"], "b": p["b"]}
    done = [0] * len(p["programs"])
    held = [None] * len(p["programs"])
    report = []
    for t in p["turns"]:
        prog = p["programs"][t]
        if done[t] == len(prog):
            continue
        s = prog[done[t]]
        if s["op"] == "snap":
            if held[t] is None:
                held[t] = acc["a"]
            else:
                report.append(held[t] + acc["b"])
                held[t] = None
                done[t] += 1
            continue
        if held[t] is None:
            held[t] = acc[s["v"]]
            continue
        v, held[t] = held[t], None
        if acc[s["v"]] == v:
            acc[s["v"]] = v + s["d"]
            done[t] += 1
    print(acc["a"], acc["b"], "|", *report)
elif p["kind"] == "counter":
    x = p["initial"]
    left = [a["times"] for a in p["adds"]]
    fails = [0] * len(left)
    seen = [None] * len(left)
    for t in p["turns"]:
        if left[t] == 0:
            continue
        if seen[t] is None:
            seen[t] = x
            continue
        v, seen[t] = seen[t], None
        if x == v:
            x = v + p["adds"][t]["d"]
            left[t] -= 1
        else:
            fails[t] += 1
    print(x, *fails)
else:
    class Node:
        def __init__(self, name):
            self.name = name
            self.next = None

    objs = [Node(n) for n in p["nodes"]]
    for a, b in zip(objs, objs[1:]):
        a.next = b
    top = objs[0]
    version = 0
    progs = p["programs"]
    pos = [0] * len(progs)
    got = [[] for _ in progs]
    pending = [None] * len(progs)
    for t in p["turns"]:
        if pos[t] == len(progs[t]):
            continue
        op = progs[t][pos[t]]
        if op["op"] == "push":
            mine = Node(op["node"]) if op["reuse"] is None else got[t][op["reuse"]]
        if pending[t] is None:
            if op["op"] == "pop" and top is None:
                got[t].append(None)
                pos[t] += 1
                continue
            if op["op"] == "push":
                mine.next = top
                pending[t] = (top, version, mine)
            else:
                pending[t] = (top, version, top.next)
            continue
        h, seen_version, new = pending[t]
        pending[t] = None
        if top is h and (not p["tagged"] or version == seen_version):
            top = new
            version += 1
            if op["op"] == "pop":
                got[t].append(h)
            pos[t] += 1
    out = []
    node = top
    while node is not None and len(out) < 12:
        out.append(node.name)
        node = node.next
    line = [" ".join(out) if out else "empty"]
    for g in got:
        line.append("|")
        line.append(" ".join("empty" if n is None else n.name for n in g) if g else "-")
    print(" ".join(line))
`;

const MIDDLE_WRONG: Record<string, Partial<MiddleRules>> = {
	atomic: { atomic: true },
	'ignore-lock': { lock: 'ignore' },
	'lock-guards-data': { lock: 'guards-data' },
	'check-at-write': { checkAtWrite: true }
};

function seniorWrong(id: string, p: SeniorParams): CasRules | null {
	switch (id) {
		case 'cas-as-write':
			return { cas: 'write', tagged: null };
		case 'cas-no-retry':
			return { cas: 'no-retry', tagged: null };
		case 'aba-detected':
			return p.kind === 'stack' && !p.tagged ? { cas: 'right', tagged: true } : null;
		case 'value-only-cas':
			return p.kind === 'stack' && p.tagged ? { cas: 'right', tagged: false } : null;
		case 'atomic':
			return p.kind === 'transfer' ? { cas: 'right', tagged: null, atomic: true } : null;
		default:
			return null;
	}
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/no-lock': ['atomic'],
	'middle/partial-lock': ['atomic', 'ignore-lock', 'lock-guards-data'],
	'middle/transfer': ['atomic'],
	'senior/cas-counter': ['cas-as-write', 'cas-no-retry'],
	'senior/aba-stack': ['aba-detected'],
	'senior/tagged-stack': ['value-only-cas'],
	'middle/check-then-act': ['check-at-write', 'atomic'],
	'senior/split-transfer': ['atomic']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		let answer: string;
		let wrong: Record<string, string | null>;
		let markdown: string;
		let source: string;
		let stdin: string;
		if (input.grade === 'middle') {
			const p = middleScenario(rng, input.classId);
			const right = runMiddle(p, MIDDLE_RIGHT);
			if (right.active.length > 0 || p.turns.length > 16) continue;
			const vars = Object.keys(p.initial);
			const reserving = p.programs.some((program) => program.some((s) => s.op === 'reserve'));
			const show = (o: MiddleOutcome): string =>
				[...vars.map((v) => o.values[v]), ...(reserving ? [o.reserved] : [])].join(' ');
			answer = show(right);
			wrong = Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const change = MIDDLE_WRONG[id];
					const value = change === undefined ? answer : show(runMiddle(p, { ...MIDDLE_RIGHT, ...change }));
					return [id, value === answer ? null : value];
				})
			);
			markdown = describeMiddle(p);
			source = MIDDLE_REFERENCE;
			stdin = JSON.stringify(p);
		} else {
			const p = seniorScenario(rng, input.classId);
			const right = runSenior(p, SENIOR_RIGHT);
			if (right.active.length > 0 || right.broken || p.turns.length > 20) continue;
			answer = right.answer;
			wrong = Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const rules = seniorWrong(id, p);
					const value = rules === null ? answer : runSenior(p, rules).answer;
					return [id, value === answer ? null : value];
				})
			);
			markdown = describeSenior(p);
			source = SENIOR_REFERENCE;
			stdin = JSON.stringify(p);
		}
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown, code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin }),
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
