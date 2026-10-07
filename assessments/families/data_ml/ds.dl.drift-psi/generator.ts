// Data drift in production monitoring: the population stability index of a binned feature, with smoothing of empty
// bins and with the monitor's coarser bins, and the two-sample Kolmogorov–Smirnov statistic with ties.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { floatAnswer, frameMarkdown, roundingRule } from '../../_lib/ds.ts';
import type { ComputedAnswer } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const SMOOTHING = 0.5;
const FEATURES = [
	'age',
	'income',
	'tenure_days',
	'num_orders',
	'avg_check',
	'session_len',
	'days_since_login',
	'credit_limit',
	'num_devices',
	'basket_size',
	'region_code',
	'discount_share'
] as const;

interface Binned {
	name: string;
	expected: number[];
	actual: number[];
}

interface Task {
	kind: 'psi' | 'psi-smoothing' | 'ks' | 'psi-merged';
	features: Binned[];
	left: number[];
	right: number[];
}

interface Rules {
	shares: boolean;
	symmetric: boolean;
	naturalLog: boolean;
	smoothAll: boolean;
	renormalize: boolean;
	groupTies: boolean;
	allPoints: boolean;
	merge: boolean;
}

const RIGHT: Rules = {
	shares: true,
	symmetric: true,
	naturalLog: true,
	smoothAll: true,
	renormalize: true,
	groupTies: true,
	allPoints: true,
	merge: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'counts-not-shares': { shares: false },
	'one-sided-kl': { symmetric: false },
	log10: { naturalLog: false },
	'smooth-empty-only': { smoothAll: false },
	'no-renormalize': { renormalize: false },
	'ties-split': { groupTies: false },
	'first-sample-points': { allPoints: false },
	'no-merge': { merge: false }
};

function psi(f: Binned, r: Rules, smoothing: boolean): number {
	const prepare = (counts: readonly number[]): number[] => {
		const anyEmpty = counts.some((c) => c === 0);
		const add = (c: number): number => (smoothing && (r.smoothAll || (anyEmpty && c === 0)) ? c + SMOOTHING : c);
		const smoothed = counts.map(add);
		const raw = counts.reduce((s, c) => s + c, 0);
		const total = r.renormalize ? smoothed.reduce((s, c) => s + c, 0) : raw;
		return r.shares ? smoothed.map((c) => c / total) : smoothed;
	};
	const e = prepare(f.expected);
	const a = prepare(f.actual);
	const ln = (x: number): number => (r.naturalLog ? Math.log(x) : Math.log10(x));
	return e.reduce((sum, ei, i) => {
		const ai = a[i] ?? 0;
		return sum + (r.symmetric ? (ai - ei) * ln(ai / ei) : ai * ln(ai / ei));
	}, 0);
}

function ks(left: readonly number[], right: readonly number[], r: Rules): number {
	const n = left.length;
	const m = right.length;
	if (!r.groupTies) {
		// Steps through the merged sample one element at a time, the first sample first on a tie.
		const merged = [...left.map((v) => ({ v, s: 0 })), ...right.map((v) => ({ v, s: 1 }))].sort(
			(a, b) => a.v - b.v || a.s - b.s
		);
		let i = 0;
		let j = 0;
		let best = 0;
		for (const x of merged) {
			if (x.s === 0) i += 1;
			else j += 1;
			best = Math.max(best, Math.abs(i / n - j / m));
		}
		return best;
	}
	const points = r.allPoints ? [...left, ...right] : [...left];
	let best = 0;
	for (const x of points) {
		const fl = left.filter((v) => v <= x).length / n;
		const fr = right.filter((v) => v <= x).length / m;
		best = Math.max(best, Math.abs(fl - fr));
	}
	return best;
}

function evaluate(t: Task, r: Rules): ComputedAnswer | null {
	if (t.kind === 'ks') return floatAnswer(ks(t.left, t.right, r), DIGITS);
	const f = t.features[0];
	if (!f) return null;
	if (t.kind === 'psi-merged' && r.merge) return floatAnswer(psi(merged(f), r, false), DIGITS);
	return floatAnswer(psi(f, r, t.kind === 'psi-smoothing'), DIGITS);
}

/** The monitor's bins: fine bins joined in pairs, (b1, b2), (b3, b4), … */
function merged(f: Binned): Binned {
	const pairs = (c: readonly number[]): number[] =>
		Array.from({ length: c.length / 2 }, (_, k) => (c[2 * k] ?? 0) + (c[2 * k + 1] ?? 0));
	return { name: f.name, expected: pairs(f.expected), actual: pairs(f.actual) };
}

/** Counts of `bins` bins summing to `total`, drawn around the shares `base` with a shift of size `shift`. */
function counts(rng: Rng, base: readonly number[], shift: number, total: number): number[] {
	const weights = base.map((b) => Math.max(0.005, b * (1 + (rng.next() * 2 - 1) * shift)));
	const sum = weights.reduce((s, w) => s + w, 0);
	const out = weights.map((w) => Math.max(1, Math.round((w / sum) * total)));
	return out;
}

function baseShares(rng: Rng, bins: number): number[] {
	const raw = Array.from({ length: bins }, () => 0.5 + rng.next());
	const sum = raw.reduce((s, x) => s + x, 0);
	return raw.map((x) => x / sum);
}

function binned(rng: Rng, name: string, shift: number, bins: number): Binned {
	const base = baseShares(rng, bins);
	return {
		name,
		expected: counts(rng, base, 0.1, rng.int(20, 60) * 100),
		actual: counts(rng, base, shift, rng.int(5, 30) * 100)
	};
}

function scenario(rng: Rng, kind: Task['kind']): Task {
	const empty = { features: [] as Binned[], left: [] as number[], right: [] as number[] };
	if (kind === 'psi')
		return { ...empty, kind, features: [binned(rng, rng.pick(FEATURES), rng.pick([0.3, 0.6, 0.9]), rng.int(5, 8))] };
	if (kind === 'psi-smoothing') {
		const f = binned(rng, rng.pick(FEATURES), rng.pick([0.3, 0.6]), rng.int(5, 8));
		// One bin of production data is empty: a new category stopped coming, or a cut-off moved.
		const k = rng.int(0, f.actual.length - 1);
		f.actual[k] = 0;
		return { ...empty, kind, features: [f] };
	}
	if (kind === 'ks') {
		const n = rng.int(6, 10);
		const m = rng.int(6, 10);
		const shift = rng.int(0, 3);
		return {
			...empty,
			kind,
			left: Array.from({ length: n }, () => rng.int(1, 12)).sort((a, b) => a - b),
			right: Array.from({ length: m }, () => rng.int(1, 12) + shift).sort((a, b) => a - b)
		};
	}
	return {
		...empty,
		kind,
		features: [binned(rng, rng.pick(FEATURES), rng.pick([0.4, 0.7, 1.0]), rng.pick([8, 10, 12]))]
	};
}

function table(f: Binned): string {
	return frameMarkdown(
		['корзина', 'базовый период', 'прод'],
		f.expected.map((e, i) => [`b${i + 1}`, e, f.actual[i] ?? 0])
	);
}

const PSI_RULE = 'PSI = Σ (aᵢ − eᵢ) · ln(aᵢ / eᵢ) по корзинам, где eᵢ и aᵢ — доли корзины в базовом периоде и в проде.';

function render(t: Task): string {
	if (t.kind === 'psi') {
		return [
			`Мониторинг модели сравнивает распределение признака \`${t.features[0]?.name}\` в проде с базовым периодом (обучающими данными). Число объектов по корзинам:`,
			'',
			table(t.features[0] as Binned),
			'',
			`${PSI_RULE} Вычислите PSI признака. ${roundingRule(DIGITS)}`
		].join('\n');
	}
	if (t.kind === 'psi-smoothing') {
		return [
			`Мониторинг модели сравнивает распределение признака \`${t.features[0]?.name}\` в проде с базовым периодом. Число объектов по корзинам:`,
			'',
			table(t.features[0] as Binned),
			'',
			`${PSI_RULE} Чтобы логарифм был определён, мониторинг сглаживает счётчики: к числу объектов **каждой** корзины обоих периодов прибавляется ${SMOOTHING}, и доли считаются от сглаженных счётчиков. Вычислите PSI. ${roundingRule(DIGITS)}`
		].join('\n');
	}
	if (t.kind === 'ks') {
		return [
			'Значения признака (целые) в выборке базового периода и в выборке из прода:',
			'',
			`- базовый период: ${t.left.join(', ')}`,
			`- прод: ${t.right.join(', ')}`,
			'',
			`Вычислите статистику двухвыборочного критерия Колмогорова — Смирнова D = sup |F₁(x) − F₂(x)|, где F₁ и F₂ — эмпирические функции распределения выборок. ${roundingRule(DIGITS)}`
		].join('\n');
	}
	return [
		`Признак \`${t.features[0]?.name}\` разбит на мелкие корзины. Число объектов по ним в базовом периоде и в проде:`,
		'',
		table(t.features[0] as Binned),
		'',
		`Мониторинг считает PSI не по мелким корзинам, а по укрупнённым: соседние корзины объединяются парами — (b1, b2), (b3, b4) и так далее. ${PSI_RULE} Вычислите PSI, который покажет мониторинг. ${roundingRule(DIGITS)}`
	].join('\n');
}

const REQUIRED: Record<string, string[]> = {
	psi: ['counts-not-shares', 'one-sided-kl', 'log10'],
	'psi-smoothing': ['smooth-empty-only', 'no-renormalize'],
	ks: ['ties-split'],
	'psi-merged': ['no-merge', 'counts-not-shares']
};

const PYTHON_REFERENCE = `import json
import math

t = json.loads(input())
kind = t["kind"]

def shares(counts, add):
    c = [x + add for x in counts]
    total = sum(c)
    return [x / total for x in c]

def psi(f, add):
    e = shares(f["expected"], add)
    a = shares(f["actual"], add)
    return sum((ai - ei) * math.log(ai / ei) for ai, ei in zip(a, e))

if kind == "psi":
    print(repr(psi(t["features"][0], 0)))
elif kind == "psi-smoothing":
    print(repr(psi(t["features"][0], ${SMOOTHING})))
elif kind == "ks":
    x, y = t["left"], t["right"]
    def ecdf(s, v):
        return sum(1 for u in s if u <= v) / len(s)
    print(repr(max(abs(ecdf(x, v) - ecdf(y, v)) for v in sorted(set(x + y)))))
else:
    f = t["features"][0]
    def pairs(c):
        return [c[k] + c[k + 1] for k in range(0, len(c), 2)]
    print(repr(psi({"expected": pairs(f["expected"]), "actual": pairs(f["actual"])}, 0)))
`;

function distinct(right: ComputedAnswer, wrong: ComputedAnswer): boolean {
	if (right.kind === 'float_eps' && wrong.kind === 'float_eps')
		return (
			Math.abs(right.value - wrong.value) >=
			5 * 10 ** -DIGITS * Math.max(1, Math.abs(right.value), Math.abs(wrong.value))
		);
	return JSON.stringify(right) !== JSON.stringify(wrong);
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const kind = input.classId as Task['kind'];
	const required = REQUIRED[kind] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const t = scenario(rng, kind);
		const answer = evaluate(t, RIGHT);
		if (answer === null) continue;
		if (answer.kind === 'float_eps' && answer.value < 0.005) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = evaluate(t, { ...RIGHT, ...change });
				return [id, value === null || JSON.stringify(value) === JSON.stringify(answer) ? null : value];
			})
		);
		if (Object.values(wrong).some((value) => value !== null && !distinct(answer, value))) continue;
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: render(t), code: null },
			answer
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(t) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: value }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no task for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
