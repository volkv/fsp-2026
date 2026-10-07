// Graded ranking metrics over a few search queries: NDCG@k with exponential and linear gain, the ideal DCG from the
// whole judged pool, MAP@k (Middle); ties in scores, a query without relevant documents, k beyond the list and ERR
// (Senior). The answer is the mean over queries.
import { farApart, floatAnswer, frameMarkdown, num, roundingRule, stdinJson } from '../../_lib/ds.ts';
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
const DIGITS = 3;
const MAX_GRADE = 3;
const BINARY_THRESHOLD = 2;

interface Doc {
	id: string;
	rel: number;
	score: number;
}
interface Query {
	text: string;
	/** In the order shown: ranked, or (ties) listed in an arbitrary order with scores. */
	docs: Doc[];
	/** Grades of judged documents of the query that the list does not contain. */
	extra: number[];
}
interface Scenario {
	queries: Query[];
	k: number;
	plot: string;
}

const PLOTS: readonly { plot: string; queries: readonly string[] }[] = [
	{
		plot: 'поиск по каталогу товаров',
		queries: ['кроссовки для бега', 'чайник стальной', 'рюкзак 30 л', 'наушники с шумоподавлением']
	},
	{ plot: 'поиск вакансий', queries: ['python разработчик', 'аналитик данных', 'ml инженер', 'тестировщик удалённо'] },
	{ plot: 'поиск по базе знаний', queries: ['сброс пароля', 'возврат платежа', 'лимиты api', 'настройка sso'] },
	{ plot: 'поиск статей', queries: ['градиентный бустинг', 'калибровка вероятностей', 'a/b тесты', 'дрейф данных'] }
];

type Gain = (rel: number) => number;
const expGain: Gain = (rel) => 2 ** rel - 1;
const linGain: Gain = (rel) => rel;
type Discount = (i: number) => number;
const logDiscount: Discount = (i) => 1 / Math.log2(i + 1);
const rankDiscount: Discount = (i) => 1 / i;

function dcg(rels: readonly number[], k: number, gain: Gain, discount: Discount): number {
	return rels.slice(0, k).reduce((t, rel, i) => t + gain(rel) * discount(i + 1), 0);
}

/** By score descending; ties by the shown order (only the misconception relies on it). */
const ranked = (q: Query): Doc[] =>
	q.docs
		.map((d, at) => ({ d, at }))
		.sort((a, b) => b.d.score - a.d.score || a.at - b.at)
		.map((x) => x.d);

function ndcg(q: Query, k: number, gain: Gain, discount: Discount, idealFromList = false, idealLength = k): number {
	const rels = ranked(q).map((d) => d.rel);
	const pool = [...rels, ...(idealFromList ? [] : q.extra)].sort((a, b) => b - a);
	return dcg(rels, k, gain, discount) / dcg(pool, idealLength, gain, discount);
}

/** Tie-aware DCG: a group of equal scores spreads its mean gain over the positions it occupies. */
function tieDcg(q: Query, k: number): number {
	const docs = ranked(q);
	let total = 0;
	let start = 0;
	while (start < docs.length) {
		let end = start;
		while (end + 1 < docs.length && docs[end + 1]?.score === docs[start]?.score) end += 1;
		const group = docs.slice(start, end + 1);
		const meanGain = group.reduce((t, d) => t + expGain(d.rel), 0) / group.length;
		for (let i = start; i <= end && i < k; i += 1) total += meanGain * logDiscount(i + 1);
		start = end + 1;
	}
	return total;
}

function ap(q: Query, k: number, byHits: boolean): number {
	const rels = ranked(q).map((d) => d.rel >= BINARY_THRESHOLD);
	const total = [...q.docs.map((d) => d.rel), ...q.extra].filter((r) => r >= BINARY_THRESHOLD).length;
	let hits = 0;
	let sum = 0;
	rels.slice(0, k).forEach((r, i) => {
		if (!r) return;
		hits += 1;
		sum += hits / (i + 1);
	});
	const denominator = byHits ? hits : Math.min(total, k);
	return denominator === 0 ? 0 : sum / denominator;
}

function err(q: Query, k: number, cascade: boolean): number {
	let stay = 1;
	let total = 0;
	ranked(q)
		.slice(0, k)
		.forEach((d, i) => {
			const r = expGain(d.rel) / 2 ** MAX_GRADE;
			total += (cascade ? stay : 1) * (r / (i + 1));
			stay *= 1 - r;
		});
	return total;
}

const mean = (xs: readonly number[]): number => xs.reduce((t, x) => t + x, 0) / xs.length;
const hasRelevant = (q: Query): boolean => q.docs.some((d) => d.rel > 0) || q.extra.length > 0;

function metric(classId: string, s: Scenario): number {
	const { queries: qs, k } = s;
	switch (classId) {
		case 'ndcg-exp':
		case 'ideal-pool':
		case 'k-beyond-list':
			return mean(qs.map((q) => ndcg(q, k, expGain, logDiscount)));
		case 'ndcg-linear':
			return mean(qs.map((q) => ndcg(q, k, linGain, logDiscount)));
		case 'map':
			return mean(qs.map((q) => ap(q, k, false)));
		case 'ndcg-ties':
			return mean(
				qs.map(
					(q) =>
						tieDcg(q, k) /
						dcg(
							[...q.docs.map((d) => d.rel), ...q.extra].sort((a, b) => b - a),
							k,
							expGain,
							logDiscount
						)
				)
			);
		case 'empty-query':
			return mean(qs.filter(hasRelevant).map((q) => ndcg(q, k, expGain, logDiscount)));
		case 'err':
			return mean(qs.map((q) => err(q, k, true)));
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const { queries: qs, k } = s;
	const each = (f: (q: Query) => number): number => mean(qs.map(f));
	const exp = ['ndcg-exp', 'ideal-pool'].includes(classId);
	return {
		'linear-gain': exp ? each((q) => ndcg(q, k, linGain, logDiscount)) : null,
		'exp-gain': classId === 'ndcg-linear' ? each((q) => ndcg(q, k, expGain, logDiscount)) : null,
		'discount-by-rank':
			classId === 'ndcg-exp' || classId === 'ndcg-linear'
				? each((q) => ndcg(q, k, classId === 'ndcg-exp' ? expGain : linGain, rankDiscount))
				: null,
		'ideal-from-retrieved':
			classId === 'ideal-pool' || classId === 'k-beyond-list'
				? each((q) => ndcg(q, k, expGain, logDiscount, true))
				: null,
		'ap-divide-by-hits': classId === 'map' ? each((q) => ap(q, k, true)) : null,
		'ties-by-shown-order':
			classId === 'ndcg-ties'
				? each(
						(q) =>
							dcg(
								ranked(q).map((d) => d.rel),
								k,
								expGain,
								logDiscount
							) /
							dcg(
								[...q.docs.map((d) => d.rel), ...q.extra].sort((a, b) => b - a),
								k,
								expGain,
								logDiscount
							)
					)
				: null,
		'empty-query-as-zero':
			classId === 'empty-query' ? each((q) => (hasRelevant(q) ? ndcg(q, k, expGain, logDiscount) : 0)) : null,
		'ideal-truncated':
			classId === 'k-beyond-list' ? each((q) => ndcg(q, k, expGain, logDiscount, false, q.docs.length)) : null,
		'err-no-cascade': classId === 'err' ? each((q) => err(q, k, false)) : null
	};
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const theme = rng.pick(PLOTS);
	const count = grade === 'senior' ? rng.int(3, 4) : 3;
	const texts = rng.sample(theme.queries, count);
	const k = classId === 'k-beyond-list' ? 10 : rng.int(4, 5);
	const queries = texts.map((text, qi): Query => {
		const length = rng.int(5, 7);
		const ids = rng.sample(
			Array.from({ length: 90 }, (_, i) => `d${i + 10}`),
			length
		);
		const empty = classId === 'empty-query' && qi === 0;
		const tieLevels = rng.sample([0.9, 0.8, 0.7, 0.6, 0.5, 0.4], 3);
		const docs = ids.map((id, i): Doc => ({
			id,
			rel: empty ? 0 : rng.pick([0, 0, 1, 1, 2, 3]),
			score: classId === 'ndcg-ties' ? (tieLevels[Math.min(2, Math.floor(i / 2))] ?? 0.5) : 0.99 - i * 0.07
		}));
		const extraCount = classId === 'ndcg-exp' || classId === 'ndcg-linear' || empty ? 0 : rng.int(1, 3);
		const extra = Array.from({ length: extraCount }, () => rng.int(1, 3));
		return { text, docs: classId === 'ndcg-ties' ? rng.shuffle(docs) : docs, extra };
	});
	return { queries, k, plot: theme.plot };
}

function question(classId: string, k: number): string {
	const ndcgRule = (gain: string): string =>
		`DCG@${k} = Σ по позициям i = 1…${k} выдачи значения ${gain} / log₂(i + 1); NDCG@${k} = DCG@${k} / IDCG@${k}, где IDCG@${k} — DCG@${k} идеального порядка всех оценённых документов запроса (из выдачи и вне её) по убыванию оценки.`;
	switch (classId) {
		case 'ndcg-exp':
		case 'ideal-pool':
			return `${ndcgRule('(2^rel − 1)')} Найдите среднее NDCG@${k} по запросам.`;
		case 'ndcg-linear':
			return `${ndcgRule('rel')} Найдите среднее NDCG@${k} по запросам.`;
		case 'map':
			return `Релевантным считается документ с оценкой не ниже ${BINARY_THRESHOLD}. AP@${k} запроса — сумма precision@i по позициям i ≤ ${k}, где стоит релевантный документ, делённая на min(R, ${k}), R — число релевантных документов запроса среди всех оценённых (из выдачи и вне её). Найдите MAP@${k} — среднее AP@${k} по запросам.`;
		case 'ndcg-ties':
			return `Выдача — документы по убыванию скора; у некоторых документов скоры равны. Чтобы не зависеть от случайного порядка внутри ничьей, каждый документ группы равных скоров получает среднюю выгоду (2^rel − 1) группы на каждой позиции, которую группа занимает. ${ndcgRule('выгода позиции')} Найдите среднее NDCG@${k} по запросам.`;
		case 'empty-query':
			return `${ndcgRule('(2^rel − 1)')} У запроса без единого релевантного документа (все оценки 0) NDCG не определён — такой запрос в среднее не входит. Найдите среднее NDCG@${k}.`;
		case 'k-beyond-list':
			return `${ndcgRule('(2^rel − 1)')} Выдача короче ${k}: недостающих позиций в DCG нет, а идеальный порядок берётся из всех оценённых документов. Найдите среднее NDCG@${k} по запросам.`;
		case 'err':
			return `Найдите ERR@${k} (expected reciprocal rank), среднее по запросам. Пользователь просматривает выдачу сверху вниз и на документе с оценкой rel останавливается с вероятностью R = (2^rel − 1) / 2^${MAX_GRADE}; ERR@${k} = Σ по позициям r = 1…${k} величины (1 / r) · R_r · Π по i < r (1 − R_i).`;
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function describe(s: Scenario, classId: string): string {
	const ties = classId === 'ndcg-ties';
	const cell = (d: Doc): string => (ties ? `${d.id} (скор ${num(d.score, 2)}): ${d.rel}` : `${d.id}: ${d.rel}`);
	return [
		`${s.plot[0]?.toUpperCase() ?? ''}${s.plot.slice(1)}: асессоры оценили документы по шкале 0–${MAX_GRADE} (rel). ${
			ties
				? 'Для каждого запроса документы выдачи перечислены в произвольном порядке со скором модели и оценкой.'
				: 'Для каждого запроса — выдача сверху вниз (документ: оценка).'
		} В последнем столбце — оценки документов запроса, которые асессоры оценили, но в выдачу они не попали.`,
		'',
		frameMarkdown(
			['запрос', 'выдача', 'оценены вне выдачи'],
			s.queries.map((q) => [q.text, q.docs.map(cell).join(', '), q.extra.length ? q.extra.join(', ') : '—'])
		),
		'',
		question(classId, s.k),
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json, math

d = json.loads(input())
kind, k = d["metric"], d["k"]

def disc(i):
    return 1 / math.log2(i + 1)

def gain(rel):
    return rel if kind == "ndcg-linear" else 2 ** rel - 1

def dcg(rels):
    return sum(gain(r) * disc(i + 1) for i, r in enumerate(rels[:k]))

vals = []
for q in d["queries"]:
    order = sorted(range(len(q["docs"])), key=lambda i: (-q["docs"][i][1], i))
    rels = [q["docs"][i][0] for i in order]
    scores = [q["docs"][i][1] for i in order]
    pool = sorted([x[0] for x in q["docs"]] + q["extra"], reverse=True)
    if kind == "map":
        rel_bin = [r >= 2 for r in rels]
        total = sum(1 for r in pool if r >= 2)
        hits, acc = 0, 0.0
        for i, r in enumerate(rel_bin[:k]):
            if r:
                hits += 1
                acc += hits / (i + 1)
        vals.append(acc / min(total, k))
    elif kind == "err":
        stay, acc = 1.0, 0.0
        for i, r in enumerate(rels[:k]):
            p = (2 ** r - 1) / 8
            acc += stay * p / (i + 1)
            stay *= 1 - p
        vals.append(acc)
    elif kind == "ndcg-ties":
        acc, i = 0.0, 0
        while i < len(rels):
            j = i
            while j + 1 < len(rels) and scores[j + 1] == scores[i]:
                j += 1
            g = sum(2 ** r - 1 for r in rels[i : j + 1]) / (j - i + 1)
            acc += sum(g * disc(p + 1) for p in range(i, min(j + 1, k)))
            i = j + 1
        vals.append(acc / dcg(pool))
    else:
        if dcg(pool) == 0:
            continue
        vals.append(dcg(rels) / dcg(pool))
print(repr(sum(vals) / len(vals)))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const empty = input.classId === 'empty-query';
		if (s.queries.some((q, i) => !(empty && i === 0) && !hasRelevant(q))) continue;
		if (
			input.classId === 'map' &&
			s.queries.some((q) => ![...q.docs.map((d) => d.rel), ...q.extra].some((r) => r >= BINARY_THRESHOLD))
		)
			continue;
		const answer = metric(input.classId, s);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		// The shown order of the queries is surface; the empty query is not always first.
		const queries = rng.shuffle(s.queries);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe({ ...s, queries }, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = {
			metric: input.classId,
			k: s.k,
			queries: queries.map((q) => ({
				docs: q.docs.map((d, i) => [d.rel, input.classId === 'ndcg-ties' ? d.score : 1 - i / 100]),
				extra: q.extra
			}))
		};
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(data) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
