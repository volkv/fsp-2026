// Backpropagation by hand: one gradient a short PyTorch program prints after `backward()` through a small network.
// The batch mean of the loss, the derivative of ReLU on a batch, sigmoid with binary cross-entropy, softmax with
// cross-entropy and a skip connection decide the answer.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { floatAnswer, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;

interface Net {
	kind: 'relu-batch' | 'tanh-bce' | 'softmax-ce' | 'residual';
	/** Rows of inputs: a batch of two for `relu-batch`, one row otherwise. */
	x: number[][];
	t: number[];
	W: number[][];
	b: number[];
	v: number[];
	c: number;
	/** `residual`: the weights of the skip connection. */
	u: number[];
	/** `softmax-ce`: the true class. */
	target: number;
	/** The asked gradient: `W.grad[j, i]` or, for `residual`, `x.grad[0, i]`. */
	j: number;
	i: number;
}

interface Rules {
	batchMean: boolean;
	squareFactor: boolean;
	reluMask: boolean;
	bceShortcut: boolean;
	tanhDerivative: boolean;
	softmaxIndicator: boolean;
	softmaxJacobian: boolean;
	skip: boolean;
}

const RIGHT: Rules = {
	batchMean: true,
	squareFactor: true,
	reluMask: true,
	bceShortcut: true,
	tanhDerivative: true,
	softmaxIndicator: true,
	softmaxJacobian: true,
	skip: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'sum-not-mean': { batchMean: false },
	'half-mse': { squareFactor: false },
	'relu-derivative-ignored': { reluMask: false },
	'sigmoid-extra-factor': { bceShortcut: false },
	'tanh-as-sigmoid': { tanhDerivative: false },
	'indicator-forgotten': { softmaxIndicator: false },
	'softmax-jacobian-ignored': { softmaxJacobian: false },
	'skip-ignored': { skip: false }
};

const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, k) => s + x * (b[k] ?? 0), 0);
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const at = (a: readonly number[], k: number): number => a[k] ?? 0;

function gradient(n: Net, r: Rules): number {
	const square = r.squareFactor ? 2 : 1;
	if (n.kind === 'relu-batch') {
		let g = 0;
		for (let s = 0; s < n.x.length; s += 1) {
			const x = n.x[s] ?? [];
			const z = n.W.map((row, j) => dot(row, x) + at(n.b, j));
			const h = z.map((zj) => Math.max(0, zj));
			const y = dot(n.v, h) + n.c;
			const active = r.reluMask ? (at(z, n.j) > 0 ? 1 : 0) : 1;
			g += square * (y - at(n.t, s)) * at(n.v, n.j) * active * at(x, n.i);
		}
		return r.batchMean ? g / n.x.length : g;
	}
	const x = n.x[0] ?? [];
	if (n.kind === 'tanh-bce') {
		const h = n.W.map((row, j) => Math.tanh(dot(row, x) + at(n.b, j)));
		const p = sigmoid(dot(n.v, h) + n.c);
		const dz = r.bceShortcut ? p - at(n.t, 0) : (p - at(n.t, 0)) * p * (1 - p);
		const hj = at(h, n.j);
		const dh = r.tanhDerivative ? 1 - hj * hj : hj * (1 - hj);
		return dz * at(n.v, n.j) * dh * at(x, n.i);
	}
	if (n.kind === 'softmax-ce') {
		const z = n.W.map((row, k) => dot(row, x) + at(n.b, k));
		const m = Math.max(...z);
		const e = z.map((zk) => Math.exp(zk - m));
		const sum = e.reduce((s, v) => s + v, 0);
		const p = e.map((v) => v / sum);
		const pj = at(p, n.j);
		const pc = at(p, n.target);
		let dz: number;
		if (!r.softmaxJacobian) dz = n.j === n.target ? -1 / pc : 0;
		else dz = pj - (n.j === n.target && r.softmaxIndicator ? 1 : 0);
		return dz * at(x, n.i);
	}
	const z = n.W.map((row, j) => dot(row, x) + at(n.b, j));
	const h = z.map((zj) => Math.max(0, zj));
	const y = dot(n.v, h) + dot(n.u, x);
	let local = r.skip ? at(n.u, n.i) : 0;
	n.W.forEach((row, j) => {
		const active = r.reluMask ? (at(z, j) > 0 ? 1 : 0) : 1;
		local += at(n.v, j) * active * at(row, n.i);
	});
	return square * (y - at(n.t, 0)) * local;
}

/** A value on a grid of tenths, never zero. */
function tenth(rng: Rng, lo: number, hi: number): number {
	let k = 0;
	while (k === 0) k = rng.int(lo, hi);
	return k / 10;
}

const vec = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	Array.from({ length: n }, () => tenth(rng, lo, hi));
const mat = (rng: Rng, rows: number, cols: number, lo: number, hi: number): number[][] =>
	Array.from({ length: rows }, () => vec(rng, cols, lo, hi));

function scenario(rng: Rng, kind: Net['kind']): Net {
	const base = { kind, c: tenth(rng, -10, 10), u: [] as number[], target: 0, j: 0, i: 0 };
	if (kind === 'relu-batch') {
		return {
			...base,
			x: mat(rng, 2, 2, -20, 20),
			t: [rng.int(-3, 3), rng.int(-3, 3)],
			W: mat(rng, 2, 2, -15, 15),
			b: vec(rng, 2, -10, 10),
			v: vec(rng, 2, -15, 15),
			j: rng.int(0, 1),
			i: rng.int(0, 1)
		};
	}
	if (kind === 'tanh-bce') {
		return {
			...base,
			x: [vec(rng, 2, -15, 15)],
			t: [rng.int(0, 1)],
			W: mat(rng, 2, 2, -12, 12),
			b: vec(rng, 2, -5, 5),
			v: vec(rng, 2, -20, 20),
			j: rng.int(0, 1),
			i: rng.int(0, 1)
		};
	}
	if (kind === 'softmax-ce') {
		return {
			...base,
			c: 0,
			x: [vec(rng, 2, -15, 15)],
			t: [],
			W: mat(rng, 3, 2, -15, 15),
			b: vec(rng, 3, -10, 10),
			v: [],
			target: rng.int(0, 2),
			j: rng.int(0, 2),
			i: rng.int(0, 1)
		};
	}
	return {
		...base,
		c: 0,
		x: [vec(rng, 2, -20, 20)],
		t: [rng.int(-3, 3)],
		W: mat(rng, 2, 2, -15, 15),
		b: vec(rng, 2, -10, 10),
		v: vec(rng, 2, -15, 15),
		u: vec(rng, 2, -10, 10),
		i: rng.int(0, 1)
	};
}

/** The pre-activations of the hidden units on every row, to keep them clear of zero and of saturation. */
function preActivations(n: Net): number[] {
	return n.x.flatMap((x) => n.W.map((row, j) => dot(row, x) + at(n.b, j)));
}

/** Whether the scenario has the shape the class promises. */
function shaped(n: Net): boolean {
	const z = preActivations(n);
	if (z.some((v) => Math.abs(v) < 0.05)) return false;
	if (n.kind === 'relu-batch') {
		// The asked unit is active on exactly one of the two rows.
		const unit = n.x.map((x) => dot(n.W[n.j] ?? [], x) + at(n.b, n.j) > 0);
		return unit.filter(Boolean).length === 1;
	}
	if (n.kind === 'residual') {
		const active = n.W.map((row, j) => dot(row, n.x[0] ?? []) + at(n.b, j) > 0);
		return active.filter(Boolean).length === 1;
	}
	if (n.kind === 'tanh-bce') return z.every((v) => Math.abs(v) < 2.5);
	return true;
}

const lit = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vecLit = (a: readonly number[]): string => `[${a.map(lit).join(', ')}]`;
const matLit = (m: readonly (readonly number[])[]): string => `[${m.map(vecLit).join(', ')}]`;

function render(n: Net): string {
	const head = ['import torch', 'import torch.nn.functional as F', '', 'torch.set_default_dtype(torch.float64)', ''];
	if (n.kind === 'relu-batch') {
		return [
			...head,
			`x = torch.tensor(${matLit(n.x)})`,
			`t = torch.tensor(${vecLit(n.t)})`,
			`W = torch.tensor(${matLit(n.W)}, requires_grad=True)`,
			`b = torch.tensor(${vecLit(n.b)})`,
			`v = torch.tensor(${vecLit(n.v)})`,
			`c = ${lit(n.c)}`,
			'',
			'h = torch.relu(x @ W.T + b)',
			'y = h @ v + c',
			'loss = ((y - t) ** 2).mean()',
			'loss.backward()',
			`print(W.grad[${n.j}, ${n.i}].item())`
		].join('\n');
	}
	if (n.kind === 'tanh-bce') {
		return [
			...head,
			`x = torch.tensor(${vecLit(n.x[0] ?? [])})`,
			`t = torch.tensor(${lit(at(n.t, 0))})`,
			`W = torch.tensor(${matLit(n.W)}, requires_grad=True)`,
			`b = torch.tensor(${vecLit(n.b)})`,
			`v = torch.tensor(${vecLit(n.v)})`,
			`c = ${lit(n.c)}`,
			'',
			'h = torch.tanh(W @ x + b)',
			'p = torch.sigmoid(h @ v + c)',
			'loss = F.binary_cross_entropy(p, t)',
			'loss.backward()',
			`print(W.grad[${n.j}, ${n.i}].item())`
		].join('\n');
	}
	if (n.kind === 'softmax-ce') {
		return [
			...head,
			`x = torch.tensor(${vecLit(n.x[0] ?? [])})`,
			`W = torch.tensor(${matLit(n.W)}, requires_grad=True)`,
			`b = torch.tensor(${vecLit(n.b)})`,
			'',
			'logits = W @ x + b',
			`loss = F.cross_entropy(logits.unsqueeze(0), torch.tensor([${n.target}]))`,
			'loss.backward()',
			`print(W.grad[${n.j}, ${n.i}].item())`
		].join('\n');
	}
	return [
		...head,
		`x = torch.tensor(${vecLit(n.x[0] ?? [])}, requires_grad=True)`,
		`t = ${lit(at(n.t, 0))}`,
		`W = torch.tensor(${matLit(n.W)})`,
		`b = torch.tensor(${vecLit(n.b)})`,
		`v = torch.tensor(${vecLit(n.v)})`,
		`u = torch.tensor(${vecLit(n.u)})`,
		'',
		'h = torch.relu(W @ x + b)',
		'y = h @ v + u @ x  # skip connection',
		'loss = (y - t) ** 2',
		'loss.backward()',
		`print(x.grad[${n.i}].item())`
	].join('\n');
}

const REQUIRED: Record<string, string[]> = {
	'relu-batch': ['sum-not-mean', 'half-mse', 'relu-derivative-ignored'],
	'tanh-bce': ['sigmoid-extra-factor', 'tanh-as-sigmoid'],
	'softmax-ce': ['softmax-jacobian-ignored'],
	residual: ['skip-ignored', 'relu-derivative-ignored', 'half-mse']
};

const PYTHON_REFERENCE = `import json
import math

n = json.loads(input())
kind, W, b = n["kind"], n["W"], n["b"]
j, i = n["j"], n["i"]

def affine(x):
    return [sum(w * xi for w, xi in zip(row, x)) + bk for row, bk in zip(W, b)]

if kind == "relu-batch":
    grad = 0.0
    rows = n["x"]
    for x, t in zip(rows, n["t"]):
        z = affine(x)
        h = [max(0.0, zk) for zk in z]
        y = sum(vk * hk for vk, hk in zip(n["v"], h)) + n["c"]
        dy = 2 * (y - t) / len(rows)
        if z[j] > 0:
            grad += dy * n["v"][j] * x[i]
elif kind == "tanh-bce":
    x = n["x"][0]
    h = [math.tanh(zk) for zk in affine(x)]
    p = 1 / (1 + math.exp(-(sum(vk * hk for vk, hk in zip(n["v"], h)) + n["c"])))
    t = n["t"][0]
    # dL/dp = -(t/p) + (1-t)/(1-p); dp/da = p(1-p)
    dlogit = (-(t / p) + (1 - t) / (1 - p)) * p * (1 - p)
    grad = dlogit * n["v"][j] * (1 - h[j] ** 2) * x[i]
elif kind == "softmax-ce":
    x = n["x"][0]
    z = affine(x)
    top = max(z)
    e = [math.exp(zk - top) for zk in z]
    p = [ek / sum(e) for ek in e]
    grad = (p[j] - (1.0 if j == n["target"] else 0.0)) * x[i]
else:
    x = n["x"][0]
    z = affine(x)
    h = [max(0.0, zk) for zk in z]
    y = sum(vk * hk for vk, hk in zip(n["v"], h)) + sum(uk * xk for uk, xk in zip(n["u"], x))
    local = n["u"][i] + sum(n["v"][k] * W[k][i] for k in range(len(W)) if z[k] > 0)
    grad = 2 * (y - n["t"][0]) * local
print(repr(grad))
`;

/** The wrong answer differs from the right one by at least five units of the last asked place, relative to its size. */
function distinct(right: number, wrong: number): boolean {
	return Math.abs(right - wrong) >= 5 * 10 ** -DIGITS * Math.max(1, Math.abs(right), Math.abs(wrong));
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const kind = input.classId as Net['kind'];
	const required = REQUIRED[kind] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const net = scenario(rng, kind);
		if (!shaped(net)) continue;
		const answer = gradient(net, RIGHT);
		if (Math.abs(answer) < 0.01 || Math.abs(answer) > 50) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = gradient(net, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		// A misconception that changes the answer only a little would pass the rounded check: such a draw is redrawn.
		if (Object.values(wrong).some((value) => value !== null && !distinct(answer, value))) continue;
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `Что напечатает программа? ${roundingRule(DIGITS)}`,
				code: { language: 'python3', source: render(net) }
			},
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(net) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no network for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
