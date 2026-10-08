// Steps of training a linear model by hand: gradient descent on MSE and log-loss, with L2 and two features (Middle);
// an epoch of mini-batches, class weights in the loss, Newton's method and a softmax step (Senior). The loss and the
// update rule are given in the statement; the answer is one parameter after the steps.
import { farApart, floatAnswer, frameMarkdown, num, roundingRule, stdinJson, type Cell } from '../../_lib/ds.ts';
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
const DIGITS = 4;

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

interface Variant {
	noTwo?: boolean;
	sequential?: boolean;
	sumNotMean?: boolean;
	ascent?: boolean;
	noSigmoid?: boolean;
	regularizeBias?: boolean;
	lambdaNotHalved?: boolean;
	fullBatch?: boolean;
	unweighted?: boolean;
	normalizedWeights?: boolean;
}

interface Spec {
	kind: 'linear' | 'logistic';
	xs: number[][];
	ys: number[];
	lr: number;
	steps: number;
	lambda: number;
	/** Weights of class 0 and class 1 in the loss. */
	weights: [number, number];
	/** Mini-batch size; 0 — full batch. */
	batch: number;
	/** The starting value of every feature weight; the intercept starts at zero. */
	w0: number;
}

/** Gradient of the loss over `rows` at θ = [w₁, …, w_d, b], one component `j` (all when `j` is null). */
function gradient(s: Spec, theta: readonly number[], rows: readonly number[], v: Variant): number[] {
	const d = theta.length - 1;
	const g = theta.map(() => 0);
	let denom = v.sumNotMean ? 1 : rows.length;
	if (v.normalizedWeights) denom = rows.reduce((sum, i) => sum + s.weights[s.ys[i] === 1 ? 1 : 0], 0);
	for (const i of rows) {
		const x = s.xs[i] ?? [];
		const y = s.ys[i] ?? 0;
		const z = x.reduce((sum, xj, j) => sum + xj * (theta[j] ?? 0), theta[d] ?? 0);
		let e: number;
		if (s.kind === 'linear') e = (v.noTwo ? 1 : 2) * (z - y);
		else e = (v.noSigmoid ? z : sigmoid(z)) - y;
		const c = v.unweighted ? 1 : s.weights[y === 1 ? 1 : 0];
		for (let j = 0; j < d; j += 1) g[j] = (g[j] ?? 0) + (c * e * (x[j] ?? 0)) / denom;
		g[d] = (g[d] ?? 0) + (c * e) / denom;
	}
	for (let j = 0; j < d; j += 1) g[j] = (g[j] ?? 0) + (v.lambdaNotHalved ? 2 : 1) * s.lambda * (theta[j] ?? 0);
	if (v.regularizeBias) g[d] = (g[d] ?? 0) + s.lambda * (theta[d] ?? 0);
	return g;
}

function train(s: Spec, v: Variant = {}): number[] {
	// Weights of the features from w0 and the intercept last, from zero.
	const d = s.xs[0]?.length ?? 0;
	let theta: number[] = Array.from({ length: d + 1 }, (_, j) => (j < d ? s.w0 : 0));
	const all = s.xs.map((_, i) => i);
	const batches: number[][] = [];
	if (s.batch === 0 || v.fullBatch) for (let k = 0; k < s.steps; k += 1) batches.push(all);
	else for (let start = 0; start < all.length; start += s.batch) batches.push(all.slice(start, start + s.batch));
	const sign = v.ascent ? 1 : -1;
	for (const rows of batches) {
		if (v.sequential) {
			const next = [...theta];
			for (let j = 0; j < next.length; j += 1)
				next[j] = (next[j] ?? 0) + sign * s.lr * (gradient(s, next, rows, v)[j] ?? 0);
			theta = next;
		} else {
			const g = gradient(s, theta, rows, v);
			theta = theta.map((t, j) => t + sign * s.lr * (g[j] ?? 0));
		}
	}
	return theta;
}

/** Newton's method for a logistic model with one weight and no intercept. */
function newton(
	xs: readonly number[],
	ys: readonly number[],
	steps: number,
	v: 'right' | 'gradient-step' | 'fixed-curvature'
): number {
	let w = 0;
	for (let k = 0; k < steps; k += 1) {
		const p = xs.map((x) => sigmoid(w * x));
		const g = xs.reduce((s, x, i) => s + ((p[i] ?? 0) - (ys[i] ?? 0)) * x, 0) / xs.length;
		const h =
			v === 'fixed-curvature'
				? xs.reduce((s, x) => s + 0.25 * x * x, 0) / xs.length
				: xs.reduce((s, x, i) => s + (p[i] ?? 0) * (1 - (p[i] ?? 0)) * x * x, 0) / xs.length;
		w -= v === 'gradient-step' ? g : g / h;
	}
	return w;
}

/** Softmax regression with one feature and an intercept per class: [w_c, b_c] after the steps. */
function softmax(
	xs: readonly number[],
	ys: readonly number[],
	classes: number,
	lr: number,
	steps: number,
	v: Variant
): number[][] {
	let W = Array.from({ length: classes }, () => [0, 0]);
	for (let k = 0; k < steps; k += 1) {
		const G = W.map(() => [0, 0]);
		xs.forEach((x, i) => {
			const z = W.map(([w, b]) => (w ?? 0) * x + (b ?? 0));
			const ez = z.map(Math.exp);
			const total = ez.reduce((s, e) => s + e, 0);
			z.forEach((zc, c) => {
				const p = v.noSigmoid ? sigmoid(zc) : (ez[c] ?? 0) / total;
				const e = p - (ys[i] === c ? 1 : 0);
				const row = G[c] ?? [0, 0];
				row[0] = (row[0] ?? 0) + (e * x) / xs.length;
				row[1] = (row[1] ?? 0) + e / xs.length;
			});
		});
		const sign = v.ascent ? 1 : -1;
		W = W.map(([w, b], c) => [(w ?? 0) + sign * lr * (G[c]?.[0] ?? 0), (b ?? 0) + sign * lr * (G[c]?.[1] ?? 0)]);
	}
	return W;
}

function gdProbe(s: Spec, which: number): object {
	const { kind: model, ...rest } = s;
	return { kind: 'gd', model, ...rest, which };
}

interface Task {
	markdown: string;
	answer: number;
	wrong: Record<string, number | null>;
	probe: object;
}

const LOSS_MSE = 'Потери — L = (1/n)·Σ (w·x + b − y)² по n строкам.';
const LOSS_LOG =
	'Модель — p = σ(z), z = w·x + b, σ(z) = 1 / (1 + e^(−z)); потери — L = −(1/n)·Σ [y·ln p + (1 − y)·ln(1 − p)] по n строкам.';
const SIMULTANEOUS =
	'Шаг градиентного спуска: все параметры обновляются одновременно — θ ← θ − η·∂L/∂θ, градиент считается в текущей точке.';

function binaryData(rng: Rng, n: number, d: number): { xs: number[][]; ys: number[] } {
	for (;;) {
		const xs = Array.from({ length: n }, () => Array.from({ length: d }, () => rng.int(-3, 4)));
		const ys = xs.map((x) => ((x[0] ?? 0) + rng.int(-2, 2) > 0 ? 1 : 0));
		if (ys.some((y) => y === 1) && ys.some((y) => y === 0)) return { xs, ys };
	}
}

function dataTable(xs: readonly number[][], ys: readonly number[], names: readonly string[]): string {
	return frameMarkdown(
		[...names, 'y'],
		xs.map((x, i): Cell[] => [...x, ys[i] ?? 0])
	);
}

function middleTask(rng: Rng, classId: string): Task {
	const n = rng.int(4, 6);
	if (classId === 'linear-gd') {
		const xs = Array.from({ length: n }, () => [rng.int(-3, 4)]);
		const ys = xs.map((x) => 2 * (x[0] ?? 0) + rng.int(-3, 6));
		const s: Spec = {
			kind: 'linear',
			xs,
			ys,
			lr: rng.pick([0.01, 0.02, 0.05]),
			steps: 2,
			lambda: 0,
			weights: [1, 1],
			batch: 0,
			w0: 0
		};
		const which = rng.int(0, 1);
		const name = which === 0 ? 'w' : 'b';
		const pick = (t: number[]): number => t[which] ?? 0;
		return {
			markdown: [
				'Линейная регрессия y ≈ w·x + b обучается градиентным спуском на данных:',
				'',
				dataTable(xs, ys, ['x']),
				'',
				`${LOSS_MSE} ${SIMULTANEOUS} Начало — w = 0, b = 0, шаг η = ${num(s.lr)}.`,
				'',
				`Чему будет равен \`${name}\` после двух шагов?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: pick(train(s)),
			wrong: {
				'no-two': pick(train(s, { noTwo: true })),
				sequential: which === 1 ? pick(train(s, { sequential: true })) : null,
				'sum-not-mean': pick(train(s, { sumNotMean: true }))
			},
			probe: gdProbe(s, which)
		};
	}
	const two = classId === 'two-features';
	const { xs, ys } = binaryData(rng, n, two ? 2 : 1);
	const s: Spec = {
		kind: 'logistic',
		xs,
		ys,
		lr: rng.pick([0.1, 0.2, 0.5, 1]),
		steps: 2,
		lambda: classId === 'l2' ? rng.pick([0.1, 0.2, 0.5, 1]) : 0,
		weights: [1, 1],
		batch: 0,
		// From w = 0 the penalty λw is zero on the first step, and the intercept after two steps would not depend on λ.
		w0: classId === 'l2' ? rng.pick([-1, -0.5, 0.5, 1]) : 0
	};
	const which = two ? rng.int(0, 1) : rng.int(0, 1);
	const names = two ? ['x1', 'x2'] : ['x'];
	const paramNames = two ? ['w1', 'w2', 'b'] : ['w', 'b'];
	const pick = (t: number[]): number => t[which] ?? 0;
	const model = two
		? 'Модель — p = σ(z), z = w1·x1 + w2·x2 + b, σ(z) = 1 / (1 + e^(−z)); потери — L = −(1/n)·Σ [y·ln p + (1 − y)·ln(1 − p)] по n строкам.'
		: LOSS_LOG;
	const penalty =
		classId === 'l2'
			? ` К потерям добавлен штраф (λ/2)·w² с λ = ${num(s.lambda)}; свободный член b не штрафуется.`
			: '';
	const start = classId === 'l2' ? `Начало — w = ${num(s.w0)}, b = 0` : 'Начало — все параметры равны 0';
	return {
		markdown: [
			'Логистическая регрессия обучается градиентным спуском на данных:',
			'',
			dataTable(xs, ys, names),
			'',
			`${model}${penalty} ${SIMULTANEOUS} ${start}, шаг η = ${num(s.lr)}.`,
			'',
			`Чему будет равен \`${paramNames[which]}\` после двух шагов?`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		answer: pick(train(s)),
		wrong: {
			ascent: classId === 'logistic-gd' ? pick(train(s, { ascent: true })) : null,
			'no-sigmoid': pick(train(s, { noSigmoid: true })),
			sequential: classId === 'two-features' || classId === 'logistic-gd' ? pick(train(s, { sequential: true })) : null,
			'regularize-bias': classId === 'l2' && which === 1 ? pick(train(s, { regularizeBias: true })) : null,
			'lambda-not-halved': classId === 'l2' && which === 0 ? pick(train(s, { lambdaNotHalved: true })) : null,
			'no-penalty': classId === 'l2' ? pick(train({ ...s, lambda: 0 })) : null
		},
		probe: gdProbe(s, which)
	};
}

function seniorTask(rng: Rng, classId: string): Task {
	const n = rng.int(6, 8);
	if (classId === 'newton') {
		const { xs, ys } = binaryData(rng, n, 1);
		const flat = xs.map((x) => x[0] ?? 0);
		if (flat.every((x) => x === 0)) return seniorTask(rng, classId);
		return {
			markdown: [
				'Логистическая регрессия без свободного члена, p = σ(w·x), σ(z) = 1 / (1 + e^(−z)), обучается методом Ньютона на данных:',
				'',
				dataTable(xs, ys, ['x']),
				'',
				'Потери — L(w) = −(1/n)·Σ [y·ln p + (1 − y)·ln(1 − p)]. Шаг метода Ньютона — w ← w − L′(w) / L″(w), обе производные — в текущей точке. Начало — w = 0.',
				'',
				'Чему будет равен `w` после двух шагов?',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: newton(flat, ys, 2, 'right'),
			wrong: {
				'gradient-step': newton(flat, ys, 2, 'gradient-step'),
				'fixed-curvature': newton(flat, ys, 2, 'fixed-curvature')
			},
			probe: { kind: 'newton', xs: flat, ys }
		};
	}
	if (classId === 'softmax') {
		const xs = Array.from({ length: n }, () => rng.int(-3, 4));
		const ys = xs.map((x) => (x + rng.int(-1, 1) <= -1 ? 0 : x + rng.int(-1, 1) <= 2 ? 1 : 2));
		if (new Set(ys).size < 3) return seniorTask(rng, classId);
		const lr = rng.pick([0.5, 1]);
		const c = rng.int(0, 2);
		const which = rng.int(0, 1);
		const pick = (W: number[][]): number => W[c]?.[which] ?? 0;
		return {
			markdown: [
				'Многоклассовая логистическая регрессия с классами 0, 1, 2 и одним признаком обучается градиентным спуском на данных:',
				'',
				frameMarkdown(
					['x', 'y'],
					xs.map((x, i) => [x, ys[i] ?? 0])
				),
				'',
				'У каждого класса k свои параметры: zₖ = wₖ·x + bₖ, вероятности — softmax: pₖ = e^(zₖ) / Σⱼ e^(zⱼ). Потери — L = −(1/n)·Σ ln p_y по n строкам. ' +
					`${SIMULTANEOUS} Начало — все параметры равны 0, шаг η = ${num(lr)}.`,
				'',
				`Чему будет равен \`${which === 0 ? 'w' : 'b'}${['₀', '₁', '₂'][c]}\` после двух шагов?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: pick(softmax(xs, ys, 3, lr, 2, {})),
			wrong: {
				'one-vs-rest': pick(softmax(xs, ys, 3, lr, 2, { noSigmoid: true })),
				ascent: pick(softmax(xs, ys, 3, lr, 2, { ascent: true }))
			},
			probe: { kind: 'softmax', xs, ys, lr, c, which }
		};
	}
	const { xs, ys } = binaryData(rng, n, 1);
	const which = rng.int(0, 1);
	const pick = (t: number[]): number => t[which] ?? 0;
	if (classId === 'minibatch') {
		const batch = rng.int(2, 3);
		const s: Spec = {
			kind: 'logistic',
			xs,
			ys,
			lr: rng.pick([0.2, 0.5, 1]),
			steps: 1,
			lambda: 0,
			weights: [1, 1],
			batch,
			w0: 0
		};
		return {
			markdown: [
				'Логистическая регрессия обучается мини-батчевым градиентным спуском на данных:',
				'',
				dataTable(xs, ys, ['x']),
				'',
				`${LOSS_LOG} Одна эпоха: строки идут в порядке таблицы, батчи — по ${batch} подряд (последний может быть короче); после каждого батча все параметры одновременно сдвигаются на −η·(средний по батчу градиент потерь). Начало — w = 0, b = 0, шаг η = ${num(s.lr)}.`,
				'',
				`Чему будет равен \`${which === 0 ? 'w' : 'b'}\` после одной эпохи?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: pick(train(s)),
			wrong: {
				'full-batch': pick(train(s, { fullBatch: true })),
				'sum-not-mean': pick(train(s, { sumNotMean: true })),
				'no-sigmoid': pick(train(s, { noSigmoid: true }))
			},
			probe: gdProbe(s, which)
		};
	}
	const weight = rng.int(2, 5);
	const s: Spec = {
		kind: 'logistic',
		xs,
		ys,
		lr: rng.pick([0.2, 0.5, 1]),
		steps: 2,
		lambda: 0,
		weights: [1, weight],
		batch: 0,
		w0: 0
	};
	return {
		markdown: [
			'Логистическая регрессия обучается с весами классов на данных:',
			'',
			dataTable(xs, ys, ['x']),
			'',
			`Модель — p = σ(z), z = w·x + b, σ(z) = 1 / (1 + e^(−z)); потери — L = −(1/n)·Σ cᵢ·[yᵢ·ln pᵢ + (1 − yᵢ)·ln(1 − pᵢ)], где cᵢ = ${weight} для строк с y = 1 и cᵢ = 1 для y = 0, n — число строк. ${SIMULTANEOUS} Начало — w = 0, b = 0, шаг η = ${num(s.lr)}.`,
			'',
			`Чему будет равен \`${which === 0 ? 'w' : 'b'}\` после двух шагов?`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		answer: pick(train(s)),
		wrong: {
			unweighted: pick(train(s, { unweighted: true })),
			'normalized-weights': pick(train(s, { normalizedWeights: true })),
			'no-sigmoid': pick(train(s, { noSigmoid: true }))
		},
		probe: gdProbe(s, which)
	};
}

const PYTHON_REFERENCE = `import json
import math

p = json.loads(input())
kind = p["kind"]

def sig(z):
    return 1 / (1 + math.exp(-z))

if kind == "gd":
    xs, ys = p["xs"], p["ys"]
    d = len(xs[0])
    w, b = [float(p["w0"])] * d, 0.0
    n = len(xs)
    if p["batch"]:
        batches = [list(range(i, min(i + p["batch"], n))) for i in range(0, n, p["batch"])]
    else:
        batches = [list(range(n))] * p["steps"]
    for rows in batches:
        gw, gb = [0.0] * d, 0.0
        for i in rows:
            z = sum(wj * xj for wj, xj in zip(w, xs[i])) + b
            err = 2 * (z - ys[i]) if p["model"] == "linear" else sig(z) - ys[i]
            c = p["weights"][1] if ys[i] == 1 else p["weights"][0]
            for j in range(d):
                gw[j] += c * err * xs[i][j] / len(rows)
            gb += c * err / len(rows)
        for j in range(d):
            gw[j] += p["lambda"] * w[j]
        w = [wj - p["lr"] * g for wj, g in zip(w, gw)]
        b = b - p["lr"] * gb
    print(repr((w + [b])[p["which"]]))
elif kind == "newton":
    xs, ys = p["xs"], p["ys"]
    w = 0.0
    for _ in range(2):
        ps = [sig(w * x) for x in xs]
        g = sum((q - y) * x for q, y, x in zip(ps, ys, xs)) / len(xs)
        h = sum(q * (1 - q) * x * x for q, x in zip(ps, xs)) / len(xs)
        w -= g / h
    print(repr(w))
else:
    xs, ys = p["xs"], p["ys"]
    W = [[0.0, 0.0] for _ in range(3)]
    for _ in range(2):
        G = [[0.0, 0.0] for _ in range(3)]
        for x, y in zip(xs, ys):
            z = [w * x + b for w, b in W]
            m = max(z)
            e = [math.exp(v - m) for v in z]
            s = sum(e)
            for k in range(3):
                err = e[k] / s - (1 if y == k else 0)
                G[k][0] += err * x / len(xs)
                G[k][1] += err / len(xs)
        W = [[w - p["lr"] * g0, b - p["lr"] * g1] for (w, b), (g0, g1) in zip(W, G)]
    print(repr(W[p["c"]][p["which"]]))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const t = input.grade === 'middle' ? middleTask(rng, input.classId) : seniorTask(rng, input.classId);
		if (!Number.isFinite(t.answer) || Math.abs(t.answer) < 0.01 || Math.abs(t.answer) > 50) continue;
		if (Object.values(t.wrong).some((w) => w !== null && !farApart(t.answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: t.markdown, code: null },
			answer: floatAnswer(t.answer, DIGITS)
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, t.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(t.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
