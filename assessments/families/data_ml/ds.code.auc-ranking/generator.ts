// Practice: a ranking metric over scored objects by the metric the class sets — ROC AUC with ties, average precision
// over distinct thresholds, NDCG@k, the Kolmogorov–Smirnov statistic; Senior averages it over queries with a rule for
// degenerate ones. The volume rules out the quadratic way. The step «измени своё решение» adds weights of examples
// (AUC, AP, KS) or averages the gain over tied scores (NDCG).
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

const descriptor = readDescriptor(import.meta.url);
const CHANGE_WEIGHT = 0.3;
const EPS = 1e-5;

type Variant = 'right' | 'ties-ignored' | 'quadratic' | 'linear-gain' | 'idcg-from-topk' | 'skip-rule';
const WRONG_IDS = ['ties-ignored', 'quadratic', 'linear-gain', 'idcg-from-topk', 'skip-rule'] as const;

interface Item {
	q: string;
	y: number;
	s: number;
	w: number;
}
interface Input {
	k: number;
	items: Item[];
	/** The change step: weights for AUC, AP and KS; averaging over ties for NDCG. */
	changed: boolean;
}

/** Runs of equal score in an ordered list; with `ties-ignored` every item is a run of its own. */
function blocks(items: readonly Item[], variant: Variant): Item[][] {
	const out: Item[][] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (last && variant !== 'ties-ignored' && last[0]?.s === item.s) last.push(item);
		else out.push([item]);
	}
	return out;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const posWeight = (b: readonly Item[]): number => sum(b.filter((r) => r.y > 0).map((r) => r.w));
const negWeight = (b: readonly Item[]): number => sum(b.filter((r) => r.y === 0).map((r) => r.w));
const desc = (items: readonly Item[]): Item[] => [...items].sort((a, b) => b.s - a.s);

/** The metric of one query, or `null` when it is undefined there. */
function metric(classId: string, items: readonly Item[], k: number, changed: boolean, variant: Variant): number | null {
	const wp = posWeight(items);
	const wn = negWeight(items);
	if (classId === 'roc-auc') {
		if (wp === 0 || wn === 0) return null;
		let acc = 0;
		let below = 0;
		for (const b of blocks(
			[...items].sort((a, c) => a.s - c.s),
			variant
		)) {
			const bp = posWeight(b);
			const bn = negWeight(b);
			acc += bp * (below + (variant === 'ties-ignored' ? 0 : bn / 2));
			below += bn;
		}
		return acc / (wp * wn);
	}
	if (classId === 'average-precision' || classId === 'ks-statistic') {
		if (wp === 0 || (classId === 'ks-statistic' && wn === 0)) return null;
		let tp = 0;
		let fp = 0;
		let value = 0;
		for (const b of blocks(desc(items), variant)) {
			const bp = posWeight(b);
			tp += bp;
			fp += negWeight(b);
			value =
				classId === 'average-precision'
					? value + (bp / wp) * (tp / (tp + fp))
					: Math.max(value, Math.abs(tp / wp - fp / wn));
		}
		return value;
	}
	const gain = (rel: number): number => (variant === 'linear-gain' ? rel : 2 ** rel - 1);
	const disc = (i: number): number => 1 / Math.log2(i + 2);
	const order = variant === 'ties-ignored' ? [...items].sort((a, b) => b.s - a.s || b.y - a.y) : desc(items);
	const idealFrom = variant === 'idcg-from-topk' ? order.slice(0, k) : items;
	const ideal = idealFrom
		.map((r) => r.y)
		.sort((a, b) => b - a)
		.slice(0, k);
	const idcg = sum(ideal.map((rel, i) => gain(rel) * disc(i)));
	if (idcg === 0) return null;
	let dcg = 0;
	if (changed) {
		let at = 0;
		for (const b of blocks(order, 'right')) {
			const mean = sum(b.map((r) => gain(r.y))) / b.length;
			for (let i = at; i < Math.min(at + b.length, k); i += 1) dcg += mean * disc(i);
			at += b.length;
		}
	} else {
		dcg = sum(order.slice(0, k).map((r, i) => gain(r.y) * disc(i)));
	}
	return dcg / idcg;
}

function value(classId: string, input: Input, variant: Variant = 'right'): number {
	const byQuery = new Map<string, Item[]>();
	for (const item of input.items) {
		const list = byQuery.get(item.q);
		if (list) list.push(item);
		else byQuery.set(item.q, [item]);
	}
	const values: number[] = [];
	for (const items of byQuery.values()) {
		const v = metric(classId, items, input.k, input.changed, variant);
		if (v !== null) values.push(v);
		else if (variant === 'skip-rule') values.push(0);
	}
	return sum(values) / values.length;
}

const APPLIES: Record<string, readonly Variant[]> = {
	'roc-auc': ['ties-ignored', 'quadratic', 'skip-rule'],
	'average-precision': ['ties-ignored', 'quadratic', 'skip-rule'],
	'ndcg-at-k': ['ties-ignored', 'linear-gain', 'idcg-from-topk', 'skip-rule'],
	'ks-statistic': ['ties-ignored', 'skip-rule']
};

type GroupId = 'basic' | 'ties' | 'rare' | 'small' | 'scale';
const GROUP_IDS: readonly GroupId[] = ['basic', 'ties', 'rare', 'small', 'scale'];

const EXPOSES: Record<GroupId, readonly Variant[]> = {
	basic: ['linear-gain', 'idcg-from-topk', 'skip-rule'],
	ties: ['ties-ignored'],
	rare: [],
	small: [],
	scale: []
};

const QUERY_NAMES = ['q', 'r', 's', 'u', 'v'] as const;

function makeInput(rng: Rng, group: GroupId, classId: string, senior: boolean, changed: boolean): Input {
	const graded = classId === 'ndcg-at-k';
	const queries = senior && group !== 'scale' ? rng.int(3, 6) : 1;
	const perQuery =
		group === 'scale'
			? (changed ? rng.int(2500, 3500) : rng.int(19_000, 20_000)) / queries
			: group === 'small'
				? rng.int(2, 6)
				: rng.int(8, 24);
	const scoreMax = group === 'ties' ? 3 : group === 'scale' ? 1_000_000 : 60;
	const prefix = rng.pick(QUERY_NAMES);
	const items: Item[] = [];
	for (let qi = 0; qi < queries; qi += 1) {
		const q = senior ? `${prefix}${100 + qi * 10 + rng.int(0, 9)}` : '';
		const n = Math.max(2, Math.round(perQuery));
		const local: Item[] = [];
		for (let i = 0; i < n; i += 1) {
			const positive = rng.bool(group === 'rare' ? 0.08 : 0.4);
			const y = graded ? (positive ? rng.int(1, 3) : 0) : positive ? 1 : 0;
			// Positives tend to score higher: a model better than chance.
			const s = Math.min(
				scoreMax,
				Math.max(0, rng.int(0, scoreMax) + (positive ? rng.int(0, Math.ceil(scoreMax / 3)) : 0))
			);
			local.push({ q, y, s, w: changed && !graded ? rng.int(1, 5) : 1 });
		}
		// Every query is defined, except one degenerate query of Senior in the ordinary group.
		const degenerate = senior && group === 'basic' && qi === 0;
		const first = local[0];
		const second = local[1];
		if (first && second) {
			if (degenerate) for (const r of local) r.y = 0;
			else {
				first.y = graded ? rng.int(1, 3) : 1;
				second.y = 0;
			}
		}
		items.push(...local);
	}
	const k = graded ? (group === 'small' ? rng.int(1, 8) : rng.int(3, 10)) : 0;
	return { k, items: rng.shuffle(items), changed };
}

function render(input: Input, classId: string, senior: boolean): string {
	const graded = classId === 'ndcg-at-k';
	const weighted = input.changed && !graded;
	const head = graded ? `${input.items.length} ${input.k}` : `${input.items.length}`;
	const lines = input.items.map((r) => [...(senior ? [r.q] : []), r.y, r.s, ...(weighted ? [r.w] : [])].join(' '));
	return `${[head, ...lines].join('\n')}\n`;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4;

function groups(
	rng: Rng,
	classId: string,
	others: readonly string[],
	senior: boolean,
	changed: boolean
): HiddenTestGroup[] {
	const applies = APPLIES[classId] ?? [];
	return GROUP_IDS.map((id) => {
		const count = id === 'scale' ? 1 : 3;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 3000) throw new Error(`${descriptor.key}: no ${id} test for ${classId}`);
			const input = makeInput(rng, id, classId, senior, changed);
			const expected = value(classId, input);
			if (changed) {
				// The new condition changes the answer.
				const before = { ...input, changed: false, items: input.items.map((r) => ({ ...r, w: 1 })) };
				if (close(value(classId, before), expected)) continue;
			} else {
				// Classes with the same input tell each other apart on every test.
				const sameInput = others.filter((o) => (o === 'ndcg-at-k') === (classId === 'ndcg-at-k'));
				if (sameInput.some((o) => close(value(o, input), expected))) continue;
				const exposes = EXPOSES[id].filter((v) => applies.includes(v) && (v !== 'skip-rule' || senior));
				if (exposes.some((v) => close(value(classId, input, v), expected))) continue;
			}
			tests.push({ stdin: render(input, classId, senior), expected: `${expected.toFixed(6)}\n` });
		}
		return { id, tests };
	});
}

const TASK: Record<string, string> = {
	'roc-auc':
		'ROC AUC — доля пар «позитив, негатив», где скор позитива больше скора негатива; пара с равными скорами даёт ½.',
	'average-precision':
		'Average precision: пусть различные значения скора упорядочены по убыванию t₁ > t₂ > …; на пороге tᵢ позитивными предсказаны все объекты со скором ≥ tᵢ, Pᵢ и Rᵢ — precision и recall на этом пороге (R₀ = 0). AP = Σᵢ (Rᵢ − Rᵢ₋₁)·Pᵢ. Объекты с равным скором всегда попадают за порог вместе.',
	'ndcg-at-k':
		'NDCG@k: документы упорядочиваются по убыванию скора, при равных скорах — в порядке входа. DCG@k = Σ по первым k позициям i = 1, 2, … значений (2^rel − 1) / log₂(i + 1). Идеальный IDCG@k — DCG@k тех же документов, упорядоченных по убыванию rel (из **всех** документов, а не только из первых k выдачи). NDCG@k = DCG@k / IDCG@k; если документов меньше k, берутся все.',
	'ks-statistic':
		'Статистика Колмогорова — Смирнова: для каждого порога t из различных значений скора позитивными предсказаны объекты со скором ≥ t; TPR = TP / P — доля предсказанных позитивными среди всех P позитивов, FPR = FP / N — доля предсказанных позитивными среди всех N негативов (P и N — по всем объектам, по которым считается метрика). KS — наибольшее значение |TPR − FPR| по всем таким порогам.'
};

function statement(classId: string, senior: boolean): string {
	const graded = classId === 'ndcg-at-k';
	const skip: Record<string, string> = {
		'roc-auc': 'запросы, где нет позитивов или нет негативов,',
		'average-precision': 'запросы без позитивов',
		'ndcg-at-k': 'запросы, где у всех документов rel = 0,',
		'ks-statistic': 'запросы, где нет позитивов или нет негативов,'
	};
	return [
		'Модель выставила скоры объектам. Напишите программу, которая считает метрику качества ранжирования.',
		'',
		'## Вход',
		'',
		graded
			? 'В первой строке — `N k`: число документов (1 ≤ N ≤ 2·10⁴) и глубина 1 ≤ k ≤ 100.'
			: 'В первой строке — `N`: число объектов (2 ≤ N ≤ 2·10⁴).',
		senior
			? graded
				? 'Далее N строк `запрос rel скор`: идентификатор запроса (латинские буквы и цифры), целая релевантность 0 ≤ rel ≤ 3 и целый скор 0 ≤ скор ≤ 10⁶.'
				: 'Далее N строк `запрос y скор`: идентификатор запроса (латинские буквы и цифры), метка y (1 — позитив, 0 — негатив) и целый скор 0 ≤ скор ≤ 10⁶.'
			: graded
				? 'Далее N строк `rel скор`: целая релевантность документа 0 ≤ rel ≤ 3 и целый скор 0 ≤ скор ≤ 10⁶; хотя бы у одного документа rel > 0.'
				: 'Далее N строк `y скор`: метка (1 — позитив, 0 — негатив) и целый скор 0 ≤ скор ≤ 10⁶; есть и позитивы, и негативы.',
		'',
		'## Что вывести',
		'',
		TASK[classId] ?? '',
		senior
			? `Метрика считается отдельно внутри каждого запроса, ответ — её среднее без весов по запросам; ${skip[classId] ?? ''} в среднее не входят (хотя бы один запрос всегда входит).`
			: '',
		'',
		'Выведите одно число с 6 знаками после запятой (например, `0.734127`); допускается погрешность 10⁻⁵. Ограничение времени — 2 с: квадратичный по N алгоритм не уложится.',
		'',
		'Скрытые тесты — пять групп: обычные данные, много равных скоров, редкие позитивы, совсем маленькие входы, большой объём. Группа засчитывается, если пройдены все её тесты.'
	]
		.filter((line, i, all) => line !== '' || all[i - 1] !== '')
		.join('\n');
}

function changeStatement(classId: string, senior: boolean): string {
	if (classId === 'ndcg-at-k')
		return [
			'**Новое условие.** Порядок входа больше не разрешает ничьи. Документы с равным скором образуют блок, занимающий подряд идущие позиции выдачи; каждый документ блока получает **средний выигрыш блока** (среднее 2^rel − 1 по всем документам блока). DCG@k — сумма по позициям 1…k среднего выигрыша блока, занимающего позицию, делённого на log₂(i + 1); блок, пересекающий границу k, учитывается только своими позициями до k. IDCG@k не меняется. Формат входа и вывода прежний. Измените решение и отправьте его снова.'
		].join('\n');
	return [
		`**Новое условие.** У каждой строки появился целый вес 1 ≤ w ≤ 100: строки входа теперь \`${senior ? 'запрос ' : ''}y скор w\`. Метрика считается по весам: ${
			classId === 'roc-auc'
				? 'пара «позитив i, негатив j» входит с весом wᵢ·wⱼ, AUC — взвешенная доля выигранных пар (ничья — ½)'
				: classId === 'average-precision'
					? 'число позитивов и негативов заменяется суммой их весов в precision, recall и в приращениях recall'
					: 'TPR — сумма весов позитивов, предсказанных позитивными, делённая на сумму весов всех позитивов; FPR — то же для негативов'
		}. Формат вывода прежний. Измените решение и отправьте его снова.`
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, senior: boolean, changed: boolean, variant: Variant): string {
	const graded = classId === 'ndcg-at-k';
	const weighted = changed && !graded;
	const fields = 2 + (senior ? 1 : 0) + (weighted ? 1 : 0);
	const q = senior ? 'data[pos]' : "''";
	const off = senior ? 1 : 0;
	const read = [
		'data = sys.stdin.read().split()',
		'n = int(data[0])',
		...(graded ? ['k = int(data[1])', 'pos = 2'] : ['pos = 1']),
		'queries = {}',
		'for _ in range(n):',
		`    queries.setdefault(${q}, []).append((int(data[pos + ${off}]), float(data[pos + ${off + 1}]), ${weighted ? `int(data[pos + ${off + 2}])` : '1'}))`,
		`    pos += ${fields}`
	];
	const blocks = [
		'def blocks(items):',
		'    out = []',
		'    for r in items:',
		variant === 'ties-ignored' ? '        out.append([r])' : '        if out and out[-1][0][1] == r[1]:',
		...(variant === 'ties-ignored'
			? []
			: ['            out[-1].append(r)', '        else:', '            out.append([r])']),
		'    return out'
	];
	const weights = ['    wp = sum(w for y, s, w in items if y)', '    wn = sum(w for y, s, w in items if not y)'];
	const body: Record<string, string[]> = {
		'roc-auc':
			variant === 'quadratic'
				? [
						'def metric(items):',
						...weights,
						'    if wp == 0 or wn == 0:',
						'        return None',
						'    acc = 0',
						'    for y1, s1, w1 in items:',
						'        if y1:',
						'            for y2, s2, w2 in items:',
						'                if not y2:',
						'                    acc += w1 * w2 * (1 if s1 > s2 else 0.5 if s1 == s2 else 0)',
						'    return acc / (wp * wn)'
					]
				: [
						...blocks,
						'',
						'',
						'def metric(items):',
						...weights,
						'    if wp == 0 or wn == 0:',
						'        return None',
						'    acc = below = 0',
						'    for b in blocks(sorted(items, key=lambda r: r[1])):',
						'        bp = sum(w for y, s, w in b if y)',
						'        bn = sum(w for y, s, w in b if not y)',
						variant === 'ties-ignored' ? '        acc += bp * below' : '        acc += bp * (below + bn / 2)',
						'        below += bn',
						'    return acc / (wp * wn)'
					],
		'average-precision':
			variant === 'quadratic'
				? [
						'def metric(items):',
						...weights,
						'    if wp == 0:',
						'        return None',
						'    ap = 0.0',
						'    for t in sorted(set(s for y, s, w in items), reverse=True):',
						'        tp = sum(w for y, s, w in items if y and s >= t)',
						'        fp = sum(w for y, s, w in items if not y and s >= t)',
						'        bp = sum(w for y, s, w in items if y and s == t)',
						'        ap += bp / wp * tp / (tp + fp)',
						'    return ap'
					]
				: [
						...blocks,
						'',
						'',
						'def metric(items):',
						...weights,
						'    if wp == 0:',
						'        return None',
						'    tp = fp = 0',
						'    ap = 0.0',
						'    for b in blocks(sorted(items, key=lambda r: -r[1])):',
						'        bp = sum(w for y, s, w in b if y)',
						'        tp += bp',
						'        fp += sum(w for y, s, w in b if not y)',
						'        ap += bp / wp * tp / (tp + fp)',
						'    return ap'
					],
		'ks-statistic': [
			...blocks,
			'',
			'',
			'def metric(items):',
			...weights,
			'    if wp == 0 or wn == 0:',
			'        return None',
			'    tp = fp = 0',
			'    best = 0.0',
			'    for b in blocks(sorted(items, key=lambda r: -r[1])):',
			'        tp += sum(w for y, s, w in b if y)',
			'        fp += sum(w for y, s, w in b if not y)',
			'        best = max(best, abs(tp / wp - fp / wn))',
			'    return best'
		],
		'ndcg-at-k': [
			...(changed ? [...blocks, '', ''] : []),
			'def gain(rel):',
			variant === 'linear-gain' ? '    return rel' : '    return 2 ** rel - 1',
			'',
			'',
			'def metric(items):',
			variant === 'ties-ignored'
				? '    order = sorted(items, key=lambda r: (-r[1], -r[0]))'
				: '    order = sorted(items, key=lambda r: -r[1])',
			variant === 'idcg-from-topk'
				? '    ideal = sorted((r[0] for r in order[:k]), reverse=True)[:k]'
				: '    ideal = sorted((r[0] for r in items), reverse=True)[:k]',
			'    idcg = sum(gain(rel) / log2(i + 2) for i, rel in enumerate(ideal))',
			'    if idcg == 0:',
			'        return None',
			...(changed
				? [
						'    dcg = 0.0',
						'    at = 0',
						'    for b in blocks(order):',
						'        mean = sum(gain(r[0]) for r in b) / len(b)',
						'        dcg += mean * sum(1 / log2(i + 2) for i in range(at, min(at + len(b), k)))',
						'        at += len(b)'
					]
				: ['    dcg = sum(gain(r[0]) / log2(i + 2) for i, r in enumerate(order[:k]))']),
			'    return dcg / idcg'
		]
	};
	return [
		'import sys',
		...(graded ? ['from math import log2'] : []),
		'',
		'',
		...(body[classId] ?? []),
		'',
		'',
		...read,
		'values = [metric(items) for items in queries.values()]',
		variant === 'skip-rule'
			? 'values = [0.0 if v is None else v for v in values]'
			: 'values = [v for v in values if v is not None]',
		"print(f'{sum(values) / len(values):.6f}')"
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
	const applies = (APPLIES[classId] ?? []).filter((v) => v !== 'skip-rule' || senior);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(classId, senior), code: null },
		answer: null,
		practice: { languages: ['python3'], groups: main, checker: { kind: 'float_eps', eps: EPS } },
		changeStep: {
			markdown: changeStatement(classId, senior),
			weight: CHANGE_WEIGHT,
			answer: null,
			groups: step,
			qa: null
		}
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
