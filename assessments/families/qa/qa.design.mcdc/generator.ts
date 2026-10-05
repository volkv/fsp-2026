// MC/DC (unique-cause) of a decision written as a Boolean expression: the pairs of tests that show a condition's
// independent effect, the smallest subset of a test set that gives MC/DC, the gaps of a set and the smallest set of
// truth-table rows that completes it — at the senior level with domain constraints that make some combinations of
// conditions impossible.
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

type Node =
	{ kind: 'leaf'; index: number; neg: boolean } | { kind: 'op'; op: 'and' | 'or'; kids: Node[]; neg: boolean };

interface Constraint {
	kind: 'excl' | 'impl';
	a: number;
	b: number;
}

interface Params {
	decision: string;
	names: string[];
	expr: string;
	/** Row values by condition: bit i is condition i (in the order of the expression). */
	decisions: boolean[];
	constraints: Constraint[];
	/** The test set of the statement, numbered from 1; empty for the class that looks at the whole table. */
	tests: number[];
	/** The condition whose pairs are asked, for the pair classes. */
	target: number | null;
}

interface Rules {
	/** A pair needs the decision to change. */
	decisionChanges: boolean;
	/** A pair may differ only in the condition. */
	othersFixed: boolean;
	/** Impossible combinations are excluded. */
	constraints: boolean;
}

const RIGHT: Rules = { decisionChanges: true, othersFixed: true, constraints: true };

const DOMAINS: { decision: string; names: string[] }[] = [
	{
		decision: 'approve',
		names: ['is_adult', 'has_income', 'has_debt', 'is_client', 'has_guarantor', 'is_blacklisted']
	},
	{ decision: 'can_deliver', names: ['in_zone', 'is_weekend', 'has_courier', 'is_heavy', 'is_paid', 'is_express'] },
	{ decision: 'grant', names: ['is_admin', 'is_owner', 'is_locked', 'has_2fa', 'from_vpn', 'is_suspended'] },
	{ decision: 'discount', names: ['is_member', 'has_coupon', 'on_sale', 'first_order', 'over_limit', 'is_employee'] },
	{ decision: 'confirm', names: ['has_seats', 'is_vip', 'refundable', 'in_window', 'on_waitlist', 'is_group'] },
	{ decision: 'publish', names: ['is_draft', 'has_review', 'is_editor', 'has_media', 'is_embargoed', 'is_urgent'] },
	{ decision: 'notify', names: ['opted_in', 'is_quiet_hours', 'is_critical', 'has_email', 'has_push', 'is_muted'] }
];

function buildTree(rng: Rng, lo: number, hi: number): Node {
	if (hi - lo === 1) return { kind: 'leaf', index: lo, neg: rng.bool(0.25) };
	const split = rng.int(lo + 1, hi - 1);
	const op = rng.pick(['and', 'or'] as const);
	const kids: Node[] = [];
	for (const kid of [buildTree(rng, lo, split), buildTree(rng, split, hi)]) {
		if (kid.kind === 'op' && kid.op === op && !kid.neg) kids.push(...kid.kids);
		else kids.push(kid);
	}
	return { kind: 'op', op, kids, neg: rng.bool(0.15) };
}

function render(node: Node, names: readonly string[]): string {
	if (node.kind === 'leaf') return `${node.neg ? 'not ' : ''}${names[node.index] ?? ''}`;
	const body = node.kids
		.map((kid) => (kid.kind === 'op' && !kid.neg ? `(${render(kid, names)})` : render(kid, names)))
		.join(` ${node.op} `);
	return node.neg ? `not (${body})` : body;
}

function evaluate(node: Node, row: number): boolean {
	const value =
		node.kind === 'leaf'
			? ((row >> node.index) & 1) === 1
			: node.op === 'and'
				? node.kids.every((kid) => evaluate(kid, row))
				: node.kids.some((kid) => evaluate(kid, row));
	return node.neg ? !value : value;
}

function bit(row: number, i: number): boolean {
	return ((row >> i) & 1) === 1;
}

function feasible(row: number, constraints: readonly Constraint[]): boolean {
	return constraints.every((c) =>
		c.kind === 'excl' ? !(bit(row, c.a) && bit(row, c.b)) : !bit(row, c.a) || bit(row, c.b)
	);
}

function isPair(p: Params, r1: number, r2: number, i: number, rules: Rules): boolean {
	if (bit(r1, i) === bit(r2, i)) return false;
	if (rules.othersFixed && (r1 ^ r2) !== 1 << i) return false;
	if (rules.decisionChanges && p.decisions[r1] === p.decisions[r2]) return false;
	return true;
}

/** Rows a rule set may use. */
function usable(p: Params, rows: readonly number[], rules: Rules): number[] {
	return rows.filter((row) => !rules.constraints || feasible(row, p.constraints));
}

/** For every two rows of the table, the mask of the conditions whose independence the pair shows. */
function pairMasks(p: Params, rules: Rules): Uint8Array {
	const key = `${rules.decisionChanges}|${rules.othersFixed}|${rules.constraints}`;
	const cached = MASKS.get(p)?.get(key);
	if (cached) return cached;
	const size = 2 ** p.names.length;
	const masks = new Uint8Array(size * size);
	for (let a = 0; a < size; a += 1) {
		if (rules.constraints && !feasible(a, p.constraints)) continue;
		for (let b = 0; b < size; b += 1) {
			if (a === b || (rules.constraints && !feasible(b, p.constraints))) continue;
			let mask = 0;
			for (let i = 0; i < p.names.length; i += 1) if (isPair(p, a, b, i, rules)) mask |= 1 << i;
			masks[a * size + b] = mask;
		}
	}
	const byRules = MASKS.get(p) ?? new Map<string, Uint8Array>();
	byRules.set(key, masks);
	MASKS.set(p, byRules);
	return masks;
}

const MASKS = new WeakMap<Params, Map<string, Uint8Array>>();

/** Pairs of positions (indexes into `rows`) for condition i. */
function pairsOf(p: Params, rows: readonly number[], i: number, rules: Rules): [number, number][] {
	const masks = pairMasks(p, rules);
	const size = 2 ** p.names.length;
	const pairs: [number, number][] = [];
	for (let a = 0; a < rows.length; a += 1) {
		for (let b = a + 1; b < rows.length; b += 1) {
			if (((masks[(rows[a] ?? 0) * size + (rows[b] ?? 0)] ?? 0) >> i) & 1) pairs.push([a, b]);
		}
	}
	return pairs;
}

function coverMask(masks: Uint8Array, size: number, rows: readonly number[]): number {
	let mask = 0;
	for (let a = 0; a < rows.length; a += 1)
		for (let b = a + 1; b < rows.length; b += 1) mask |= masks[(rows[a] ?? 0) * size + (rows[b] ?? 0)] ?? 0;
	return mask;
}

function covered(p: Params, rows: readonly number[], rules: Rules): boolean[] {
	const mask = coverMask(pairMasks(p, rules), 2 ** p.names.length, rows);
	return p.names.map((_, i) => ((mask >> i) & 1) === 1);
}

/**
 * The smallest subsets of `candidates` that, added to `base`, give a pair for every condition of `need` (a mask): at
 * most two of them, at the smallest size, in lexicographic order of positions (indexes into `candidates`).
 */
function smallest(
	p: Params,
	base: readonly number[],
	candidates: readonly number[],
	need: number,
	rules: Rules,
	limit: number
): number[][] {
	const masks = pairMasks(p, rules);
	const size = 2 ** p.names.length;
	const start = coverMask(masks, size, base);
	for (let count = 0; count <= Math.min(limit, candidates.length); count += 1) {
		const found: number[][] = [];
		const pick: number[] = [];
		const walk = (from: number, mask: number): void => {
			if (found.length >= 2) return;
			if (pick.length === count) {
				if ((mask & need) === need) found.push([...pick]);
				return;
			}
			for (let k = from; k <= candidates.length - (count - pick.length); k += 1) {
				const row = candidates[k] ?? 0;
				let next = mask;
				for (const other of base) next |= masks[row * size + other] ?? 0;
				for (const q of pick) next |= masks[row * size + (candidates[q] ?? 0)] ?? 0;
				pick.push(k);
				walk(k + 1, next);
				pick.pop();
			}
		};
		walk(0, start);
		if (found.length > 0) return found;
	}
	return [];
}

/** The fewest rows of `rows` that give a pair for every condition of `need`: one pair per condition, united. */
function fewestRows(p: Params, rows: readonly number[], need: readonly number[], rules: Rules): number {
	const edges = need
		.map((i) => pairsOf(p, rows, i, rules).map(([a, b]) => [rows[a] ?? 0, rows[b] ?? 0] as const))
		.sort((x, y) => x.length - y.length);
	let best = Infinity;
	const walk = (k: number, chosen: Set<number>): void => {
		if (chosen.size >= best) return;
		if (k === edges.length) {
			best = chosen.size;
			return;
		}
		for (const [a, b] of edges[k] ?? []) {
			const added = [a, b].filter((r) => !chosen.has(r));
			for (const r of added) chosen.add(r);
			walk(k + 1, chosen);
			for (const r of added) chosen.delete(r);
		}
	};
	walk(0, new Set());
	return best;
}

const allRows = (n: number): number[] => Array.from({ length: 2 ** n }, (_, r) => r);

const bits = (p: Params, row: number): string => p.names.map((_, i) => (bit(row, i) ? '1' : '0')).join('');

/** Test numbers of test positions. */
const ids = (positions: readonly number[]): string[] => positions.map((k) => String(k + 1));

/** The lines of an answer, or the single line `-` for an empty one. */
const orDash = (lines: string[]): string[] => (lines.length ? lines : ['-']);

const key = (lines: readonly string[]): string => [...lines].sort().join(' ');

/**
 * The answer of a class under a rule set (null when the question has no answer under it) and whether the smallest set
 * the class asks for is the only one of its size.
 */
function solve(p: Params, classId: string, rules: Rules): { answer: string[] | null; unique: boolean } {
	const n = p.names.length;
	const every = (1 << n) - 1;
	switch (classId) {
		case 'min-subset':
		case 'feasible-min': {
			const rows = usable(p, p.tests, rules);
			const found = smallest(p, [], rows, every, rules, rows.length);
			const first = found[0];
			return {
				answer: first ? orDash(ids(first.map((k) => p.tests.indexOf(rows[k] ?? 0)))) : null,
				unique: found.length === 1
			};
		}
		case 'pairs':
		case 'feasible-pairs': {
			const pairs = pairsOf(p, p.tests, p.target ?? 0, rules);
			return { answer: orDash(pairs.map(([a, b]) => `${a + 1}-${b + 1}`)), unique: true };
		}
		case 'gaps': {
			const cov = covered(p, p.tests, rules);
			const missing = p.names.filter((_, i) => !cov[i]);
			const inPair = new Set<number>();
			for (let i = 0; i < n; i += 1) for (const [a, b] of pairsOf(p, p.tests, i, rules)) inPair.add(a).add(b);
			const useless = p.tests.map((_, k) => k).filter((k) => !inPair.has(k));
			return { answer: orDash([...missing, ...ids(useless)]), unique: true };
		}
		case 'complete':
		case 'feasible-complete': {
			const candidates = usable(
				p,
				allRows(n).filter((row) => !p.tests.includes(row)),
				rules
			);
			const found = smallest(p, p.tests, candidates, every, rules, 4);
			const first = found[0];
			if (!first) return { answer: null, unique: false };
			return {
				answer: orDash(first.map((k) => bits(p, candidates[k] ?? 0))),
				unique: found.length === 1
			};
		}
		case 'undemonstrable': {
			const rows = usable(p, allRows(n), rules);
			const cov = covered(p, rows, rules);
			const shown = p.names.map((_, i) => i).filter((i) => cov[i]);
			const missing = p.names.filter((_, i) => !cov[i]);
			return {
				answer: [...missing, String(fewestRows(p, rows, shown, rules))],
				unique: true
			};
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const domain = rng.pick(DOMAINS);
	const senior = grade === 'senior';
	const n = senior ? rng.int(4, 5) : classId === 'pairs' ? 4 : rng.int(3, 4);
	const names = rng.sample(domain.names, n);
	const tree = buildTree(rng, 0, n);
	const decisions = allRows(n).map((row) => evaluate(tree, row));
	const constraints: Constraint[] = [];
	if (senior) {
		const count = classId === 'undemonstrable' ? 2 : rng.int(1, 2);
		while (constraints.length < count) {
			const [a, b] = rng.sample(
				names.map((_, i) => i),
				2
			) as [number, number];
			if (constraints.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) continue;
			constraints.push({ kind: rng.pick(['excl', 'impl'] as const), a, b });
		}
	}
	const p: Params = {
		decision: domain.decision,
		names,
		expr: render(tree, names),
		decisions,
		constraints,
		tests: [],
		target: null
	};
	const feasibleRows = allRows(n).filter((row) => feasible(row, constraints));
	const infeasibleRows = allRows(n).filter((row) => !feasible(row, constraints));
	// Pairs are planted for the conditions the class needs shown, then rows are added at random.
	const rows = new Set<number>();
	const plant = (conditions: readonly number[]): void => {
		for (const i of conditions) {
			const pairs = pairsOf(p, feasibleRows, i, RIGHT);
			if (pairs.length === 0) continue;
			const [x, y] = rng.pick(pairs);
			rows.add(feasibleRows[x] ?? 0).add(feasibleRows[y] ?? 0);
		}
	};
	const pad = (count: number): void => {
		for (const row of rng.shuffle(feasibleRows)) {
			if (count <= 0) break;
			if (!rows.has(row)) {
				rows.add(row);
				count -= 1;
			}
		}
	};
	const every = names.map((_, i) => i);
	const some = (left: number): number[] => rng.sample(every, n - left);
	switch (classId) {
		case 'min-subset':
		case 'feasible-min':
			plant(every);
			pad(rng.int(1, 3));
			break;
		case 'pairs':
		case 'feasible-pairs':
			p.target = rng.int(0, n - 1);
			plant([p.target, p.target, p.target]);
			pad(rng.int(6, 8) - rows.size);
			break;
		case 'gaps':
			plant(some(rng.int(1, 2)));
			pad(rng.int(1, 3));
			break;
		case 'complete':
		case 'feasible-complete':
			plant(some(rng.int(1, 2)));
			pad(rng.int(0, 2));
			break;
		case 'undemonstrable':
			break;
	}
	if (classId === 'feasible-min' || classId === 'feasible-pairs') {
		// Impossible rows next to the set: under the misconception they would form pairs.
		const near = infeasibleRows.filter((row) => every.some((i) => rows.has(row ^ (1 << i))));
		for (const row of rng.sample(near, Math.min(near.length, rng.int(1, 3)))) rows.add(row);
	}
	p.tests = rng.shuffle([...rows]);
	return p;
}

/** Whether a drawn scenario poses the question of its class well. */
function suits(p: Params, classId: string, answer: readonly string[]): boolean {
	const cov = covered(p, p.tests, RIGHT);
	switch (classId) {
		case 'min-subset':
		case 'feasible-min':
			return cov.every(Boolean) && answer.length < usable(p, p.tests, RIGHT).length;
		case 'pairs':
		case 'feasible-pairs':
			return key(answer) !== '-';
		case 'gaps':
			return cov.some((c) => !c) && cov.some(Boolean);
		case 'complete':
		case 'feasible-complete': {
			const all = usable(p, allRows(p.names.length), RIGHT);
			return cov.some((c) => !c) && covered(p, all, RIGHT).every(Boolean);
		}
		case 'undemonstrable': {
			const missing = answer.filter((line) => p.names.includes(line));
			return missing.length > 0 && missing.length < p.names.length - 1;
		}
	}
	return false;
}

function constraintText(p: Params, c: Constraint): string {
	const a = `\`${p.names[c.a] ?? ''}\``;
	const b = `\`${p.names[c.b] ?? ''}\``;
	return c.kind === 'excl' ? `${a} и ${b} не бывают истинны одновременно;` : `если ${a} истинно, то и ${b} истинно;`;
}

function table(p: Params): string[] {
	const headers = ['тест', ...p.names];
	const widths = headers.map((h) => h.length + 2);
	const line = (cells: string[]): string =>
		cells
			.map((cell, k) => cell.padEnd(widths[k] ?? 0))
			.join('')
			.trimEnd();
	return [
		'```',
		line(headers),
		...p.tests.map((row, k) => line([String(k + 1), ...p.names.map((_, i) => (bit(row, i) ? '1' : '0'))])),
		'```'
	];
}

function describe(p: Params, classId: string): string {
	const intro = [
		`Решение \`${p.decision}\` вычисляется так (условия — логические значения, 1 — истинно, 0 — ложно):`,
		'',
		'```',
		`${p.decision} = ${p.expr}`,
		'```',
		'',
		'Тест — набор значений всех условий. Пара тестов показывает независимое влияние условия X (MC/DC в варианте unique-cause), если в этих двух тестах различается значение X, все остальные условия совпадают, а значение решения различается. Набор тестов даёт MC/DC, если для каждого условия в нём есть такая пара.'
	];
	if (p.constraints.length > 0) {
		intro.push(
			'',
			'Ограничения предметной области — сочетание, нарушающее любое из них, невозможно: такой тест нельзя выполнить, и в пары он не входит.',
			'',
			...p.constraints.map((c) => `- ${constraintText(p, c)}`)
		);
	}
	const body: string[] = [];
	const target = `\`${p.names[p.target ?? 0] ?? ''}\``;
	const tests = p.tests.length > 0 ? ['', 'Набор тестов:', '', ...table(p)] : [];
	switch (classId) {
		case 'min-subset':
		case 'feasible-min':
			body.push(
				...tests,
				'',
				`Из этого набора нужно оставить как можно меньше${p.constraints.length ? ' выполнимых' : ''} тестов так, чтобы оставшиеся давали MC/DC. Гарантируется, что такое наименьшее подмножество одно.`,
				'',
				'Введите номера тестов этого подмножества по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'2',
				'3',
				'5',
				'7',
				'```'
			);
			break;
		case 'pairs':
		case 'feasible-pairs':
			body.push(
				...tests,
				'',
				`Найдите в наборе все пары тестов, которые показывают независимое влияние условия ${target}.`,
				'',
				'Введите пары по одной в строке, в любом порядке, каждую в виде `меньший номер-больший номер`; если таких пар нет — одна строка `-`. Например:',
				'',
				'```',
				'1-4',
				'2-6',
				'3-6',
				'```'
			);
			break;
		case 'gaps':
			body.push(
				...tests,
				'',
				'Найдите условия, для которых в наборе нет пары независимости, и тесты, которые не входят ни в одну пару независимости ни одного условия.',
				'',
				'Введите имена условий без пары и номера тестов вне пар по одному в строке, в любом порядке; если нет ни тех, ни других — одна строка `-`. Например:',
				'',
				'```',
				'is_x',
				'is_y',
				'2',
				'5',
				'```'
			);
			break;
		case 'complete':
		case 'feasible-complete':
			body.push(
				...tests,
				'',
				`Набор нужно дополнить как можно меньшим числом новых тестов — ${p.constraints.length ? 'выполнимых ' : ''}строк таблицы истинности, которых в наборе нет, — так, чтобы весь набор давал MC/DC. Гарантируется, что такое наименьшее дополнение одно.`,
				'',
				`Введите новые тесты по одному в строке, в любом порядке; каждый тест — строка из 0 и 1, значения условий в порядке ${p.names.map((name) => `\`${name}\``).join(', ')}. Например:`,
				'',
				'```',
				// Rows of the given set: never part of the answer, so the example gives nothing away.
				...p.tests.slice(0, 2).map((row) => p.names.map((_, i) => (bit(row, i) ? '1' : '0')).join('')),
				'```'
			);
			break;
		case 'undemonstrable':
			body.push(
				'',
				'Тесты можно выбирать из всех выполнимых строк таблицы истинности. Для некоторых условий пару независимости из выполнимых тестов составить нельзя. Найдите такие условия и наименьшее число выполнимых тестов, которое показывает независимое влияние всех остальных условий.',
				'',
				'Введите по одному в строке, в любом порядке, имена условий, влияние которых показать нельзя, и отдельной строкой — наименьшее число тестов. Например:',
				'',
				'```',
				'is_x',
				'5',
				'```'
			);
			break;
	}
	return [...intro, ...body].join('\n');
}

const PYTHON_REFERENCE = `import json
from itertools import combinations, product

p = json.loads(input())
names = p["names"]
n = len(names)
cls = p["classId"]
table = [tuple(bool(v) for v in reversed(vals)) for vals in product([False, True], repeat=n)]
decision = {t: bool(eval(p["expr"], {}, dict(zip(names, t)))) for t in table}


def possible(values):
    for c in p["constraints"]:
        a, b = values[c["a"]], values[c["b"]]
        if c["kind"] == "excl" and a and b:
            return False
        if c["kind"] == "impl" and a and not b:
            return False
    return True


def shows(x, y, i):
    if not (possible(x) and possible(y)) or x[i] == y[i] or decision[x] == decision[y]:
        return False
    return all(x[j] == y[j] for j in range(n) if j != i)


mask = {(x, y): sum(1 << i for i in range(n) if shows(x, y, i)) for x in table for y in table}


def covered(rows):
    got = 0
    for x, y in combinations(rows, 2):
        got |= mask[(x, y)]
    return got


every = (1 << n) - 1
tests = [tuple(bool(r >> i & 1) for i in range(n)) for r in p["tests"]]
ok_table = [t for t in table if possible(t)]
out = None

if cls in ("min-subset", "feasible-min"):
    numbered = [(k + 1, t) for k, t in enumerate(tests) if possible(t)]
    for size in range(1, len(numbered) + 1):
        found = [c for c in combinations(numbered, size) if covered([t for _, t in c]) == every]
        if found:
            out = "\\n".join(str(k) for k, _ in found[0])
            break
elif cls in ("pairs", "feasible-pairs"):
    i = p["target"]
    pairs = []
    for a in range(len(tests)):
        for b in range(a + 1, len(tests)):
            if shows(tests[a], tests[b], i):
                pairs.append(f"{a + 1}-{b + 1}")
    out = "\\n".join(pairs) or "-"
elif cls == "gaps":
    got = covered(tests)
    missing = [names[i] for i in range(n) if not got >> i & 1]
    used = set()
    for a in range(len(tests)):
        for b in range(a + 1, len(tests)):
            if mask[(tests[a], tests[b])]:
                used.update([a + 1, b + 1])
    useless = [str(k) for k in range(1, len(tests) + 1) if k not in used]
    out = "\\n".join(missing + useless) or "-"
elif cls in ("complete", "feasible-complete"):
    extra = [t for t in ok_table if t not in tests]
    for size in range(0, 5):
        found = [c for c in combinations(extra, size) if covered(tests + list(c)) == every]
        if found:
            out = "\\n".join("".join("1" if v else "0" for v in t) for t in found[0]) or "-"
            break
elif cls == "undemonstrable":
    got = covered(ok_table)
    need = [i for i in range(n) if got >> i & 1]
    choices = [[(x, y) for x, y in combinations(ok_table, 2) if shows(x, y, i)] for i in need]
    fewest = min(len({t for pair in pick for t in pair}) for pick in product(*choices))
    out = "\\n".join([names[i] for i in range(n) if not got >> i & 1] + [str(fewest)])
print(out)
`;

const WRONG: Record<string, Partial<Rules> | 'greedy' | 'n-plus-one'> = {
	'decision-ignored': { decisionChanges: false },
	'others-may-change': { othersFixed: false },
	'greedy-pairs': 'greedy',
	'ignore-constraints': { constraints: false },
	'n-plus-one': 'n-plus-one'
};

/** The first pair of every condition, united: a cover, rarely the smallest. */
function greedy(p: Params, classId: string): string[] | null {
	if (classId !== 'min-subset' && classId !== 'feasible-min') return null;
	const rows = usable(p, p.tests, RIGHT);
	const chosen = new Set<number>();
	for (let i = 0; i < p.names.length; i += 1) {
		const first = pairsOf(p, rows, i, RIGHT)[0];
		if (!first) return null;
		chosen.add(p.tests.indexOf(rows[first[0]] ?? 0)).add(p.tests.indexOf(rows[first[1]] ?? 0));
	}
	return ids([...chosen]);
}

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'middle/min-subset': ['greedy-pairs', 'others-may-change'],
	'middle/pairs': ['decision-ignored', 'others-may-change'],
	'middle/gaps': ['decision-ignored', 'others-may-change'],
	'middle/complete': ['others-may-change'],
	'senior/feasible-min': ['ignore-constraints'],
	'senior/undemonstrable': ['ignore-constraints', 'n-plus-one'],
	'senior/feasible-pairs': ['ignore-constraints', 'decision-ignored'],
	'senior/feasible-complete': ['ignore-constraints']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Scenarios are drawn until the question is well posed, its answer unique and every misconception that applies to
	// the class changes the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, input.grade, classId);
		const right = solve(p, classId, RIGHT);
		const answer = right.answer;
		if (answer === null || !right.unique || !suits(p, classId, answer)) continue;
		const wrong: Record<string, string[] | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			let value: string[] | null;
			if (change === 'greedy') value = greedy(p, classId);
			else if (change === 'n-plus-one') {
				const missing = answer.filter((line) => p.names.includes(line));
				value = classId === 'undemonstrable' ? [...missing, String(p.names.length - missing.length + 1)] : null;
			} else if (change.constraints === false && p.constraints.length === 0) value = null;
			else value = solve(p, classId, { ...RIGHT, ...change }).answer;
			wrong[id] = value === null || key(value) === key(answer) ? null : value;
		}
		if ((REQUIRED[`${input.grade}/${classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'set', value: answer }
		});
		const stdin = JSON.stringify({
			classId,
			names: p.names,
			expr: p.expr,
			constraints: p.constraints,
			tests: p.tests,
			target: p.target
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
