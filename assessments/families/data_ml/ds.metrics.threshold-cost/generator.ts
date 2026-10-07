// Choosing a decision threshold over scores grouped by value: minimum cost, maximum Fβ, precision under a recall
// constraint and Youden's J (Middle); profit under review capacity, cost after the negatives of the validation set were
// thinned, the Bayes threshold of a calibrated model and net benefit (Senior). The answer is the value of the criterion,
// so a wrong choice of threshold shows in it.
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

interface Row {
	score: number;
	pos: number;
	neg: number;
}
interface Scenario {
	/** Descending by score. */
	rows: Row[];
	cfp: number;
	cfn: number;
	beta: number;
	recallMin: number;
	gain: number;
	review: number;
	capacity: number;
	keep: number;
	pt: number;
	plot: { task: string; positive: string; flag: string };
}

const PLOTS = [
	{ task: 'Антифрод-модель оценивает платежи', positive: 'мошенничество', flag: 'отправить платёж на ручную проверку' },
	{ task: 'Скоринговая модель оценивает заявки на кредит', positive: 'дефолт', flag: 'отклонить заявку' },
	{ task: 'Модель оттока оценивает клиентов', positive: 'уйдёт', flag: 'предложить клиенту скидку' },
	{ task: 'Модель модерации оценивает объявления', positive: 'нарушение', flag: 'снять объявление на проверку' }
] as const;

interface Point {
	t: number;
	tp: number;
	fp: number;
	fn: number;
	tn: number;
}

/** The confusion counts at every threshold equal to a score of the table (flag: score ≥ t). */
function points(rows: readonly Row[], negWeight = 1): Point[] {
	const P = rows.reduce((s, r) => s + r.pos, 0);
	const N = rows.reduce((s, r) => s + r.neg * negWeight, 0);
	let tp = 0;
	let fp = 0;
	return rows.map((r) => {
		tp += r.pos;
		fp += r.neg * negWeight;
		return { t: r.score, tp, fp, fn: P - tp, tn: N - fp };
	});
}

/** The counts when flagging every object with score ≥ t, t not necessarily a score of the table. */
function at(rows: readonly Row[], t: number): Point {
	const pts = points(rows);
	const last = pts.filter((p) => p.t >= t).at(-1);
	const P = rows.reduce((s, r) => s + r.pos, 0);
	const N = rows.reduce((s, r) => s + r.neg, 0);
	return last ?? { t, tp: 0, fp: 0, fn: P, tn: N };
}

const total = (p: Point): number => p.tp + p.fp + p.fn + p.tn;
const precision = (p: Point): number => p.tp / (p.tp + p.fp);
const recall = (p: Point): number => p.tp / (p.tp + p.fn);
const fbeta = (p: Point, b: number): number => {
	const pr = precision(p);
	const rc = recall(p);
	return pr + rc === 0 ? 0 : ((1 + b * b) * pr * rc) / (b * b * pr + rc);
};
const youdenJ = (p: Point): number => recall(p) - p.fp / (p.fp + p.tn);
const accuracy = (p: Point): number => (p.tp + p.tn) / total(p);
const cost = (s: Scenario, p: Point, cfp = s.cfp, cfn = s.cfn): number => (cfp * p.fp + cfn * p.fn) / total(p);
const profit = (s: Scenario, p: Point): number => (s.gain * p.tp - s.review * (p.tp + p.fp)) / total(p);
const netBenefit = (p: Point, pt: number, odds = pt / (1 - pt)): number => p.tp / total(p) - (p.fp / total(p)) * odds;

/** The first point with the largest (or smallest) value of a criterion. */
function best(pts: readonly Point[], f: (p: Point) => number, minimize = false): Point {
	let chosen = pts[0];
	for (const p of pts) {
		if (!chosen) chosen = p;
		else if (minimize ? f(p) < f(chosen) : f(p) > f(chosen)) chosen = p;
	}
	if (!chosen) throw new Error(`${descriptor.key}: no thresholds`);
	return chosen;
}

function production(s: Scenario): Point[] {
	return points(s.rows, 1 / s.keep);
}

function metric(classId: string, s: Scenario): number {
	const pts = points(s.rows);
	switch (classId) {
		case 'min-cost':
			return cost(
				s,
				best(pts, (p) => cost(s, p), true)
			);
		case 'max-fbeta':
			return fbeta(
				best(pts, (p) => fbeta(p, s.beta)),
				s.beta
			);
		case 'precision-at-recall':
			return precision(
				best(
					pts.filter((p) => recall(p) >= s.recallMin),
					precision
				)
			);
		case 'youden':
			return youdenJ(best(pts, youdenJ));
		case 'capacity-profit':
			return profit(
				s,
				best(
					pts.filter((p) => p.tp + p.fp <= s.capacity),
					(p) => profit(s, p)
				)
			);
		case 'prior-shift-cost': {
			const prod = production(s);
			return cost(
				s,
				best(prod, (p) => cost(s, p), true)
			);
		}
		case 'bayes-threshold':
			return cost(s, at(s.rows, s.cfp / (s.cfp + s.cfn)));
		case 'net-benefit':
			return netBenefit(at(s.rows, s.pt), s.pt);
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const pts = points(s.rows);
	const half = at(s.rows, 0.5);
	const halfFor: Record<string, () => number> = {
		'min-cost': () => cost(s, half),
		'max-fbeta': () => fbeta(half, s.beta),
		youden: () => youdenJ(half),
		'bayes-threshold': () => cost(s, half),
		'net-benefit': () => netBenefit(half, s.pt)
	};
	const prod = production(s);
	return {
		'swap-costs':
			classId === 'min-cost'
				? cost(
						s,
						best(pts, (p) => cost(s, p, s.cfn, s.cfp), true)
					)
				: null,
		'default-half': halfFor[classId]?.() ?? null,
		'f1-instead':
			classId === 'max-fbeta'
				? fbeta(
						best(pts, (p) => fbeta(p, 1)),
						s.beta
					)
				: null,
		'ignore-constraint': classId === 'precision-at-recall' ? precision(best(pts, precision)) : null,
		'accuracy-max': classId === 'youden' ? youdenJ(best(pts, accuracy)) : null,
		'ignore-capacity':
			classId === 'capacity-profit'
				? profit(
						s,
						best(pts, (p) => profit(s, p))
					)
				: null,
		'no-reweight':
			classId === 'prior-shift-cost'
				? cost(s, prod[pts.indexOf(best(pts, (p) => cost(s, p), true))] ?? (prod[0] as Point))
				: null,
		'inverted-ratio': classId === 'bayes-threshold' ? cost(s, at(s.rows, s.cfn / (s.cfp + s.cfn))) : null,
		'odds-inverted': classId === 'net-benefit' ? netBenefit(at(s.rows, s.pt), s.pt, (1 - s.pt) / s.pt) : null
	};
}

function scenario(rng: Rng, classId: string): Scenario {
	const n = rng.int(8, 11);
	const scores = new Set<number>();
	while (scores.size < n) scores.add(rng.int(3, 97) / 100);
	const negScale = classId === 'prior-shift-cost' ? 1 : rng.int(1, 4);
	const rows = [...scores]
		.sort((a, b) => b - a)
		.map((score) => ({
			score,
			pos: Math.round(rng.int(0, 25) * score + rng.int(0, 3)),
			neg: Math.round((rng.int(0, 25) * (1 - score) + rng.int(0, 3)) * negScale)
		}));
	const totalCount = rows.reduce((t, r) => t + r.pos + r.neg, 0);
	return {
		rows,
		cfp: rng.int(1, 5),
		cfn: rng.int(3, 20),
		beta: rng.pick([0.5, 2, 3]),
		recallMin: rng.pick([0.6, 0.7, 0.75, 0.8, 0.9]),
		gain: rng.int(5, 30),
		review: rng.int(1, 4),
		capacity: Math.round((totalCount * rng.int(15, 35)) / 100),
		keep: rng.pick([0.1, 0.2, 0.25, 0.5]),
		pt: rng.pick([0.1, 0.15, 0.2, 0.25, 0.3, 0.4]),
		plot: rng.pick(PLOTS)
	};
}

function question(classId: string, s: Scenario): string {
	const pick = `Порог t выбирается среди значений скора в таблице; объект с \`скор ≥ t\` модель помечает как «${s.plot.positive}» (решение — ${s.plot.flag}).`;
	switch (classId) {
		case 'min-cost':
			return `${pick} Ложное срабатывание стоит ${s.cfp}, пропуск «${s.plot.positive}» — ${s.cfn} (условных единиц), верные решения ничего не стоят. Выберите порог с наименьшей суммарной стоимостью ошибок и введите эту стоимость, делённую на число объектов в таблице.`;
		case 'max-fbeta':
			return `${pick} Выберите порог с наибольшей F-мерой при β = ${num(s.beta)} и введите значение этой F-меры.`;
		case 'precision-at-recall':
			return `${pick} Бизнес требует recall не ниже ${num(s.recallMin)}. Среди порогов, где требование выполнено, выберите порог с наибольшей precision и введите эту precision.`;
		case 'youden':
			return `${pick} Выберите порог с наибольшей статистикой Юдена J = TPR − FPR и введите значение J.`;
		case 'capacity-profit':
			return `${pick} Каждый пойманный «${s.plot.positive}» приносит ${s.gain}, каждая проверка (любого помеченного объекта) стоит ${s.review}. Проверить можно не больше ${s.capacity} объектов из таблицы. Выберите допустимый порог с наибольшей прибылью и введите эту прибыль, делённую на число объектов в таблице.`;
		case 'prior-shift-cost':
			return `${pick} Таблица — проверочная выборка, в которую из отрицательных объектов попала случайная доля ${num(s.keep)} (положительные — все); в продакшене отрицательных в ${num(1 / s.keep)} раза больше, чем в таблице, при той же доле каждого скора. Ложное срабатывание стоит ${s.cfp}, пропуск — ${s.cfn}. Выберите порог с наименьшей ожидаемой стоимостью ошибок в продакшене и введите эту стоимость в расчёте на один объект продакшена.`;
		case 'bayes-threshold':
			return `Скор модели откалиброван: это вероятность «${s.plot.positive}». Ложное срабатывание стоит ${s.cfp}, пропуск — ${s.cfn}; модель помечает объект, если ожидаемая стоимость пометки не больше ожидаемой стоимости пропуска, то есть при вероятности не ниже c_FP / (c_FP + c_FN). Введите суммарную стоимость ошибок при таком правиле, делённую на число объектов в таблице.`;
		case 'net-benefit':
			return `Скор — вероятность «${s.plot.positive}». Для анализа кривой решений модель помечает объекты со скором не ниже пороговой вероятности pₜ = ${num(s.pt)}. Введите чистую пользу модели при этом пороге: NB = TP / N − FP / N · pₜ / (1 − pₜ), N — число объектов в таблице.`;
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function describe(s: Scenario, classId: string): string {
	return [
		`${s.plot.task}. Объекты проверочной выборки сгруппированы по значению скора: сколько из них на самом деле «${s.plot.positive}» и сколько нет.`,
		'',
		frameMarkdown(
			['скор', `«${s.plot.positive}»`, 'остальные'],
			s.rows.map((r) => [r.score.toFixed(2), r.pos, r.neg])
		),
		'',
		question(classId, s),
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
kind = d["metric"]
rows = sorted([tuple(r) for r in d["rows"]], reverse=True)

def confusion(t, negw=1.0):
    tp = sum(p for s, p, n in rows if s >= t)
    fp = sum(n * negw for s, p, n in rows if s >= t)
    P = sum(p for s, p, n in rows)
    N = sum(n * negw for s, p, n in rows)
    return tp, fp, P - tp, N - fp

ts = [r[0] for r in rows]
cfp, cfn = d["cfp"], d["cfn"]

def cost(c):
    tp, fp, fn, tn = c
    return (cfp * fp + cfn * fn) / (tp + fp + fn + tn)

if kind == "min-cost":
    v = min(cost(confusion(t)) for t in ts)
elif kind == "max-fbeta":
    b2 = d["beta"] ** 2
    def fb(c):
        tp, fp, fn, tn = c
        p, r = tp / (tp + fp), tp / (tp + fn)
        return 0.0 if p + r == 0 else (1 + b2) * p * r / (b2 * p + r)
    v = max(fb(confusion(t)) for t in ts)
elif kind == "precision-at-recall":
    v = max(c[0] / (c[0] + c[1]) for c in map(confusion, ts) if c[0] / (c[0] + c[2]) >= d["recallMin"])
elif kind == "youden":
    v = max(c[0] / (c[0] + c[2]) - c[1] / (c[1] + c[3]) for c in map(confusion, ts))
elif kind == "capacity-profit":
    best = None
    for t in ts:
        tp, fp, fn, tn = confusion(t)
        if tp + fp <= d["capacity"]:
            val = (d["gain"] * tp - d["review"] * (tp + fp)) / (tp + fp + fn + tn)
            best = val if best is None else max(best, val)
    v = best
elif kind == "prior-shift-cost":
    v = min(cost(confusion(t, 1 / d["keep"])) for t in ts)
elif kind == "bayes-threshold":
    v = cost(confusion(cfp / (cfp + cfn)))
else:
    tp, fp, fn, tn = confusion(d["pt"])
    n = tp + fp + fn + tn
    v = tp / n - fp / n * d["pt"] / (1 - d["pt"])
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const s = scenario(rng, input.classId);
		const pts = points(s.rows);
		if (pts.some((p) => p.tp + p.fp === 0) || (pts.at(-1)?.tp ?? 0) === 0 || (pts.at(-1)?.fp ?? 0) === 0) continue;
		if (!s.rows.some((r) => r.score >= 0.5) || !s.rows.some((r) => r.score < 0.5)) continue;
		if (input.classId === 'precision-at-recall' && !pts.some((p) => recall(p) >= s.recallMin)) continue;
		if (input.classId === 'capacity-profit' && (pts[0]?.tp ?? 0) + (pts[0]?.fp ?? 0) > s.capacity) continue;
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
			cfp: s.cfp,
			cfn: s.cfn,
			beta: s.beta,
			recallMin: s.recallMin,
			gain: s.gain,
			review: s.review,
			capacity: s.capacity,
			keep: s.keep,
			pt: s.pt
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
