// The result of a unittest run: what lands in failures, errors, skipped, expectedFailures and unexpectedSuccesses and
// what testsRun counts, for subTest loops, expectedFailure, skip decorators and exceptions in fixtures. The shown
// program runs one test case and prints testsRun and the short ids of the records in every list of the result.
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

interface Rules {
	subtestAsTests: boolean;
	subtestStops: boolean;
	errorAsFailure: boolean;
	unexpectedSuccessIsPass: boolean;
	expectedFailureIgnored: boolean;
	xfailErrorIsError: boolean;
	skippedNotRun: boolean;
	skipUnlessInverted: boolean;
	setupErrorAsFailure: boolean;
	oneOutcomePerTest: boolean;
}

const RIGHT: Rules = {
	subtestAsTests: false,
	subtestStops: false,
	errorAsFailure: false,
	unexpectedSuccessIsPass: false,
	expectedFailureIgnored: false,
	xfailErrorIsError: false,
	skippedNotRun: false,
	skipUnlessInverted: false,
	setupErrorAsFailure: false,
	oneOutcomePerTest: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'subtest-as-tests': { subtestAsTests: true },
	'subtest-stops': { subtestStops: true },
	'error-as-failure': { errorAsFailure: true },
	'unexpected-success-is-pass': { unexpectedSuccessIsPass: true },
	'expected-failure-ignored': { expectedFailureIgnored: true },
	'xfail-error-is-error': { xfailErrorIsError: true },
	'skipped-not-run': { skippedNotRun: true },
	'skip-unless-inverted': { skipUnlessInverted: true },
	'setup-error-as-failure': { setupErrorAsFailure: true },
	'one-outcome-per-test': { oneOutcomePerTest: true }
};

const REQUIRED: Record<string, string[]> = {
	subtests: ['subtest-as-tests', 'subtest-stops', 'error-as-failure'],
	'expected-failure': ['unexpected-success-is-pass', 'expected-failure-ignored', 'xfail-error-is-error'],
	'fail-error-skip': ['error-as-failure', 'skipped-not-run', 'skip-unless-inverted'],
	'fixture-errors': ['setup-error-as-failure', 'one-outcome-per-test', 'skipped-not-run']
};

/** What a test adds to the result: to testsRun and to the lists, one record per unit. */
interface Counts {
	run: number;
	failures: number;
	errors: number;
	skipped: number;
	xfail: number;
	xpass: number;
}

/** A record lands in a list under the short id of its test: the method name, for a subTest with its parameters. */
type Add = (part: Partial<Counts>, label?: string) => void;

/** A problem a test or a subTest meets; the rules turn it into a record of the result. */
type Record_ = 'fail' | 'error';

interface Test {
	name: string;
	/** Python lines of the method with its decorators, without the indentation of the class. */
	lines: string[];
	count: (rules: Rules, add: Add) => void;
}

const WORDS = [
	'total',
	'discount',
	'refund',
	'login',
	'search',
	'export',
	'cart',
	'limit',
	'profile',
	'invoice',
	'rating',
	'upload',
	'filter',
	'payment',
	'report',
	'session',
	'coupon',
	'avatar',
	'tariff',
	'delivery'
];
const GOODS = ['tea', 'jam', 'pie', 'soup', 'rice', 'milk', 'bread', 'corn', 'salt', 'cake', 'kefir', 'honey'];
const REASONS = ['flaky on CI', 'needs network', 'slow', 'not ready', 'broken fixture'];

/** Names of the methods of one test case: distinct words. */
class Names {
	readonly #free: string[];
	constructor(rng: Rng) {
		this.#free = rng.shuffle(WORDS);
	}
	next(): string {
		const word = this.#free.pop();
		if (word === undefined) throw new Error('out of test names');
		return `test_${word}`;
	}
}

/** The record of a plain problem under the rules. */
function plain(problem: Record_, rules: Rules): Partial<Counts> {
	return problem === 'fail' || rules.errorAsFailure ? { failures: 1 } : { errors: 1 };
}

function checkTest(rng: Rng, name: string, fails: boolean, decorators: string[] = []): Test & { fails: boolean } {
	const a = rng.int(3, 12);
	const b = rng.int(3, 12);
	const expected = fails ? a * b + rng.pick([-2, -1, 1, 2, 10]) : a * b;
	return {
		name,
		fails,
		lines: [...decorators, `def ${name}(self):`, `    self.assertEqual(${a} * ${b}, ${expected})`],
		count: (rules, add) => {
			add(fails ? { run: 1, failures: 1 } : { run: 1 });
		}
	};
}

/** The module constants a suite's tests read; a test that reads PRICES adds its header. */
class Headers {
	readonly #lines = new Set<string>();
	readonly prices: Map<string, number>;
	constructor(rng: Rng) {
		this.prices = new Map(rng.sample(GOODS, 2).map((g) => [g, rng.int(10, 99)]));
	}
	add(line: string): void {
		this.#lines.add(line);
	}
	usePrices(): void {
		this.add(`PRICES = {${[...this.prices].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`);
	}
	lines(): string[] {
		return [...this.#lines].sort();
	}
}

/** Lines of a test body that raise: a missing key, a bad number or a division by zero. */
function errorLines(rng: Rng, headers: Headers): string[] {
	switch (rng.int(0, 2)) {
		case 0: {
			headers.usePrices();
			const missing = rng.pick(GOODS.filter((g) => !headers.prices.has(g)));
			return [`    self.assertEqual(PRICES['${missing}'], ${rng.int(10, 99)})`];
		}
		case 1:
			return [`    self.assertEqual(int('${rng.pick(['n/a', 'ten', 'x7', 'none'])}'), ${rng.int(1, 9)})`];
		default:
			return ['    count = 0', `    self.assertEqual(${rng.int(10, 99)} // count, ${rng.int(1, 9)})`];
	}
}

function errorTest(rng: Rng, name: string, headers: Headers): Test {
	return {
		name,
		lines: [`def ${name}(self):`, ...errorLines(rng, headers)],
		count: (rules, add) => {
			add({ run: 1, ...plain('error', rules) });
		}
	};
}

function intSubtest(rng: Rng, name: string): Test {
	const limit = rng.int(20, 80);
	const values = Array.from({ length: rng.int(4, 7) }, () => rng.int(10, 99));
	const failing = values.filter((v) => v >= limit);
	return {
		name,
		lines: [
			`def ${name}(self):`,
			`    for value in [${values.join(', ')}]:`,
			'        with self.subTest(value=value):',
			`            self.assertLess(value, ${limit})`
		],
		count: (rules, add) => {
			add({ run: rules.subtestAsTests ? values.length : 1 });
			for (const v of rules.subtestStops ? failing.slice(0, 1) : failing) add({ failures: 1 }, `${name} (value=${v})`);
		}
	};
}

function stockSubtest(rng: Rng, name: string): { test: Test; header: string } {
	const goods = rng.sample(GOODS, rng.int(5, 7));
	const stock = new Map<string, number>();
	for (const g of goods.slice(0, -rng.int(1, 2))) stock.set(g, rng.bool(0.35) ? 0 : rng.int(1, 30));
	const checked = rng.shuffle(goods).slice(0, rng.int(4, goods.length));
	const problems = checked.flatMap((g): { problem: Record_; item: string }[] =>
		!stock.has(g) ? [{ problem: 'error', item: g }] : stock.get(g) === 0 ? [{ problem: 'fail', item: g }] : []
	);
	return {
		header: `STOCK = {${[...stock].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
		test: {
			name,
			lines: [
				`def ${name}(self):`,
				`    for item in [${checked.map((g) => `'${g}'`).join(', ')}]:`,
				'        with self.subTest(item=item):',
				'            self.assertGreater(STOCK[item], 0)'
			],
			count: (rules, add) => {
				add({ run: rules.subtestAsTests ? checked.length : 1 });
				for (const p of rules.subtestStops ? problems.slice(0, 1) : problems)
					add(plain(p.problem, rules), `${name} (item='${p.item}')`);
			}
		}
	};
}

function xfailTest(rng: Rng, name: string, kind: 'fail' | 'pass' | 'error', headers: Headers): Test {
	const decorator = '@unittest.expectedFailure';
	if (kind === 'error') {
		return {
			name,
			lines: [decorator, `def ${name}(self):`, ...errorLines(rng, headers)],
			count: (rules, add) => {
				add({ run: 1 });
				if (rules.expectedFailureIgnored || rules.xfailErrorIsError) add(plain('error', rules));
				else add({ xfail: 1 });
			}
		};
	}
	const base = checkTest(rng, name, kind === 'fail', [decorator]);
	return {
		name,
		lines: base.lines,
		count: (rules, add) => {
			add({ run: 1 });
			if (kind === 'fail') add(rules.expectedFailureIgnored ? { failures: 1 } : { xfail: 1 });
			else if (!rules.expectedFailureIgnored && !rules.unexpectedSuccessIsPass) add({ xpass: 1 });
		}
	};
}

function skipCallTest(rng: Rng, name: string): Test {
	return {
		name,
		lines: [
			`def ${name}(self):`,
			`    self.skipTest('${rng.pick(REASONS)}')`,
			`    self.assertEqual(${rng.int(2, 9)}, ${rng.int(10, 20)})`
		],
		count: (rules, add) => {
			add({ run: rules.skippedNotRun ? 0 : 1, skipped: 1 });
		}
	};
}

function skipDecoratorTest(rng: Rng, name: string): Test {
	const base = checkTest(rng, name, rng.bool(), [`@unittest.skip('${rng.pick(REASONS)}')`]);
	return {
		name,
		lines: base.lines,
		count: (rules, add) => {
			add({ run: rules.skippedNotRun ? 0 : 1, skipped: 1 });
		}
	};
}

/** skipIf or skipUnless on a condition over the module constant ENV. */
function conditionalSkipTest(rng: Rng, name: string, env: string, unless: boolean): Test {
	const other = rng.pick(['prod', 'staging', 'dev', 'test'].filter((e) => e !== env));
	const compared = rng.bool() ? env : other;
	const condition = compared === env;
	const fails = rng.bool();
	const decorator = `@unittest.${unless ? 'skipUnless' : 'skipIf'}(ENV == '${compared}', '${rng.pick(REASONS)}')`;
	const base = checkTest(rng, name, fails, [decorator]);
	return {
		name,
		lines: base.lines,
		count: (rules, add) => {
			const skips = unless ? condition === rules.skipUnlessInverted : condition;
			if (skips) add({ run: rules.skippedNotRun ? 0 : 1, skipped: 1 });
			else add(fails ? { run: 1, failures: 1 } : { run: 1 });
		}
	};
}

interface Suite {
	headers: string[];
	className: string;
	fixtures: string[];
	tests: Test[];
}

function subtests(rng: Rng): Suite {
	const names = new Names(rng);
	const headers = new Headers(rng);
	const stock = stockSubtest(rng, names.next());
	headers.add(stock.header);
	const tests: Test[] = [
		stock.test,
		intSubtest(rng, names.next()),
		...(rng.bool() ? [intSubtest(rng, names.next())] : []),
		checkTest(rng, names.next(), false),
		checkTest(rng, names.next(), rng.bool()),
		...(rng.bool() ? [errorTest(rng, names.next(), headers)] : [])
	];
	return { headers: headers.lines(), className: 'TestStock', fixtures: [], tests: rng.shuffle(tests) };
}

function expectedFailure(rng: Rng): Suite {
	const names = new Names(rng);
	const headers = new Headers(rng);
	const tests: Test[] = [
		xfailTest(rng, names.next(), 'fail', headers),
		xfailTest(rng, names.next(), 'pass', headers),
		xfailTest(rng, names.next(), 'error', headers),
		xfailTest(rng, names.next(), rng.pick(['fail', 'pass'] as const), headers),
		checkTest(rng, names.next(), false),
		checkTest(rng, names.next(), rng.bool()),
		...(rng.bool() ? [skipCallTest(rng, names.next())] : []),
		...(rng.bool() ? [errorTest(rng, names.next(), headers)] : [])
	];
	return { headers: headers.lines(), className: 'TestBilling', fixtures: [], tests: rng.shuffle(tests) };
}

function failErrorSkip(rng: Rng): Suite {
	const names = new Names(rng);
	const headers = new Headers(rng);
	const env = rng.pick(['prod', 'staging', 'dev', 'test']);
	headers.add(`ENV = '${env}'`);
	const tests: Test[] = [
		checkTest(rng, names.next(), false),
		checkTest(rng, names.next(), true),
		...(rng.bool() ? [checkTest(rng, names.next(), rng.bool())] : []),
		errorTest(rng, names.next(), headers),
		...(rng.bool() ? [errorTest(rng, names.next(), headers)] : []),
		rng.bool() ? skipCallTest(rng, names.next()) : skipDecoratorTest(rng, names.next()),
		conditionalSkipTest(rng, names.next(), env, true),
		conditionalSkipTest(rng, names.next(), env, rng.bool())
	];
	return { headers: headers.lines(), className: 'TestCatalog', fixtures: [], tests: rng.shuffle(tests) };
}

function fixtureErrors(rng: Rng): Suite {
	const names = new Names(rng);
	const limit = rng.int(8, 15) * 10;
	type Account = { name: string; start: number | null | undefined; delta: number; cap: number };
	const make = (start: number | null | undefined, after: (v: number) => [number, number]): Account => {
		const [delta, cap] = start === null || start === undefined ? [rng.int(5, 40), rng.int(50, 200)] : after(start);
		return { name: names.next(), start, delta, cap };
	};
	const near = () => rng.int(limit - 40, limit - 10);
	// Paths: setUp raises, setUp skips, passes, fails, passes and breaks the limit, fails and breaks the limit.
	const accounts: Account[] = [
		make(undefined, () => [0, 0]),
		make(null, () => [0, 0]),
		make(near(), (s) => [rng.int(1, 5), s + rng.int(20, 60)]),
		make(near(), (s) => [rng.int(1, 5), s - rng.int(1, 20)]),
		make(near(), (s) => [rng.int(45, 70), s + 200]),
		make(near(), (s) => [rng.int(45, 70), s + rng.int(1, 40)]),
		...(rng.bool()
			? [
					rng.pick([
						make(undefined, () => [0, 0]),
						make(null, () => [0, 0]),
						make(near(), (s) => [rng.int(45, 70), s + 1])
					])
				]
			: [])
	];
	const stored = rng.shuffle(accounts.filter((a) => a.start !== undefined));
	return {
		headers: [
			`ACCOUNTS = {${stored.map((a) => `'${a.name}': ${a.start === null ? 'None' : a.start}`).join(', ')}}`,
			`LIMIT = ${limit}`
		],
		className: 'TestWallet',
		fixtures: [
			'def setUp(self):',
			'    self.balance = ACCOUNTS[self._testMethodName]',
			'    if self.balance is None:',
			"        self.skipTest('account closed')",
			'',
			'def tearDown(self):',
			'    if self.balance > LIMIT:',
			"        raise RuntimeError('limit exceeded')"
		],
		tests: rng.shuffle(accounts).map((a) => ({
			name: a.name,
			lines: [`def ${a.name}(self):`, `    self.balance += ${a.delta}`, `    self.assertLess(self.balance, ${a.cap})`],
			count: (rules, add) => {
				add({ run: a.start === null && rules.skippedNotRun ? 0 : 1 });
				if (a.start === undefined) add(rules.setupErrorAsFailure ? { failures: 1 } : plain('error', rules));
				else if (a.start === null) add({ skipped: 1 });
				else {
					const value = a.start + a.delta;
					const fails = value >= a.cap;
					if (fails) add({ failures: 1 });
					if (value > limit && !(fails && rules.oneOutcomePerTest)) add(plain('error', rules));
				}
			}
		}))
	};
}

function render(suite: Suite): string {
	const blocks = [...(suite.fixtures.length ? [suite.fixtures] : []), ...suite.tests.map((t) => t.lines)];
	const body = blocks.flatMap((b, i) => [...(i > 0 ? [''] : []), ...b.map((l) => (l === '' ? '' : `    ${l}`))]);
	return [
		'import io',
		'import unittest',
		...(suite.headers.length ? ['', ...suite.headers] : []),
		'',
		'',
		`class ${suite.className}(unittest.TestCase):`,
		...body,
		'',
		'',
		'def short(test):',
		"    return test.id().rsplit('.', 1)[-1]",
		'',
		'',
		`suite = unittest.defaultTestLoader.loadTestsFromTestCase(${suite.className})`,
		'result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)',
		"print('run', result.testsRun)",
		"for kind in ('failures', 'errors', 'skipped', 'expectedFailures'):",
		'    print(kind, *sorted(short(test) for test, _ in getattr(result, kind)))',
		"print('unexpectedSuccesses', *sorted(short(test) for test in result.unexpectedSuccesses))"
	].join('\n');
}

function tally(suite: Suite, rules: Rules): string {
	let run = 0;
	const lists: Record<Exclude<keyof Counts, 'run'>, string[]> = {
		failures: [],
		errors: [],
		skipped: [],
		xfail: [],
		xpass: []
	};
	for (const test of suite.tests) {
		test.count(rules, (part, label = test.name) => {
			for (const [key, n] of Object.entries(part) as [keyof Counts, number][]) {
				if (key === 'run') run += n;
				else for (let i = 0; i < n; i += 1) lists[key].push(label);
			}
		});
	}
	const sorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return [
		`run ${run}`,
		`failures ${sorted(lists.failures).join(' ')}`,
		`errors ${sorted(lists.errors).join(' ')}`,
		`skipped ${sorted(lists.skipped).join(' ')}`,
		`expectedFailures ${sorted(lists.xfail).join(' ')}`,
		`unexpectedSuccesses ${sorted(lists.xpass).join(' ')}`
	]
		.join(' ')
		.split(/\s+/)
		.filter(Boolean)
		.join(' ');
}

const SUITES: Record<string, (rng: Rng) => Suite> = {
	subtests,
	'expected-failure': expectedFailure,
	'fail-error-skip': failErrorSkip,
	'fixture-errors': fixtureErrors
};

const STATEMENT = [
	'Что напечатает программа на CPython 3.12–3.13? Тесты запускаются стандартным раннером `unittest`; его отчёт пишется в',
	'отдельный поток и на экран не попадает — на экране только то, что печатают последние строки программы.',
	'Запись подтеста `subTest` в списках результата — объект подтеста: его `id()` — это `id()` теста и параметры подтеста',
	"в скобках через пробел, например `__main__.TestCart.test_total (n=3)` или `__main__.TestCart.test_name (name='a')`.",
	'',
	'Введите вывод программы. Ответ сравнивается по словам: переносы строк и число пробелов не важны, порядок слов важен.',
	'Пример формата: `run 4 failures test_a errors skipped test_b test_c expectedFailures unexpectedSuccesses`.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = SUITES[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no suite for ${input.classId}`);
	const required = REQUIRED[input.classId] ?? [];
	// Suites are drawn until every misconception the class is about changes the printed numbers.
	for (let tries = 0; tries < 200; tries += 1) {
		const suite = make(rng);
		const answer = tally(suite, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = tally(suite, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = render(suite);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: STATEMENT, code: { language: 'python3', source } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no suite for ${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
