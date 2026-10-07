// ROC AUC and related metrics over scores with ties: AUC with ties, an inverted score, the area under given ROC points
// and Gini (Junior); average precision, AUC within groups, weighted AUC and AUC of a model that outputs labels only
// (Middle).
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
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 3;

/** Objects of one score: how many (or how much weight) are positive and negative. */
interface Row {
	score: number;
	pos: number;
	neg: number;
}
interface Scenario {
	rows: Row[];
	groups: { name: string; rows: Row[] }[];
	/** Individual objects with weights (the weighted class). */
	objects: { name: string; score: number; positive: boolean; weight: number }[];
	points: { fpr: number; tpr: number }[];
	threshold: number;
	plot: { positive: string; negative: string };
}

const PLOTS = [
	{ positive: 'ушёл', negative: 'остался' },
	{ positive: 'мошенничество', negative: 'норма' },
	{ positive: 'кликнул', negative: 'не кликнул' },
	{ positive: 'дефолт', negative: 'вернул кредит' }
] as const;

/**
 * Weighted share of correctly ordered (positive, negative) pairs; a tie counts `tie`. `inverted` — a lower score means
 * positive.
 */
function auc(rows: readonly Row[], tie = 0.5, inverted = false): number {
	let good = 0;
	let pos = 0;
	let neg = 0;
	for (const a of rows) {
		pos += a.pos;
		neg += a.neg;
		for (const b of rows) {
			const better = inverted ? a.score < b.score : a.score > b.score;
			if (better) good += a.pos * b.neg;
			else if (a.score === b.score) good += tie * a.pos * b.neg;
		}
	}
	return good / (pos * neg);
}

function prPoints(rows: readonly Row[]): { p: number; r: number }[] {
	const total = rows.reduce((s, x) => s + x.pos, 0);
	let tp = 0;
	let fp = 0;
	return [...rows]
		.sort((a, b) => b.score - a.score)
		.map((x) => {
			tp += x.pos;
			fp += x.neg;
			return { p: tp / (tp + fp), r: tp / total };
		});
}

function averagePrecision(rows: readonly Row[]): number {
	let prev = 0;
	let ap = 0;
	for (const { p, r } of prPoints(rows)) {
		ap += (r - prev) * p;
		prev = r;
	}
	return ap;
}

function rocArea(points: readonly { fpr: number; tpr: number }[], trapezoid: boolean): number {
	const sorted = [
		{ fpr: 0, tpr: 0 },
		...[...points].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr),
		{ fpr: 1, tpr: 1 }
	];
	let area = 0;
	for (let i = 1; i < sorted.length; i += 1) {
		const a = sorted[i - 1] ?? { fpr: 0, tpr: 0 };
		const b = sorted[i] ?? { fpr: 1, tpr: 1 };
		area += (b.fpr - a.fpr) * (trapezoid ? (a.tpr + b.tpr) / 2 : a.tpr);
	}
	return area;
}

const objectRows = (s: Scenario): Row[] =>
	s.objects.map((o) => ({ score: o.score, pos: o.positive ? o.weight : 0, neg: o.positive ? 0 : o.weight }));
const hardRows = (s: Scenario): Row[] =>
	s.rows.map((r) => ({ score: r.score >= s.threshold ? 1 : 0, pos: r.pos, neg: r.neg }));

function metric(classId: string, s: Scenario): number {
	switch (classId) {
		case 'ties':
			return auc(s.rows);
		case 'inverted':
			return auc(s.rows, 0.5, true);
		case 'roc-points':
			return rocArea(s.points, true);
		case 'gini':
			return 2 * auc(s.rows) - 1;
		case 'average-precision':
			return averagePrecision(s.rows);
		case 'group-macro':
			return s.groups.reduce((t, g) => t + auc(g.rows), 0) / s.groups.length;
		case 'weighted':
			return auc(objectRows(s));
		case 'hard-labels':
			return auc(hardRows(s));
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const tieIgnored: Record<string, () => number> = {
		ties: () => auc(s.rows, 0),
		inverted: () => auc(s.rows, 0, true),
		gini: () => 2 * auc(s.rows, 0) - 1,
		weighted: () => auc(objectRows(s), 0)
	};
	return {
		'ties-ignored': tieIgnored[classId]?.() ?? null,
		orientation: classId === 'inverted' ? auc(s.rows) : null,
		rectangles: classId === 'roc-points' ? rocArea(s.points, false) : null,
		'gini-as-auc': classId === 'gini' ? auc(s.rows) : null,
		'ap-mean-precision':
			classId === 'average-precision' ? prPoints(s.rows).reduce((t, x) => t + x.p, 0) / s.rows.length : null,
		pooled: classId === 'group-macro' ? auc(s.groups.flatMap((g) => g.rows)) : null,
		unweighted:
			classId === 'weighted'
				? auc(s.objects.map((o) => ({ score: o.score, pos: o.positive ? 1 : 0, neg: o.positive ? 0 : 1 })))
				: null,
		'use-scores': classId === 'hard-labels' ? auc(s.rows) : null
	};
}

function bucketRows(rng: Rng, n: number, scale: number, lift: number): Row[] {
	const scores = new Set<number>();
	while (scores.size < n) scores.add(rng.int(2, 98) / 100);
	return [...scores]
		.sort((a, b) => b - a)
		.map((score) => ({
			score,
			pos: Math.round(rng.int(0, scale) * (lift * score + (1 - lift) * 0.5) + rng.int(0, 3)),
			neg: Math.round(rng.int(0, scale) * (lift * (1 - score) + (1 - lift) * 0.5) + rng.int(0, 3))
		}));
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const plot = rng.pick(PLOTS);
	const rows = bucketRows(rng, rng.int(6, 9), rng.int(10, 30), rng.int(5, 9) / 10);
	// Every score value has objects of both classes in some rows: ties matter.
	for (const r of rng.sample(rows, 3)) {
		r.pos = Math.max(r.pos, rng.int(1, 6));
		r.neg = Math.max(r.neg, rng.int(1, 6));
	}
	const groups =
		classId === 'group-macro'
			? rng.sample(['Москва', 'Казань', 'Омск', 'Самара', 'Пермь'], 3).map((name, i) => {
					// Groups differ in base rate and score level, so the pooled AUC mixes them.
					const g = bucketRows(rng, rng.int(4, 6), rng.int(8, 20), rng.int(4, 9) / 10);
					for (const r of g) {
						r.score = Math.min(0.99, Math.max(0.01, Math.round((r.score * 0.6 + i * 0.2) * 100) / 100));
						if (i === 0) r.pos = Math.round(r.pos / 2);
					}
					const merged = new Map<number, Row>();
					for (const r of g) {
						const m = merged.get(r.score);
						if (m) {
							m.pos += r.pos;
							m.neg += r.neg;
						} else merged.set(r.score, { ...r });
					}
					return { name, rows: [...merged.values()].sort((a, b) => b.score - a.score) };
				})
			: [];
	const objects =
		classId === 'weighted'
			? rng.sample(PERSON_NAMES, rng.int(10, 14)).map((name, i) => ({
					name,
					score: rng.int(1, 9) / 10,
					positive: i < 4 ? i % 2 === 0 : rng.bool(),
					weight: rng.int(1, 5)
				}))
			: [];
	const points: { fpr: number; tpr: number }[] = [];
	if (classId === 'roc-points') {
		const count = rng.int(4, 6);
		const fprs = rng
			.sample(
				Array.from({ length: 98 }, (_, i) => (i + 1) / 100),
				count
			)
			.sort((a, b) => a - b);
		const tprs = rng
			.sample(
				Array.from({ length: 98 }, (_, i) => (i + 1) / 100),
				count
			)
			.sort((a, b) => a - b);
		fprs.forEach((fpr, i) => points.push({ fpr, tpr: Math.max(tprs[i] ?? 0, fpr) }));
	}
	const threshold = rows[rng.int(2, rows.length - 3)]?.score ?? 0.5;
	return { rows, groups, objects, points: rng.shuffle(points), threshold, plot };
}

function rowsTable(s: Scenario, rows: readonly Row[], scoreOf = 'скор'): string {
	return frameMarkdown(
		[scoreOf, `«${s.plot.positive}»`, `«${s.plot.negative}»`],
		rows.map((r) => [r.score.toFixed(2), r.pos, r.neg])
	);
}

function describe(s: Scenario, classId: string): string {
	const intro = (scoreOf: string): string =>
		`Модель выдала скор каждому объекту проверочной выборки; положительный класс — «${s.plot.positive}». Объекты сгруппированы по значению скора: в строке — сколько объектов с этим скором на самом деле «${s.plot.positive}» и сколько «${s.plot.negative}». Скор — ${scoreOf}.`;
	const aucRule =
		'ROC AUC — доля пар (положительный объект, отрицательный объект), в которых положительный упорядочен моделью выше; пара с равными скорами засчитывается как ½.';
	const tail = ['', roundingRule(DIGITS)];
	switch (classId) {
		case 'ties':
			return [
				intro(`оценка вероятности класса «${s.plot.positive}»`),
				'',
				rowsTable(s, s.rows),
				'',
				`${aucRule} Найдите ROC AUC.`,
				...tail
			].join('\n');
		case 'inverted':
			return [
				intro(
					`оценка вероятности класса «${s.plot.negative}» (чем выше, тем увереннее модель, что объект — «${s.plot.negative}»)`
				),
				'',
				rowsTable(s, s.rows),
				'',
				`${aucRule} Найдите ROC AUC модели для положительного класса «${s.plot.positive}».`,
				...tail
			].join('\n');
		case 'roc-points':
			return [
				'При нескольких порогах для модели посчитали долю ложных срабатываний (FPR) и долю найденных положительных (TPR). Точки перечислены в случайном порядке:',
				'',
				frameMarkdown(
					['FPR', 'TPR'],
					s.points.map((p) => [num(p.fpr, 2), num(p.tpr, 2)])
				),
				'',
				'ROC-кривая — ломаная через точки (0, 0), данные точки по возрастанию FPR и (1, 1). Найдите площадь под ней (ROC AUC).',
				...tail
			].join('\n');
		case 'gini':
			return [
				intro(`оценка вероятности класса «${s.plot.positive}»`),
				'',
				rowsTable(s, s.rows),
				'',
				`${aucRule} Найдите коэффициент Джини модели: Gini = 2·AUC − 1.`,
				...tail
			].join('\n');
		case 'average-precision':
			return [
				intro(`оценка вероятности класса «${s.plot.positive}»`),
				'',
				rowsTable(s, s.rows),
				'',
				'Порогами служат значения скора по убыванию; при пороге t положительными предсказаны все объекты со скором ≥ t, и для порога считаются precision Pₜ и recall Rₜ. Найдите average precision: AP = Σ (Rₜ − Rₜ₋₁)·Pₜ по порогам, R₀ = 0.',
				...tail
			].join('\n');
		case 'group-macro':
			return [
				`Модель ранжирует объекты в трёх регионах; положительный класс — «${s.plot.positive}», скор — оценка его вероятности. Объекты сгруппированы по региону и значению скора.`,
				'',
				...s.groups.flatMap((g) => [`**${g.name}**`, '', rowsTable(s, g.rows), '']),
				`${aucRule} Пары составляются только внутри региона. Найдите среднее по трём регионам значение ROC AUC.`,
				...tail
			].join('\n');
		case 'weighted':
			return [
				`Объекты проверочной выборки со скором модели и весом объекта; положительный класс — «${s.plot.positive}».`,
				'',
				frameMarkdown(
					['объект', 'скор', 'класс', 'вес'],
					s.objects.map((o) => [o.name, num(o.score, 2), o.positive ? s.plot.positive : s.plot.negative, o.weight])
				),
				'',
				'Найдите взвешенный ROC AUC: каждая пара (положительный, отрицательный) входит с весом, равным произведению весов объектов; пара упорядочена верно, если скор положительного выше, а равные скоры дают ½ веса пары. Сумма засчитанных весов делится на сумму весов всех пар.',
				...tail
			].join('\n');
		case 'hard-labels':
			return [
				intro(`оценка вероятности класса «${s.plot.positive}»`),
				'',
				rowsTable(s, s.rows),
				'',
				`В продакшен модель отдаёт не скор, а только метку: «${s.plot.positive}», если скор не меньше ${s.threshold.toFixed(2)}, иначе «${s.plot.negative}». ${aucRule} Найдите ROC AUC выхода модели в продакшене (по меткам, которые она отдаёт).`,
				...tail
			].join('\n');
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
kind = d["metric"]

def auc(objs):
    # objs: (score, pos_weight, neg_weight); pairs counted one by one, ties as a half
    good = 0.0
    for sa, pa, _ in objs:
        for sb, _, nb in objs:
            if sa > sb:
                good += pa * nb
            elif sa == sb:
                good += 0.5 * pa * nb
    return good / (sum(o[1] for o in objs) * sum(o[2] for o in objs))

rows = [tuple(r) for r in d["rows"]]
if kind == "ties":
    v = auc(rows)
elif kind == "inverted":
    v = auc([(-s, p, n) for s, p, n in rows])
elif kind == "gini":
    v = 2 * auc(rows) - 1
elif kind == "roc-points":
    pts = sorted([(0.0, 0.0)] + [tuple(p) for p in d["points"]] + [(1.0, 1.0)])
    v = sum((x2 - x1) * (y1 + y2) / 2 for (x1, y1), (x2, y2) in zip(pts, pts[1:]))
elif kind == "average-precision":
    total = sum(p for _, p, _ in rows)
    tp = fp = 0
    prev = 0.0
    v = 0.0
    for s, p, n in sorted(rows, reverse=True):
        tp += p
        fp += n
        r = tp / total
        v += (r - prev) * tp / (tp + fp)
        prev = r
elif kind == "group-macro":
    v = sum(auc([tuple(r) for r in g]) for g in d["groups"]) / len(d["groups"])
elif kind == "weighted":
    v = auc([(s, w if y else 0, 0 if y else w) for s, y, w in d["objects"]])
else:
    t = d["threshold"]
    v = auc([(1 if s >= t else 0, p, n) for s, p, n in rows])
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const allRows = [s.rows, ...s.groups.map((g) => g.rows), objectRows(s)];
		if (allRows.some((rows) => rows.length > 0 && (rows.every((r) => r.pos === 0) || rows.every((r) => r.neg === 0))))
			continue;
		const answer = metric(input.classId, s);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = {
			metric: input.classId,
			rows: s.rows.map((r) => [r.score, r.pos, r.neg]),
			groups: s.groups.map((g) => g.rows.map((r) => [r.score, r.pos, r.neg])),
			objects: s.objects.map((o) => [o.score, o.positive, o.weight]),
			points: s.points.map((p) => [p.fpr, p.tpr]),
			threshold: s.threshold
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
