// Metrics of a regression forecast on a short table of facts and predictions: MAE, RMSE, MAPE and R² (Intern); sMAPE,
// weighted MAE, a negative R² and MAPE with zero facts left out (Junior).
import { farApart, floatAnswer, frameMarkdown, roundingRule, stdinJson } from '../../_lib/ds.ts';
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

interface Scenario {
	y: number[];
	p: number[];
	w: number[] | null;
	plot: { what: string; unit: string; weight: string };
}

const PLOTS = [
	{ what: 'время доставки заказа', unit: 'мин', weight: 'заказов в партии' },
	{ what: 'дневной спрос на товар', unit: 'шт.', weight: 'магазинов в кластере' },
	{ what: 'нагрузку на сервер', unit: 'тыс. запросов', weight: 'серверов в группе' },
	{ what: 'цену квартиры', unit: 'млн руб.', weight: 'похожих объявлений' }
] as const;

const DIGITS: Record<string, number> = {
	mae: 3,
	rmse: 3,
	mape: 2,
	r2: 3,
	smape: 2,
	'weighted-mae': 3,
	'r2-negative': 3,
	'mape-zeros': 2
};

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

function r2(y: readonly number[], p: readonly number[]): number {
	const m = mean(y);
	return 1 - sum(y.map((v, i) => (v - (p[i] ?? 0)) ** 2)) / sum(y.map((v) => (v - m) ** 2));
}

function corr2(y: readonly number[], p: readonly number[]): number {
	const my = mean(y);
	const mp = mean(p);
	const cov = sum(y.map((v, i) => (v - my) * ((p[i] ?? 0) - mp)));
	return (cov * cov) / (sum(y.map((v) => (v - my) ** 2)) * sum(p.map((v) => (v - mp) ** 2)));
}

/** MAPE in percent over the rows with a non-zero fact, divided by `count` (the right count is those rows). */
function mapeOver(y: readonly number[], p: readonly number[], byPrediction: boolean, count?: number): number {
	let total = 0;
	let rows = 0;
	y.forEach((v, i) => {
		if (v === 0) return;
		const q = p[i] ?? 0;
		total += Math.abs(v - q) / Math.abs(byPrediction ? q : v);
		rows += 1;
	});
	return (100 * total) / (count ?? rows);
}

function metric(classId: string, s: Scenario): number {
	const e = s.y.map((v, i) => v - (s.p[i] ?? 0));
	switch (classId) {
		case 'mae':
			return mean(e.map(Math.abs));
		case 'rmse':
			return Math.sqrt(mean(e.map((x) => x * x)));
		case 'mape':
		case 'mape-zeros':
			return mapeOver(s.y, s.p, false);
		case 'r2':
		case 'r2-negative':
			return r2(s.y, s.p);
		case 'smape':
			return (
				(100 * sum(s.y.map((v, i) => Math.abs(v - (s.p[i] ?? 0)) / ((Math.abs(v) + Math.abs(s.p[i] ?? 0)) / 2)))) /
				s.y.length
			);
		case 'weighted-mae': {
			const w = s.w ?? [];
			return sum(e.map((x, i) => Math.abs(x) * (w[i] ?? 0))) / sum(w);
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const e = s.y.map((v, i) => v - (s.p[i] ?? 0));
	const n = s.y.length;
	const w = s.w ?? [];
	return {
		'signed-mean': classId === 'mae' ? Math.abs(mean(e)) : null,
		'mse-no-root': classId === 'rmse' ? mean(e.map((x) => x * x)) : null,
		'n-minus-one':
			classId === 'mae'
				? sum(e.map(Math.abs)) / (n - 1)
				: classId === 'rmse'
					? Math.sqrt(sum(e.map((x) => x * x)) / (n - 1))
					: null,
		'mape-by-prediction': classId === 'mape' || classId === 'mape-zeros' ? mapeOver(s.y, s.p, true) : null,
		'r2-squared-corr': classId === 'r2' || classId === 'r2-negative' ? corr2(s.y, s.p) : null,
		'mape-instead': classId === 'smape' ? mapeOver(s.y, s.p, false) : null,
		unweighted: classId === 'weighted-mae' ? mean(e.map(Math.abs)) : null,
		'weights-over-n': classId === 'weighted-mae' ? sum(e.map((x, i) => Math.abs(x) * (w[i] ?? 0))) / n : null,
		'zeros-in-count': classId === 'mape-zeros' ? mapeOver(s.y, s.p, false, n) : null
	};
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const n = grade === 'junior' ? rng.int(9, 12) : rng.int(8, 11);
	const plot = rng.pick(PLOTS);
	const y: number[] = [];
	const p: number[] = [];
	const base = rng.int(20, 80);
	for (let i = 0; i < n; i += 1) {
		const v = base + rng.int(-15, 25);
		y.push(v);
		if (classId === 'r2-negative') {
			// Worse than the constant: errors larger than the spread of the facts.
			p.push(Math.max(1, base + rng.int(-25, 35)));
		} else {
			const bias = classId === 'r2' ? 6 : 0;
			p.push(Math.max(1, v + bias + rng.int(-9, 9)));
		}
	}
	if (classId === 'mape-zeros') {
		// Some facts are zero: a day without sales, an idle hour.
		for (const i of rng.sample(
			y.map((_, k) => k),
			rng.int(2, 3)
		))
			y[i] = 0;
	}
	if (classId === 'r2' && rng.bool()) {
		// A model that underestimates as often: the bias may go either way.
		for (let i = 0; i < n; i += 1) p[i] = Math.max(1, (p[i] ?? 0) - 12);
	}
	const w = classId === 'weighted-mae' ? y.map(() => rng.int(1, 9)) : null;
	return { y, p, w, plot };
}

const QUESTION: Record<string, string> = {
	mae: 'Найдите MAE — среднюю абсолютную ошибку прогноза.',
	rmse: 'Найдите RMSE — корень из средней квадратичной ошибки прогноза.',
	mape: 'Найдите MAPE в процентах: среднее по строкам значение |факт − прогноз| / |факт| · 100.',
	r2: 'Найдите коэффициент детерминации R² прогноза.',
	smape: 'Найдите sMAPE в процентах: среднее по строкам значение |факт − прогноз| / ((|факт| + |прогноз|) / 2) · 100.',
	'weighted-mae':
		'Каждая строка — агрегат по группе, её вес — число в столбце «вес». Найдите взвешенную MAE: сумма вес · |факт − прогноз|, делённая на сумму весов.',
	'r2-negative': 'Найдите коэффициент детерминации R² прогноза (R² = 1 − SSE / SST, SST — по среднему факта).',
	'mape-zeros':
		'Найдите MAPE в процентах: |факт − прогноз| / |факт| · 100, усреднённое по строкам. Строки с фактом 0 в расчёт не входят — по ним MAPE не определена.'
};

function describe(s: Scenario, classId: string): string {
	const columns = ['№', `факт, ${s.plot.unit}`, `прогноз, ${s.plot.unit}`, ...(s.w ? ['вес'] : [])];
	const rows = s.y.map((v, i) => [i + 1, v, s.p[i] ?? 0, ...(s.w ? [s.w[i] ?? 0] : [])]);
	return [
		`Модель прогнозирует ${s.plot.what}. Факт и прогноз на проверочных данных:`,
		'',
		frameMarkdown(columns, rows),
		'',
		QUESTION[classId] ?? '',
		'',
		roundingRule(DIGITS[classId] ?? 3)
	].join('\n');
}

const PYTHON_REFERENCE = `import json, math

d = json.loads(input())
y, p, w, m = d["y"], d["p"], d["w"], d["metric"]
n = len(y)
err = [a - b for a, b in zip(y, p)]
if m == "mae":
    v = sum(abs(e) for e in err) / n
elif m == "rmse":
    v = math.sqrt(sum(e * e for e in err) / n)
elif m in ("mape", "mape-zeros"):
    terms = [abs(a - b) / abs(a) for a, b in zip(y, p) if a != 0]
    v = 100 * sum(terms) / len(terms)
elif m in ("r2", "r2-negative"):
    my = sum(y) / n
    v = 1 - sum(e * e for e in err) / sum((a - my) ** 2 for a in y)
elif m == "smape":
    v = 100 * sum(abs(a - b) / ((abs(a) + abs(b)) / 2) for a, b in zip(y, p)) / n
else:
    v = sum(wi * abs(e) for wi, e in zip(w, err)) / sum(w)
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const digits = DIGITS[input.classId] ?? 3;
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const answer = metric(input.classId, s);
		if (input.classId === 'r2-negative' && answer > -0.05) continue;
		if (input.classId === 'r2' && answer < 0.2) continue;
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, digits))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, digits)
		});
		const data = { y: s.y, p: s.p, w: s.w, metric: input.classId };
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(data) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, digits) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
