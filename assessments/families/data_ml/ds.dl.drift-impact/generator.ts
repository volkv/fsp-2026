// What drift does to a model's metric in production: the expected accuracy, precision or RMSE when the mix of segments
// shifts while the model's behaviour inside a segment stays the same, and what a monitoring dashboard shows when only
// approved cases get labels.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { floatAnswer, frameMarkdown, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const SEGMENTS = ['web', 'android', 'ios', 'partners', 'b2b', 'offline', 'call-center'] as const;

interface Segment {
	name: string;
	/** Validation: share in percent (accuracy, RMSE) or the number of objects (precision). */
	valShare: number;
	valCount: number;
	prodShare: number;
	metric: number;
	tp: number;
	fp: number;
}

interface Task {
	kind: 'segment-accuracy' | 'segment-precision' | 'selective-labels' | 'rmse-mix';
	segments: Segment[];
	/** `selective-labels`: buckets by score, the volume share and the true bad rate; approved are the first `before`/`after`. */
	buckets: { share: number; badRate: number }[];
	before: number;
	after: number;
}

interface Rules {
	prodWeights: boolean;
	weighted: boolean;
	poolCounts: boolean;
	approvedOnly: boolean;
	newPolicy: boolean;
	squares: boolean;
}

const RIGHT: Rules = {
	prodWeights: true,
	weighted: true,
	poolCounts: true,
	approvedOnly: true,
	newPolicy: true,
	squares: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'validation-weights': { prodWeights: false },
	'unweighted-mean': { weighted: false },
	'average-of-precisions': { poolCounts: false },
	'all-buckets': { approvedOnly: false },
	'old-threshold': { newPolicy: false },
	'rmse-linear-mix': { squares: false }
};

function evaluate(t: Task, r: Rules): number {
	if (t.kind === 'selective-labels') {
		const k = r.newPolicy ? t.after : t.before;
		const used = r.approvedOnly ? t.buckets.slice(0, k) : t.buckets;
		const volume = used.reduce((s, b) => s + b.share, 0);
		return used.reduce((s, b) => s + b.share * b.badRate, 0) / volume;
	}
	const totalVal = t.segments.reduce((s, x) => s + x.valCount, 0);
	const weight = (x: Segment): number => {
		if (!r.weighted) return 1 / t.segments.length;
		if (!r.prodWeights) return t.kind === 'segment-precision' ? x.valCount / totalVal : x.valShare / 100;
		return x.prodShare / 100;
	};
	if (t.kind === 'segment-precision') {
		if (!r.poolCounts || !r.weighted) return t.segments.reduce((s, x) => s + weight(x) * (x.tp / (x.tp + x.fp)), 0);
		// Counts of a segment scale with its volume in production relative to validation.
		const scale = (x: Segment): number => weight(x) / (x.valCount / totalVal);
		const tp = t.segments.reduce((s, x) => s + scale(x) * x.tp, 0);
		const all = t.segments.reduce((s, x) => s + scale(x) * (x.tp + x.fp), 0);
		return tp / all;
	}
	if (t.kind === 'rmse-mix' && r.squares)
		return Math.sqrt(t.segments.reduce((s, x) => s + weight(x) * x.metric * x.metric, 0));
	return t.segments.reduce((s, x) => s + weight(x) * x.metric, 0);
}

/** `n` integer percents summing to 100, each at least `min`. */
function percents(rng: Rng, n: number, min: number): number[] {
	const out = Array.from({ length: n }, () => min);
	for (let left = 100 - n * min; left > 0; left -= 1) {
		const k = rng.int(0, n - 1);
		out[k] = (out[k] ?? 0) + 1;
	}
	return out;
}

function scenario(rng: Rng, kind: Task['kind']): Task {
	const empty = { buckets: [] as Task['buckets'], before: 0, after: 0 };
	if (kind === 'selective-labels') {
		const n = rng.int(5, 7);
		const shares = percents(rng, n, 5);
		// Score buckets from the safest to the riskiest: the bad rate grows.
		let rate = rng.int(1, 3);
		const buckets = shares.map((share) => {
			const b = { share, badRate: rate / 100 };
			rate += rng.int(2, 8);
			return b;
		});
		const before = rng.int(2, n - 2);
		return { kind, segments: [], buckets, before, after: rng.int(before + 1, n - 1) };
	}
	const n = rng.int(3, 5);
	const names = rng.sample(SEGMENTS, n);
	const val = percents(rng, n, 8);
	const prod = percents(rng, n, 4);
	const segments = names.map((name, i) => {
		const valCount = rng.int(4, 40) * 50;
		const positives = Math.round((valCount * rng.int(5, 30)) / 100);
		const tp = Math.max(1, Math.round((positives * rng.int(40, 95)) / 100));
		const fp = rng.int(1, Math.max(2, Math.round(positives * 0.8)));
		return {
			name,
			valShare: val[i] ?? 0,
			valCount,
			prodShare: prod[i] ?? 0,
			metric: kind === 'rmse-mix' ? rng.int(20, 400) / 10 : rng.int(55, 98) / 100,
			tp,
			fp
		};
	});
	return { kind, segments, ...empty };
}

function render(t: Task): string {
	if (t.kind === 'selective-labels') {
		return [
			'Кредитная модель делит заявки на корзины по скору — от самых надёжных (1) до самых рискованных. Доля заявок в корзинах и истинная доля невозвратов в каждой корзине (её знает только аналитик по историческому эксперименту):',
			'',
			frameMarkdown(
				['корзина', 'доля заявок, %', 'доля невозвратов'],
				t.buckets.map((b, i) => [String(i + 1), b.share, b.badRate])
			),
			'',
			`Одобряются заявки корзин 1–${t.before}; метку «вернул / не вернул» дашборд мониторинга получает только по одобренным заявкам и показывает долю невозвратов среди них. Модель не меняли, но политику расширили: теперь одобряются корзины 1–${t.after}, состав заявок прежний.`,
			'',
			`Какую долю невозвратов покажет дашборд после изменения, когда метки по новым одобренным заявкам придут? Введите долю, а не проценты. ${roundingRule(DIGITS)}`
		].join('\n');
	}
	if (t.kind === 'segment-precision') {
		return [
			'Классификатор фрода проверяли на валидационной выборке. Его поведение внутри каждого сегмента в проде то же, что на валидации (сдвиг только в составе сегментов). Результаты валидации по сегментам и доля сегмента в проде:',
			'',
			frameMarkdown(
				['сегмент', 'объектов в валидации', 'TP', 'FP', 'доля в проде, %'],
				t.segments.map((s) => [s.name, s.valCount, s.tp, s.fp, s.prodShare])
			),
			'',
			`Какой будет precision модели в проде? ${roundingRule(DIGITS)}`
		].join('\n');
	}
	if (t.kind === 'rmse-mix') {
		return [
			'Регрессионная модель прогнозирует время доставки. Ошибка модели внутри каждого сегмента в проде такая же, как на валидации; меняется только состав трафика. RMSE на валидации по сегментам и доли сегментов:',
			'',
			frameMarkdown(
				['сегмент', 'доля в валидации, %', 'RMSE на валидации, мин', 'доля в проде, %'],
				t.segments.map((s) => [s.name, s.valShare, s.metric, s.prodShare])
			),
			'',
			`Каким будет RMSE модели по всему трафику прода, мин? ${roundingRule(DIGITS)}`
		].join('\n');
	}
	return [
		'Классификатор оттока проверяли на валидационной выборке. Точность (accuracy) модели внутри каждого сегмента в проде такая же, как на валидации; меняется только состав клиентов. Данные по сегментам:',
		'',
		frameMarkdown(
			['сегмент', 'доля в валидации, %', 'accuracy на валидации', 'доля в проде, %'],
			t.segments.map((s) => [s.name, s.valShare, num(s.metric), s.prodShare])
		),
		'',
		`Какой будет accuracy модели в проде? ${roundingRule(DIGITS)}`
	].join('\n');
}

const REQUIRED: Record<string, string[]> = {
	'segment-accuracy': ['validation-weights', 'unweighted-mean'],
	'segment-precision': ['average-of-precisions', 'validation-weights'],
	'selective-labels': ['all-buckets', 'old-threshold'],
	'rmse-mix': ['rmse-linear-mix', 'validation-weights']
};

const PYTHON_REFERENCE = `import json
import math

t = json.loads(input())
kind = t["kind"]
segs = t["segments"]
if kind == "selective-labels":
    approved = t["buckets"][: t["after"]]
    result = sum(b["share"] * b["badRate"] for b in approved) / sum(b["share"] for b in approved)
elif kind == "segment-precision":
    n = sum(s["valCount"] for s in segs)
    tp = fp = 0.0
    for s in segs:
        w = (s["prodShare"] / 100) / (s["valCount"] / n)
        tp += w * s["tp"]
        fp += w * s["fp"]
    result = tp / (tp + fp)
elif kind == "rmse-mix":
    result = math.sqrt(sum(s["prodShare"] / 100 * s["metric"] ** 2 for s in segs))
else:
    result = sum(s["prodShare"] / 100 * s["metric"] for s in segs)
print(repr(result))
`;

function distinct(right: number, wrong: number): boolean {
	return Math.abs(right - wrong) >= 5 * 10 ** -DIGITS * Math.max(1, Math.abs(right), Math.abs(wrong));
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const kind = input.classId as Task['kind'];
	const required = REQUIRED[kind] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const t = scenario(rng, kind);
		const answer = evaluate(t, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = evaluate(t, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		// A misconception the data hardly separate from the right answer is no evidence: such a draw is redrawn.
		if (Object.values(wrong).some((value) => value !== null && !distinct(answer, value))) continue;
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: render(t), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(t) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no task for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
