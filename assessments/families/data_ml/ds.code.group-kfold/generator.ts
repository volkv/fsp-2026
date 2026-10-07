// Practice: split a dataset into K folds for cross-validation by the rule the class sets — whole groups balanced by
// size, stratification by label, contiguous blocks in time, whole groups in time order; Senior rows carry weights and
// folds are balanced by weight. The step «измени своё решение» holds some groups out before splitting.
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
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const CHANGE_WEIGHT = 0.3;

type Variant =
	'right' | 'split-groups' | 'tie-break' | 'counter-restart' | 'unsorted-time' | 'remainder-last' | 'row-balance';
const WRONG_IDS = [
	'split-groups',
	'tie-break',
	'counter-restart',
	'unsorted-time',
	'remainder-last',
	'row-balance'
] as const;

interface Row {
	id: number;
	group: string;
	label: number;
	t: number;
	w: number;
}
interface Input {
	k: number;
	rows: Row[];
	held: string[] | null;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const argmin = (xs: readonly number[]): number => xs.indexOf(Math.min(...xs));

/** The fold of every row in input order (−1 for a held-out row); a variant other than `right` is a wrong solution. */
function assign(classId: string, input: Input, senior: boolean, variant: Variant = 'right'): number[] {
	const { k, rows } = input;
	const held = new Set(input.held ?? []);
	const fold = rows.map(() => -1);
	const active = rows.map((_, i) => i).filter((i) => !held.has(rows[i]?.group ?? ''));
	const row = (i: number): Row => rows[i] as Row;
	const weight = (i: number): number => (senior && variant !== 'row-balance' ? row(i).w : 1);
	const key = (i: number): string => (variant === 'split-groups' ? String(row(i).id) : row(i).group);
	if (classId === 'group-kfold') {
		const size = new Map<string, number>();
		const first = new Map<string, number>();
		for (const i of active) {
			size.set(key(i), (size.get(key(i)) ?? 0) + weight(i));
			if (!first.has(key(i))) first.set(key(i), i);
		}
		const order = [...size.keys()].sort(
			(a, b) =>
				(size.get(b) ?? 0) - (size.get(a) ?? 0) ||
				(variant === 'tie-break' ? (first.get(a) ?? 0) - (first.get(b) ?? 0) : byName(a, b))
		);
		const load = Array.from({ length: k }, () => 0);
		const where = new Map<string, number>();
		for (const g of order) {
			const f = argmin(load);
			where.set(g, f);
			load[f] = (load[f] ?? 0) + (size.get(g) ?? 0);
		}
		for (const i of active) fold[i] = where.get(key(i)) ?? -1;
		return fold;
	}
	if (classId === 'stratified') {
		const labels = [...new Set(active.map((i) => row(i).label))].sort((a, b) => a - b);
		let c = 0;
		for (const label of labels) {
			const members = active.filter((i) => row(i).label === label);
			if (!senior) {
				if (variant === 'counter-restart') c = 0;
				for (const i of members) {
					fold[i] = c % k;
					c += 1;
				}
				continue;
			}
			members.sort((a, b) => row(b).w - row(a).w || (variant === 'tie-break' ? a - b : row(a).id - row(b).id));
			const load = Array.from({ length: k }, () => 0);
			for (const i of members) {
				const f = argmin(load);
				fold[i] = f;
				load[f] = (load[f] ?? 0) + weight(i);
			}
		}
		return fold;
	}
	const timeOrder = (xs: readonly number[]): number[] =>
		variant === 'unsorted-time'
			? [...xs]
			: [...xs].sort((a, b) => row(a).t - row(b).t || (variant === 'tie-break' ? a - b : row(a).id - row(b).id));
	if (classId === 'time-blocks') {
		const order = timeOrder(active);
		if (senior) {
			const total = order.reduce((s, i) => s + weight(i), 0);
			let before = 0;
			for (const i of order) {
				fold[i] = Math.min(k - 1, Math.floor((before * k) / total));
				before += weight(i);
			}
			return fold;
		}
		const base = Math.floor(order.length / k);
		const extra = order.length % k;
		let at = 0;
		for (let f = 0; f < k; f += 1) {
			const longer = variant === 'remainder-last' ? f >= k - extra : f < extra;
			const size = base + (longer ? 1 : 0);
			for (const i of order.slice(at, at + size)) fold[i] = f;
			at += size;
		}
		return fold;
	}
	const start = new Map<string, number>();
	const members = new Map<string, number[]>();
	for (const i of active) {
		const g = key(i);
		const at = variant === 'unsorted-time' ? i : row(i).t;
		start.set(g, Math.min(start.get(g) ?? at, at));
		const list = members.get(g);
		if (list) list.push(i);
		else members.set(g, [i]);
	}
	const order = [...members.keys()].sort(
		(a, b) => (start.get(a) ?? 0) - (start.get(b) ?? 0) || (variant === 'tie-break' ? 0 : byName(a, b))
	);
	const total = active.reduce((s, i) => s + weight(i), 0);
	let before = 0;
	for (const g of order) {
		const f = Math.min(k - 1, Math.floor((before * k) / total));
		for (const i of members.get(g) ?? []) {
			fold[i] = f;
			before += weight(i);
		}
	}
	return fold;
}

const solve = (classId: string, input: Input, senior: boolean, variant: Variant = 'right'): string =>
	assign(classId, input, senior, variant).join('\n');

const APPLIES: Record<string, Record<string, readonly Variant[]>> = {
	middle: {
		'group-kfold': ['split-groups', 'tie-break'],
		stratified: ['counter-restart'],
		'time-blocks': ['unsorted-time', 'remainder-last', 'tie-break'],
		'group-time': ['split-groups', 'unsorted-time', 'tie-break']
	},
	senior: {
		'group-kfold': ['split-groups', 'tie-break', 'row-balance'],
		stratified: ['tie-break', 'row-balance'],
		'time-blocks': ['unsorted-time', 'tie-break', 'row-balance'],
		'group-time': ['split-groups', 'unsorted-time', 'tie-break', 'row-balance']
	}
};

type GroupId = 'basic' | 'ties' | 'remainder' | 'skewed' | 'scale';
const GROUP_IDS: readonly GroupId[] = ['basic', 'ties', 'remainder', 'skewed', 'scale'];

const EXPOSES: Record<GroupId, readonly Variant[]> = {
	basic: ['split-groups', 'counter-restart', 'unsorted-time', 'row-balance'],
	ties: ['tie-break'],
	remainder: ['remainder-last'],
	skewed: [],
	scale: []
};

function makeInput(rng: Rng, group: GroupId): Input {
	const k = group === 'scale' ? 5 : rng.int(2, 5);
	const groupCount = group === 'scale' ? rng.int(300, 400) : rng.int(Math.max(3, k), 8);
	const pool: string[] = rng.sample(PERSON_NAMES, Math.min(groupCount, PERSON_NAMES.length));
	while (pool.length < groupCount) pool.push(`${rng.pick(PERSON_NAMES)}${pool.length}`);
	const labels = rng.int(2, 3);
	const sameSize = rng.int(1, 4);
	const rows: Row[] = [];
	for (const [gi, name] of pool.entries()) {
		const size =
			group === 'ties'
				? sameSize
				: group === 'skewed' && gi === 0
					? rng.int(8, 14)
					: group === 'scale'
						? rng.int(5, 12)
						: rng.int(1, 5);
		for (let j = 0; j < size; j += 1) {
			const rare = group === 'skewed' && rng.bool(0.85);
			rows.push({
				id: 0,
				group: name,
				label: rare ? 0 : rng.int(0, labels - 1),
				t: group === 'ties' ? rng.int(0, 4) : rng.int(0, group === 'scale' ? 10_000 : 60),
				w: group === 'ties' ? rng.int(1, 2) : rng.int(1, 6)
			});
		}
	}
	if (group === 'remainder' && rows.length % k === 0 && rows[0]) rows.push({ ...rows[0], t: rng.int(0, 60) });
	const ids = rng.sample(
		Array.from({ length: rows.length * 3 }, (_, i) => 100 + i),
		rows.length
	);
	const shuffled = rng.shuffle(rows).map((r, i) => ({ ...r, id: ids[i] ?? i }));
	return { k, rows: shuffled, held: null };
}

function render(input: Input, senior: boolean): string {
	const head = [input.rows.length, input.k, ...(input.held === null ? [] : [input.held.length])].join(' ');
	const lines = input.rows.map((r) => [r.id, r.group, r.label, r.t, ...(senior ? [r.w] : [])].join(' '));
	return `${[head, ...(input.held === null ? [] : [input.held.join(' ')]), ...lines].join('\n')}\n`;
}

function groups(
	rng: Rng,
	classId: string,
	others: readonly string[],
	senior: boolean,
	withHoldout: boolean
): HiddenTestGroup[] {
	const applies = APPLIES[senior ? 'senior' : 'middle']?.[classId] ?? [];
	return GROUP_IDS.map((id) => {
		const count = id === 'scale' ? 1 : 3;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 3000) throw new Error(`${descriptor.key}: no ${id} test for ${classId}`);
			const base = makeInput(rng, id);
			const input = withHoldout ? holdOut(rng, base) : base;
			if (!input) continue;
			const expected = solve(classId, input, senior);
			if (others.some((other) => solve(other, input, senior) === expected)) continue;
			if (withHoldout) {
				// The held-out rows must change the split of the others, not only be masked.
				const masked = assign(classId, { ...input, held: null }, senior).map((f, i) =>
					input.held?.includes(input.rows[i]?.group ?? '') ? -1 : f
				);
				if (masked.join('\n') === expected) continue;
			} else {
				const exposes = EXPOSES[id].filter((v) => applies.includes(v));
				if (exposes.some((v) => solve(classId, input, senior, v) === expected)) continue;
			}
			tests.push({ stdin: render(input, senior), expected: `${expected}\n` });
		}
		return { id, tests };
	});
}

/** One or two groups held out, leaving at least K rows and two groups. */
function holdOut(rng: Rng, input: Input): Input | null {
	const names = [...new Set(input.rows.map((r) => r.group))];
	const held = rng.sample(names, Math.min(rng.int(1, 2), names.length - 2));
	const left = input.rows.filter((r) => !held.includes(r.group)).length;
	if (held.length === 0 || left < input.k) return null;
	return { ...input, held };
}

const RULE: Record<string, (senior: boolean) => string> = {
	'group-kfold': (senior) =>
		`Строки одной группы попадают в один фолд. Размер группы — ${senior ? 'сумма весов её строк' : 'число её строк'}. Группы обрабатываются по убыванию размера, при равенстве — по имени группы (лексикографически, по возрастанию); каждая группа идёт в фолд с наименьшей текущей нагрузкой (${senior ? 'суммой весов' : 'числом строк'} уже назначенных групп), при равенстве — в фолд с меньшим номером.`,
	stratified: (senior) =>
		senior
			? 'Метки обрабатываются по возрастанию. Внутри метки строки упорядочиваются по убыванию веса, при равенстве — по возрастанию id; каждая строка идёт в фолд с наименьшей суммой весов **строк этой метки**, уже назначенных в фолд, при равенстве — в фолд с меньшим номером. Группы не учитываются.'
			: 'Метки обрабатываются по возрастанию; внутри метки строки идут в порядке входа. Один общий счётчик c, начиная с 0, проходит по всем строкам в этом порядке, не сбрасываясь при смене метки: строка получает фолд c mod K. Группы не учитываются.',
	'time-blocks': (senior) =>
		senior
			? 'Строки упорядочиваются по t, при равенстве — по id. Пусть W — сумма весов всех строк, S — сумма весов строк, стоящих в этом порядке раньше данной. Строка получает фолд min(K − 1, ⌊S·K / W⌋). Группы и метки не учитываются.'
			: 'Строки упорядочиваются по t, при равенстве — по id, и режутся на K подряд идущих блоков: при N = q·K + r первые r блоков содержат q + 1 строку, остальные — q строк. Блок номер f (с нуля) — фолд f. Группы и метки не учитываются.',
	'group-time': (senior) =>
		`Строки одной группы попадают в один фолд. Начало группы — наименьшее t её строк; группы упорядочиваются по началу, при равенстве — по имени (лексикографически). Пусть W — ${senior ? 'сумма весов' : 'число'} всех строк, S — ${senior ? 'сумма весов' : 'число'} строк групп, стоящих в этом порядке раньше данной. Группа получает фолд min(K − 1, ⌊S·K / W⌋).`
};

function statement(classId: string, senior: boolean): string {
	return [
		'Для кросс-валидации датасет делят на K фолдов. Напишите программу, которая детерминированно назначает каждой строке номер фолда (от 0 до K − 1).',
		'',
		'## Вход',
		'',
		'В первой строке — `N K`: число строк (1 ≤ N ≤ 5000) и число фолдов (2 ≤ K ≤ 10, K ≤ N).',
		senior
			? 'Далее N строк `id группа метка t w`: уникальный целый id, имя группы (латинские буквы и цифры), целая метка класса, целый момент времени t ≥ 0 и целый вес строки w ≥ 1.'
			: 'Далее N строк `id группа метка t`: уникальный целый id, имя группы (латинские буквы и цифры), целая метка класса и целый момент времени t ≥ 0.',
		'',
		'## Правило',
		'',
		RULE[classId]?.(senior) ?? '',
		'',
		'## Выход',
		'',
		'N строк: номер фолда каждой строки в порядке входа.',
		'',
		'Скрытые тесты — пять групп: обычные данные, равенства (одинаковые размеры, веса и моменты времени), N не делится на K, одна большая группа и редкая метка, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

function changeStatement(): string {
	return [
		'**Новое условие.** Часть групп отложена для финальной проверки модели. Вторая строка входа теперь — имена отложенных групп через пробел, а первая — `N K H`, где H ≥ 1 — их число.',
		'Строки отложенных групп получают фолд `-1` и в разбиении не участвуют: правило применяется к оставшимся строкам так, как будто отложенных строк во входе нет (все размеры, суммы, счётчики и блоки считаются только по оставшимся). Измените решение и отправьте его снова; формат вывода прежний.'
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, senior: boolean, withHoldout: boolean, variant: Variant): string {
	const fields = senior ? 5 : 4;
	const weight = senior && variant !== 'row-balance' ? 'rows[i][4]' : '1';
	const key = variant === 'split-groups' ? 'str(rows[i][0])' : 'rows[i][1]';
	const tie = variant === 'tie-break';
	const timeOrder =
		variant === 'unsorted-time'
			? 'order = list(active)'
			: tie
				? 'order = sorted(active, key=lambda i: rows[i][3])'
				: 'order = sorted(active, key=lambda i: (rows[i][3], rows[i][0]))';
	const body: Record<string, string[]> = {
		'group-kfold': [
			'size = {}',
			'first = {}',
			'for i in active:',
			`    size[${key}] = size.get(${key}, 0) + ${weight}`,
			`    first.setdefault(${key}, i)`,
			tie
				? 'order = sorted(size, key=lambda g: (-size[g], first[g]))'
				: 'order = sorted(size, key=lambda g: (-size[g], g))',
			'load = [0] * k',
			'where = {}',
			'for g in order:',
			'    f = load.index(min(load))',
			'    where[g] = f',
			'    load[f] += size[g]',
			'for i in active:',
			`    fold[i] = where[${key}]`
		],
		stratified: senior
			? [
					'for label in sorted(set(rows[i][2] for i in active)):',
					tie
						? '    members = sorted((i for i in active if rows[i][2] == label), key=lambda i: -rows[i][4])'
						: '    members = sorted((i for i in active if rows[i][2] == label), key=lambda i: (-rows[i][4], rows[i][0]))',
					'    load = [0] * k',
					'    for i in members:',
					'        f = load.index(min(load))',
					'        fold[i] = f',
					`        load[f] += ${weight}`
				]
			: [
					'c = 0',
					'for label in sorted(set(rows[i][2] for i in active)):',
					...(variant === 'counter-restart' ? ['    c = 0'] : []),
					'    for i in active:',
					'        if rows[i][2] == label:',
					'            fold[i] = c % k',
					'            c += 1'
				],
		'time-blocks': senior
			? [
					timeOrder,
					`total = sum(${weight} for i in order)`,
					'before = 0',
					'for i in order:',
					'    fold[i] = min(k - 1, before * k // total)',
					`    before += ${weight}`
				]
			: [
					timeOrder,
					'base, extra = divmod(len(order), k)',
					'at = 0',
					'for f in range(k):',
					variant === 'remainder-last'
						? '    size = base + (1 if f >= k - extra else 0)'
						: '    size = base + (1 if f < extra else 0)',
					'    for i in order[at:at + size]:',
					'        fold[i] = f',
					'    at += size'
				],
		'group-time': [
			'start = {}',
			'members = {}',
			'for i in active:',
			`    g = ${key}`,
			variant === 'unsorted-time'
				? '    start[g] = min(start.get(g, i), i)'
				: '    start[g] = min(start.get(g, rows[i][3]), rows[i][3])',
			'    members.setdefault(g, []).append(i)',
			tie ? 'order = sorted(members, key=lambda g: start[g])' : 'order = sorted(members, key=lambda g: (start[g], g))',
			`total = sum(${weight} for i in active)`,
			'before = 0',
			'for g in order:',
			'    f = min(k - 1, before * k // total)',
			'    for i in members[g]:',
			'        fold[i] = f',
			`        before += ${weight}`
		]
	};
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		'n, k = int(data[0]), int(data[1])',
		...(withHoldout ? ['h = int(data[2])', 'held = set(data[3:3 + h])', 'pos = 3 + h'] : ['held = set()', 'pos = 2']),
		'rows = []',
		'for _ in range(n):',
		`    rows.append((int(data[pos]), data[pos + 1], int(data[pos + 2]), int(data[pos + 3])${senior ? ', int(data[pos + 4])' : ''}))`,
		`    pos += ${fields}`,
		'fold = [-1] * n',
		'active = [i for i in range(n) if rows[i][1] not in held]',
		...(body[classId] ?? []),
		"print('\\n'.join(map(str, fold)))"
	].join('\n');
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const classId = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== classId);
	const main = groups(rng, classId, others, senior, false);
	const step = groups(rng, classId, others, senior, true);
	const applies = APPLIES[senior ? 'senior' : 'middle']?.[classId] ?? [];
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(classId, senior), code: null },
		answer: null,
		practice: { languages: ['python3'], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
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
					applies.includes(id)
						? { kind: 'program' as const, source: referenceSource(classId, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
