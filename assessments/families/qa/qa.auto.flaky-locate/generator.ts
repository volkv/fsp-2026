// A flaky test: a module with product code and its unittest tests that pass in a usual run but fail under other
// conditions of the environment — another order of tests, another moment of the run, other random data, another
// order of incoming events, another latency of a worker. Exactly one line of the tests is the source of the
// instability; the candidate names it. The check runs the tests under every condition the statement names (and in
// every order where the order is the condition): with the defect some run fails, with the line fixed all pass; then
// it breaks the product code and requires the tests to notice.
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

/** A line of the module; a keyed line is one the generator needs the number of. */
type Line = string | { text: string; key: Key };
type Key = 'defect' | 'other' | 'product';

interface Flaky {
	header: string[];
	/** Top-level blocks of product code and helpers, separated by two empty lines. */
	blocks: Line[][];
	testClass: string;
	/** Methods of the test class, setUp included; their order is the order of declaration. */
	methods: Line[][];
	/** Working tests the module may also carry; they change nothing about the instability. */
	extras: string[][];
	fix: string;
	/** The check: module globals the tests may change, conditions as Python callables, broken product code. */
	state: string[];
	permute: boolean;
	conditions: string[];
	breaks: string[];
	/** What the statement says about the environment of the run. */
	environment: string;
}

const DOCSTRINGS = [
	'Модуль сервиса и его тесты.',
	'Код продукта и тесты к нему.',
	'Сервис и автотесты, которые иногда падают на CI.',
	'Модуль и тесты из ночного прогона.'
];
const DOCSTRING_TAILS = [
	'Тесты запускаются на каждом коммите.',
	'Падения тестов разбирает дежурный тестировщик.',
	'Нестабильные тесты помечаются в трекере.',
	'Отчёт о прогоне уходит в чат команды.'
];
const CONSTANTS = [
	'SERVICE = "shop"',
	'API_VERSION = "v2"',
	'LOG_LEVEL = "INFO"',
	'REGION = "ru"',
	'RETRIES = 3',
	'TIMEZONE = "UTC"',
	'OWNER = "qa-team"',
	'BUILD = 1024'
];
/** Helpers of the module with a working test each, which a separate test class may carry. */
const HELPERS: { lines: string[]; test: string[] }[] = [
	{
		lines: ['def format_money(amount):', "    return f'{amount:,}'.replace(',', ' ')"],
		test: ['def test_format_money(self):', "    self.assertEqual(format_money(1234567), '1 234 567')"]
	},
	{
		lines: ['def normalize_name(name):', '    return name.strip().lower()'],
		test: ['def test_normalize_name(self):', "    self.assertEqual(normalize_name('  Anna '), 'anna')"]
	},
	{
		lines: ['def chunks(items, size):', '    return [items[i:i + size] for i in range(0, len(items), size)]'],
		test: ['def test_chunks(self):', '    self.assertEqual(chunks([1, 2, 3], 2), [[1, 2], [3]])']
	},
	{
		lines: ['def percent(part, whole):', '    return part * 100 // whole if whole else 0'],
		test: [
			'def test_percent(self):',
			'    self.assertEqual(percent(1, 3), 33)',
			'    self.assertEqual(percent(1, 0), 0)'
		]
	}
];
const TEST_DOCSTRINGS = [
	'"""Проверка из чек-листа релиза."""',
	'"""Регрессия по задаче из трекера."""',
	'"""Сценарий из приёмки."""',
	'"""Проверка из смоук-набора."""'
];

/**
 * The module source: a docstring and constants of random length, the product blocks, the test class; a test may
 * carry a docstring. The surface layout spreads the number of the defect line.
 */
function render(rng: Rng, f: Flaky): { source: string; at: Record<Key, number> } {
	const lines: string[] = [];
	const at: Record<Key, number> = { defect: 0, other: 0, product: 0 };
	const push = (line: Line, indent: string) => {
		if (typeof line === 'string') lines.push(line === '' ? '' : `${indent}${line}`);
		else {
			at[line.key] = lines.length + 1;
			lines.push(`${indent}${line.text}`);
		}
	};
	const tails = rng.sample(DOCSTRING_TAILS, rng.int(0, 2));
	if (tails.length === 0) lines.push(`"""${rng.pick(DOCSTRINGS)}"""`);
	else lines.push(`"""${rng.pick(DOCSTRINGS)}`, '', ...tails, '"""');
	lines.push('', ...f.header);
	const constants = rng.sample(CONSTANTS, rng.int(0, 6));
	if (constants.length) lines.push('', ...constants);
	lines.push('', '');
	// Top-level blocks only define names, so their order is free; a helper nobody tests may join them.
	const helpers = rng.sample(HELPERS, rng.int(0, 3));
	const blocks: Line[][] = rng.shuffle([...f.blocks, ...helpers.map((h) => h.lines)]);
	for (const block of blocks) {
		for (const line of block) push(line, '');
		lines.push('', '');
	}
	const helperTests = helpers.filter(() => rng.bool());
	if (helperTests.length) {
		lines.push('class TestHelpers(unittest.TestCase):');
		helperTests.forEach((h, i) => {
			if (i > 0) lines.push('');
			lines.push(...h.test.map((l) => `    ${l}`));
		});
		lines.push('', '');
	}
	lines.push(`class ${f.testClass}(unittest.TestCase):`);
	const methods = [...f.methods];
	const first = typeof methods[0]?.[0] === 'string' && methods[0][0].startsWith('def setUp') ? 1 : 0;
	for (const extra of rng.sample(f.extras, rng.int(0, f.extras.length))) {
		methods.splice(rng.int(first, methods.length), 0, extra);
	}
	methods.forEach((method, i) => {
		if (i > 0) lines.push('');
		method.forEach((line, j) => {
			push(line, '    ');
			const isTest = typeof method[0] === 'string' && method[0].startsWith('def test_');
			if (j === 0 && isTest && rng.bool(0.4)) lines.push(`        ${rng.pick(TEST_DOCSTRINGS)}`);
		});
	});
	return { source: lines.join('\n'), at };
}

function check(f: Flaky): string {
	return [
		'',
		'',
		'import copy as _copy',
		'import itertools as _itertools',
		'from unittest import mock as _mock',
		'',
		`_SAVED = {name: _copy.deepcopy(globals()[name]) for name in [${f.state.map((s) => `'${s}'`).join(', ')}]}`,
		'_CONDITIONS = [',
		...f.conditions.map((c) => `    ${c},`),
		']',
		'',
		'',
		'def _passes(names, condition):',
		'    _mock.patch.stopall()',
		'    for name, value in _SAVED.items():',
		'        globals()[name] = _copy.deepcopy(value)',
		'    condition()',
		'    result = unittest.TestResult()',
		`    unittest.TestSuite([${f.testClass}(name) for name in names]).run(result)`,
		'    _mock.patch.stopall()',
		'    return result.wasSuccessful()',
		'',
		'',
		'def _check():',
		`    names = unittest.defaultTestLoader.getTestCaseNames(${f.testClass})`,
		`    orders = ${f.permute ? 'list(_itertools.permutations(names))' : '[names]'}`,
		'    for i, condition in enumerate(_CONDITIONS):',
		'        for order in orders:',
		'            if not _passes(order, condition):',
		"                return 'fail: unstable in condition ' + str(i) + ', order ' + ' '.join(order)",
		`    for patcher in [${f.breaks.join(', ')}]:`,
		'        with patcher:',
		'            if _passes(names, _CONDITIONS[0]):',
		"                return 'fail: the tests pass on broken product code'",
		"    return 'ok'",
		'',
		'',
		'print(_check())'
	].join('\n');
}

const pyStr = (s: string) => `'${s}'`;

// ---- middle -------------------------------------------------------------------------------------------------

/** Lines of a setUp that set nothing the tests depend on. */
const SETUP_NOISE = [
	'    self.maxDiff = None',
	"    self.user = 'qa'",
	'    self.calls = []',
	"    self.locale = 'ru'"
];

function sharedFixture(rng: Rng): Flaky {
	const noise = rng.sample(SETUP_NOISE, rng.int(0, 3));
	const goods = rng.sample(['tea', 'jam', 'pie', 'soup', 'rice', 'milk', 'bread', 'honey'], 3) as [
		string,
		string,
		string
	];
	if (rng.bool()) {
		const prices = [rng.int(5, 60) * 10, rng.int(5, 60) * 10];
		const extra = rng.int(5, 30) * 10;
		const total = (prices[0] ?? 0) + (prices[1] ?? 0);
		return {
			header: ['import unittest'],
			blocks: [
				[
					`DEFAULT_ITEMS = [${goods
						.slice(0, 2)
						.map((g, i) => `('${g}', ${prices[i] ?? 0})`)
						.join(', ')}]`
				],
				[
					'class Cart:',
					'    """Корзина меняет переданный список позиций на месте: так корзина сессии видит изменения."""',
					'',
					'    def __init__(self, items):',
					'        self.items = items',
					'',
					'    def add(self, name, price):',
					{ text: '        self.items.append((name, price))', key: 'product' },
					'',
					'    def total(self):',
					'        return sum(price for _, price in self.items)'
				]
			],
			testClass: rng.pick(['TestCart', 'TestBasket']),
			extras: [
				['def test_empty_cart(self):', '    self.assertEqual(Cart([]).total(), 0)'],
				[
					'def test_add_to_own_list(self):',
					'    cart = Cart([])',
					"    cart.add('box', 5)",
					'    self.assertEqual(cart.total(), 5)'
				]
			],
			methods: [
				['def setUp(self):', ...noise, { text: '    self.cart = Cart(DEFAULT_ITEMS)', key: 'defect' }],
				...rng.shuffle<Line[]>([
					['def test_default_total(self):', `    self.assertEqual(self.cart.total(), ${total})`],
					['def test_item_count(self):', '    self.assertEqual(len(self.cart.items), 2)'],
					[
						'def test_session_sees_changes(self):',
						'    session = []',
						`    Cart(session).add('${goods[2]}', ${extra})`,
						`    self.assertEqual(session, [('${goods[2]}', ${extra})])`
					],
					[
						`def test_with_${goods[2]}_added(self):`,
						{ text: `    self.cart.add('${goods[2]}', ${extra})`, key: 'other' },
						`    self.assertEqual(self.cart.total(), ${total + extra})`
					]
				])
			],
			fix: '        self.cart = Cart(list(DEFAULT_ITEMS))',
			state: ['DEFAULT_ITEMS'],
			permute: true,
			conditions: ['lambda: None'],
			breaks: ['_mock.patch.object(Cart, "total", lambda self: -1)'],
			environment: 'На CI тесты запускаются в разном порядке и выборочно: тест должен проходить при любом порядке.'
		};
	}
	const stock = [rng.int(2, 9), rng.int(2, 9)];
	const [g0, g1] = goods;
	return {
		header: ['import unittest'],
		blocks: [
			[`DEFAULT_STOCK = {'${g0}': ${stock[0] ?? 1}, '${g1}': ${stock[1] ?? 1}}`],
			[
				'class Inventory:',
				'    """Остатки склада: объект меняет переданный словарь остатков на месте."""',
				'',
				'    def __init__(self, stock):',
				'        self.stock = stock',
				'',
				'    def reserve(self, item, qty):',
				'        if self.stock.get(item, 0) < qty:',
				'            raise ValueError(item)',
				{ text: '        self.stock[item] -= qty', key: 'product' },
				'',
				'    def available(self, item):',
				'        return self.stock.get(item, 0)'
			]
		],
		testClass: rng.pick(['TestInventory', 'TestStock']),
		extras: [
			[
				'def test_reserve_too_much(self):',
				'    with self.assertRaises(ValueError):',
				"        Inventory({'box': 1}).reserve('box', 2)"
			],
			['def test_unknown_item(self):', "    self.assertEqual(Inventory({}).available('box'), 0)"]
		],
		methods: [
			['def setUp(self):', ...noise, { text: '    self.inventory = Inventory(DEFAULT_STOCK)', key: 'defect' }],
			...rng.shuffle<Line[]>([
				[
					`def test_available_${g0}(self):`,
					`    self.assertEqual(self.inventory.available('${g0}'), ${stock[0] ?? 1})`
				],
				[
					'def test_shared_dict(self):',
					"    stock = {'box': 3}",
					"    Inventory(stock).reserve('box', 1)",
					"    self.assertEqual(stock, {'box': 2})"
				],
				[
					`def test_with_${g0}_reserved(self):`,
					{ text: `    self.inventory.reserve('${g0}', ${stock[0] ?? 1})`, key: 'other' },
					`    self.assertEqual(self.inventory.available('${g0}'), 0)`
				]
			])
		],
		fix: '        self.inventory = Inventory(dict(DEFAULT_STOCK))',
		state: ['DEFAULT_STOCK'],
		permute: true,
		conditions: ['lambda: None'],
		breaks: ['_mock.patch.object(Inventory, "available", lambda self, item: -1)'],
		environment: 'На CI тесты запускаются в разном порядке и выборочно: тест должен проходить при любом порядке.'
	};
}

function calendarBoundary(rng: Rng): Flaky {
	const day = rng.int(3, 25);
	const month = rng.int(1, 11);
	const hour = rng.int(8, 15);
	const minute = rng.pick([0, 10, 15, 30, 45]);
	const byDay = rng.bool();
	const hours = byDay ? 24 : rng.int(2, 6);
	const dueDays = rng.int(2, 9);
	const flakyName = byDay ? 'test_token_expires_next_day' : `test_token_expires_in_${hours}_hours`;
	const defect = byDay
		? "    self.assertEqual(token['expires'].day, NOW.day + 1)"
		: `    self.assertEqual(token['expires'].hour, NOW.hour + ${hours})`;
	const fix = byDay
		? "        self.assertEqual(token['expires'].date(), NOW.date() + timedelta(days=1))"
		: `        self.assertEqual(token['expires'], NOW + timedelta(hours=${hours}))`;
	return {
		header: ['import unittest', 'from datetime import datetime, timedelta'],
		blocks: [
			[`NOW = datetime(2026, ${month}, ${day}, ${hour}, ${minute})  # момент запуска; на CI — текущее время`],
			[
				'class FrozenClock:',
				'    def __init__(self, moment):',
				'        self.moment = moment',
				'',
				'    def now(self):',
				'        return self.moment'
			],
			[
				'def issue_token(clock, hours):',
				'    """Токен действует hours часов с момента выдачи."""',
				'    issued = clock.now()',
				{ text: "    return {'issued': issued, 'expires': issued + timedelta(hours=hours)}", key: 'product' }
			],
			[
				'def due_date(clock, days):',
				'    """Срок оплаты: дата через days дней."""',
				'    return (clock.now() + timedelta(days=days)).date()'
			]
		],
		testClass: rng.pick(['TestTokens', 'TestBilling']),
		extras: [
			['def test_due_date_today(self):', '    self.assertEqual(due_date(self.clock, 0), NOW.date())'],
			['def test_token_issued_now(self):', "    self.assertEqual(issue_token(self.clock, 1)['issued'], NOW)"]
		],
		methods: [
			['def setUp(self):', '    self.clock = FrozenClock(NOW)'],
			...rng.shuffle([
				[
					'def test_token_lifetime(self):',
					`    token = issue_token(self.clock, ${hours})`,
					`    self.assertEqual(token['expires'] - token['issued'], timedelta(hours=${hours}))`
				],
				[
					`def ${flakyName}(self):`,
					{ text: `    token = issue_token(self.clock, ${hours})`, key: 'other' as const },
					{ text: defect, key: 'defect' as const }
				],
				[
					'def test_due_date(self):',
					`    self.assertEqual(due_date(self.clock, ${dueDays}), NOW.date() + timedelta(days=${dueDays}))`
				]
			])
		],
		fix,
		state: ['NOW'],
		permute: false,
		conditions: [
			'lambda: None',
			'lambda: globals().update(NOW=datetime(2026, 1, 31, 23, 30))',
			'lambda: globals().update(NOW=datetime(2026, 4, 30, 22, 45))',
			'lambda: globals().update(NOW=datetime(2026, 12, 31, 21, 15))',
			'lambda: globals().update(NOW=datetime(2026, 6, 15, 0, 5))'
		],
		breaks: [
			'_mock.patch.dict(globals(), {"issue_token": lambda clock, hours: {"issued": clock.now(), "expires": clock.now()}})'
		],
		environment:
			'`NOW` — момент запуска: на CI это текущее время, и тест должен проходить, когда бы его ни запустили, в том числе ночью и в последний день месяца.'
	};
}

interface Threshold {
	constant: string;
	value: number;
	fn: string;
	param: string;
	doc: string;
	below: string;
	above: string;
	belowName: string;
	aboveName: string;
}

const THRESHOLDS: Threshold[] = [
	{
		constant: 'FREE_FROM',
		value: 3000,
		fn: 'delivery_fee',
		param: 'total',
		doc: 'Доставка бесплатна для заказов от FREE_FROM рублей включительно, иначе стоит 300.',
		below: '300',
		above: '0',
		belowName: 'test_small_order_pays',
		aboveName: 'test_big_order_is_free'
	},
	{
		constant: 'BULK_FROM',
		value: 10,
		fn: 'bulk_discount',
		param: 'qty',
		doc: 'Скидка 15 процентов при заказе от BULK_FROM штук включительно, иначе 0.',
		below: '0',
		above: '15',
		belowName: 'test_retail_has_no_discount',
		aboveName: 'test_bulk_has_discount'
	},
	{
		constant: 'ADULT_FROM',
		value: 18,
		fn: 'can_buy',
		param: 'age',
		doc: 'Покупать можно с ADULT_FROM лет включительно.',
		below: 'False',
		above: 'True',
		belowName: 'test_minor_cannot_buy',
		aboveName: 'test_adult_can_buy'
	}
];

function randomBoundary(rng: Rng): Flaky {
	const t = rng.pick(THRESHOLDS);
	const value = t.value * rng.pick([1, 2, 3]);
	const defectInBelow = rng.bool();
	const c = t.constant;
	const lowRange = defectInBelow ? `random.randint(1, ${c})` : `random.randint(1, ${c} - 1)`;
	const gap = rng.int(1, Math.max(1, Math.floor(value / 3)));
	const highRange = defectInBelow ? `random.randint(${c}, ${c} * 3)` : `random.randint(${c} - ${gap}, ${c} * 3)`;
	const lowLine = `    ${t.param} = ${lowRange}`;
	const highLine = `    ${t.param} = ${highRange}`;
	const fix = defectInBelow
		? `        ${t.param} = random.randint(1, ${c} - 1)`
		: `        ${t.param} = random.randint(${c}, ${c} * 3)`;
	const product =
		t.above === 'True'
			? [{ text: `    return ${t.param} >= ${c}`, key: 'product' as const }]
			: [
					{ text: `    if ${t.param} >= ${c}:`, key: 'product' as const },
					`        return ${t.above}`,
					`    return ${t.below}`
				];
	return {
		header: ['import random', 'import unittest'],
		blocks: [[`${c} = ${value}`], [`def ${t.fn}(${t.param}):`, `    """${t.doc}"""`, ...product]],
		testClass: rng.pick(['TestRules', 'TestPricing', 'TestPolicy']),
		extras: [
			['def test_far_above(self):', `    self.assertEqual(${t.fn}(${c} * 10), ${t.above})`],
			['def test_minimum(self):', `    self.assertEqual(${t.fn}(1), ${t.below})`]
		],
		methods: rng.shuffle([
			[
				`def ${t.belowName}(self):`,
				defectInBelow ? { text: lowLine, key: 'defect' as const } : lowLine,
				defectInBelow
					? { text: `    self.assertEqual(${t.fn}(${t.param}), ${t.below})`, key: 'other' as const }
					: `    self.assertEqual(${t.fn}(${t.param}), ${t.below})`
			],
			[
				`def ${t.aboveName}(self):`,
				defectInBelow ? highLine : { text: highLine, key: 'defect' as const },
				defectInBelow
					? `    self.assertEqual(${t.fn}(${t.param}), ${t.above})`
					: { text: `    self.assertEqual(${t.fn}(${t.param}), ${t.above})`, key: 'other' as const }
			],
			['def test_exact_threshold(self):', `    self.assertEqual(${t.fn}(${c}), ${t.above})`]
		]),
		fix,
		state: [],
		permute: false,
		conditions: [
			'lambda: _mock.patch.object(random, "randint", lambda a, b: (a + b) // 2).start()',
			'lambda: _mock.patch.object(random, "randint", lambda a, b: a).start()',
			'lambda: _mock.patch.object(random, "randint", lambda a, b: b).start()'
		],
		breaks: [`_mock.patch.dict(globals(), {"${t.fn}": lambda ${t.param}: ${t.above}})`],
		environment:
			'Случайные значения на каждом запуске свои: тест должен проходить при любых значениях, которые может вернуть `random`.'
	};
}

/** Users in the order of their first event. */
const firstSeen = (events: { user: string }[]) => [...new Set(events.map((e) => e.user))];
const rotations = <T>(xs: T[]): T[][] => [...xs.map((_, i) => [...xs.slice(i), ...xs.slice(0, i)]), [...xs].reverse()];

function unorderedResult(rng: Rng): Flaky | null {
	const users = rng.sample(['anna', 'boris', 'vera', 'gleb', 'dina', 'egor'], 3);
	const events = rng.shuffle(
		[...users, rng.pick(users), rng.pick(users)].map((user) => ({ user, amount: rng.int(1, 30) * 10 }))
	);
	const order = firstSeen(events);
	const totals = new Map<string, number>();
	for (const e of events) totals.set(e.user, (totals.get(e.user) ?? 0) + e.amount);
	const byKeys = rng.bool();
	const conditions = rotations(events);
	const values = (evs: typeof events) => {
		const m = new Map<string, number>();
		for (const e of evs) m.set(e.user, (m.get(e.user) ?? 0) + e.amount);
		return [...m.values()].join(',');
	};
	// Some order of the queue must change what the defect line compares.
	const changes = conditions.some((evs) =>
		byKeys ? firstSeen(evs).join(',') !== order.join(',') : values(evs) !== values(events)
	);
	if (!changes) return null;
	const sortedUsers = [...order].sort();
	const defect = byKeys
		? `    self.assertEqual(list(totals), [${order.map(pyStr).join(', ')}])`
		: `    self.assertEqual(list(totals.values()), [${order.map((u) => totals.get(u) ?? 0).join(', ')}])`;
	const fix = byKeys
		? `        self.assertEqual(sorted(totals), [${sortedUsers.map(pyStr).join(', ')}])`
		: `        self.assertEqual(totals, {${order.map((u) => `'${u}': ${totals.get(u) ?? 0}`).join(', ')}})`;
	const someone = rng.pick(order);
	const queue = (evs: typeof events) =>
		`[${evs.map((e) => `{'user': '${e.user}', 'amount': ${e.amount}}`).join(', ')}]`;
	const grand = events.reduce((s, e) => s + e.amount, 0);
	return {
		header: ['import unittest'],
		blocks: [
			[`QUEUE = ${queue(events)}  # события из очереди; порядок доставки не гарантирован`],
			['def fetch_events():', '    return list(QUEUE)'],
			[
				'def totals_by_user(events):',
				'    """Сумма событий по каждому пользователю."""',
				'    totals = {}',
				'    for event in events:',
				{ text: "        totals[event['user']] = totals.get(event['user'], 0) + event['amount']", key: 'product' },
				'    return totals'
			]
		],
		testClass: rng.pick(['TestTotals', 'TestReport', 'TestStats']),
		extras: [
			['def test_no_events(self):', '    self.assertEqual(totals_by_user([]), {})'],
			[
				'def test_single_event(self):',
				"    self.assertEqual(totals_by_user([{'user': 'kim', 'amount': 5}]), {'kim': 5})"
			]
		],
		methods: rng.shuffle([
			[
				`def test_${byKeys ? 'users' : 'amounts_per_user'}(self):`,
				{ text: '    totals = totals_by_user(fetch_events())', key: 'other' as const },
				{ text: defect, key: 'defect' as const }
			],
			[
				`def test_total_of_${someone}(self):`,
				`    self.assertEqual(totals_by_user(fetch_events())['${someone}'], ${totals.get(someone) ?? 0})`
			],
			['def test_grand_total(self):', `    self.assertEqual(sum(totals_by_user(fetch_events()).values()), ${grand})`]
		]),
		fix,
		state: ['QUEUE'],
		permute: false,
		conditions: conditions.map((evs) => `lambda: globals().update(QUEUE=${queue(evs)})`),
		breaks: ['_mock.patch.dict(globals(), {"totals_by_user": lambda events: {e["user"]: 1 for e in events}})'],
		environment:
			'Очередь доставляет события в любом порядке: тест должен проходить при любом порядке событий в `QUEUE`.'
	};
}

// ---- senior -------------------------------------------------------------------------------------------------

const WORKER_BLOCKS: Line[][] = [
	['LATENCY = 300  # задержка воркера, мс; на CI бывает от 50 до 3000'],
	[
		'class FakeClock:',
		'    def __init__(self):',
		'        self.now = 0',
		'',
		'    def sleep(self, ms):',
		'        self.now += ms'
	],
	[
		'class Worker:',
		'    def __init__(self, clock, latency):',
		'        self.clock = clock',
		'        self.latency = latency',
		'        self.jobs = {}',
		'',
		'    def submit(self, job_id):',
		{ text: '        self.jobs[job_id] = self.clock.now + self.latency', key: 'product' },
		'',
		'    def is_done(self, job_id):',
		'        return self.clock.now >= self.jobs[job_id]'
	],
	[
		'def wait_until(clock, condition, timeout, interval):',
		'    deadline = clock.now + timeout',
		'    while not condition():',
		'        if clock.now >= deadline:',
		'            raise TimeoutError(timeout)',
		'        clock.sleep(interval)'
	]
];

function workerFlaky(rng: Rng, kind: 'sleep' | 'timeout'): Flaky {
	const ids = rng.sample(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], 3) as [string, string, string];
	const pause = rng.pick([400, 500, 600, 800, 1000]);
	const tight = rng.pick([500, 800, 1000, 1500, 2000]);
	const interval = rng.pick([20, 50, 100]);
	const [pending, flaky, report] = ids;
	const wait = (id: string, timeout: number) =>
		`wait_until(self.clock, lambda: self.worker.is_done('${id}'), timeout=${timeout}, interval=${interval})`;
	const defect = kind === 'sleep' ? `    self.clock.sleep(${pause})` : `    ${wait(flaky, tight)}`;
	return {
		header: ['import unittest'],
		blocks: WORKER_BLOCKS,
		testClass: rng.pick(['TestWorker', 'TestJobs', 'TestQueue']),
		extras: [
			['def test_unknown_job(self):', '    with self.assertRaises(KeyError):', "        self.worker.is_done('zz')"],
			['def test_clock_starts_at_zero(self):', '    self.assertEqual(self.clock.now, 0)']
		],
		methods: [
			['def setUp(self):', '    self.clock = FakeClock()', '    self.worker = Worker(self.clock, LATENCY)'],
			...rng.shuffle([
				[
					'def test_job_is_pending_after_submit(self):',
					`    self.worker.submit('${pending}')`,
					`    self.assertFalse(self.worker.is_done('${pending}'))`
				],
				[
					'def test_job_finishes(self):',
					{ text: `    self.worker.submit('${flaky}')`, key: 'other' as const },
					{ text: defect, key: 'defect' as const },
					`    self.assertTrue(self.worker.is_done('${flaky}'))`
				],
				[
					'def test_clock_after_job(self):',
					`    self.worker.submit('${report}')`,
					`    ${wait(report, 5000)}`,
					'    self.assertGreaterEqual(self.clock.now, LATENCY)'
				]
			])
		],
		fix: `        ${wait(flaky, 5000)}`,
		state: ['LATENCY'],
		permute: false,
		conditions: [50, 300, 1200, 2900].map((l) => `lambda: globals().update(LATENCY=${l})`),
		breaks: ['_mock.patch.object(Worker, "is_done", lambda self, job_id: True)'],
		environment:
			'`LATENCY` — задержка воркера: на CI она бывает от 50 до 3000 мс, и тест должен проходить при любой из них.'
	};
}

function leakedPatch(rng: Rng): Flaky {
	const limit = rng.int(8, 20);
	const small = rng.int(2, limit - 4);
	const currency = rng.pick(['RUB', 'KZT', 'BYN']);
	const other = rng.pick(['USD', 'EUR', 'CNY']);
	const amount = rng.int(5, 500);
	return {
		header: ['import types', 'import unittest', 'from unittest import mock'],
		blocks: [
			[`config = types.SimpleNamespace(MAX_ITEMS=${limit}, CURRENCY='${currency}')`],
			[
				'def can_add(cart_size):',
				'    """В корзину можно добавить позицию, пока в ней меньше MAX_ITEMS позиций."""',
				{ text: '    return cart_size < config.MAX_ITEMS', key: 'product' }
			],
			['def price_label(amount):', "    return f'{amount} {config.CURRENCY}'"]
		],
		testClass: rng.pick(['TestLimits', 'TestCartRules', 'TestCheckout']),
		extras: [
			['def test_limit_is_positive(self):', '    self.assertGreater(config.MAX_ITEMS, 0)'],
			['def test_label_of_zero(self):', `    self.assertEqual(price_label(0), '0 ${currency}')`]
		],
		methods: rng.shuffle([
			['def test_default_limit(self):', `    self.assertTrue(can_add(${limit - 1}))`],
			['def test_label(self):', `    self.assertEqual(price_label(${amount}), '${amount} ${currency}')`],
			[
				'def test_small_limit(self):',
				{ text: `    mock.patch.object(config, 'MAX_ITEMS', ${small}).start()`, key: 'defect' as const },
				{ text: `    self.assertFalse(can_add(${small}))`, key: 'other' as const }
			],
			[
				'def test_currency_override(self):',
				`    with mock.patch.object(config, 'CURRENCY', '${other}'):`,
				`        self.assertEqual(price_label(${amount}), '${amount} ${other}')`
			]
		]),
		fix: `        self.enterContext(mock.patch.object(config, 'MAX_ITEMS', ${small}))`,
		state: ['config'],
		permute: true,
		conditions: ['lambda: None'],
		breaks: ['_mock.patch.dict(globals(), {"can_add": lambda cart_size: True})'],
		environment: 'На CI тесты запускаются в разном порядке и выборочно: тест должен проходить при любом порядке.'
	};
}

function sortTies(rng: Rng): Flaky | null {
	const ids = rng.sample(
		Array.from({ length: 40 }, (_, i) => i + 1),
		5
	);
	const top = rng.int(80, 99) * 10;
	const tie = rng.int(30, 70) * 10;
	const low = rng.int(5, 25) * 10;
	const totals = rng.shuffle([top, tie, tie, low, rng.pick([tie, low])]);
	const orders = ids.map((id, i) => ({ id, total: totals[i] ?? 0 }));
	const limit = rng.int(3, 4);
	const topOf = (os: typeof orders) => [...os].sort((a, b) => b.total - a.total).slice(0, limit);
	const expected = topOf(orders);
	const conditions = rotations(orders);
	if (
		!conditions.some(
			(os) =>
				topOf(os)
					.map((o) => o.id)
					.join(',') !== expected.map((o) => o.id).join(',')
		)
	)
		return null;
	const queue = (os: typeof orders) => `[${os.map((o) => `{'id': ${o.id}, 'total': ${o.total}}`).join(', ')}]`;
	const maxId = expected[0]?.id ?? 0;
	return {
		header: ['import unittest'],
		blocks: [
			[`QUEUE = ${queue(orders)}  # заказы из очереди; порядок доставки не гарантирован`],
			['def fetch_orders():', '    return list(QUEUE)'],
			[
				'def top_orders(orders, limit):',
				'    """limit заказов с наибольшей суммой, по убыванию суммы."""',
				{ text: "    return sorted(orders, key=lambda o: o['total'], reverse=True)[:limit]", key: 'product' }
			]
		],
		testClass: rng.pick(['TestTopOrders', 'TestDashboard', 'TestReport']),
		extras: [
			['def test_no_orders(self):', '    self.assertEqual(top_orders([], 3), [])'],
			['def test_zero_limit(self):', '    self.assertEqual(top_orders(fetch_orders(), 0), [])']
		],
		methods: rng.shuffle([
			[
				'def test_top_orders(self):',
				{ text: `    result = top_orders(fetch_orders(), ${limit})`, key: 'other' as const },
				{
					text: `    self.assertEqual([o['id'] for o in result], [${expected.map((o) => o.id).join(', ')}])`,
					key: 'defect' as const
				}
			],
			['def test_limit(self):', `    self.assertEqual(len(top_orders(fetch_orders(), 2)), 2)`],
			['def test_biggest_first(self):', `    self.assertEqual(top_orders(fetch_orders(), 1)[0]['id'], ${maxId})`]
		]),
		fix: `        self.assertEqual([o['total'] for o in result], [${expected.map((o) => o.total).join(', ')}])`,
		state: ['QUEUE'],
		permute: false,
		conditions: conditions.map((os) => `lambda: globals().update(QUEUE=${queue(os)})`),
		breaks: [
			'_mock.patch.dict(globals(), {"top_orders": lambda orders, limit: sorted(orders, key=lambda o: o["total"])[:limit]})'
		],
		environment: 'Очередь доставляет заказы в любом порядке: тест должен проходить при любом порядке заказов в `QUEUE`.'
	};
}

const MAKERS: Record<string, (rng: Rng) => Flaky | null> = {
	'middle/shared-fixture': sharedFixture,
	'middle/calendar-boundary': calendarBoundary,
	'middle/random-boundary': randomBoundary,
	'middle/unordered-result': unorderedResult,
	'senior/fixed-sleep': (rng) => workerFlaky(rng, 'sleep'),
	'senior/leaked-patch': leakedPatch,
	'senior/sort-ties': sortTies,
	'senior/tight-timeout': (rng) => workerFlaky(rng, 'timeout')
};

function statement(environment: string): string {
	return [
		'Модуль на Python 3: код продукта и тесты `unittest`. При обычном запуске все тесты проходят, но на CI один из них',
		'время от времени падает, хотя код продукта верен и соответствует строкам документации.',
		'',
		environment,
		'',
		'Найдите строку тестов — источник нестабильности: если исправить только её, все тесты стабильно проходят в любых',
		'условиях запуска и по-прежнему ловят ошибки в коде продукта. Введите номер этой строки (нумерация с 1), например `42`.'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = MAKERS[slot];
	if (!make) throw new Error(`${descriptor.key}: no module for ${slot}`);
	for (let tries = 0; tries < 200; tries += 1) {
		const f = make(rng);
		if (f === null) continue;
		const { source, at } = render(rng, f);
		const lines = source.split('\n');
		const unchanged = (line: number) => ({ kind: 'line' as const, line, replacement: lines[line - 1] ?? '' });
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(f.environment), code: { language: 'python3', source } },
			answer: { kind: 'line_no', value: at.defect }
		});
		const probe = check(f);
		return {
			instance,
			reference: () => ({ kind: 'bug', check: probe, fix: f.fix }),
			wrong: () => ({
				'test-other-line': unchanged(at.other),
				'product-line': unchanged(at.product)
			})
		};
	}
	throw new Error(`${descriptor.key}: no module for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
