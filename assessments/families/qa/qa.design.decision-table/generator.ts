// Decision tables: the expected action for each listed case (rules read left to right, «-» means «безразлично»,
// numeric conditions with strict and inclusive thresholds), and how many possible combinations of conditions each rule
// of a compressed table actually handles, given the order of the rules and the combinations that cannot happen.
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

/** `Y` — да, `N` — нет, `-` — безразлично. */
type Entry = 'Y' | 'N' | '-';

interface Condition {
	text: string;
	/** A numeric condition: `value > n` when strict, `value >= n` otherwise. */
	num: { n: number; strict: boolean; label: string; unit: string } | null;
	yes: string;
	no: string;
}

interface Params {
	plot: string;
	conditions: Condition[];
	/** One column per rule: an entry per condition and an action code. */
	rules: { entries: Entry[]; action: string }[];
	actions: { code: string; text: string }[];
	defaultAction: { code: string; text: string } | null;
	/** Intern: the cases, a value per condition (a boolean or a number). */
	cases: (boolean | number)[][];
	/** Junior: pairs of condition values that never happen together. */
	impossible: [number, boolean, number, boolean][];
}

interface Rules {
	strictFlip: boolean;
	dashAsNo: boolean;
	lastMatch: boolean;
	noPriority: boolean;
	countImpossible: boolean;
}

const RIGHT: Rules = {
	strictFlip: false,
	dashAsNo: false,
	lastMatch: false,
	noPriority: false,
	countImpossible: false
};

function truth(c: Condition, value: boolean | number, rules: Rules): boolean {
	if (typeof value === 'boolean') return value;
	if (!c.num) throw new Error('a number for a yes/no condition');
	const strict = rules.strictFlip && value === c.num.n ? !c.num.strict : c.num.strict;
	return strict ? value > c.num.n : value >= c.num.n;
}

function matches(entries: readonly Entry[], combo: readonly boolean[], rules: Rules): boolean {
	return entries.every((e, i) => {
		const read = e === '-' && rules.dashAsNo ? 'N' : e;
		return read === '-' || (read === 'Y') === combo[i];
	});
}

/** Intern: the action code per case. */
function actionsFor(p: Params, rules: Rules): string[] {
	return p.cases.map((values) => {
		const combo = values.map((v, i) => {
			const c = p.conditions[i];
			if (!c) throw new Error('case wider than the conditions');
			return truth(c, v, rules);
		});
		const order = rules.lastMatch ? [...p.rules].reverse() : p.rules;
		return order.find((r) => matches(r.entries, combo, rules))?.action ?? p.defaultAction?.code ?? '?';
	});
}

function combos(n: number): boolean[][] {
	return Array.from({ length: 2 ** n }, (_, m) => Array.from({ length: n }, (__, i) => ((m >> (n - 1 - i)) & 1) === 1));
}

const possible = (p: Params, combo: readonly boolean[]): boolean =>
	!p.impossible.some(([i, a, j, b]) => combo[i] === a && combo[j] === b);

/** Junior: how many combinations each rule handles, and the default last. */
function counts(p: Params, rules: Rules): number[] {
	const out = p.rules.map(() => 0);
	let rest = 0;
	for (const combo of combos(p.conditions.length)) {
		if (!rules.countImpossible && !possible(p, combo)) continue;
		if (rules.noPriority) {
			const hits = p.rules.flatMap((r, i) => (matches(r.entries, combo, rules) ? [i] : []));
			for (const i of hits) out[i] = (out[i] ?? 0) + 1;
			if (hits.length === 0) rest += 1;
			continue;
		}
		const order = p.rules.map((r, i) => ({ r, i }));
		if (rules.lastMatch) order.reverse();
		const hit = order.find(({ r }) => matches(r.entries, combo, rules));
		if (hit) out[hit.i] = (out[hit.i] ?? 0) + 1;
		else rest += 1;
	}
	return [...out, rest];
}

function solve(p: Params, grade: string, rules: Rules): string[] {
	return grade === 'intern' ? actionsFor(p, rules) : counts(p, rules).map(String);
}

// ---------------------------------------------------------------------------------------------------------------
// Plots.

interface NumSpec {
	label: string;
	unit: string;
	lo: number;
	hi: number;
	step: number;
}

interface InternPlot {
	title: string;
	nums: readonly NumSpec[];
	bools: readonly { text: string; yes: string; no: string }[];
	actions: readonly string[];
	fallback: string;
}

const INTERN_PLOTS: readonly InternPlot[] = [
	{
		title: 'Интернет-магазин рассчитывает доставку',
		nums: [
			{ label: 'Сумма заказа', unit: '₽', lo: 500, hi: 20000, step: 100 },
			{ label: 'Вес заказа', unit: 'кг', lo: 2, hi: 60, step: 1 }
		],
		bools: [
			{ text: 'Есть карта лояльности', yes: 'карта лояльности есть', no: 'карты лояльности нет' },
			{ text: 'Адрес за городом', yes: 'адрес за городом', no: 'адрес в городе' },
			{ text: 'Срочная доставка', yes: 'срочная доставка', no: 'обычная доставка' }
		],
		actions: ['бесплатная доставка', 'доставка 99 ₽', 'доставка 199 ₽', 'доставка 399 ₽', 'только самовывоз'],
		fallback: 'доставка 299 ₽'
	},
	{
		title: 'Банк рассматривает заявку на кредитную карту',
		nums: [
			{ label: 'Ежемесячный доход', unit: '₽', lo: 20000, hi: 300000, step: 1000 },
			{ label: 'Возраст', unit: 'лет', lo: 18, hi: 75, step: 1 }
		],
		bools: [
			{ text: 'Есть просроченные кредиты', yes: 'просрочки есть', no: 'просрочек нет' },
			{ text: 'Зарплатный клиент', yes: 'зарплатный клиент', no: 'не зарплатный клиент' },
			{ text: 'Доход подтверждён справкой', yes: 'справка есть', no: 'справки нет' }
		],
		actions: ['лимит 300 000 ₽', 'лимит 100 000 ₽', 'лимит 30 000 ₽', 'отказ', 'ручная проверка'],
		fallback: 'предложить дебетовую карту'
	},
	{
		title: 'Сервис такси выбирает тариф поездки',
		nums: [
			{ label: 'Длина поездки', unit: 'км', lo: 2, hi: 120, step: 1 },
			{ label: 'Время подачи', unit: 'мин', lo: 3, hi: 40, step: 1 }
		],
		bools: [
			{ text: 'Ночное время', yes: 'ночью', no: 'днём' },
			{ text: 'Поездка в аэропорт', yes: 'в аэропорт', no: 'по городу' },
			{ text: 'Нужно детское кресло', yes: 'с детским креслом', no: 'без детского кресла' }
		],
		actions: ['тариф «Эконом»', 'тариф «Комфорт»', 'тариф «Трансфер»', 'надбавка 20 %', 'фиксированная цена'],
		fallback: 'тариф «Стандарт»'
	}
];

interface JuniorPlot {
	title: string;
	conditions: readonly string[];
	/** Pairs of condition values that never happen together. */
	impossible: readonly [number, boolean, number, boolean][];
	actions: readonly string[];
	fallback: string;
}

const JUNIOR_PLOTS: readonly JuniorPlot[] = [
	{
		title: 'Интернет-магазин рассчитывает доставку',
		conditions: [
			'Клиент — гость (без регистрации)',
			'Есть карта лояльности',
			'Сумма заказа от 3 000 ₽',
			'Сумма заказа от 10 000 ₽',
			'Адрес за городом'
		],
		impossible: [
			[0, true, 1, true],
			[2, false, 3, true]
		],
		actions: ['бесплатная доставка', 'доставка 99 ₽', 'доставка 199 ₽', 'доставка 399 ₽', 'только самовывоз'],
		fallback: 'доставка 299 ₽'
	},
	{
		title: 'Банк рассматривает заявку на кредитную карту',
		conditions: [
			'Возраст от 21 года',
			'Возраст от 65 лет',
			'Есть просроченные кредиты',
			'Зарплатный клиент',
			'Доход подтверждён справкой'
		],
		impossible: [[0, false, 1, true]],
		actions: ['лимит 300 000 ₽', 'лимит 100 000 ₽', 'лимит 30 000 ₽', 'отказ', 'ручная проверка'],
		fallback: 'предложить дебетовую карту'
	},
	{
		title: 'Онлайн-кинотеатр открывает доступ к фильму',
		conditions: ['Пробный период', 'Оплаченная подписка', 'Семейный тариф', 'Профиль ребёнка', 'Фильм 18+'],
		impossible: [
			[0, true, 1, true],
			[2, false, 3, true]
		],
		actions: ['показать фильм', 'показать трейлер', 'предложить подписку', 'скрыть фильм', 'запросить PIN-код'],
		fallback: 'показать карточку фильма'
	},
	{
		title: 'Сервис такси выбирает тариф поездки',
		conditions: ['Ночное время', 'Час пик', 'Поездка в аэропорт', 'Нужно детское кресло', 'Оплата бонусами'],
		impossible: [[0, true, 1, true]],
		actions: ['тариф «Эконом»', 'тариф «Комфорт»', 'тариф «Трансфер»', 'надбавка 20 %', 'фиксированная цена'],
		fallback: 'тариф «Стандарт»'
	}
];

const CODES = ['A', 'B', 'C', 'D', 'E'];
const num = (n: number): string => n.toLocaleString('ru-RU').replaceAll(' ', ' ');

function randomEntries(rng: Rng, n: number, dash: number): Entry[] {
	return Array.from({ length: n }, () => (rng.bool(dash) ? '-' : rng.bool() ? 'Y' : 'N'));
}

const overlap = (a: readonly Entry[], b: readonly Entry[]): boolean =>
	a.every((e, i) => e === '-' || b[i] === '-' || e === b[i]);

function internScenario(rng: Rng, classId: string): Params {
	const plot = rng.pick(INTERN_PLOTS);
	const numCount = classId === 'two-thresholds' ? 2 : 1;
	const boolCount = classId === 'full-table' ? 1 : classId === 'two-thresholds' ? 1 : 2;
	const nums = rng.sample(plot.nums, numCount);
	const bools = rng.sample(plot.bools, boolCount);
	const conditions: Condition[] = rng.shuffle([
		...nums.map((s): Condition => {
			const n = rng.int(Math.ceil(s.lo / s.step) + 2, Math.floor(s.hi / s.step) - 2) * s.step;
			const strict = rng.bool();
			return {
				text: `${s.label} ${strict ? 'больше' : 'не меньше'} ${num(n)} ${s.unit}`,
				num: { n, strict, label: s.label, unit: s.unit },
				yes: '',
				no: ''
			};
		}),
		...bools.map((b): Condition => ({ text: b.text, num: null, yes: b.yes, no: b.no }))
	]);
	const n = conditions.length;
	const actionTexts = rng.sample(plot.actions, 5);
	let rules: Params['rules'];
	let complete = false;
	if (classId === 'full-table') {
		complete = true;
		rules = rng.shuffle(combos(2)).map((combo, i) => ({
			entries: combo.map((v): Entry => (v ? 'Y' : 'N')),
			action: CODES[i] ?? ''
		}));
	} else {
		const k = rng.int(3, 4);
		rules = Array.from({ length: k }, (_, i) => ({ entries: randomEntries(rng, n, 0.4), action: CODES[i] ?? '' }));
	}
	const actions = rules.map((r, i) => ({ code: r.action, text: actionTexts[i] ?? '' }));
	const cases = Array.from({ length: rng.int(5, 6) }, () =>
		conditions.map((c) => {
			if (!c.num) return rng.bool();
			const spec = nums.find((s) => s.label === c.num?.label);
			if (!spec) throw new Error('decision-table: numeric spec');
			if (rng.bool(0.4)) return c.num.n;
			const v = rng.int(Math.ceil(spec.lo / spec.step), Math.floor(spec.hi / spec.step)) * spec.step;
			return v === c.num.n ? v + spec.step : v;
		})
	);
	return {
		plot: plot.title,
		conditions,
		rules,
		actions,
		defaultAction: complete ? null : { code: 'Z', text: plot.fallback },
		cases,
		impossible: []
	};
}

function juniorScenario(rng: Rng, classId: string): Params {
	const plot = rng.pick(JUNIOR_PLOTS);
	const wantImpossible = classId !== 'priority';
	// The subsets of the plot's conditions of the class's size with (or without) a combination that cannot happen.
	const subsets = (size: number): number[][] =>
		combos(5)
			.map((mask) => mask.flatMap((on, i) => (on ? [i] : [])))
			.filter((s) => s.length === size)
			.filter((s) => wantImpossible === plot.impossible.some(([i, , j]) => s.includes(i) && s.includes(j)));
	const size = classId === 'priority' || classId === 'impossible' ? rng.int(3, 4) : 4;
	const pool = subsets(size).length > 0 ? subsets(size) : subsets(size - 1);
	const picked = rng.pick(pool);
	const n = picked.length;
	const impossible = plot.impossible
		.filter(([i, , j]) => picked.includes(i) && picked.includes(j))
		.map(([i, a, j, b]): [number, boolean, number, boolean] => [picked.indexOf(i), a, picked.indexOf(j), b]);
	const conditions = picked.map((i): Condition => ({ text: plot.conditions[i] ?? '', num: null, yes: '', no: '' }));
	const k = rng.int(4, 5);
	const actionTexts = rng.sample(plot.actions, 5);
	const rules = Array.from({ length: k }, (_, i) => ({
		entries: randomEntries(rng, n, 0.45),
		action: CODES[i] ?? ''
	}));
	return {
		plot: plot.title,
		conditions,
		rules,
		actions: rules.map((r, i) => ({ code: r.action, text: actionTexts[i] ?? '' })),
		defaultAction: { code: 'Z', text: plot.fallback },
		cases: [],
		impossible
	};
}

const yesNo = (e: Entry): string => (e === 'Y' ? 'Да' : e === 'N' ? 'Нет' : '-');

function tableLines(p: Params): string[] {
	const head = ['Условие', ...p.rules.map((_, i) => `П${i + 1}`)];
	const rows = [
		...p.conditions.map((c, ci) => [c.text, ...p.rules.map((r) => yesNo(r.entries[ci] ?? '-'))]),
		['Действие', ...p.rules.map((r) => r.action)]
	];
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
	const line = (cells: readonly string[]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join('   ')
			.trimEnd();
	return ['```', line(head), ...rows.map(line), '```'];
}

function caseText(p: Params, values: readonly (boolean | number)[]): string {
	return values
		.map((v, i) => {
			const c = p.conditions[i];
			if (!c) return '';
			if (c.num) return `${c.num.label.toLowerCase()} ${num(Number(v))} ${c.num.unit}`;
			return v ? c.yes : c.no;
		})
		.join(', ');
}

function describe(p: Params, grade: string): string {
	const actions = [
		...p.actions.map((a) => `- \`${a.code}\` — ${a.text};`),
		...(p.defaultAction
			? [`- \`${p.defaultAction.code}\` — ${p.defaultAction.text} (ни одно правило не подошло).`]
			: [])
	];
	const last = actions.length - 1;
	actions[last] = (actions[last] ?? '').replace(/;$/, '.');
	const head = [
		`${p.plot}. Логика задана таблицей решений: «Да» и «Нет» — значение условия, «-» — условие безразлично (правило подходит при любом его значении).`,
		'',
		...tableLines(p),
		'',
		'Действия:',
		'',
		...actions,
		''
	];
	if (grade === 'intern') {
		return [
			...head,
			p.defaultAction
				? 'Правила просматриваются слева направо, срабатывает первое правило, все условия которого выполнены. Если не подошло ни одно — действие `Z`.'
				: 'Правила просматриваются слева направо, срабатывает первое правило, все условия которого выполнены.',
			'',
			'Тестировщик готовит ожидаемые результаты для случаев:',
			'',
			...p.cases.map((values, i) => {
				const text = caseText(p, values);
				return `${i + 1}. ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
			}),
			'',
			'Какое действие ожидается в каждом случае? Введите коды действий по одному в строке, в порядке случаев. Например:',
			'',
			'```',
			'B',
			'Z',
			'A',
			'```'
		].join('\n');
	}
	const impossible = p.impossible.map(
		([i, a, j, b]) =>
			`- не бывает сочетания: «${p.conditions[i]?.text ?? ''}» — ${a ? 'Да' : 'Нет'} и «${p.conditions[j]?.text ?? ''}» — ${b ? 'Да' : 'Нет'};`
	);
	if (impossible.length > 0) {
		const lastI = impossible.length - 1;
		impossible[lastI] = (impossible[lastI] ?? '').replace(/;$/, '.');
	}
	return [
		...head,
		'Правила просматриваются слева направо, срабатывает первое правило, все условия которого выполнены. Если не подошло ни одно — действие `Z`.',
		'',
		...(impossible.length > 0
			? ['Ограничения предметной области:', '', ...impossible, '']
			: ['Все сочетания значений условий возможны.', '']),
		`Сочетание — набор значений «Да»/«Нет» всех ${p.conditions.length} условий. Тестировщик разворачивает таблицу в полную: для каждого правила — сколько возможных сочетаний обрабатывает именно оно (с учётом порядка просмотра), и сколько сочетаний уходит в действие \`Z\`. Невозможные сочетания не считаются.`,
		'',
		`Введите ${p.rules.length + 1} чисел по одному в строке: для П1, П2, … по порядку, последним — для действия \`Z\`. Например:`,
		'',
		'```',
		...Array.from({ length: p.rules.length + 1 }, (_, i) => String((i * 3 + 1) % 4)),
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = `import itertools
import json

p = json.loads(input())


def fits(entries, combo):
    return all(e == "-" or (e == "Y") == v for e, v in zip(entries, combo))


def first_action(combo):
    for rule in p["rules"]:
        if fits(rule["entries"], combo):
            return rule["action"]
    return p["default"]


if p["grade"] == "intern":
    for values in p["cases"]:
        combo = []
        for cond, v in zip(p["conditions"], values):
            if cond["num"] is None:
                combo.append(v)
            elif cond["num"]["strict"]:
                combo.append(v > cond["num"]["n"])
            else:
                combo.append(v >= cond["num"]["n"])
        print(first_action(combo))
else:
    tally = {rule["action"]: 0 for rule in p["rules"]}
    tally[p["default"]] = 0
    for combo in itertools.product([False, True], repeat=len(p["conditions"])):
        if any(combo[i] == a and combo[j] == b for i, a, j, b in p["impossible"]):
            continue
        tally[first_action(combo)] += 1
    for rule in p["rules"]:
        print(tally[rule["action"]])
    print(tally[p["default"]])
`;

const WRONG: Record<string, Partial<Rules>> = {
	'boundary-strict': { strictFlip: true },
	'dash-as-no': { dashAsNo: true },
	'last-match': { lastMatch: true },
	'no-priority': { noPriority: true },
	'count-impossible': { countImpossible: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/full-table': ['boundary-strict'],
	'intern/dashes': ['dash-as-no'],
	'intern/priority': ['last-match', 'dash-as-no'],
	'intern/two-thresholds': ['boundary-strict', 'dash-as-no'],
	'junior/priority': ['no-priority', 'dash-as-no'],
	'junior/impossible': ['count-impossible', 'dash-as-no'],
	'junior/mixed': ['no-priority', 'count-impossible'],
	'junior/shadowed': ['no-priority', 'count-impossible']
};

/** Shape rules of a class beyond its misconceptions. */
function fits(p: Params, grade: string, classId: string): boolean {
	if (grade === 'intern') {
		const overlapping = p.rules.some((a, i) => p.rules.some((b, j) => j > i && overlap(a.entries, b.entries)));
		if (classId === 'dashes' && overlapping) return false;
		// Some case falls through to the default unless the table is complete.
		const answer = actionsFor(p, RIGHT);
		if (p.defaultAction && !answer.includes(p.defaultAction.code)) return false;
		return new Set(answer).size >= 3;
	}
	const handled = counts(p, RIGHT);
	const raw = counts(p, { ...RIGHT, noPriority: true });
	const ruleCounts = handled.slice(0, -1);
	// No rule is impossible by itself; only the shadowed class has a rule that every earlier one covers.
	if (raw.slice(0, -1).some((c) => c === 0)) return false;
	const shadowed = ruleCounts.some((c) => c === 0);
	return classId === 'shadowed' ? shadowed : !shadowed;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = input.grade === 'intern' ? internScenario(rng, input.classId) : juniorScenario(rng, input.classId);
		if (!fits(p, input.grade, input.classId)) continue;
		const answer = solve(p, input.grade, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, input.grade, { ...RIGHT, ...change });
				return [id, value.join('|') === answer.join('|') ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		const stdin = JSON.stringify({
			grade: input.grade,
			conditions: p.conditions.map((c) => ({ num: c.num ? { n: c.num.n, strict: c.num.strict } : null })),
			rules: p.rules,
			default: p.defaultAction?.code ?? 'Z',
			cases: p.cases,
			impossible: p.impossible
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
