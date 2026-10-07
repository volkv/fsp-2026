// Parameters and memory of attention: the trainable parameters of multi-head attention, of a Transformer encoder and
// of grouped-query attention, and the bytes of a KV cache at inference. Which projections exist, their biases, the
// LayerNorms, the feed-forward pair and the number of key-value heads decide the answer.
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

interface Params {
	kind: 'mha' | 'kv' | 'encoder' | 'gqa';
	d: number;
	heads: number;
	kvHeads: number;
	headDim: number;
	layers: number;
	bias: boolean;
	ff: number;
	batch: number;
	seq: number;
	bytes: number;
}

interface Rules {
	outProj: boolean;
	sharedHeads: boolean;
	bias: boolean;
	layerNorm: boolean;
	ffnPair: boolean;
	kvPair: boolean;
	kvHeads: boolean;
	headDim: boolean;
}

const RIGHT: Rules = {
	outProj: true,
	sharedHeads: true,
	bias: true,
	layerNorm: true,
	ffnPair: true,
	kvPair: true,
	kvHeads: true,
	headDim: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-out-proj': { outProj: false },
	'heads-multiply': { sharedHeads: false },
	'bias-ignored': { bias: false },
	'layernorm-forgotten': { layerNorm: false },
	'ffn-one-matrix': { ffnPair: false },
	'keys-only': { kvPair: false },
	'query-heads': { kvHeads: false },
	'head-dim-is-model-dim': { headDim: false }
};

function mhaParams(p: Params, r: Rules): number {
	const d = p.d;
	// Q, K and V projections are d × d in total (split into heads), plus the output projection.
	const qkv = r.sharedHeads ? 3 * d * d : 3 * p.heads * d * d;
	const qkvBias = p.bias && r.bias ? (r.sharedHeads ? 3 * d : 3 * p.heads * d) : 0;
	const out = r.outProj ? d * d + (p.bias && r.bias ? d : 0) : 0;
	return qkv + qkvBias + out;
}

function evaluate(p: Params, r: Rules): number {
	if (p.kind === 'mha') return p.layers * mhaParams(p, r);
	if (p.kind === 'encoder') {
		const ffn = r.ffnPair ? p.d * p.ff + p.ff + p.ff * p.d + p.d : p.d * p.ff + p.ff;
		const norms = r.layerNorm ? 2 * 2 * p.d : 0;
		return p.layers * (mhaParams(p, r) + ffn + norms);
	}
	if (p.kind === 'gqa') {
		const kv = r.kvHeads ? p.kvHeads : p.heads;
		const q = p.d * p.heads * p.headDim;
		const out = r.outProj ? p.heads * p.headDim * p.d : 0;
		return p.layers * (q + 2 * p.d * kv * p.headDim + out);
	}
	const kv = r.kvHeads ? p.kvHeads : p.heads;
	const dim = r.headDim ? p.headDim : p.d;
	return (r.kvPair ? 2 : 1) * p.layers * p.batch * p.seq * kv * dim * p.bytes;
}

function scenario(rng: Rng, classId: string): Params {
	const heads = rng.pick([4, 8, 12, 16, 32]);
	const headDim = rng.pick([32, 48, 64, 80, 96, 128]);
	const d = heads * headDim;
	const base: Params = {
		kind: 'mha',
		d,
		heads,
		kvHeads: heads,
		headDim,
		layers: rng.int(2, 32),
		bias: true,
		ff: 0,
		batch: 1,
		seq: 0,
		bytes: 2
	};
	if (classId === 'mha-stack') return { ...base, bias: rng.bool(0.7) };
	if (classId === 'encoder-block')
		return {
			...base,
			kind: 'encoder',
			layers: rng.int(2, 24),
			ff: d * rng.pick([2, 3, 4]) + rng.pick([0, 0, 256, 512])
		};
	const kvHeads = rng.pick([1, 2, 4, 8].filter((k) => k < heads));
	if (classId === 'gqa') return { ...base, kind: 'gqa', kvHeads, d: rng.pick([d, d, 1024, 2048, 4096]), bias: false };
	return {
		...base,
		kind: 'kv',
		kvHeads,
		batch: rng.pick([1, 2, 4, 8, 16]),
		seq: rng.pick([512, 1024, 2048, 4096, 8192]) + rng.pick([0, 0, 128, 256]),
		bytes: rng.pick([2, 2, 4])
	};
}

function render(p: Params): { markdown: string; code: string } {
	if (p.kind === 'mha') {
		return {
			markdown:
				'Сколько обучаемых параметров у модуля `blocks`? Введите одно целое число. Параметры модулей PyTorch — значения по умолчанию, кроме указанных.',
			code: [
				'import torch.nn as nn',
				'',
				`blocks = nn.ModuleList([`,
				`    nn.MultiheadAttention(embed_dim=${p.d}, num_heads=${p.heads}${p.bias ? '' : ', bias=False'})`,
				`    for _ in range(${p.layers})`,
				'])'
			].join('\n')
		};
	}
	if (p.kind === 'encoder') {
		return {
			markdown:
				'Сколько обучаемых параметров у `encoder`? Введите одно целое число. Параметры модулей PyTorch — значения по умолчанию, кроме указанных (у `TransformerEncoder` нет финальной нормализации: `norm=None`).',
			code: [
				'import torch.nn as nn',
				'',
				`layer = nn.TransformerEncoderLayer(d_model=${p.d}, nhead=${p.heads}, dim_feedforward=${p.ff}, batch_first=True)`,
				`encoder = nn.TransformerEncoder(layer, num_layers=${p.layers})  # копии слоя с независимыми весами`
			].join('\n')
		};
	}
	if (p.kind === 'gqa') {
		return {
			markdown: `Слой внимания с группированными запросами (grouped-query attention): ${p.heads} голов запросов делят ${p.kvHeads} голов ключей и значений. В модели ${p.layers} таких слоёв. Сколько обучаемых параметров у всех слоёв внимания модели вместе? Введите одно целое число.`,
			code: [
				'import torch.nn as nn',
				'',
				`d_model, n_heads, n_kv_heads, head_dim = ${p.d}, ${p.heads}, ${p.kvHeads}, ${p.headDim}`,
				'',
				'class Attention(nn.Module):',
				'    def __init__(self):',
				'        super().__init__()',
				'        self.q_proj = nn.Linear(d_model, n_heads * head_dim, bias=False)',
				'        self.k_proj = nn.Linear(d_model, n_kv_heads * head_dim, bias=False)',
				'        self.v_proj = nn.Linear(d_model, n_kv_heads * head_dim, bias=False)',
				'        self.o_proj = nn.Linear(n_heads * head_dim, d_model, bias=False)'
			].join('\n')
		};
	}
	const dtype = p.bytes === 2 ? 'bfloat16' : 'float32';
	return {
		markdown: [
			`Декодер генерирует текст с KV-кэшем: для каждого слоя и каждого уже обработанного токена хранятся ключи и значения всех голов ключей-значений. Конфигурация модели и запроса — ниже, кэш хранится в \`${dtype}\` (${p.bytes} байта на число).`,
			'',
			'Сколько байт займёт KV-кэш, когда в каждой последовательности батча обработано `seq_len` токенов? Введите одно целое число.'
		].join('\n'),
		code: [
			'config = {',
			`    "num_layers": ${p.layers},`,
			`    "d_model": ${p.d},`,
			`    "num_attention_heads": ${p.heads},`,
			`    "num_key_value_heads": ${p.kvHeads},`,
			`    "head_dim": ${p.headDim},`,
			'}',
			`batch_size, seq_len = ${p.batch}, ${p.seq}`
		].join('\n')
	};
}

const REQUIRED: Record<string, string[]> = {
	'mha-stack': ['no-out-proj', 'heads-multiply'],
	'kv-cache': ['keys-only', 'query-heads', 'head-dim-is-model-dim'],
	'encoder-block': ['layernorm-forgotten', 'ffn-one-matrix'],
	gqa: ['query-heads', 'no-out-proj']
};

const PYTHON_REFERENCE = `import json

p = json.loads(input())
d, L = p["d"], p["layers"]

def attention(bias):
    in_proj = 3 * d * d + (3 * d if bias else 0)
    out_proj = d * d + (d if bias else 0)
    return in_proj + out_proj

kind = p["kind"]
if kind == "mha":
    total = L * attention(p["bias"])
elif kind == "encoder":
    f = p["ff"]
    linear1 = d * f + f
    linear2 = f * d + d
    norms = 2 * (d + d)
    total = L * (attention(True) + linear1 + linear2 + norms)
elif kind == "gqa":
    hd = p["headDim"]
    q = d * p["heads"] * hd
    k = d * p["kvHeads"] * hd
    v = d * p["kvHeads"] * hd
    o = p["heads"] * hd * d
    total = L * (q + k + v + o)
else:
    per_token_layer = 2 * p["kvHeads"] * p["headDim"] * p["bytes"]
    total = per_token_layer * L * p["batch"] * p["seq"]
print(total)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	for (let tries = 0; tries < 200; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = String(evaluate(p, RIGHT));
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = String(evaluate(p, { ...RIGHT, ...change }));
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const shown = render(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: shown.markdown, code: { language: 'python3', source: shown.code } },
			answer: { kind: 'exact', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'exact' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
