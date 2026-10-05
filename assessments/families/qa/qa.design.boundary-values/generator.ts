// Boundary value analysis: the test values of an integer input by the two-point or the three-point method, given the
// requirement in words — closed and strict comparisons, adjacent tiers with their own behaviour, values excluded from
// the range and a stricter limit of one mode of operation on top of the general one.
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

type Op = 'ge' | 'gt' | 'le' | 'lt' | 'eq';

/** What a condition limits: the field as a whole, a tier inside it, a value cut out of it, or one mode only. */
type Role = 'limit' | 'tier' | 'excluded' | 'mode';

interface Cond {
	op: Op;
	n: number;
	role: Role;
}

/** A rule fires when all its conditions hold; the first rule that fires gives the behaviour, none — a rejection. */
interface Rule {
	outcome: string;
	conds: Cond[];
}

interface Params {
	points: 2 | 3;
	rules: Rule[];
	lines: string[];
	plot: Plot;
}

interface Rules {
	strictAsInclusive: boolean;
	insideOnly: boolean;
	outerOnly: boolean;
	points: 'right' | 'two' | 'three';
	excluded: boolean;
	modeLimit: boolean;
}

const RIGHT: Rules = {
	strictAsInclusive: false,
	insideOnly: false,
	outerOnly: false,
	points: 'right',
	excluded: true,
	modeLimit: true
};

const REJECT = 'reject';

interface Plot {
	system: string;
	field: string;
	unit: string;
	step: number;
	lo: number;
	hi: number;
	accept: string;
	refuse: string;
	tiers: readonly string[];
	modes: readonly [string, string];
}

const PLOTS: readonly Plot[] = [
	{
		system: 'Интернет-магазин',
		field: 'Сумма заказа',
		unit: '₽',
		step: 10,
		lo: 100,
		hi: 300000,
		accept: 'заказ оформляется',
		refuse: 'заказ не оформляется, показывается ошибка',
		tiers: ['без скидки', 'скидка 3 %', 'скидка 5 %', 'скидка 7 %', 'скидка 10 %'],
		modes: ['курьерская доставка', 'доставка в пункт выдачи']
	},
	{
		system: 'Служба доставки',
		field: 'Вес посылки',
		unit: 'г',
		step: 10,
		lo: 50,
		hi: 60000,
		accept: 'посылка принимается',
		refuse: 'посылка не принимается',
		tiers: ['тариф «Письмо»', 'тариф «Лёгкий»', 'тариф «Средний»', 'тариф «Тяжёлый»', 'тариф «Грузовой»'],
		modes: ['доставка курьером', 'доставка в постамат']
	},
	{
		system: 'Мобильный банк',
		field: 'Сумма перевода',
		unit: '₽',
		step: 100,
		lo: 100,
		hi: 900000,
		accept: 'перевод выполняется',
		refuse: 'перевод отклоняется',
		tiers: ['без комиссии', 'комиссия 0,5 %', 'комиссия 1 %', 'комиссия 1,5 %', 'комиссия 2 %'],
		modes: ['перевод по номеру телефона', 'перевод по номеру карты']
	},
	{
		system: 'Сервис бронирования отелей',
		field: 'Стоимость брони',
		unit: '₽',
		step: 50,
		lo: 500,
		hi: 400000,
		accept: 'бронь создаётся',
		refuse: 'бронь не создаётся',
		tiers: ['кешбэк 0 %', 'кешбэк 2 %', 'кешбэк 4 %', 'кешбэк 6 %', 'кешбэк 8 %'],
		modes: ['оплата картой', 'оплата баллами']
	},
	{
		system: 'Сервис аренды самокатов',
		field: 'Длительность поездки',
		unit: 'мин',
		step: 1,
		lo: 1,
		hi: 1440,
		accept: 'поездка оплачивается',
		refuse: 'поездка отклоняется и уходит на ручную проверку',
		tiers: ['тариф «Короткий»', 'тариф «Стандарт»', 'тариф «Долгий»', 'тариф «День»', 'тариф «Сутки»'],
		modes: ['поминутный тариф', 'абонемент']
	}
];

const holds = (c: Cond, x: number): boolean =>
	c.op === 'ge' ? x >= c.n : c.op === 'gt' ? x > c.n : c.op === 'le' ? x <= c.n : c.op === 'lt' ? x < c.n : x === c.n;

/** The rules as a misconception reads them. */
function readRules(p: Params, rules: Rules): Rule[] {
	return p.rules
		.filter((rule) => rules.excluded || !rule.conds.some((c) => c.role === 'excluded'))
		.map((rule) => ({
			outcome: rule.outcome,
			conds: rule.conds
				.filter((c) => rules.modeLimit || c.role !== 'mode')
				.map((c): Cond => {
					if (!rules.strictAsInclusive) return c;
					return c.op === 'gt' ? { ...c, op: 'ge' } : c.op === 'lt' ? { ...c, op: 'le' } : c;
				})
		}));
}

function outcome(rules: readonly Rule[], x: number): string {
	return rules.find((rule) => rule.conds.every((c) => holds(c, x)))?.outcome ?? REJECT;
}

/** The test values, ascending. */
function solve(p: Params, rules: Rules): number[] {
	const read = readRules(p, rules);
	const points = rules.points === 'right' ? p.points : rules.points === 'two' ? 2 : 3;
	const values = new Set<number>();
	const conds = read.flatMap((rule) => rule.conds);
	if (points === 3) {
		for (const c of conds) {
			if (rules.outerOnly && c.role === 'tier') continue;
			for (const v of [c.n - 1, c.n, c.n + 1]) values.add(v);
		}
	} else {
		// Behaviour changes only next to a number of the requirements.
		const xs = new Set(conds.flatMap((c) => [c.n - 2, c.n - 1, c.n, c.n + 1]));
		for (const x of xs) {
			const left = outcome(read, x);
			const right = outcome(read, x + 1);
			if (left === right) continue;
			if (rules.outerOnly && left !== REJECT && right !== REJECT) continue;
			values.add(x);
			values.add(x + 1);
		}
	}
	const out = [...values].filter((v) => !rules.insideOnly || outcome(p.rules, v) !== REJECT);
	return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

/** `count` ascending multiples of the plot's step, at least `gap` steps apart. */
function points(rng: Rng, plot: Plot, count: number, gap: number): number[] {
	const loK = Math.ceil(plot.lo / plot.step);
	const hiK = Math.floor(plot.hi / plot.step);
	for (let tries = 0; tries < 100; tries += 1) {
		const ks = [...new Set(Array.from({ length: count }, () => rng.int(loK, hiK)))].sort((a, b) => a - b);
		if (ks.length === count && ks.every((k, i) => i === 0 || k - (ks[i - 1] ?? 0) >= gap)) {
			return ks.map((k) => k * plot.step);
		}
	}
	throw new Error('boundary-values: no points');
}

const num = (n: number): string => n.toLocaleString('ru-RU').replaceAll(' ', ' ');

/** The lower end of a range: from `n` on (inclusive) or above `n` (strict). */
function lower(n: number, strict: boolean, role: Role): Cond {
	return { op: strict ? 'gt' : 'ge', n, role };
}

function upper(n: number, strict: boolean, role: Role): Cond {
	return { op: strict ? 'lt' : 'le', n, role };
}

/** A range in words: «от 10 до 20 включительно», «больше 10 и меньше 20», … */
function rangeText(lo: Cond, hi: Cond, unit: string): string {
	const from = lo.op === 'ge' ? `не меньше ${num(lo.n)} ${unit}` : `больше ${num(lo.n)} ${unit}`;
	const to = hi.op === 'le' ? `не больше ${num(hi.n)} ${unit}` : `меньше ${num(hi.n)} ${unit}`;
	if (lo.op === 'ge' && hi.op === 'le') return `от ${num(lo.n)} до ${num(hi.n)} ${unit} включительно`;
	return `${from} и ${to}`;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const plot = rng.pick(PLOTS);
	const u = plot.unit;
	if (grade === 'intern') {
		if (classId === 'closed' || classId === 'strict' || classId === 'three-point') {
			const [a = 0, b = 0] = points(rng, plot, 2, 8);
			let strictLo = false;
			let strictHi = false;
			if (classId === 'strict') {
				const kind = rng.int(0, 2);
				strictLo = kind !== 1;
				strictHi = kind !== 0;
			} else if (classId === 'three-point') {
				strictLo = rng.bool();
				strictHi = rng.bool();
			}
			const lo = lower(a, strictLo, 'limit');
			const hi = upper(b, strictHi, 'limit');
			return {
				points: classId === 'three-point' ? 3 : 2,
				rules: [{ outcome: 'accept', conds: [lo, hi] }],
				lines: [
					`- если значение ${rangeText(lo, hi, u)}, ${plot.accept};`,
					`- при любом другом значении ${plot.refuse}.`
				],
				plot
			};
		}
		// Two adjacent tiers inside the limits.
		const [a = 0, t = 0, b = 0] = points(rng, plot, 3, 8);
		const lo = lower(a, rng.bool(0.3), 'limit');
		const hi = upper(b, rng.bool(0.3), 'limit');
		const cutStrict = rng.bool();
		const tiers = rng.sample(plot.tiers, 2);
		const first = upper(t, cutStrict, 'tier');
		const second = lower(t, !cutStrict, 'tier');
		return {
			points: 2,
			rules: [
				{ outcome: tiers[0] ?? '', conds: [lo, first] },
				{ outcome: tiers[1] ?? '', conds: [second, hi] }
			],
			lines: [
				`- ${rangeText(lo, first, u)} — ${plot.accept}, ${tiers[0] ?? ''};`,
				`- ${rangeText(second, hi, u)} — ${plot.accept}, ${tiers[1] ?? ''};`,
				`- при любом другом значении ${plot.refuse}.`
			],
			plot
		};
	}
	if (classId === 'tiers' || classId === 'three-point-tiers') {
		const count = rng.int(3, 4);
		const ns = points(rng, plot, count + 1, 8);
		const names = rng.sample(plot.tiers, count);
		const rules: Rule[] = [];
		const lines: string[] = [];
		let lo = lower(ns[0] ?? 0, rng.bool(0.4), 'limit');
		for (let i = 0; i < count; i += 1) {
			const last = i === count - 1;
			const strict = rng.bool();
			const hi = upper(ns[i + 1] ?? 0, last ? rng.bool(0.4) : strict, last ? 'limit' : 'tier');
			rules.push({ outcome: names[i] ?? '', conds: [lo, hi] });
			lines.push(`- ${rangeText(lo, hi, u)} — ${plot.accept}, ${names[i] ?? ''};`);
			lo = lower(ns[i + 1] ?? 0, !strict, 'tier');
		}
		lines.push(`- при любом другом значении ${plot.refuse}.`);
		return { points: classId === 'tiers' ? 2 : 3, rules, lines, plot };
	}
	if (classId === 'excluded') {
		const twoTiers = rng.bool();
		const ns = points(rng, plot, twoTiers ? 6 : 5, 6);
		const lo = lower(ns[0] ?? 0, rng.bool(0.3), 'limit');
		const hi = upper(ns[ns.length - 1] ?? 0, rng.bool(0.3), 'limit');
		const rules: Rule[] = [];
		const lines: string[] = [];
		// Points between the limits: either two single excluded values or one excluded sub-range, plus maybe a tier cut.
		const between = ns.slice(1, -1);
		const cutAt = twoTiers ? between.splice(rng.int(0, between.length - 1), 1)[0] : undefined;
		const [e1 = 0, e2 = 0] = rng.sample(between, 2).sort((x, y) => x - y);
		// An excluded sub-range never swallows the tier cut.
		const asRange = rng.bool() && !(cutAt !== undefined && e1 < cutAt && cutAt < e2);
		if (asRange) {
			rules.push({
				outcome: REJECT,
				conds: [
					{ op: 'ge', n: e1, role: 'excluded' },
					{ op: 'le', n: e2, role: 'excluded' }
				]
			});
		} else {
			rules.push({ outcome: REJECT, conds: [{ op: 'eq', n: e1, role: 'excluded' }] });
			rules.push({ outcome: REJECT, conds: [{ op: 'eq', n: e2, role: 'excluded' }] });
		}
		const excludedText = asRange
			? `кроме значений от ${num(e1)} до ${num(e2)} ${u} включительно`
			: `кроме значений ${num(e1)} и ${num(e2)} ${u}`;
		if (cutAt === undefined) {
			rules.push({ outcome: 'accept', conds: [lo, hi] });
			lines.push(`- если значение ${rangeText(lo, hi, u)}, ${excludedText}, ${plot.accept};`);
		} else {
			const tiers = rng.sample(plot.tiers, 2);
			const cutStrict = rng.bool();
			const first = upper(cutAt, cutStrict, 'tier');
			const second = lower(cutAt, !cutStrict, 'tier');
			rules.push({ outcome: tiers[0] ?? '', conds: [lo, first] });
			rules.push({ outcome: tiers[1] ?? '', conds: [second, hi] });
			lines.push(`- ${rangeText(lo, first, u)} — ${plot.accept}, ${tiers[0] ?? ''};`);
			lines.push(`- ${rangeText(second, hi, u)} — ${plot.accept}, ${tiers[1] ?? ''};`);
			lines.push(
				`- значения ${asRange ? `от ${num(e1)} до ${num(e2)} ${u} включительно` : `${num(e1)} и ${num(e2)} ${u}`} не принимаются ни в одном тарифе;`
			);
		}
		lines.push(`- при любом другом значении ${plot.refuse}.`);
		return { points: 2, rules, lines, plot };
	}
	// intersection: the general limits, a tier cut, and a stricter limit of the chosen mode; the other mode has its own.
	const [a = 0, t = 0, p2 = 0, p3 = 0, b = 0] = points(rng, plot, 5, 8);
	const [m1, m2] = rng.bool() ? [p2, p3] : [p3, p2];
	const lo = lower(a, rng.bool(0.3), 'limit');
	const hi = upper(b, rng.bool(0.3), 'limit');
	const cutStrict = rng.bool();
	const tiers = rng.sample(plot.tiers, 2);
	const first = upper(t, cutStrict, 'tier');
	const second = lower(t, !cutStrict, 'tier');
	const modeStrict = rng.bool();
	const otherStrict = rng.bool();
	const [mode, other] = rng.shuffle(plot.modes);
	const modeLimit = upper(m1, modeStrict, 'mode');
	return {
		points: 2,
		rules: [
			{ outcome: tiers[0] ?? '', conds: [lo, first, modeLimit] },
			{ outcome: tiers[1] ?? '', conds: [second, hi, modeLimit] }
		],
		lines: [
			`- для любого способа: ${rangeText(lo, first, u)} — ${plot.accept}, ${tiers[0] ?? ''};`,
			`- для любого способа: ${rangeText(second, hi, u)} — ${plot.accept}, ${tiers[1] ?? ''};`,
			`- дополнительно для способа «${mode ?? ''}» значение должно быть ${modeStrict ? 'меньше' : 'не больше'} ${num(m1)} ${u};`,
			`- дополнительно для способа «${other ?? ''}» значение должно быть ${otherStrict ? 'меньше' : 'не больше'} ${num(m2)} ${u};`,
			`- при любом другом значении ${plot.refuse}.`,
			'',
			`Анализ проводится для способа «${mode ?? ''}».`
		],
		plot
	};
}

function describe(p: Params): string {
	const method =
		p.points === 2
			? 'Тестировщик проводит **двухточечный** анализ граничных значений: граница — место между соседними целыми значениями x и x + 1, где поведение системы меняется (другой результат, другой тариф или отказ вместо приёма); для каждой границы в набор входят оба значения, x и x + 1.'
			: 'Тестировщик проводит **трёхточечный** анализ граничных значений: для каждого числа N, названного в требованиях как граница, в набор входят N − 1, N и N + 1.';
	return [
		`${p.plot.system}. Поле «${p.plot.field}» принимает целое число (${p.plot.unit}). Требования:`,
		'',
		...p.lines,
		'',
		method,
		'',
		'Какие значения войдут в набор? Введите числа по одному в строке, в любом порядке, без единиц измерения и пробелов внутри числа. Например:',
		'',
		'```',
		'7',
		'8',
		'1500',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())


def holds(c, x):
    n = c["n"]
    return {"ge": x >= n, "gt": x > n, "le": x <= n, "lt": x < n, "eq": x == n}[c["op"]]


def behaviour(x):
    for rule in p["rules"]:
        if all(holds(c, x) for c in rule["conds"]):
            return rule["outcome"]
    return "reject"


numbers = [c["n"] for rule in p["rules"] for c in rule["conds"]]
values = set()
if p["points"] == 3:
    for n in numbers:
        values.update((n - 1, n, n + 1))
else:
    for n in numbers:
        for x in range(n - 3, n + 3):
            if behaviour(x) != behaviour(x + 1):
                values.update((x, x + 1))
for v in sorted(values):
    print(v)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'inclusive-flip': { strictAsInclusive: true },
	'inside-only': { insideOnly: true },
	'outer-only': { outerOnly: true },
	'three-point': { points: 'three' },
	'two-point': { points: 'two' },
	'excluded-ignored': { excluded: false },
	'loosest-limit': { modeLimit: false }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/closed': ['inside-only', 'three-point'],
	'intern/strict': ['inclusive-flip', 'inside-only', 'three-point'],
	'intern/two-tiers': ['outer-only', 'inside-only', 'three-point'],
	'intern/three-point': ['two-point', 'inside-only'],
	'junior/tiers': ['inclusive-flip', 'outer-only', 'three-point'],
	'junior/excluded': ['excluded-ignored', 'inside-only'],
	'junior/intersection': ['loosest-limit', 'inclusive-flip'],
	'junior/three-point-tiers': ['two-point', 'outer-only']
};

const key = (values: readonly number[]): string => values.join(',');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, key(value) === key(answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: answer.map(String) }
		});
		const stdin = JSON.stringify({
			points: p.points,
			rules: p.rules.map((r) => ({ outcome: r.outcome, conds: r.conds.map(({ op, n }) => ({ op, n })) }))
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null
							? null
							: { kind: 'answer' as const, answer: { kind: 'set' as const, value: value.map(String) } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
