// The life cycle of a unittest test case: in which order the loader runs the methods, what runs around a test when a
// check fails or setUp fails, and when the functions registered with addCleanup run. The shown program runs one test
// case with the standard runner; the candidate writes what it prints.
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
	declarationOrder: boolean;
	teardownSkippedOnFailure: boolean;
	restOfTestRuns: boolean;
	failureStopsClass: boolean;
	teardownAfterSetupError: boolean;
	cleanupSkippedOnSetupError: boolean;
	cleanupFifo: boolean;
	cleanupBeforeTeardown: boolean;
	naturalOrder: boolean;
	testPrefixOnly: boolean;
}

const RIGHT: Rules = {
	declarationOrder: false,
	teardownSkippedOnFailure: false,
	restOfTestRuns: false,
	failureStopsClass: false,
	teardownAfterSetupError: false,
	cleanupSkippedOnSetupError: false,
	cleanupFifo: false,
	cleanupBeforeTeardown: false,
	naturalOrder: false,
	testPrefixOnly: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'declaration-order': { declarationOrder: true },
	'teardown-skipped-on-failure': { teardownSkippedOnFailure: true },
	'rest-of-test-runs': { restOfTestRuns: true },
	'failure-stops-class': { failureStopsClass: true },
	'teardown-after-setup-error': { teardownAfterSetupError: true },
	'cleanup-skipped-on-setup-error': { cleanupSkippedOnSetupError: true },
	'cleanup-fifo': { cleanupFifo: true },
	'cleanup-before-teardown': { cleanupBeforeTeardown: true },
	'natural-order': { naturalOrder: true },
	'test-prefix-only': { testPrefixOnly: true }
};

/** The misconceptions each class is about: an instance is drawn until every one of them changes the output. */
const REQUIRED: Record<string, string[]> = {
	'alphabetical-order': ['declaration-order', 'teardown-skipped-on-failure', 'rest-of-test-runs'],
	'setup-error': ['declaration-order', 'teardown-after-setup-error', 'cleanup-skipped-on-setup-error'],
	'cleanup-stack': ['cleanup-fifo', 'cleanup-before-teardown'],
	'name-sorting': ['declaration-order', 'natural-order', 'test-prefix-only']
};

/** One step of setUp or of a test body: a print, a registered cleanup or a failure that ends the method. */
type Step = { kind: 'print'; text: string } | { kind: 'cleanup'; text: string } | { kind: 'fail' };

interface Method {
	name: string;
	/** Python lines of the method without the indentation of the class. */
	lines: string[];
	steps: Step[];
}

interface Suite {
	className: string;
	header: string[];
	classOpen: { line: string; text: string } | null;
	classClose: { line: string; text: string } | null;
	setUp: { lines: string[]; steps: (name: string) => Step[] } | null;
	tearDown: { lines: string[]; text: (name: string) => string } | null;
	/** Methods in the order of declaration, collected by the loader or not. */
	methods: Method[];
}

/** Text runs of digits and of the rest, compared case-insensitively and numerically: the «natural» order. */
function naturalCompare(a: string, b: string): number {
	const parts = (s: string) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
	const [pa, pb] = [parts(a), parts(b)];
	for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
		const [x, y] = [pa[i] ?? '', pb[i] ?? ''];
		if (x === y) continue;
		if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y);
		return x < y ? -1 : 1;
	}
	return pa.length - pb.length;
}

function runOrder(suite: Suite, rules: Rules): Method[] {
	const prefix = rules.testPrefixOnly ? 'test_' : 'test';
	const collected = suite.methods.filter((m) => m.name.startsWith(prefix));
	if (rules.declarationOrder) return collected;
	if (rules.naturalOrder) return [...collected].sort((a, b) => naturalCompare(a.name, b.name));
	// The loader sorts the names as strings: by code points, as JavaScript does for ASCII.
	return [...collected].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function simulate(suite: Suite, rules: Rules): string[] {
	const out: string[] = [];
	if (suite.classOpen) out.push(suite.classOpen.text);
	for (const method of runOrder(suite, rules)) {
		const cleanups: string[] = [];
		let failed = false;
		let setUpFailed = false;
		for (const step of suite.setUp?.steps(method.name) ?? []) {
			if (step.kind === 'print') out.push(step.text);
			else if (step.kind === 'cleanup') cleanups.push(step.text);
			else {
				setUpFailed = true;
				break;
			}
		}
		const runCleanups = () => out.push(...(rules.cleanupFifo ? cleanups : [...cleanups].reverse()));
		const tearDown = suite.tearDown?.text(method.name);
		if (setUpFailed) {
			failed = true;
			if (rules.teardownAfterSetupError && tearDown !== undefined) out.push(tearDown);
			if (!rules.cleanupSkippedOnSetupError) runCleanups();
		} else {
			for (const step of method.steps) {
				if (step.kind === 'print') out.push(step.text);
				else if (step.kind === 'cleanup') cleanups.push(step.text);
				else {
					failed = true;
					if (!rules.restOfTestRuns) break;
				}
			}
			if (rules.cleanupBeforeTeardown) runCleanups();
			if (tearDown !== undefined && !(failed && rules.teardownSkippedOnFailure)) out.push(tearDown);
			if (!rules.cleanupBeforeTeardown) runCleanups();
		}
		if (failed && rules.failureStopsClass) break;
	}
	if (suite.classClose) out.push(suite.classClose.text);
	return out;
}

function render(suite: Suite): string {
	const indent = (lines: string[]) => lines.map((l) => (l === '' ? '' : `    ${l}`));
	const blocks: string[][] = [];
	if (suite.classOpen) blocks.push(['@classmethod', 'def setUpClass(cls):', `    ${suite.classOpen.line}`]);
	if (suite.classClose) blocks.push(['@classmethod', 'def tearDownClass(cls):', `    ${suite.classClose.line}`]);
	if (suite.setUp) blocks.push(suite.setUp.lines);
	if (suite.tearDown) blocks.push(suite.tearDown.lines);
	for (const m of suite.methods) blocks.push(m.lines);
	const body = blocks.flatMap((b, i) => [...(i > 0 ? [''] : []), ...indent(b)]);
	return [
		'import io',
		'import unittest',
		...(suite.header.length ? ['', ...suite.header] : []),
		'',
		'',
		`class ${suite.className}(unittest.TestCase):`,
		...body,
		'',
		'',
		`suite = unittest.defaultTestLoader.loadTestsFromTestCase(${suite.className})`,
		'unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)'
	].join('\n');
}

const WORDS: readonly string[] = [
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
	'session'
];
const CLASS_NAMES = ['TestCart', 'TestBilling', 'TestOrders', 'TestProfile', 'TestCatalog', 'TestReports'] as const;
const RESOURCES = ['db', 'cache', 'tmpdir', 'server', 'queue', 'browser', 'socket', 'mailbox'] as const;

/** Names in a random order of declaration that is not their sorted order. */
function unsortedNames(rng: Rng, names: string[]): string[] {
	const sorted = [...names].sort();
	for (;;) {
		const order = rng.shuffle(names);
		if (order.some((n, i) => n !== sorted[i])) return order;
	}
}

/** A test that computes a product and checks it; a failing one expects a wrong value and prints nothing after it. */
function checkedMethod(rng: Rng, word: string, fails: boolean, extra: Step[] = [], extraLines: string[] = []): Method {
	const a = rng.int(3, 12);
	const b = rng.int(3, 12);
	const product = a * b;
	const expected = fails ? product + rng.pick([-3, -2, -1, 1, 2, 3, 10]) : product;
	return {
		name: `test_${word}`,
		lines: [
			`def test_${word}(self):`,
			...extraLines.map((l) => `    ${l}`),
			`    value = ${a} * ${b}`,
			`    self.assertEqual(value, ${expected})`,
			`    print('${word}', value)`
		],
		steps: [...extra, ...(fails ? [{ kind: 'fail' } as const] : []), { kind: 'print', text: `${word} ${product}` }]
	};
}

function alphabeticalOrder(rng: Rng): Suite {
	const words = rng.sample(WORDS, rng.int(4, 5));
	const failing = new Set(rng.sample(words, rng.int(1, 2)));
	const order = unsortedNames(rng, words);
	const resource = rng.pick(RESOURCES);
	return {
		className: rng.pick(CLASS_NAMES),
		header: [],
		classOpen: { line: `print('open', '${resource}')`, text: `open ${resource}` },
		classClose: { line: `print('close', '${resource}')`, text: `close ${resource}` },
		setUp: {
			lines: ['def setUp(self):', "    print('setUp', self._testMethodName)"],
			steps: (name) => [{ kind: 'print', text: `setUp ${name}` }]
		},
		tearDown: {
			lines: ['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
			text: (name) => `tearDown ${name}`
		},
		methods: order.map((w) => checkedMethod(rng, w, failing.has(w)))
	};
}

function setupError(rng: Rng): Suite {
	const words = rng.sample(WORDS, rng.int(3, 4));
	const missing = new Set(rng.sample(words, rng.int(1, 2)));
	const order = unsortedNames(rng, words);
	const sizes = new Map(words.map((w) => [w, rng.int(2, 9)]));
	const fixtures = rng.shuffle(words.filter((w) => !missing.has(w)));
	return {
		className: rng.pick(CLASS_NAMES),
		header: [`FIXTURES = {${fixtures.map((w) => `'test_${w}': ${sizes.get(w) ?? 0}`).join(', ')}}`],
		classOpen: null,
		classClose: null,
		setUp: {
			lines: [
				'def setUp(self):',
				'    name = self._testMethodName',
				"    print('setUp', name)",
				"    self.addCleanup(print, 'cleanup', name)",
				'    self.size = FIXTURES[name]'
			],
			steps: (name) => [
				{ kind: 'print', text: `setUp ${name}` },
				{ kind: 'cleanup', text: `cleanup ${name}` },
				...(missing.has(name.slice(5)) ? [{ kind: 'fail' } as const] : [])
			]
		},
		tearDown: {
			lines: ['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
			text: (name) => `tearDown ${name}`
		},
		methods: order.map((w) => {
			const k = rng.int(2, 9);
			return {
				name: `test_${w}`,
				lines: [`def test_${w}(self):`, `    print('${w}', self.size * ${k})`],
				steps: [{ kind: 'print', text: `${w} ${(sizes.get(w) ?? 0) * k}` }]
			};
		})
	};
}

function cleanupStack(rng: Rng): Suite {
	const words = rng.sample(WORDS, rng.int(2, 3));
	const order = unsortedNames(rng, words);
	const resources = rng.sample(RESOURCES, rng.int(2, 3));
	const verbs = ['close', 'remove', 'stop', 'drop', 'reset'] as const;
	const setUpCleanups = resources.map((r) => ({ verb: rng.pick(verbs), resource: r }));
	const failing = rng.bool(0.5) ? rng.pick(words) : null;
	return {
		className: rng.pick(CLASS_NAMES),
		header: [],
		classOpen: null,
		classClose: null,
		setUp: {
			lines: [
				'def setUp(self):',
				"    print('setUp', self._testMethodName)",
				...setUpCleanups.map((c) => `    self.addCleanup(print, '${c.verb}', '${c.resource}')`)
			],
			steps: (name) => [
				{ kind: 'print', text: `setUp ${name}` },
				...setUpCleanups.map((c) => ({ kind: 'cleanup', text: `${c.verb} ${c.resource}` }) as const)
			]
		},
		tearDown: {
			lines: ['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
			text: (name) => `tearDown ${name}`
		},
		methods: order.map((w) => {
			const count = rng.int(0, 2);
			const own = Array.from({ length: count }, (_, i) => `${w}${i + 1}`);
			return checkedMethod(
				rng,
				w,
				w === failing,
				own.map((r) => ({ kind: 'cleanup', text: `delete ${r}` }) as const),
				own.map((r) => `self.addCleanup(print, 'delete', '${r}')`)
			);
		})
	};
}

function nameSorting(rng: Rng): Suite {
	const [stem, capital, other, helper] = rng.sample(WORDS, 4) as [string, string, string, string];
	// A one-digit number and a two-digit number whose first digit is smaller: as strings, the two-digit one is first.
	const one = rng.int(3, 9);
	const two = rng.int(1, one - 1) * 10 + rng.int(0, 9);
	const cap = capital.charAt(0).toUpperCase() + capital.slice(1);
	const names = [
		`test_${stem}${one}`,
		`test_${stem}${two}`,
		`test_${cap}`,
		rng.pick([`testing_${other}`, `tests_${other}`]),
		`check_${helper}`
	];
	const order = unsortedNames(rng, names);
	return {
		className: rng.pick(CLASS_NAMES),
		header: [],
		classOpen: null,
		classClose: null,
		setUp: null,
		tearDown: null,
		methods: order.map((name) => {
			const k = rng.int(10, 99);
			return {
				name,
				lines: [`def ${name}(self):`, `    print('${name}', ${k})`],
				steps: [{ kind: 'print', text: `${name} ${k}` }]
			};
		})
	};
}

const SUITES: Record<string, (rng: Rng) => Suite> = {
	'alphabetical-order': alphabeticalOrder,
	'setup-error': setupError,
	'cleanup-stack': cleanupStack,
	'name-sorting': nameSorting
};

const STATEMENT = [
	'Что напечатает программа на Python 3? Тесты запускаются стандартным раннером `unittest`; его отчёт пишется в',
	'отдельный поток `io.StringIO()` и на экран не попадает — на экране только то, что печатает `print`.',
	'',
	'Введите вывод построчно, как он появится на экране: каждая напечатанная строка — отдельной строкой ответа,',
	'слова через один пробел, например `setUp test_total`.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = SUITES[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no suite for ${input.classId}`);
	const required = REQUIRED[input.classId] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Suites are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 200; tries += 1) {
		const suite = make(rng);
		const answer = simulate(suite, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(suite, { ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = render(suite);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: STATEMENT, code: { language: 'python3', source } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no suite for ${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
