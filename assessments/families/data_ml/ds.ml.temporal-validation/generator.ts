// Validation of a model on time-ordered samples whose labels look into the future: which days a training set keeps
// when the days whose label window reaches into the validation are purged — with an expanding or a sliding window,
// in K-fold over time with an embargo, and with labels of different lengths.
import { frameMarkdown, stdinJson, type Cell } from '../../_lib/ds.ts';
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

const PLOTS = [
	'отток клиента в ближайшие h дней',
	'рост цены товара за следующие h дней',
	'возврат пользователя в следующие h дней',
	'отказ оборудования в ближайшие h дней'
] as const;

interface Task {
	markdown: string;
	answer: string;
	wrong: Record<string, string | null>;
	probe: object;
}

const LABEL_RULE = (h: number, plot: string): string =>
	`Каждый день t — одна строка выборки; признаки — данные до дня t включительно, метка — ${plot.replace('h', String(h))}, то есть метка дня t вычисляется по дням t + 1 … t + ${h}.`;

const PURGE_RULE =
	'Чтобы не было утечки, из обучения выбрасывают каждый день, у которого хотя бы один день окна метки попадает в валидационные дни.';

function task(rng: Rng, classId: string): Task | null {
	const plot = rng.pick(PLOTS);
	if (classId === 'event-labels') {
		const n = rng.int(20, 30);
		const k = rng.int(3, 5);
		if (n % k !== 0) return null;
		const size = n / k;
		const f = rng.int(2, k - 1);
		const a = (f - 1) * size + 1;
		const b = f * size;
		const ends = Array.from({ length: n }, (_, i) => Math.min(n, i + 1 + rng.int(1, 6)));
		const span = Math.max(...ends.slice(a - 1, b));
		const days = Array.from({ length: n }, (_, i) => i + 1);
		const outside = days.filter((t) => t < a || t > b);
		const overlaps = (t: number): boolean => t <= span && (ends[t - 1] ?? 0) >= a;
		const show = (xs: number[]): string => (xs.length ? xs.join(' ') : '-');
		return {
			markdown: [
				`Каждый день t (1…${n}) — одна строка выборки; метка дня t определяется событием, которое наступает в день \`label_end\` (окно метки — дни t … label_end):`,
				'',
				frameMarkdown(
					['day', 'label_end'],
					days.map((t): Cell[] => [t, ends[t - 1] ?? t])
				),
				'',
				`Модель проверяют K-fold по времени без перемешивания: ${k} фолдов по ${size} дней подряд, на итерации i валидация — фолд i, обучение — остальные дни по обе стороны. На итерации ${f} валидационные дни — ${a}…${b}.`,
				'',
				`Из обучения выбрасывают каждый день, чьё окно метки пересекается с отрезком от первого валидационного дня до самого позднего \`label_end\` среди валидационных дней.`,
				'',
				`Какие дни выбросят из обучения на итерации ${f}? Введите их номера через пробел по возрастанию (если таких нет — \`-\`).`
			].join('\n'),
			answer: show(outside.filter(overlaps)),
			wrong: {
				'start-only': show(outside.filter((t) => t < a && overlaps(t))),
				'after-only': show(outside.filter((t) => t > b && overlaps(t)))
			},
			probe: { kind: 'event', ends, a, b }
		};
	}
	const h = rng.int(2, 5);
	if (classId === 'purged-kfold') {
		const k = rng.int(4, 6);
		const size = rng.int(8, 16);
		const n = k * size;
		const f = rng.int(2, k - 1);
		const embargo = rng.int(1, 4);
		const a = (f - 1) * size + 1;
		const b = f * size;
		const answer = (purge: number, emb: number, before = 0): string => {
			const lastBefore = a - purge - before - 1;
			const firstAfter = b + emb + 1;
			return `${lastBefore + (n - firstAfter + 1)} ${lastBefore} ${firstAfter}`;
		};
		return {
			markdown: [
				`${LABEL_RULE(h, plot)} Всего ${n} дней.`,
				'',
				`Модель проверяют K-fold по времени без перемешивания: ${k} фолдов по ${size} дней подряд; на итерации i валидация — фолд i, обучение — дни по обе стороны от него. ${PURGE_RULE} Кроме того, действует эмбарго длиной ${embargo}: столько дней сразу после последнего валидационного дня тоже выбрасывают из обучения.`,
				'',
				`Введите для итерации ${f} три числа через пробел: сколько дней останется в обучении, последний день обучения перед валидацией и первый день обучения после неё.`
			].join('\n'),
			answer: answer(h, embargo),
			wrong: {
				'no-purge': answer(0, embargo),
				'purge-one-less': answer(h - 1, embargo),
				'no-embargo': answer(h, 0),
				'embargo-before': answer(h, 0, embargo)
			},
			probe: { kind: 'kfold', n, k, f, h, embargo }
		};
	}
	const splits = rng.int(3, 5);
	const val = rng.int(5, 10);
	const n = rng.int(40, 90);
	const f = rng.int(1, splits);
	const a = n - (splits - f + 1) * val + 1;
	const b = a + val - 1;
	if (a - h - 1 < 5) return null;
	const scheme = `Модель проверяют на ${splits} итерациях: валидационные блоки — последние ${splits * val} дней по ${val} дней подряд, на итерации i валидация — i-й из этих блоков; на итерации ${f} это дни ${a}…${b}.`;
	if (classId === 'walk-forward') {
		const range = (purge: number): string => `1 ${a - purge - 1}`;
		return {
			markdown: [
				`${LABEL_RULE(h, plot)} Всего ${n} дней.`,
				'',
				`${scheme} Обучение — все дни до валидации (окно расширяется). ${PURGE_RULE}`,
				'',
				`Введите через пробел первый и последний день обучения на итерации ${f}.`
			].join('\n'),
			answer: range(h),
			wrong: { 'no-purge': range(0), 'purge-one-less': range(h - 1) },
			probe: { kind: 'expanding', a, h, window: null }
		};
	}
	const window = rng.int(10, 25);
	if (a - h - window < 1) return null;
	const range = (first: number, last: number): string => `${first} ${last}`;
	return {
		markdown: [
			`${LABEL_RULE(h, plot)} Всего ${n} дней.`,
			'',
			`${scheme} ${PURGE_RULE} Обучение — ${window} последних дней, оставшихся до валидации после этой очистки (окно скользит).`,
			'',
			`Введите через пробел первый и последний день обучения на итерации ${f}.`
		].join('\n'),
		answer: range(a - h - window, a - h - 1),
		wrong: {
			'no-purge': range(a - window, a - 1),
			'purge-one-less': range(a - h + 1 - window, a - h),
			'window-includes-gap': range(a - window, a - h - 1)
		},
		probe: { kind: 'expanding', a, h, window }
	};
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
kind = p["kind"]
if kind == "event":
    ends, a, b = p["ends"], p["a"], p["b"]
    span = max(ends[t - 1] for t in range(a, b + 1))
    out = [t for t in range(1, len(ends) + 1) if not a <= t <= b and t <= span and ends[t - 1] >= a]
    print(" ".join(map(str, out)) if out else "-")
elif kind == "kfold":
    size = p["n"] // p["k"]
    a, b = (p["f"] - 1) * size + 1, p["f"] * size
    train = [t for t in range(1, p["n"] + 1) if t < a or t > b]
    train = [t for t in train if not (t < a and t + p["h"] >= a)]
    train = [t for t in train if not (b < t <= b + p["embargo"])]
    print(len(train), max(t for t in train if t < a), min(t for t in train if t > b))
else:
    a, h = p["a"], p["h"]
    clean = [t for t in range(1, a) if t + h < a]
    if p["window"] is not None:
        clean = clean[-p["window"]:]
    print(clean[0], clean[-1])
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 400; tries += 1) {
		const t = task(rng, input.classId);
		if (t === null) continue;
		if (Object.values(t.wrong).some((w) => w === t.answer)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: t.markdown, code: null },
			answer: { kind: 'tokens', value: t.answer }
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, t.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(t.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
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
