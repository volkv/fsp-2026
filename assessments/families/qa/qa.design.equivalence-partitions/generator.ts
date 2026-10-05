// Equivalence partitioning: which tests of a given list add no new equivalence class, given the requirements of one or
// several input fields — ranges with strict and inclusive ends, disjoint ranges of one rule, format rules for input that
// is not an integer, and, with several fields, Myers' rules of what a test with invalid values covers.
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

type Op = 'ge' | 'gt' | 'le' | 'lt';
type Format = 'empty' | 'letters' | 'fraction';

/** `strict` — the requirement says it with a strict word («больше», «меньше»). */
interface Cond {
	op: Op;
	n: number;
	strict: boolean;
}

/** One item of the requirements of a field: one rule, one class per contiguous range it names. */
type Bullet =
	| { kind: 'range'; ranges: Cond[][]; valid: boolean; text: string }
	| { kind: 'format'; format: Format; text: string }
	| { kind: 'enum'; values: string[] | null; valid: boolean; text: string };

interface Field {
	name: string;
	bullets: Bullet[];
}

interface Params {
	plot: string;
	fields: Field[];
	/** One row per test, one value per field. */
	tests: string[][];
}

interface Rules {
	mergeDisjoint: boolean;
	edgeFlip: boolean;
	boundaryClass: boolean;
	mergeFormat: boolean;
	multiInvalidCounts: boolean;
	invalidCoversValid: boolean;
	combinationCounts: boolean;
}

const RIGHT: Rules = {
	mergeDisjoint: false,
	edgeFlip: false,
	boundaryClass: false,
	mergeFormat: false,
	multiInvalidCounts: false,
	invalidCoversValid: false,
	combinationCounts: false
};

const holds = (c: Cond, x: number, flip: boolean): boolean => {
	const op = flip && c.strict ? (c.op === 'gt' ? 'ge' : c.op === 'lt' ? 'le' : c.op) : c.op;
	return op === 'ge' ? x >= c.n : op === 'gt' ? x > c.n : op === 'le' ? x <= c.n : x < c.n;
};

function formatOf(value: string): Format | null {
	if (value === '') return 'empty';
	if (/[a-zа-яё]/i.test(value)) return 'letters';
	if (/^-?\d+\.\d+$/.test(value)) return 'fraction';
	return null;
}

/** The smallest and the largest integer of a range; infinite ends are null. */
function ends(range: readonly Cond[]): [number | null, number | null] {
	let lo: number | null = null;
	let hi: number | null = null;
	for (const c of range) {
		if (c.op === 'ge' || c.op === 'gt') lo = Math.max(lo ?? -Infinity, c.op === 'ge' ? c.n : c.n + 1);
		else hi = Math.min(hi ?? Infinity, c.op === 'le' ? c.n : c.n - 1);
	}
	return [lo, hi];
}

/** The class of a value as a misconception sees it, and whether the class is valid. */
function classOf(field: Field, value: string, rules: Rules): { key: string; valid: boolean } {
	const format = formatOf(value);
	if (field.bullets.some((b) => b.kind === 'enum')) {
		const index = field.bullets.findIndex((b) => b.kind === 'enum' && (b.values === null || b.values.includes(value)));
		const bullet = field.bullets[index];
		if (!bullet || bullet.kind !== 'enum') throw new Error(`no rule for ${value}`);
		return { key: `${index}`, valid: bullet.valid };
	}
	if (format !== null) {
		const index = field.bullets.findIndex((b) => b.kind === 'format' && b.format === format);
		if (index < 0) throw new Error(`no format rule for ${value}`);
		return { key: rules.mergeFormat ? 'format' : `${index}`, valid: false };
	}
	const x = Number(value);
	// A misreading of strict words wins at the shared end: the rule that says «больше n» takes n too.
	const order = field.bullets
		.map((bullet, index) => ({ bullet, index }))
		.sort(
			(a, b) => (rules.edgeFlip ? Number(hasStrict(b.bullet)) - Number(hasStrict(a.bullet)) : 0) || a.index - b.index
		);
	for (const { bullet, index } of order) {
		if (bullet.kind !== 'range') continue;
		const r = bullet.ranges.findIndex((range) => range.every((c) => holds(c, x, rules.edgeFlip)));
		if (r < 0) continue;
		let key = rules.mergeDisjoint ? `${index}` : `${index}.${r}`;
		const [lo, hi] = ends(bullet.ranges[r] ?? []);
		if (rules.boundaryClass && (x === lo || x === hi)) key += `@${x}`;
		return { key, valid: bullet.valid };
	}
	throw new Error(`no rule for ${value}`);
}

const hasStrict = (bullet: Bullet): boolean =>
	bullet.kind === 'range' && bullet.ranges.some((r) => r.some((c) => c.strict));

/** The numbers (1-based) of the redundant tests, ascending. */
function solve(p: Params, rules: Rules): number[] {
	const covered = new Set<string>();
	const combos = new Set<string>();
	const redundant: number[] = [];
	p.tests.forEach((row, t) => {
		const classes = row.map((value, f) => {
			const field = p.fields[f];
			if (!field) throw new Error('row wider than the fields');
			return { ...classOf(field, value, rules), key: `${f}:${classOf(field, value, rules).key}` };
		});
		const invalid = classes.filter((c) => !c.valid);
		let gives: string[];
		if (invalid.length === 0) gives = classes.map((c) => c.key);
		else if (invalid.length === 1)
			gives = rules.invalidCoversValid ? classes.map((c) => c.key) : [invalid[0]?.key ?? ''];
		else gives = rules.multiInvalidCounts ? invalid.map((c) => c.key) : [];
		let fresh = gives.some((k) => !covered.has(k));
		if (rules.combinationCounts && invalid.length === 0) {
			const combo = gives.join('|');
			fresh = fresh || !combos.has(combo);
			combos.add(combo);
		}
		for (const k of gives) covered.add(k);
		if (!fresh) redundant.push(t + 1);
	});
	return redundant;
}

// ---------------------------------------------------------------------------------------------------------------
// Fields.

interface NumericPlot {
	name: string;
	unit: string;
	lo: number;
	hi: number;
	tiers: readonly string[];
	low: string;
	high: string;
	formats: Readonly<Record<Format, string>>;
}

const NUMERIC: readonly NumericPlot[] = [
	{
		name: 'Возраст',
		unit: 'лет',
		lo: 1,
		hi: 110,
		tiers: ['детский билет', 'подростковый билет', 'взрослый билет', 'льготный билет'],
		low: '«Возраст слишком мал»',
		high: '«Проверьте возраст»',
		formats: { empty: '«Укажите возраст»', letters: '«Введите число»', fraction: '«Возраст — целое число»' }
	},
	{
		name: 'Количество',
		unit: 'шт.',
		lo: 1,
		hi: 500,
		tiers: ['розничная цена', 'мелкий опт', 'опт', 'крупный опт'],
		low: '«Минимум не набран»',
		high: '«Свяжитесь с менеджером»',
		formats: { empty: '«Укажите количество»', letters: '«Только цифры»', fraction: '«Количество — целое число»' }
	},
	{
		name: 'Сумма',
		unit: '₽',
		lo: 10,
		hi: 900000,
		tiers: ['без комиссии', 'комиссия 1 %', 'комиссия 2 %', 'нужно подтверждение по SMS'],
		low: '«Сумма слишком мала»',
		high: '«Превышен лимит»',
		formats: { empty: '«Введите сумму»', letters: '«Сумма — число»', fraction: '«Сумма в целых рублях»' }
	},
	{
		name: 'Срок',
		unit: 'мес.',
		lo: 1,
		hi: 360,
		tiers: ['ставка 9 %', 'ставка 11 %', 'ставка 12 %', 'ставка 13 %'],
		low: '«Срок слишком короткий»',
		high: '«Срок слишком длинный»',
		formats: { empty: '«Укажите срок»', letters: '«Срок — число месяцев»', fraction: '«Срок — целое число»' }
	},
	{
		name: 'Вес',
		unit: 'кг',
		lo: 1,
		hi: 1000,
		tiers: ['тариф S', 'тариф M', 'тариф L', 'тариф XL'],
		low: '«Слишком лёгкий груз»',
		high: '«Слишком тяжёлый груз»',
		formats: { empty: '«Укажите вес»', letters: '«Вес — число»', fraction: '«Вес в целых килограммах»' }
	}
];

interface EnumPlot {
	name: string;
	valid: readonly string[];
	refused: readonly string[];
	refusedMessage: string;
	otherMessage: string;
	others: readonly string[];
}

const ENUMS: readonly EnumPlot[] = [
	{
		name: 'Способ оплаты',
		valid: ['card', 'sbp', 'wallet'],
		refused: ['cash', 'credit'],
		refusedMessage: '«Способ временно недоступен»',
		otherMessage: '«Неизвестный способ оплаты»',
		others: ['bank', 'crypto', 'check']
	},
	{
		name: 'Доставка',
		valid: ['courier', 'pickup', 'locker'],
		refused: ['post', 'drone'],
		refusedMessage: '«Недоступно в вашем регионе»',
		otherMessage: '«Неизвестный способ доставки»',
		others: ['taxi', 'mail', 'ship']
	},
	{
		name: 'Тип клиента',
		valid: ['person', 'company', 'sole'],
		refused: ['foreign', 'nonres'],
		refusedMessage: '«Обслуживается только в офисе»',
		otherMessage: '«Неизвестный тип клиента»',
		others: ['bank', 'state', 'other']
	}
];

const num = (n: number): string => String(n);

function cuts(rng: Rng, plot: NumericPlot, count: number): number[] {
	const span = plot.hi - plot.lo;
	const gap = Math.max(3, Math.floor(span / (count * 4)));
	for (let tries = 0; tries < 200; tries += 1) {
		const ns = [...new Set(Array.from({ length: count }, () => rng.int(plot.lo, plot.hi)))].sort((a, b) => a - b);
		if (ns.length === count && ns.every((n, i) => i === 0 || n - (ns[i - 1] ?? 0) >= gap)) return ns;
	}
	throw new Error('equivalence-partitions: no cuts');
}

const ge = (n: number): Cond => ({ op: 'ge', n, strict: false });
const gt = (n: number): Cond => ({ op: 'gt', n, strict: true });
const le = (n: number): Cond => ({ op: 'le', n, strict: false });
const lt = (n: number): Cond => ({ op: 'lt', n, strict: true });

/** A range in words: «от 10 до 20 включительно», «больше 10 и меньше 20», «не меньше 10 и меньше 20». */
function rangeText(lo: Cond, hi: Cond): string {
	if (lo.op === 'ge' && hi.op === 'le') return `от ${num(lo.n)} до ${num(hi.n)} включительно`;
	const from = lo.op === 'ge' ? `не меньше ${num(lo.n)}` : `больше ${num(lo.n)}`;
	const to = hi.op === 'le' ? `не больше ${num(hi.n)}` : `меньше ${num(hi.n)}`;
	return `${from} и ${to}`;
}

/** The lower end of a range and its complement below, in words. */
function lowerEnd(n: number, strict: boolean): { cond: Cond; below: Cond; belowText: string } {
	return strict
		? { cond: gt(n), below: le(n), belowText: `${num(n)} и меньше` }
		: { cond: ge(n), below: lt(n), belowText: `меньше ${num(n)}` };
}

function upperEnd(n: number, strict: boolean): { cond: Cond; above: Cond; aboveText: string } {
	return strict
		? { cond: lt(n), above: ge(n), aboveText: `${num(n)} и больше` }
		: { cond: le(n), above: gt(n), aboveText: `больше ${num(n)}` };
}

interface NumericShape {
	tiers: number;
	merged: boolean;
	formats: Format[];
	excluded: boolean;
}

/** A numeric field: invalid below, valid tiers (one may have a value cut out), invalid above, format rules. */
function numericField(rng: Rng, plot: NumericPlot, shape: NumericShape): Field {
	const ns = cuts(rng, plot, shape.tiers + 1 + (shape.excluded ? 1 : 0));
	const cut = shape.excluded ? ns.splice(rng.int(1, ns.length - 2), 1)[0] : undefined;
	const bullets: Bullet[] = [];
	const first = lowerEnd(ns[0] ?? 0, rng.bool());
	const last = upperEnd(ns[ns.length - 1] ?? 0, rng.bool());
	const names = rng.sample(plot.tiers, shape.tiers);
	const tiers: Bullet[] = [];
	let lower = first;
	for (let i = 0; i < shape.tiers; i += 1) {
		const isLast = i === shape.tiers - 1;
		const upper = isLast ? last : upperEnd(ns[i + 1] ?? 0, rng.bool());
		const range = [lower.cond, upper.cond];
		const name = names[i] ?? '';
		if (cut !== undefined && cut > (ns[i] ?? 0) && cut < (ns[i + 1] ?? 0)) {
			tiers.push({
				kind: 'range',
				ranges: [
					[lower.cond, { op: 'lt', n: cut, strict: false }],
					[{ op: 'gt', n: cut, strict: false }, upper.cond]
				],
				valid: true,
				text: `${rangeText(lower.cond, upper.cond)}, кроме ${num(cut)} — принимается, ${name}`
			});
			tiers.push({
				kind: 'range',
				ranges: [[ge(cut), le(cut)]],
				valid: false,
				text: `ровно ${num(cut)} — отказ, «Значение ${num(cut)} зарезервировано»`
			});
		} else {
			tiers.push({
				kind: 'range',
				ranges: [range],
				valid: true,
				text: `${rangeText(lower.cond, upper.cond)} — принимается, ${name}`
			});
		}
		if (!isLast) {
			const flip = upper.cond.op === 'lt';
			lower = flip ? lowerEnd(upper.cond.n, false) : lowerEnd(upper.cond.n, true);
		}
	}
	if (shape.merged) {
		bullets.push({
			kind: 'range',
			ranges: [[first.below], [last.above]],
			valid: false,
			text: `${first.belowText} или ${last.aboveText} — отказ, «Значение вне допустимого диапазона»`
		});
	} else {
		bullets.push({
			kind: 'range',
			ranges: [[first.below]],
			valid: false,
			text: `${first.belowText} — отказ, ${plot.low}`
		});
	}
	bullets.push(...tiers);
	if (!shape.merged) {
		bullets.push({
			kind: 'range',
			ranges: [[last.above]],
			valid: false,
			text: `${last.aboveText} — отказ, ${plot.high}`
		});
	}
	const formatText: Record<Format, string> = {
		empty: 'поле пустое',
		letters: 'в значении есть буквы',
		fraction: 'дробное число (с точкой)'
	};
	for (const format of shape.formats) {
		bullets.push({ kind: 'format', format, text: `${formatText[format]} — отказ, ${plot.formats[format]}` });
	}
	return { name: `${plot.name}, ${plot.unit}`, bullets };
}

function enumField(rng: Rng, plot: EnumPlot): Field {
	const valid = rng.sample(plot.valid, 2);
	const refused = rng.sample(plot.refused, 1);
	const code = (values: readonly string[]): string => values.map((v) => `\`${v}\``).join(', ');
	return {
		name: plot.name,
		bullets: [
			{ kind: 'enum', values: valid, valid: true, text: `${code(valid)} — принимается` },
			{ kind: 'enum', values: refused, valid: false, text: `${code(refused)} — отказ, ${plot.refusedMessage}` },
			{ kind: 'enum', values: null, valid: false, text: `любое другое значение — отказ, ${plot.otherMessage}` }
		]
	};
}

/** A value of a class: a range near or at its end, a format sample, an enum value. */
function valueOf(rng: Rng, bullet: Bullet, range: number, plot: EnumPlot | null): string {
	if (bullet.kind === 'format') {
		if (bullet.format === 'empty') return '';
		if (bullet.format === 'letters') return rng.pick(['abc', '12a', 'десять', 'n/a', '5кг']);
		return `${rng.int(1, 99)}.${rng.int(1, 9)}`;
	}
	if (bullet.kind === 'enum') {
		if (bullet.values) return rng.pick(bullet.values);
		return rng.pick(plot?.others ?? ['other']);
	}
	const [lo, hi] = ends(bullet.ranges[range] ?? []);
	if (lo !== null && hi !== null) {
		if (rng.bool(0.45)) return String(rng.bool() ? lo : hi);
		return String(rng.int(lo, hi));
	}
	// An open range: its end, or a value up to half the end's size away (not below zero).
	const edge = lo ?? hi ?? 0;
	if (rng.bool(0.45)) return String(edge);
	const away = rng.int(1, Math.max(5, Math.round(edge / 2)));
	return String(lo !== null ? edge + away : edge >= 0 ? Math.max(0, edge - away) : edge - away);
}

interface ClassRef {
	bullet: Bullet;
	range: number;
	valid: boolean;
}

function classesOf(field: Field): ClassRef[] {
	return field.bullets.flatMap((bullet): ClassRef[] =>
		bullet.kind === 'range'
			? bullet.ranges.map((_, range) => ({ bullet, range, valid: bullet.valid }))
			: [{ bullet, range: 0, valid: bullet.kind === 'enum' ? bullet.valid : false }]
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const MIX: Readonly<Record<string, readonly [number, number]>> = {
	masking: [0.45, 0.3],
	'invalid-valid': [0.45, 0.45],
	combinations: [0.7, 0.25],
	'format-fields': [0.35, 0.35]
};

const PLOTS = ['Форма заказа', 'Форма заявки', 'Форма расчёта тарифа', 'Форма бронирования'];

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		const plot = rng.pick(NUMERIC);
		const shape: NumericShape =
			classId === 'tiers'
				? { tiers: rng.int(2, 3), merged: false, formats: [], excluded: false }
				: classId === 'format'
					? {
							tiers: rng.int(1, 2),
							merged: false,
							formats: rng.sample(['empty', 'letters', 'fraction'] as const, rng.int(2, 3)),
							excluded: false
						}
					: classId === 'split-invalid'
						? { tiers: rng.int(1, 2), merged: true, formats: [], excluded: false }
						: { tiers: 1, merged: rng.bool(), formats: [], excluded: true };
		const field = numericField(rng, plot, shape);
		const classes = classesOf(field);
		const count = rng.int(9, 11);
		const tests = Array.from({ length: count }, () => {
			const c = rng.pick(classes);
			return [valueOf(rng, c.bullet, c.range, null)];
		});
		return { plot: rng.pick(PLOTS), fields: [field], tests };
	}
	const enumPlot = rng.pick(ENUMS);
	const [p1, p2] = rng.sample(NUMERIC, 2);
	if (!p1 || !p2) throw new Error('equivalence-partitions: plots');
	const formatsX = classId === 'format-fields';
	const fields: Field[] = [
		numericField(rng, p1, {
			tiers: rng.int(1, 2),
			merged: classId === 'combinations' && rng.bool(),
			formats: formatsX ? rng.sample(['empty', 'letters', 'fraction'] as const, 2) : [],
			excluded: false
		})
	];
	const threeFields = classId === 'invalid-valid' || classId === 'format-fields';
	if (classId === 'masking' || threeFields) fields.push(enumField(rng, enumPlot));
	if (classId !== 'masking') {
		fields.push(
			numericField(rng, p2, {
				tiers: rng.int(1, 2),
				merged: false,
				formats: formatsX ? rng.sample(['empty', 'letters', 'fraction'] as const, 1) : [],
				excluded: false
			})
		);
	}
	const all = fields.map(classesOf);
	const count = rng.int(8, 11);
	// The share of tests with no, one and two invalid values.
	const [none, one] = MIX[classId] ?? [0.5, 0.3];
	const tests: string[][] = [];
	for (let t = 0; t < count; t += 1) {
		const roll = rng.next();
		const invalidCount = roll < none ? 0 : roll < none + one ? 1 : 2;
		const bad = new Set(
			rng.sample(
				fields.map((_, i) => i),
				Math.min(invalidCount, fields.length)
			)
		);
		tests.push(
			fields.map((field, f) => {
				const pool = (all[f] ?? []).filter((c) => c.valid !== bad.has(f));
				const formats = pool.filter((c) => c.bullet.kind === 'format');
				const c = formats.length > 0 && rng.bool(0.6) ? rng.pick(formats) : rng.pick(pool);
				return valueOf(rng, c.bullet, c.range, field.bullets[0]?.kind === 'enum' ? enumPlot : null);
			})
		);
	}
	return { plot: rng.pick(PLOTS), fields, tests };
}

const shown = (value: string): string => (value === '' ? '(пусто)' : value);

function table(p: Params): string[] {
	const header = ['№', ...p.fields.map((f) => f.name)];
	const rows = p.tests.map((row, t) => [String(t + 1), ...row.map(shown)]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
	const line = (cells: readonly string[]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join('   ')
			.trimEnd();
	return ['```', line(header), ...rows.map(line), '```'];
}

function describe(p: Params, grade: string): string {
	const fieldLines = p.fields.flatMap((field) => [
		`Поле «${field.name}»${field.bullets.some((b) => b.kind === 'enum') ? ' (строка)' : ' (целое число)'}:`,
		'',
		...field.bullets.map((b, i) => `- ${b.text}${i === field.bullets.length - 1 ? '.' : ';'}`),
		''
	]);
	const classRule =
		'Класс эквивалентности — пункт требований; если пункт называет несколько несмежных числовых диапазонов (через «или» или «кроме»), каждый диапазон — отдельный класс. Значения перечислены через запятую — это один класс.';
	const coverage =
		grade === 'intern'
			? ['Тест покрывает класс, в который попадает его значение.']
			: [
					'Тест покрывает классы по правилам Майерса:',
					'',
					'- все значения теста допустимы — тест покрывает класс каждого своего значения;',
					'- ровно одно значение недопустимо — тест покрывает только этот недопустимый класс (остальные значения система не проверяет: она останавливается на первой ошибке);',
					'- недопустимых значений два и больше — тест не покрывает ни одного класса (одна ошибка маскирует другую).'
				];
	return [
		`${p.plot}. Требования к ${p.fields.length === 1 ? 'полю' : 'полям'}:`,
		'',
		...fieldLines,
		classRule,
		'',
		...coverage,
		'',
		'Тестировщик проверяет готовый набор тестов:',
		'',
		...table(p),
		'',
		'Тест **избыточен**, если он не покрывает ни одного класса, который не покрыт тестами с меньшими номерами.',
		'',
		'Какие тесты избыточны? Введите их номера по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:',
		'',
		'```',
		'3',
		'7',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import re

p = json.loads(input())


def holds(c, x):
    n = c["n"]
    return {"ge": x >= n, "gt": x > n, "le": x <= n, "lt": x < n}[c["op"]]


def classify(field, value):
    """(class id, valid) of a value: rule number plus range number within the rule."""
    for i, b in enumerate(field["bullets"]):
        if b["kind"] == "enum":
            if b["values"] is None or value in b["values"]:
                return (i, 0), b["valid"]
    if value == "":
        fmt = "empty"
    elif re.search(r"[a-zа-яё]", value, re.I):
        fmt = "letters"
    elif re.fullmatch(r"-?[0-9]+\\.[0-9]+", value):
        fmt = "fraction"
    else:
        fmt = None
    for i, b in enumerate(field["bullets"]):
        if b["kind"] == "format" and b["format"] == fmt:
            return (i, 0), False
        if b["kind"] == "range" and fmt is None:
            for r, rng in enumerate(b["ranges"]):
                if all(holds(c, int(value)) for c in rng):
                    return (i, r), b["valid"]
    raise ValueError(value)


covered = set()
redundant = []
for t, row in enumerate(p["tests"], start=1):
    classes = [(f, *classify(field, v)) for f, (field, v) in enumerate(zip(p["fields"], row))]
    bad = [(f, c) for f, c, ok in classes if not ok]
    if not bad:
        gives = {(f, c) for f, c, ok in classes}
    elif len(bad) == 1:
        gives = set(bad)
    else:
        gives = set()
    if not gives - covered:
        redundant.append(str(t))
    covered |= gives
print("\\n".join(redundant) or "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'merge-disjoint': { mergeDisjoint: true },
	'edge-flip': { edgeFlip: true },
	'boundary-class': { boundaryClass: true },
	'merge-format': { mergeFormat: true },
	'multi-invalid-counts': { multiInvalidCounts: true },
	'invalid-covers-valid': { invalidCoversValid: true },
	'combination-counts': { combinationCounts: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/tiers': ['edge-flip', 'boundary-class'],
	'intern/format': ['merge-format', 'boundary-class'],
	'intern/split-invalid': ['merge-disjoint', 'edge-flip'],
	'intern/excluded': ['merge-disjoint'],
	'junior/masking': ['multi-invalid-counts'],
	'junior/invalid-valid': ['invalid-covers-valid'],
	'junior/combinations': ['combination-counts', 'edge-flip'],
	'junior/format-fields': ['merge-format', 'multi-invalid-counts']
};

const key = (values: readonly number[]): string => values.join(',');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		if (answer.length === 0 || answer.length > p.tests.length - 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, key(value) === key(answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade), code: null },
			answer: { kind: 'set', value: answer.map(String) }
		});
		const stdin = JSON.stringify({
			fields: p.fields.map((f) => ({
				bullets: f.bullets.map((b) =>
					b.kind === 'range'
						? { kind: b.kind, valid: b.valid, ranges: b.ranges.map((r) => r.map(({ op, n }) => ({ op, n }))) }
						: b.kind === 'format'
							? { kind: b.kind, format: b.format }
							: { kind: b.kind, valid: b.valid, values: b.values }
				)
			})),
			tests: p.tests
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
