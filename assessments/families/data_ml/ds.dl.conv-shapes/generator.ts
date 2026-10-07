// Shapes and parameters of convolutional layers: the output shape of a small PyTorch model on a given input and the
// number of its trainable parameters. Floor in the size formula, padding on both sides, dilation, the default stride of
// pooling, groups, transposed convolution, BatchNorm buffers and a lazily sized linear head decide the answer.
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

type Layer =
	| { kind: 'conv'; cin: number; cout: number; k: number; s: number; p: number; d: number; g: number; bias: boolean }
	| { kind: 'tconv'; cin: number; cout: number; k: number; s: number; p: number; op: number }
	| { kind: 'bn'; c: number }
	| { kind: 'relu' }
	| { kind: 'pool'; k: number; s: number | null }
	| { kind: 'flatten' }
	| { kind: 'linear'; out: number };

interface Model {
	input: [number, number, number];
	layers: Layer[];
}

interface Rules {
	floor: boolean;
	paddingBothSides: boolean;
	bias: boolean;
	poolDefaultStride: boolean;
	dilation: boolean;
	bnBuffersExcluded: boolean;
	groups: boolean;
	transposed: boolean;
	flattenChannels: boolean;
	biasOnlyWhenSet: boolean;
}

const RIGHT: Rules = {
	floor: true,
	paddingBothSides: true,
	bias: true,
	poolDefaultStride: true,
	dilation: true,
	bnBuffersExcluded: true,
	groups: true,
	transposed: true,
	flattenChannels: true,
	biasOnlyWhenSet: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-floor': { floor: false },
	'padding-once': { paddingBothSides: false },
	'bias-forgotten': { bias: false },
	'pool-stride-1': { poolDefaultStride: false },
	'dilation-ignored': { dilation: false },
	'bn-running-stats': { bnBuffersExcluded: false },
	'groups-ignored': { groups: false },
	'transposed-as-conv': { transposed: false },
	'flatten-without-channels': { flattenChannels: false },
	'bias-always': { biasOnlyWhenSet: false }
};

/** `<C H W P>` or, after a flatten and a linear head, `<F P>`; `null` when the model is not valid under the rules. */
function evaluate(m: Model, r: Rules): string | null {
	let [c, h, w] = m.input;
	let flat: number | null = null;
	let params = 0;
	const div = (a: number, b: number): number => (r.floor ? Math.floor(a / b) : Math.ceil(a / b));
	for (const layer of m.layers) {
		if (layer.kind === 'conv') {
			const d = r.dilation ? layer.d : 1;
			const pad = r.paddingBothSides ? 2 * layer.p : layer.p;
			const size = (x: number): number => div(x + pad - d * (layer.k - 1) - 1, layer.s) + 1;
			[c, h, w] = [layer.cout, size(h), size(w)];
			const g = r.groups ? layer.g : 1;
			const hasBias = r.biasOnlyWhenSet ? layer.bias : true;
			params += (layer.cout * layer.cin * layer.k * layer.k) / g + (hasBias && r.bias ? layer.cout : 0);
		} else if (layer.kind === 'tconv') {
			const pad = r.paddingBothSides ? 2 * layer.p : layer.p;
			const size = (x: number): number =>
				r.transposed
					? (x - 1) * layer.s - pad + (layer.k - 1) + layer.op + 1
					: div(x + pad - (layer.k - 1) - 1, layer.s) + 1;
			[c, h, w] = [layer.cout, size(h), size(w)];
			params += layer.cin * layer.cout * layer.k * layer.k + (r.bias ? layer.cout : 0);
		} else if (layer.kind === 'bn') {
			params += (r.bnBuffersExcluded ? 2 : 4) * layer.c;
		} else if (layer.kind === 'pool') {
			const s = layer.s ?? (r.poolDefaultStride ? layer.k : 1);
			const size = (x: number): number => div(x - layer.k, s) + 1;
			[h, w] = [size(h), size(w)];
		} else if (layer.kind === 'flatten') {
			flat = r.flattenChannels ? c * h * w : h * w;
		} else if (layer.kind === 'linear') {
			if (flat === null) return null;
			params += flat * layer.out + (r.bias ? layer.out : 0);
		}
		if (h < 1 || w < 1) return null;
	}
	return flat === null ? `${c} ${h} ${w} ${params}` : `${flat} ${params}`;
}

function render(m: Model): string {
	const lines = m.layers.map((l) => {
		if (l.kind === 'conv') {
			const args = [`${l.cin}`, `${l.cout}`, `kernel_size=${l.k}`];
			if (l.s !== 1) args.push(`stride=${l.s}`);
			if (l.p !== 0) args.push(`padding=${l.p}`);
			if (l.d !== 1) args.push(`dilation=${l.d}`);
			if (l.g !== 1) args.push(`groups=${l.g}`);
			if (!l.bias) args.push('bias=False');
			return `nn.Conv2d(${args.join(', ')}),`;
		}
		if (l.kind === 'tconv') {
			const args = [`${l.cin}`, `${l.cout}`, `kernel_size=${l.k}`, `stride=${l.s}`];
			if (l.p !== 0) args.push(`padding=${l.p}`);
			if (l.op !== 0) args.push(`output_padding=${l.op}`);
			return `nn.ConvTranspose2d(${args.join(', ')}),`;
		}
		if (l.kind === 'bn') return `nn.BatchNorm2d(${l.c}),`;
		if (l.kind === 'relu') return 'nn.ReLU(),';
		if (l.kind === 'pool') return l.s === null ? `nn.MaxPool2d(${l.k}),` : `nn.MaxPool2d(${l.k}, stride=${l.s}),`;
		if (l.kind === 'flatten') return 'nn.Flatten(),';
		return `nn.LazyLinear(${l.out}),`;
	});
	const [c, h, w] = m.input;
	const batch = 8 + (h % 9) * 4;
	return [
		'import torch',
		'import torch.nn as nn',
		'',
		'model = nn.Sequential(',
		...lines.map((l) => `    ${l}`),
		')',
		`x = torch.randn(${batch}, ${c}, ${h}, ${w})  # (batch, channels, height, width)`,
		'y = model(x)'
	].join('\n');
}

const conv = (
	cin: number,
	cout: number,
	k: number,
	o: Partial<{ s: number; p: number; d: number; g: number; bias: boolean }> = {}
): Layer => ({ kind: 'conv', cin, cout, k, s: o.s ?? 1, p: o.p ?? 0, d: o.d ?? 1, g: o.g ?? 1, bias: o.bias ?? true });

function dims(rng: Rng, lo: number, hi: number): [number, number] {
	const h = rng.int(lo, hi);
	let w = rng.int(lo, hi);
	while (w === h) w = rng.int(lo, hi);
	return [h, w];
}

function scenario(rng: Rng, grade: string, classId: string): Model {
	const cin = rng.pick([1, 3, 4, 8, 16]);
	if (grade === 'middle') {
		const cout = rng.pick([8, 12, 16, 24, 32, 64]);
		if (classId === 'stride-padding') {
			const [h, w] = dims(rng, 17, 96);
			const k = rng.pick([3, 5, 7]);
			return { input: [cin, h, w], layers: [conv(cin, cout, k, { s: rng.pick([2, 3]), p: rng.int(1, 3) })] };
		}
		if (classId === 'pool') {
			const [h, w] = dims(rng, 15, 90);
			const k = rng.pick([3, 5]);
			return {
				input: [cin, h, w],
				layers: [
					conv(cin, cout, k, { p: (k - 1) / 2 }),
					{ kind: 'relu' },
					{ kind: 'pool', k: rng.pick([2, 3]), s: null }
				]
			};
		}
		if (classId === 'dilation') {
			const [h, w] = dims(rng, 20, 90);
			const d = rng.pick([2, 3, 4]);
			return {
				input: [cin, h, w],
				layers: [conv(cin, cout, rng.pick([3, 5]), { d, p: rng.int(0, d), s: rng.pick([1, 2]) })]
			};
		}
		const [h, w] = dims(rng, 17, 96);
		return {
			input: [cin, h, w],
			layers: [
				conv(cin, cout, rng.pick([3, 5]), { s: rng.pick([1, 2]), p: rng.int(1, 2), bias: false }),
				{ kind: 'bn', c: cout },
				{ kind: 'relu' }
			]
		};
	}
	const c1 = rng.pick([16, 24, 32, 48]);
	const c2 = rng.pick([32, 48, 64, 96, 128]);
	if (classId === 'chain') {
		const [h, w] = dims(rng, 33, 128);
		return {
			input: [cin, h, w],
			layers: [
				conv(cin, c1, rng.pick([3, 5, 7]), { s: 2, p: rng.int(1, 3), bias: false }),
				{ kind: 'bn', c: c1 },
				{ kind: 'relu' },
				{ kind: 'pool', k: rng.pick([2, 3]), s: null },
				conv(c1, c2, 3, { p: rng.int(0, 2), d: rng.pick([1, 2]) })
			]
		};
	}
	if (classId === 'depthwise') {
		const [h, w] = dims(rng, 25, 112);
		const c = rng.pick([16, 32, 48, 64]);
		const k = rng.pick([3, 5]);
		return {
			input: [c, h, w],
			layers: [
				conv(c, c, k, { s: 2, p: (k - 1) / 2, g: c, bias: false }),
				{ kind: 'bn', c },
				{ kind: 'relu' },
				conv(c, c2, 1, { bias: rng.bool() })
			]
		};
	}
	if (classId === 'transposed') {
		const [h, w] = dims(rng, 7, 40);
		const s = rng.pick([2, 3]);
		return {
			input: [c1, h, w],
			layers: [
				{
					kind: 'tconv',
					cin: c1,
					cout: rng.pick([8, 16, 32]),
					k: rng.pick([3, 4, 5]),
					s,
					p: rng.int(1, 2),
					op: rng.int(0, s - 1)
				}
			]
		};
	}
	const [h, w] = dims(rng, 20, 64);
	return {
		input: [cin, h, w],
		layers: [
			conv(cin, c1, rng.pick([3, 5]), { s: rng.pick([1, 2]), p: rng.int(0, 2) }),
			{ kind: 'relu' },
			{ kind: 'pool', k: 2, s: null },
			{ kind: 'flatten' },
			{ kind: 'linear', out: rng.pick([2, 5, 10, 20]) }
		]
	};
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/stride-padding': ['no-floor', 'padding-once', 'bias-forgotten'],
	'middle/pool': ['pool-stride-1', 'no-floor'],
	'middle/dilation': ['dilation-ignored'],
	'middle/bias-bn': ['bn-running-stats', 'bias-always'],
	'senior/chain': ['pool-stride-1', 'bn-running-stats', 'no-floor'],
	'senior/depthwise': ['groups-ignored'],
	'senior/transposed': ['transposed-as-conv', 'padding-once'],
	'senior/flatten-linear': ['flatten-without-channels', 'bias-forgotten']
};

const PYTHON_REFERENCE = `import json

m = json.loads(input())
c, h, w = m["input"]
flat = None
params = 0
for l in m["layers"]:
    t = l["kind"]
    if t == "conv":
        def out(x):
            return (x + 2 * l["p"] - l["d"] * (l["k"] - 1) - 1) // l["s"] + 1
        c, h, w = l["cout"], out(h), out(w)
        params += l["cout"] * (l["cin"] // l["g"]) * l["k"] ** 2 + (l["cout"] if l["bias"] else 0)
    elif t == "tconv":
        def out(x):
            return (x - 1) * l["s"] - 2 * l["p"] + (l["k"] - 1) + l["op"] + 1
        c, h, w = l["cout"], out(h), out(w)
        params += l["cin"] * l["cout"] * l["k"] ** 2 + l["cout"]
    elif t == "bn":
        params += 2 * l["c"]
    elif t == "pool":
        s = l["s"] if l["s"] is not None else l["k"]
        h, w = (h - l["k"]) // s + 1, (w - l["k"]) // s + 1
    elif t == "flatten":
        flat = c * h * w
    elif t == "linear":
        params += flat * l["out"] + l["out"]
print(f"{c} {h} {w} {params}" if flat is None else f"{flat} {params}")
`;

const QUESTION =
	'Введите через пробел четыре целых числа: число каналов, высоту и ширину тензора `y` (без размера батча) и число обучаемых параметров модели. Например: `16 31 47 4880`.';
const QUESTION_FLAT =
	'Введите через пробел два целых числа: число признаков на входе последнего линейного слоя и число обучаемых параметров модели после первого прохода (когда размер `LazyLinear` уже определён). Например: `5408 54090`.';

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 400; tries += 1) {
		const model = scenario(rng, input.grade, input.classId);
		const answer = evaluate(model, RIGHT);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = evaluate(model, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const flat = model.layers.some((l) => l.kind === 'flatten');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Модель на PyTorch получает тензор `x` формы (batch, channels, height, width).',
					'',
					flat ? QUESTION_FLAT : QUESTION
				].join('\n'),
				code: { language: 'python3', source: render(model) }
			},
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(model) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
