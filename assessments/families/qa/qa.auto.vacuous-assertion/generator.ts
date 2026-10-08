// A module with its unittest tests: every test passes, but one of them checks nothing that matters — it passes on a
// wrong implementation of its function too. The candidate names the line of that test which makes it vacuous. The
// check runs the tests on the right functions (all pass) and on a wrong implementation of each function (its test
// must fail).
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

/** A wrong implementation a test of the given style must catch; the check swaps the function for it. */
type Defect = 'truthy' | 'shorter' | 'sameLength' | 'wrongError';

/** A function under test with one call and its expected value, and its wrong implementations. */
interface Sut {
	name: string;
	lines: string[];
	call: string;
	expected: string;
	list: boolean;
	/** A call that must raise ValueError by the specification. */
	bad: string | null;
	/** Python bodies of wrong implementations, with the function's parameters. */
	defects: Partial<Record<Defect, string[]>>;
	params: string;
}

const SUTS: Sut[] = [
	{
		name: 'split_tags',
		params: 'text',
		lines: [
			'def split_tags(text):',
			'    """Теги через запятую: без пробелов по краям, в нижнем регистре, без пустых."""',
			'    tags = []',
			"    for part in text.split(','):",
			'        part = part.strip().lower()',
			'        if part:',
			'            tags.append(part)',
			'    return tags'
		],
		call: "split_tags(' Python, SQL ,,QA ')",
		expected: "['python', 'sql', 'qa']",
		list: true,
		bad: null,
		defects: {
			truthy: ["    return [p.strip() for p in text.split(',') if p.strip()]"],
			sameLength: ["    return [p.strip() for p in text.split(',') if p.strip()]"],
			shorter: ["    return [p.strip().lower() for p in text.split(',') if p.strip()][:-1]"]
		}
	},
	{
		name: 'normalize_phone',
		params: 'raw',
		lines: [
			'def normalize_phone(raw):',
			'    """Номер из 11 цифр в виде +7XXXXXXXXXX; ведущая 8 заменяется на 7; иначе ValueError."""',
			"    digits = ''.join(ch for ch in raw if ch.isdigit())",
			"    if len(digits) != 11 or digits[0] not in '78':",
			'        raise ValueError(raw)',
			"    if digits.startswith('8'):",
			"        digits = '7' + digits[1:]",
			"    return '+' + digits"
		],
		call: "normalize_phone('8 (912) 345-67-89')",
		expected: "'+79123456789'",
		list: false,
		bad: "normalize_phone('12-34')",
		defects: {
			truthy: ["    return '+' + ''.join(ch for ch in raw if ch.isdigit())"],
			wrongError: ['    raise TypeError(raw)']
		}
	},
	{
		name: 'apply_discount',
		params: 'price, percent',
		lines: [
			'def apply_discount(price, percent):',
			'    """Цена после скидки percent процентов, скидка округляется вниз; percent вне 0..100 — ValueError."""',
			'    if not 0 <= percent <= 100:',
			'        raise ValueError(percent)',
			'    return price - price * percent // 100'
		],
		call: 'apply_discount(1999, 15)',
		expected: '1700',
		list: false,
		bad: 'apply_discount(500, 120)',
		defects: {
			truthy: ['    return price * percent // 100'],
			wrongError: ['    raise OverflowError(percent)']
		}
	},
	{
		name: 'top_scores',
		params: 'scores, k',
		lines: [
			'def top_scores(scores, k):',
			'    """k лучших результатов по убыванию; k < 1 — ValueError."""',
			'    if k < 1:',
			'        raise ValueError(k)',
			'    ordered = sorted(scores, reverse=True)',
			'    return ordered[:k]'
		],
		call: 'top_scores([40, 95, 70, 88], 3)',
		expected: '[95, 88, 70]',
		list: true,
		bad: 'top_scores([1, 2], 0)',
		defects: {
			truthy: ['    return sorted(scores)[:k]'],
			sameLength: ['    return sorted(scores)[:k]'],
			shorter: ['    return sorted(scores, reverse=True)[:k - 1]'],
			wrongError: ['    raise IndexError(k)']
		}
	},
	{
		name: 'chunk',
		params: 'items, size',
		lines: [
			'def chunk(items, size):',
			'    """Части списка по size элементов, последняя может быть короче; size <= 0 — ValueError."""',
			'    if size <= 0:',
			'        raise ValueError(size)',
			'    return [items[i:i + size] for i in range(0, len(items), size)]'
		],
		call: 'chunk([1, 2, 3, 4, 5], 2)',
		expected: '[[1, 2], [3, 4], [5]]',
		list: true,
		bad: 'chunk([1, 2], 0)',
		defects: {
			truthy: ['    return [items[i:i + size - 1] for i in range(0, len(items), size)]'],
			sameLength: ['    return [items[i:i + size - 1] for i in range(0, len(items), size)]'],
			shorter: ['    return [items[i:i + size] for i in range(0, len(items) - size, size)]'],
			wrongError: ['    raise ZeroDivisionError(size)']
		}
	},
	{
		name: 'parse_duration',
		params: 'text',
		lines: [
			'def parse_duration(text):',
			'    """Длительность вида 2h15m в минутах; другой формат — ValueError."""',
			"    hours, sep, rest = text.partition('h')",
			"    minutes = rest.removesuffix('m')",
			'    if not sep or minutes == rest or not hours.isdigit() or not minutes.isdigit():',
			'        raise ValueError(text)',
			'    return int(hours) * 60 + int(minutes)'
		],
		call: "parse_duration('2h15m')",
		expected: '135',
		list: false,
		bad: "parse_duration('15m')",
		defects: {
			truthy: ["    return int(text.partition('h')[0]) * 60"],
			wrongError: ['    raise KeyError(text)']
		}
	},
	{
		name: 'mask_card',
		params: 'number',
		lines: [
			'def mask_card(number):',
			'    """Номер карты для чека: звёздочки и последние четыре цифры."""',
			"    digits = number.replace(' ', '')",
			"    return '**** ' + digits[-4:]"
		],
		call: "mask_card('4276 3800 1234 5678')",
		expected: "'**** 5678'",
		list: false,
		bad: null,
		defects: { truthy: ["    return '**** ' + number.replace(' ', '')[:4]"] }
	},
	{
		name: 'unique_emails',
		params: 'emails',
		lines: [
			'def unique_emails(emails):',
			'    """Адреса без повторов с точностью до регистра и пробелов, в порядке первого появления."""',
			'    seen = []',
			'    for email in emails:',
			'        email = email.strip().lower()',
			'        if email not in seen:',
			'            seen.append(email)',
			'    return seen'
		],
		call: "unique_emails(['Ann@x.io', 'ann@x.io ', 'bob@x.io', 'Cid@x.io'])",
		expected: "['ann@x.io', 'bob@x.io', 'cid@x.io']",
		list: true,
		bad: null,
		defects: {
			truthy: ['    return sorted({e.strip().lower() for e in emails}, reverse=True)'],
			sameLength: ['    return sorted({e.strip().lower() for e in emails}, reverse=True)'],
			shorter: ['    return list(dict.fromkeys(e.strip().lower() for e in emails))[:-1]']
		}
	}
];

/** How a test checks its function; the vacuous styles are the classes, the others are working checks. */
type Style =
	| 'equal'
	| 'equal-inline'
	| 'equal-true'
	| 'zip-strict'
	| 'raises'
	| 'truthy'
	| 'not-none'
	| 'zip'
	| 'length'
	| 'raises-broad'
	| 'oracle'
	| 'self-compare';

const DEFECT_OF: Record<Style, Defect> = {
	equal: 'truthy',
	'equal-inline': 'truthy',
	'equal-true': 'truthy',
	'zip-strict': 'shorter',
	raises: 'wrongError',
	truthy: 'truthy',
	'not-none': 'truthy',
	zip: 'shorter',
	length: 'sameLength',
	'raises-broad': 'wrongError',
	oracle: 'truthy',
	'self-compare': 'truthy'
};

/** The vacuous styles of each class. */
const VACUOUS: Record<string, Style[]> = {
	'truthy-check': ['truthy', 'not-none'],
	'partial-compare': ['zip', 'length'],
	'broad-raises': ['raises-broad'],
	tautology: ['oracle', 'self-compare']
};

const EQUAL = '        self.assertEqual(result, expected)';

interface TestCode {
	lines: string[];
	/** Index of the line that makes a vacuous test vacuous (or the distractor line of a working test). */
	key: number;
	/** The line that repairs the test. */
	fix: string;
	/** Index of the line that calls the function. */
	act: number;
	/** Other lines whose one-instruction replacement repairs the test too, with that replacement. */
	alternatives?: { at: number; fix: string }[];
}

function testCode(sut: Sut, style: Style): TestCode {
	if (style === 'raises' || style === 'raises-broad') {
		const exception = style === 'raises' ? 'ValueError' : 'Exception';
		return {
			lines: [
				`    def test_${sut.name}_rejects_bad_input(self):`,
				`        with self.assertRaises(${exception}):`,
				`            ${sut.bad ?? ''}`
			],
			key: 1,
			fix: '        with self.assertRaises(ValueError):',
			act: 2
		};
	}
	const head = [`    def test_${sut.name}(self):`, `        result = ${sut.call}`];
	const expected = `        expected = ${sut.expected}`;
	const inline = `        self.assertEqual(result, ${sut.expected})`;
	switch (style) {
		case 'equal':
			return { lines: [...head, expected, EQUAL], key: 3, fix: EQUAL, act: 1 };
		case 'equal-inline':
			return { lines: [...head, inline], key: 2, fix: inline, act: 1 };
		case 'equal-true':
			return { lines: [...head, expected, '        self.assertTrue(result == expected)'], key: 3, fix: EQUAL, act: 1 };
		case 'zip-strict':
		case 'zip':
			return {
				lines: [
					...head,
					expected,
					`        for got, want in zip(result, expected${style === 'zip-strict' ? ', strict=True' : ''}):`,
					'            self.assertEqual(got, want)'
				],
				key: 3,
				fix: '        for got, want in zip(result, expected, strict=True):',
				act: 1
			};
		case 'truthy':
			return { lines: [...head, expected, '        self.assertTrue(result, expected)'], key: 3, fix: EQUAL, act: 1 };
		case 'not-none':
			return { lines: [...head, '        self.assertIsNotNone(result)'], key: 2, fix: inline, act: 1 };
		case 'length':
			return {
				lines: [...head, expected, '        self.assertEqual(len(result), len(expected))'],
				key: 3,
				fix: EQUAL,
				act: 1
			};
		case 'oracle':
			// The expected value computed by the function itself: putting the literal in place of either side repairs it.
			return {
				lines: [...head, `        expected = ${sut.call}`, EQUAL],
				key: 2,
				fix: expected,
				act: 1,
				alternatives: [
					{ at: 1, fix: `        result = ${sut.expected}` },
					{ at: 3, fix: inline }
				]
			};
		case 'self-compare':
			return { lines: [...head, '        self.assertEqual(result, result)'], key: 2, fix: inline, act: 1 };
	}
}

/** Styles a function supports. */
function supports(sut: Sut, style: Style): boolean {
	if (style === 'raises' || style === 'raises-broad') return sut.bad !== null && sut.defects.wrongError !== undefined;
	if (style === 'zip' || style === 'zip-strict') return sut.list && sut.defects.shorter !== undefined;
	if (style === 'length') return sut.list && sut.defects.sameLength !== undefined;
	return sut.defects.truthy !== undefined;
}

const MODULE_TITLES = [
	'Утилиты профиля кандидата и их тесты',
	'Вспомогательные функции витрины и их тесты',
	'Функции оформления заказа и их тесты',
	'Помощники импорта данных и их тесты'
];
const HEADER_CONSTANTS = [
	'MAX_TAGS = 20',
	"CURRENCY = 'RUB'",
	'DEFAULT_PAGE = 1',
	"LOCALE = 'ru'",
	'TIMEOUT = 5',
	'RETRIES = 3',
	"DATE_FORMAT = '%d.%m.%Y'",
	'PAGE_SIZE = 50'
];
const CLASS_NAMES = ['TestHelpers', 'TestUtils', 'TestModule', 'TestFormatting'];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	alternatives: { line: number; fix: string }[];
	distractor: { line: number; text: string } | null;
	act: { line: number; text: string } | null;
}

function compose(rng: Rng, classId: string): Program | null {
	const vacuousStyle = rng.pick(VACUOUS[classId] ?? []);
	const target = rng.pick(SUTS.filter((s) => supports(s, vacuousStyle)));
	const others = rng.sample(
		SUTS.filter((s) => s !== target),
		rng.int(2, 3)
	);
	// Working tests: every one in its own style, at least one of them looking like a weak check. A test with
	// `expected` on its own line and one with the value inline both occur, so an unused name gives nothing away; next to
	// a broad `assertRaises` stands a working one.
	const lookalike: Style[] = ['equal-true', 'zip-strict', 'raises'];
	const styles = new Map<Sut, Style>([[target, vacuousStyle]]);
	for (const sut of others) {
		const options = (['equal', 'equal-inline', ...lookalike] as Style[]).filter((s) => supports(sut, s));
		styles.set(sut, rng.pick(options));
	}
	if (!others.some((s) => lookalike.includes(styles.get(s) ?? 'equal'))) return null;
	if (classId === 'broad-raises' && !others.some((s) => styles.get(s) === 'raises')) return null;
	const noExpectedLine: Style[] = ['not-none', 'self-compare'];
	if (noExpectedLine.includes(vacuousStyle) && !others.some((s) => styles.get(s) === 'equal-inline')) return null;
	const functions = rng.shuffle([target, ...others]);
	const tests = rng.shuffle([target, ...others]);
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 6));
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		'',
		'import unittest',
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	for (const sut of functions) lines.push(...sut.lines, '', '');
	const className = rng.pick(CLASS_NAMES);
	lines.push(`class ${className}(unittest.TestCase):`);
	let answer = 0;
	let fix = '';
	let alternatives: Program['alternatives'] = [];
	let act: Program['act'] = null;
	let distractor: Program['distractor'] = null;
	tests.forEach((sut, i) => {
		if (i > 0) lines.push('');
		const style = styles.get(sut) ?? 'equal';
		const code = testCode(sut, style);
		const offset = lines.length;
		lines.push(...code.lines);
		if (sut === target) {
			answer = offset + code.key + 1;
			fix = code.fix;
			alternatives = (code.alternatives ?? []).map((a) => ({ line: offset + a.at + 1, fix: a.fix }));
			// When the call line is itself a repair, naming it is not a wrong answer.
			act = alternatives.some((a) => a.line === offset + code.act + 1)
				? null
				: { line: offset + code.act + 1, text: code.lines[code.act] ?? '' };
		} else if (distractor === null && lookalike.includes(style)) {
			const text = code.lines[code.key] ?? '';
			distractor = { line: offset + code.key + 1, text: style === 'equal-true' ? EQUAL : text };
		}
	});
	const defects = [target, ...others].map((sut) => {
		const body = sut.defects[DEFECT_OF[styles.get(sut) ?? 'equal']] ?? [];
		// A constant answer as well: a test comparing the function with itself on other arguments must not pass it.
		return [
			`def _bad_${sut.name}(${sut.params}):`,
			...body,
			'',
			'',
			`def _const_${sut.name}(${sut.params}):`,
			'    return None',
			'',
			'',
			// An empty list as well: a loop over pairs of elements checks nothing on it.
			`def _empty_${sut.name}(${sut.params}):`,
			'    return []'
		];
	});
	const check = [
		'',
		'',
		...defects.flatMap((d) => [...d, '', '']),
		'def _suite_passes():',
		'    result = unittest.TestResult()',
		`    unittest.defaultTestLoader.loadTestsFromTestCase(${className}).run(result)`,
		'    return result.wasSuccessful()',
		'',
		'',
		'def _check():',
		'    if not _suite_passes():',
		"        return 'fail: the tests fail on the right functions'",
		`    for name in [${[target, ...others].map((s) => `'${s.name}'`).join(', ')}]:`,
		'        right = globals()[name]',
		"        for wrong in ('_bad_', '_const_', '_empty_'):",
		'            globals()[name] = globals()[wrong + name]',
		'            try:',
		'                caught = not _suite_passes()',
		'            finally:',
		'                globals()[name] = right',
		'            if not caught:',
		"                return 'fail: a wrong ' + name + ' passes its test'",
		"    return 'ok'",
		'',
		'',
		'print(_check())'
	].join('\n');
	return { source: lines.join('\n').trimEnd(), check, answer, fix, alternatives, distractor, act };
}

const STATEMENT = [
	'Модуль на CPython 3.12–3.13 с тестами `unittest`. У каждой функции в строке документации записана её спецификация,',
	'функции написаны верно, все тесты проходят. Но один тест ничего толком не проверяет: он прошёл бы и на неверной',
	'реализации своей функции.',
	'',
	'Найдите строку, из-за которой этот тест не ловит дефект: если заменить только её, тест упадёт на неверной',
	'реализации и по-прежнему пройдёт на верной. Введите номер этой строки (нумерация с 1), например `42`.',
	'Если исправить можно в нескольких строках — засчитывается любая из них. Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте конструкций, которых в ней нет (`:=`, lambda, обёртки, новые функции), и не переносите в неё логику из другой строки.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const p = compose(rng, input.classId);
		if (p === null) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: STATEMENT, code: { language: 'python3', source: p.source } },
			answer: {
				kind: 'line_no',
				value: p.answer,
				...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
			}
		});
		return {
			instance,
			reference: () => ({ kind: 'bug', check: p.check, fix: p.fix, alternatives: p.alternatives }),
			wrong: () => ({
				'distractor-assertion':
					p.distractor === null ? null : { kind: 'line', line: p.distractor.line, replacement: p.distractor.text },
				'act-line': p.act === null ? null : { kind: 'line', line: p.act.line, replacement: p.act.text }
			})
		};
	}
	throw new Error(`${descriptor.key}: no module for ${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
