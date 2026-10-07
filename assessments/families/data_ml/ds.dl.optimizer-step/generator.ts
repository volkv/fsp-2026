// Optimizer steps by hand: the value of one weight after a few steps of a PyTorch optimizer with given gradients.
// The momentum buffer, Nesterov's look-ahead, Adam's bias correction and decoupled weight decay against L2 decide the
// answer.
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

interface Setup {
	optimizer: 'momentum' | 'adam' | 'adamw' | 'nesterov';
	w0: number;
	grads: number[];
	lr: number;
	momentum: number;
	betas: [number, number];
	weightDecay: number;
}

interface Rules {
	torchMomentum: boolean;
	useMomentum: boolean;
	biasCorrection: boolean;
	decoupledDecay: boolean;
	decay: boolean;
	nesterov: boolean;
}

const RIGHT: Rules = {
	torchMomentum: true,
	useMomentum: true,
	biasCorrection: true,
	decoupledDecay: true,
	decay: true,
	nesterov: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'ema-momentum': { torchMomentum: false },
	'no-momentum': { useMomentum: false },
	'no-bias-correction': { biasCorrection: false },
	'l2-into-grad': { decoupledDecay: false },
	'decay-ignored': { decay: false },
	'no-nesterov': { nesterov: false }
};

const EPS = 1e-8;

function run(s: Setup, r: Rules): number {
	let w = s.w0;
	if (s.optimizer === 'momentum' || s.optimizer === 'nesterov') {
		let buf: number | null = null;
		for (const raw of s.grads) {
			// SGD's weight_decay is L2: added to the gradient.
			const g = raw + (r.decay ? s.weightDecay * w : 0);
			if (!r.useMomentum) {
				w -= s.lr * g;
				continue;
			}
			if (r.torchMomentum) buf = buf === null ? g : s.momentum * buf + g;
			else buf = s.momentum * (buf ?? 0) + (1 - s.momentum) * g;
			const step = s.optimizer === 'nesterov' && r.nesterov ? g + s.momentum * buf : buf;
			w -= s.lr * step;
		}
		return w;
	}
	let m = 0;
	let v = 0;
	const [b1, b2] = s.betas;
	s.grads.forEach((raw, k) => {
		const t = k + 1;
		let g = raw;
		if (s.optimizer === 'adamw' && r.decay) {
			if (r.decoupledDecay) w *= 1 - s.lr * s.weightDecay;
			else g += s.weightDecay * w;
		}
		m = b1 * m + (1 - b1) * g;
		v = b2 * v + (1 - b2) * g * g;
		const mHat = r.biasCorrection ? m / (1 - b1 ** t) : m;
		const vHat = r.biasCorrection ? v / (1 - b2 ** t) : v;
		w -= (s.lr * mHat) / (Math.sqrt(vHat) + EPS);
	});
	return w;
}

function tenth(rng: Rng, lo: number, hi: number): number {
	let k = 0;
	while (k === 0) k = rng.int(lo, hi);
	return k / 10;
}

function scenario(rng: Rng, optimizer: Setup['optimizer']): Setup {
	const steps = rng.int(3, 5);
	const grads = Array.from({ length: steps }, () => tenth(rng, -30, 30));
	const base: Setup = {
		optimizer,
		w0: tenth(rng, -20, 20),
		grads,
		lr: rng.pick([0.05, 0.1, 0.2, 0.3]),
		momentum: rng.pick([0.5, 0.8, 0.9]),
		betas: rng.pick([
			[0.9, 0.999],
			[0.8, 0.99],
			[0.5, 0.9]
		] as [number, number][]),
		weightDecay: 0
	};
	if (optimizer === 'adamw') return { ...base, weightDecay: rng.pick([0.1, 0.2, 0.5]) };
	if (optimizer === 'nesterov') return { ...base, weightDecay: rng.pick([0, 0.05, 0.1]) };
	return base;
}

function render(s: Setup): string {
	const opt =
		s.optimizer === 'momentum'
			? `torch.optim.SGD([w], lr=${s.lr}, momentum=${s.momentum})`
			: s.optimizer === 'nesterov'
				? `torch.optim.SGD([w], lr=${s.lr}, momentum=${s.momentum}, nesterov=True${s.weightDecay > 0 ? `, weight_decay=${s.weightDecay}` : ''})`
				: s.optimizer === 'adam'
					? `torch.optim.Adam([w], lr=${s.lr}, betas=(${s.betas[0]}, ${s.betas[1]}))`
					: `torch.optim.AdamW([w], lr=${s.lr}, betas=(${s.betas[0]}, ${s.betas[1]}), weight_decay=${s.weightDecay})`;
	const lit = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
	return [
		'import torch',
		'',
		`w = torch.nn.Parameter(torch.tensor(${lit(s.w0)}, dtype=torch.float64))`,
		`opt = ${opt}`,
		`grads = [${s.grads.map(lit).join(', ')}]  # gradient of the loss with respect to w at each step`,
		'',
		'for g in grads:',
		'    opt.zero_grad()',
		'    w.grad = torch.tensor(g, dtype=torch.float64)',
		'    opt.step()',
		'print(w.item())'
	].join('\n');
}

const REQUIRED: Record<string, string[]> = {
	momentum: ['ema-momentum', 'no-momentum'],
	adam: ['no-bias-correction'],
	adamw: ['l2-into-grad', 'decay-ignored', 'no-bias-correction'],
	nesterov: ['no-nesterov']
};

const PYTHON_REFERENCE = `import json
import math

s = json.loads(input())
w = s["w0"]
lr = s["lr"]
opt = s["optimizer"]
if opt in ("momentum", "nesterov"):
    mu, wd = s["momentum"], s["weightDecay"]
    buf = None
    for g in s["grads"]:
        d = g + wd * w
        buf = d if buf is None else mu * buf + d
        if opt == "nesterov":
            d = d + mu * buf
        else:
            d = buf
        w = w - lr * d
else:
    b1, b2 = s["betas"]
    m = v = 0.0
    for t, g in enumerate(s["grads"], start=1):
        if opt == "adamw":
            w = w * (1 - lr * s["weightDecay"])
        m = b1 * m + (1 - b1) * g
        v = b2 * v + (1 - b2) * g * g
        denom = math.sqrt(v) / math.sqrt(1 - b2 ** t) + 1e-8
        w = w - lr / (1 - b1 ** t) * m / denom
print(repr(w))
`;

function distinct(right: number, wrong: number): boolean {
	return Math.abs(right - wrong) >= 5 * 10 ** -DIGITS * Math.max(1, Math.abs(right), Math.abs(wrong));
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const optimizer = input.classId as Setup['optimizer'];
	const required = REQUIRED[optimizer] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, optimizer);
		const answer = run(s, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = run(s, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (Object.values(wrong).some((value) => value !== null && !distinct(answer, value))) continue;
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `Градиенты на каждом шаге заданы списком и не зависят от значения \`w\`. Что напечатает программа? ${roundingRule(DIGITS)}`,
				code: { language: 'python3', source: render(s) }
			},
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no setup for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
