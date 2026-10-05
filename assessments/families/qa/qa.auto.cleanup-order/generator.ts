// What runs, and in which order, when fixtures fail or clean up: a failing setUpClass, class and test cleanups, an
// exception inside a cleanup, ExitStack and enterContext, contextlib.suppress and setUp chains through super(). The
// shown program runs its test cases with the standard runner and prints the counts of the result at the end; the
// candidate writes what it prints.
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
	teardownclassAfterError: boolean;
	testsRunAfterClassError: boolean;
	classCleanupSkipped: boolean;
	cleanupFifo: boolean;
	cleanupChainStops: boolean;
	cleanupErrorIgnored: boolean;
	exitstackFifo: boolean;
	exitAfterTeardown: boolean;
	codeAfterWithRuns: boolean;
	implicitSuper: boolean;
	classCleanupBeforeTeardownclass: boolean;
	teardownclassErrorSkipsCleanup: boolean;
	contextExitsAfterSetup: boolean;
	cleanupSkippedOnSetupError: boolean;
	suppressIgnored: boolean;
	suppressResumesInside: boolean;
	suppressAnyType: boolean;
	superSkipsToTestcase: boolean;
	superRunsFirst: boolean;
}

const RIGHT: Rules = {
	teardownclassAfterError: false,
	testsRunAfterClassError: false,
	classCleanupSkipped: false,
	cleanupFifo: false,
	cleanupChainStops: false,
	cleanupErrorIgnored: false,
	exitstackFifo: false,
	exitAfterTeardown: false,
	codeAfterWithRuns: false,
	implicitSuper: false,
	classCleanupBeforeTeardownclass: false,
	teardownclassErrorSkipsCleanup: false,
	contextExitsAfterSetup: false,
	cleanupSkippedOnSetupError: false,
	suppressIgnored: false,
	suppressResumesInside: false,
	suppressAnyType: false,
	superSkipsToTestcase: false,
	superRunsFirst: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'teardownclass-after-error': { teardownclassAfterError: true },
	'tests-run-after-class-error': { testsRunAfterClassError: true },
	'class-cleanup-skipped': { classCleanupSkipped: true },
	'cleanup-fifo': { cleanupFifo: true },
	'cleanup-chain-stops': { cleanupChainStops: true },
	'cleanup-error-ignored': { cleanupErrorIgnored: true },
	'exitstack-fifo': { exitstackFifo: true },
	'exit-after-teardown': { exitAfterTeardown: true },
	'code-after-with-runs': { codeAfterWithRuns: true },
	'implicit-super': { implicitSuper: true },
	'class-cleanup-before-teardownclass': { classCleanupBeforeTeardownclass: true },
	'teardownclass-error-skips-cleanup': { teardownclassErrorSkipsCleanup: true },
	'context-exits-after-setup': { contextExitsAfterSetup: true },
	'cleanup-skipped-on-setup-error': { cleanupSkippedOnSetupError: true },
	'suppress-ignored': { suppressIgnored: true },
	'suppress-resumes-inside': { suppressResumesInside: true },
	'suppress-any-type': { suppressAnyType: true },
	'super-skips-to-testcase': { superSkipsToTestcase: true },
	'super-runs-first': { superRunsFirst: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/setupclass-error': [
		'teardownclass-after-error',
		'tests-run-after-class-error',
		'class-cleanup-skipped',
		'cleanup-fifo'
	],
	'middle/cleanup-error': ['cleanup-chain-stops', 'cleanup-fifo', 'cleanup-error-ignored'],
	'middle/exit-stack': ['exitstack-fifo', 'exit-after-teardown', 'code-after-with-runs'],
	'middle/missing-super': ['implicit-super', 'cleanup-fifo'],
	'senior/class-cleanups': [
		'class-cleanup-before-teardownclass',
		'teardownclass-error-skips-cleanup',
		'class-cleanup-skipped'
	],
	'senior/enter-context': ['context-exits-after-setup', 'cleanup-fifo', 'cleanup-skipped-on-setup-error'],
	'senior/suppress': ['suppress-ignored', 'suppress-resumes-inside', 'suppress-any-type'],
	'senior/mro-fixtures': ['super-skips-to-testcase', 'super-runs-first', 'cleanup-fifo']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const WORDS = ['export', 'import', 'invoice', 'login', 'refund', 'report', 'search', 'upload', 'payment', 'profile'];
const RESOURCES = ['db', 'cache', 'queue', 'socket', 'tmpdir', 'server', 'browser', 'mailbox', 'lock', 'bucket'];
const VERBS = ['close', 'drop', 'stop', 'remove', 'release'];

const indent = (lines: string[], depth = 1) => lines.map((l) => (l === '' ? '' : `${'    '.repeat(depth)}${l}`));
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A class from its blocks (methods), separated by empty lines. */
function classLines(name: string, bases: string, blocks: string[][]): string[] {
	return [`class ${name}(${bases}):`, ...indent(blocks.flatMap((b, i) => [...(i > 0 ? [''] : []), ...b]))];
}

function module(imports: string[], top: string[][], cases: string[]): string[] {
	return [
		...imports,
		'',
		'',
		...top.flatMap((b) => [...b, '', '']),
		`suite = unittest.TestSuite([${cases.map((c) => `unittest.defaultTestLoader.loadTestsFromTestCase(${c})`).join(', ')}])`,
		'result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)',
		"print('run', result.testsRun, 'errors', len(result.errors), 'failures', len(result.failures))"
	];
}

const summary = (run: number, errors: number, failures: number) => `run ${run} errors ${errors} failures ${failures}`;
const order = <T>(xs: T[], fifo: boolean): T[] => (fifo ? [...xs] : [...xs].reverse());

/** Test methods that print a word and a number. */
function printingTests(rng: Rng, count: number): { name: string; line: string; lines: string[] }[] {
	return rng.sample(WORDS, count).map((w) => {
		const n = rng.int(10, 99);
		return { name: `test_${w}`, line: `${w} ${n}`, lines: [`def test_${w}(self):`, `    print('${w}', ${n})`] };
	});
}

// ---- middle -------------------------------------------------------------------------------------------------

function setupclassError(rng: Rng): Program {
	const [failing, healthy] = rng.sample(['TestBilling', 'TestCatalog', 'TestOrders', 'TestUsers'], 2) as [
		string,
		string
	];
	type Case = {
		name: string;
		resource: string;
		cleanups: string[];
		raiseAt: number | null;
		tests: ReturnType<typeof printingTests>;
	};
	const make = (name: string, fails: boolean): Case => {
		const resources = rng.sample(RESOURCES, rng.int(2, 3));
		const cleanups = resources.map((r) => `${rng.pick(VERBS)} ${r}`);
		return {
			name,
			resource: resources[0] ?? 'db',
			cleanups,
			raiseAt: fails ? rng.int(1, cleanups.length) : null,
			tests: printingTests(rng, rng.int(1, 3))
		};
	};
	const cases = rng.shuffle([make(failing, true), make(healthy, false)]);
	const render = (c: Case): string[] => {
		const setUpClass = [
			'@classmethod',
			'def setUpClass(cls):',
			`    print('connect', '${c.resource}')`,
			...c.cleanups.flatMap((cl, i) => {
				const [verb, res] = cl.split(' ') as [string, string];
				const line = `    cls.addClassCleanup(print, '${verb}', '${res}')`;
				return c.raiseAt === i ? [`    raise ConnectionError('${c.resource} is down')`, line] : [line];
			}),
			...(c.raiseAt === c.cleanups.length ? [`    raise ConnectionError('${c.resource} is down')`] : [])
		];
		return classLines(c.name, 'unittest.TestCase', [
			setUpClass,
			['@classmethod', 'def tearDownClass(cls):', "    print('tearDownClass', cls.__name__)"],
			['def setUp(self):', "    print('setUp', self._testMethodName)"],
			...c.tests.map((t) => t.lines)
		]);
	};
	return {
		lines: module(
			['import io', 'import unittest'],
			cases.map(render),
			cases.map((c) => c.name)
		),
		run: (rules) => {
			const out: string[] = [];
			let run = 0;
			for (const c of cases) {
				out.push(`connect ${c.resource}`);
				const registered = c.raiseAt === null ? c.cleanups : c.cleanups.slice(0, c.raiseAt);
				const tests = () => {
					for (const t of [...c.tests].sort((a, b) => byName(a.name, b.name))) {
						out.push(`setUp ${t.name}`, t.line);
						run += 1;
					}
				};
				if (c.raiseAt !== null) {
					if (rules.testsRunAfterClassError) tests();
					if (rules.teardownclassAfterError) out.push(`tearDownClass ${c.name}`);
					if (!rules.classCleanupSkipped) out.push(...order(registered, rules.cleanupFifo));
				} else {
					tests();
					out.push(`tearDownClass ${c.name}`, ...order(registered, rules.cleanupFifo));
				}
			}
			out.push(summary(run, 1, 0));
			return out;
		}
	};
}

function cleanupError(rng: Rng): Program {
	const cls = rng.pick(['TestFiles', 'TestStorage', 'TestUploads']);
	const helper = rng.pick([
		['close_socket', 'close socket', 'OSError'],
		['stop_server', 'stop server', 'RuntimeError'],
		['release_lock', 'release lock', 'PermissionError']
	] as const);
	const plain = rng.sample(RESOURCES, rng.int(1, 2)).map((r) => `${rng.pick(VERBS)} ${r}`);
	// The raising cleanup goes after at least one plain one, so later cleanups run after it in reverse order.
	const setUpCleanups: (string | null)[] = [...plain];
	setUpCleanups.splice(rng.int(1, plain.length), 0, null);
	const tests = rng.sample(WORDS, rng.int(2, 3)).map((w) => {
		const own = rng.bool() ? `delete ${w}` : null;
		const n = rng.int(10, 99);
		const fails = rng.bool(0.4);
		return { name: `test_${w}`, word: w, own, n, fails, m: fails ? n + rng.int(1, 5) : n };
	});
	const [method, printed, error] = helper;
	const lines = module(
		['import io', 'import unittest'],
		[
			classLines(cls, 'unittest.TestCase', [
				[
					'def setUp(self):',
					"    print('setUp', self._testMethodName)",
					...setUpCleanups.map((c) => {
						if (c === null) return `    self.addCleanup(self.${method})`;
						const [verb, res] = c.split(' ') as [string, string];
						return `    self.addCleanup(print, '${verb}', '${res}')`;
					})
				],
				[
					`def ${method}(self):`,
					`    print('${printed.split(' ')[0] ?? ''}', '${printed.split(' ')[1] ?? ''}')`,
					`    raise ${error}('already done')`
				],
				['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
				...tests.map((t) => [
					`def ${t.name}(self):`,
					...(t.own ? [`    self.addCleanup(print, 'delete', '${t.word}')`] : []),
					`    print('${t.word}', ${t.n})`,
					`    self.assertEqual(${t.n}, ${t.m})`
				])
			])
		],
		[cls]
	);
	return {
		lines,
		run: (rules) => {
			const out: string[] = [];
			let errors = 0;
			let failures = 0;
			for (const t of [...tests].sort((a, b) => byName(a.name, b.name))) {
				out.push(`setUp ${t.name}`, `${t.word} ${t.n}`, `tearDown ${t.name}`);
				if (t.fails) failures += 1;
				const stack: (string | null)[] = [...setUpCleanups, ...(t.own ? [t.own] : [])];
				for (const c of order(stack, rules.cleanupFifo)) {
					if (c !== null) {
						out.push(c);
						continue;
					}
					out.push(printed);
					if (!rules.cleanupErrorIgnored) errors += 1;
					if (rules.cleanupChainStops) break;
				}
			}
			out.push(summary(tests.length, errors, failures));
			return out;
		}
	};
}

function exitStack(rng: Rng): Program {
	const cls = rng.pick(['TestExport', 'TestImport', 'TestBackup']);
	const tests = rng.sample(WORDS, rng.int(2, 3)).map((w, i) => {
		const [r1, r2] = rng.sample(RESOURCES, 2) as [string, string];
		return {
			name: `test_${w}`,
			word: w,
			callbacks: [`close ${r1}`, `unlock ${r2}`],
			n: rng.int(10, 99),
			raises: i === 0 ? true : rng.bool()
		};
	});
	const lines = module(
		['import contextlib', 'import io', 'import unittest'],
		[
			classLines(cls, 'unittest.TestCase', [
				[
					'def setUp(self):',
					"    print('setUp', self._testMethodName)",
					"    self.addCleanup(print, 'cleanup', self._testMethodName)"
				],
				['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
				...rng.shuffle(tests).map((t) => [
					`def ${t.name}(self):`,
					'    with contextlib.ExitStack() as stack:',
					...t.callbacks.map((c) => {
						const [verb, res] = c.split(' ') as [string, string];
						return `        stack.callback(print, '${verb}', '${res}')`;
					}),
					`        print('write', ${t.n})`,
					...(t.raises ? ["        raise ValueError('bad row')"] : []),
					`    print('after', '${t.word}')`
				])
			])
		],
		[cls]
	);
	return {
		lines,
		run: (rules) => {
			const out: string[] = [];
			let errors = 0;
			for (const t of [...tests].sort((a, b) => byName(a.name, b.name))) {
				out.push(`setUp ${t.name}`, `write ${t.n}`);
				const callbacks = order(t.callbacks, rules.exitstackFifo);
				if (!rules.exitAfterTeardown) out.push(...callbacks);
				if (!t.raises || rules.codeAfterWithRuns) out.push(`after ${t.word}`);
				if (t.raises && !rules.codeAfterWithRuns) errors += 1;
				out.push(`tearDown ${t.name}`);
				if (rules.exitAfterTeardown) out.push(...callbacks);
				out.push(`cleanup ${t.name}`);
			}
			out.push(summary(tests.length, errors, 0));
			return out;
		}
	};
}

function missingSuper(rng: Rng): Program {
	const base = rng.pick(['BaseApiTest', 'BaseDbTest', 'BaseUiTest']);
	const client = rng.pick(['client', 'session', 'driver']);
	const cleanups = rng.sample(RESOURCES, 2).map((r) => `${rng.pick(VERBS)} ${r}`);
	type Sub = {
		name: string;
		label: string;
		superCall: 'before' | 'after' | 'none';
		tearDown: 'none' | 'super' | 'own';
		test: string;
		n: number;
	};
	const subs: Sub[] = rng.sample(['Orders', 'Users', 'Reports', 'Carts'], 2).map((label, i) => ({
		name: `Test${label}`,
		label: label.toLowerCase(),
		superCall: i === 0 ? 'none' : rng.pick(['before', 'after'] as const),
		tearDown: rng.pick(['none', 'super', 'own'] as const),
		test: `test_${rng.pick(WORDS)}`,
		n: rng.int(10, 99)
	}));
	const ordered = rng.shuffle(subs);
	const value = rng.int(100, 999);
	const baseClass = classLines(base, 'unittest.TestCase', [
		[
			'def setUp(self):',
			"    print('base setUp', type(self).__name__)",
			`    self.${client} = ${value}`,
			...cleanups.map((c) => {
				const [verb, res] = c.split(' ') as [string, string];
				return `    self.addCleanup(print, '${verb}', '${res}')`;
			})
		],
		['def tearDown(self):', "    print('base tearDown', type(self).__name__)"]
	]);
	const render = (s: Sub) =>
		classLines(s.name, base, [
			[
				'def setUp(self):',
				...(s.superCall === 'before' ? ['    super().setUp()'] : []),
				`    print('${s.label} setUp')`,
				...(s.superCall === 'after' ? ['    super().setUp()'] : [])
			],
			...(s.tearDown === 'none'
				? []
				: [
						[
							'def tearDown(self):',
							`    print('${s.label} tearDown')`,
							...(s.tearDown === 'super' ? ['    super().tearDown()'] : [])
						]
					]),
			[`def ${s.test}(self):`, `    print('${s.label}', self.${client} + ${s.n})`]
		]);
	return {
		lines: module(
			['import io', 'import unittest'],
			[baseClass, ...ordered.map(render)],
			ordered.map((s) => s.name)
		),
		run: (rules) => {
			const out: string[] = [];
			let errors = 0;
			for (const s of ordered) {
				const baseRuns = s.superCall !== 'none' || rules.implicitSuper;
				const baseSetUp = [`base setUp ${s.name}`];
				const own = [`${s.label} setUp`];
				if (s.superCall === 'after') out.push(...own, ...baseSetUp);
				else out.push(...(baseRuns ? baseSetUp : []), ...own);
				if (baseRuns) out.push(`${s.label} ${value + s.n}`);
				else errors += 1;
				if (s.tearDown === 'none') out.push(`base tearDown ${s.name}`);
				else {
					out.push(`${s.label} tearDown`);
					if (s.tearDown === 'super' || rules.implicitSuper) out.push(`base tearDown ${s.name}`);
				}
				if (baseRuns) out.push(...order(cleanups, rules.cleanupFifo));
			}
			out.push(summary(subs.length, errors, 0));
			return out;
		}
	};
}

// ---- senior -------------------------------------------------------------------------------------------------

function classCleanups(rng: Rng): Program {
	const names = rng.sample(['TestBilling', 'TestCatalog', 'TestOrders', 'TestUsers', 'TestSearch'], 3);
	type Case = {
		name: string;
		cleanups: string[];
		setUpFails: boolean;
		tearDownFails: boolean;
		tests: ReturnType<typeof printingTests>;
	};
	const roles = rng.shuffle(['setup-fails', 'teardown-fails', rng.pick(['ok', 'teardown-fails'])]);
	const cases: Case[] = names.map((name, i) => ({
		name,
		cleanups: rng.sample(RESOURCES, rng.int(1, 2)).map((r) => `${rng.pick(VERBS)} ${r}`),
		setUpFails: roles[i] === 'setup-fails',
		tearDownFails: roles[i] === 'teardown-fails',
		tests: printingTests(rng, rng.int(1, 2))
	}));
	const render = (c: Case) =>
		classLines(c.name, 'unittest.TestCase', [
			[
				'@classmethod',
				'def setUpClass(cls):',
				"    print('setUpClass', cls.__name__)",
				...c.cleanups.map((cl) => {
					const [verb, res] = cl.split(' ') as [string, string];
					return `    cls.addClassCleanup(print, '${verb}', '${res}')`;
				}),
				...(c.setUpFails ? ["    raise RuntimeError('no fixture data')"] : [])
			],
			[
				'@classmethod',
				'def tearDownClass(cls):',
				"    print('tearDownClass', cls.__name__)",
				...(c.tearDownFails ? ["    raise RuntimeError('flush failed')"] : [])
			],
			...c.tests.map((t) => t.lines)
		]);
	return {
		lines: module(
			['import io', 'import unittest'],
			cases.map(render),
			cases.map((c) => c.name)
		),
		run: (rules) => {
			const out: string[] = [];
			let run = 0;
			let errors = 0;
			for (const c of cases) {
				out.push(`setUpClass ${c.name}`);
				const cleanups = order(c.cleanups, rules.cleanupFifo);
				if (c.setUpFails) {
					errors += 1;
					if (!rules.classCleanupSkipped) out.push(...cleanups);
					continue;
				}
				for (const t of [...c.tests].sort((a, b) => byName(a.name, b.name))) {
					out.push(t.line);
					run += 1;
				}
				if (rules.classCleanupBeforeTeardownclass) out.push(...cleanups, `tearDownClass ${c.name}`);
				else {
					out.push(`tearDownClass ${c.name}`);
					if (!(c.tearDownFails && rules.teardownclassErrorSkipsCleanup)) out.push(...cleanups);
				}
				if (c.tearDownFails) errors += 1;
			}
			out.push(summary(run, errors, 0));
			return out;
		}
	};
}

function enterContext(rng: Rng): Program {
	const cls = rng.pick(['TestJobs', 'TestWorkers', 'TestPipeline']);
	type Item = { kind: 'context'; name: string } | { kind: 'cleanup'; text: string };
	const contexts = rng.sample(RESOURCES, 2);
	const items: Item[] = rng.shuffle([
		{ kind: 'context', name: contexts[0] ?? 'db' },
		{ kind: 'context', name: contexts[1] ?? 'queue' },
		{ kind: 'cleanup', text: `reset ${rng.pick(['cache', 'counters', 'flags'])}` }
	]);
	const tests = rng.sample(WORDS, rng.int(2, 3)).map((w) => ({ name: `test_${w}`, word: w, n: rng.int(10, 99) }));
	const failing = rng.pick(tests).name;
	const failAt = rng.int(1, items.length);
	const setUp = [
		'def setUp(self):',
		...items.flatMap((item, i) => [
			...(i === failAt
				? [`    if self._testMethodName == '${failing}':`, "        raise RuntimeError('no worker')"]
				: []),
			item.kind === 'context'
				? `    self.enterContext(resource('${item.name}'))`
				: `    self.addCleanup(print, '${item.text.split(' ')[0] ?? ''}', '${item.text.split(' ')[1] ?? ''}')`
		]),
		...(failAt === items.length
			? [`    if self._testMethodName == '${failing}':`, "        raise RuntimeError('no worker')"]
			: [])
	];
	return {
		lines: module(
			['import contextlib', 'import io', 'import unittest'],
			[
				[
					'@contextlib.contextmanager',
					'def resource(name):',
					"    print('open', name)",
					'    yield name',
					"    print('close', name)"
				],
				classLines(cls, 'unittest.TestCase', [
					setUp,
					['def tearDown(self):', "    print('tearDown', self._testMethodName)"],
					...tests.map((t) => [`def ${t.name}(self):`, `    print('${t.word}', ${t.n})`])
				])
			],
			[cls]
		),
		run: (rules) => {
			const out: string[] = [];
			let errors = 0;
			for (const t of [...tests].sort((a, b) => byName(a.name, b.name))) {
				const fails = t.name === failing;
				const done = fails ? items.slice(0, failAt) : items;
				const stack: string[] = [];
				const opened: string[] = [];
				for (const item of done) {
					if (item.kind === 'context') {
						out.push(`open ${item.name}`);
						if (rules.contextExitsAfterSetup) opened.push(`close ${item.name}`);
						else stack.push(`close ${item.name}`);
					} else stack.push(item.text);
				}
				if (rules.contextExitsAfterSetup) out.push(...[...opened].reverse());
				if (fails) {
					errors += 1;
					if (!rules.cleanupSkippedOnSetupError) out.push(...order(stack, rules.cleanupFifo));
					continue;
				}
				out.push(`${t.word} ${t.n}`, `tearDown ${t.name}`, ...order(stack, rules.cleanupFifo));
			}
			out.push(summary(tests.length, errors, 0));
			return out;
		}
	};
}

function suppress(rng: Rng): Program {
	const cls = rng.pick(['TestParser', 'TestLoader', 'TestMapper']);
	type Kind = 'key' | 'wrong-type' | 'stack' | 'quiet';
	const kinds = rng.shuffle<Kind>([
		'key',
		'wrong-type',
		'stack',
		...(rng.bool() ? [rng.pick<Kind>(['quiet', 'key', 'stack'])] : [])
	]);
	const words = rng.sample(WORDS, kinds.length);
	const [have, missing] = rng.sample(['tea', 'jam', 'pie', 'soup', 'rice', 'milk'], 2) as [string, string];
	const price = rng.int(10, 99);
	const tests = kinds.map((kind, i) => {
		const w = words[i] ?? 'test';
		const name = `test_${w}`;
		const callbackFirst = rng.bool();
		const res = rng.pick(RESOURCES);
		switch (kind) {
			case 'key':
			case 'quiet': {
				const key = kind === 'key' ? missing : have;
				return {
					name,
					kind,
					lines: [
						`def ${name}(self):`,
						'    with contextlib.suppress(KeyError):',
						`        print('lookup', '${w}')`,
						`        value = PRICES['${key}']`,
						`        print('found', value)`,
						`    print('after', '${w}')`
					],
					res
				};
			}
			case 'wrong-type':
				return {
					name,
					kind,
					lines: [
						`def ${name}(self):`,
						'    with contextlib.suppress(KeyError):',
						`        print('parse', '${w}')`,
						`        value = int('${rng.pick(['n/a', 'ten', 'x7'])}')`,
						`        print('parsed', value)`,
						`    print('after', '${w}')`
					],
					res
				};
			case 'stack': {
				const register = [
					`        stack.callback(print, 'close', '${res}')`,
					'        stack.enter_context(contextlib.suppress(ValueError))'
				];
				return {
					name,
					kind,
					lines: [
						`def ${name}(self):`,
						'    with contextlib.ExitStack() as stack:',
						...(callbackFirst ? register : [...register].reverse()),
						`        print('parse', '${w}')`,
						`        value = int('${rng.pick(['n/a', 'ten', 'x7'])}')`,
						`        print('parsed', value)`,
						`    print('after', '${w}')`
					],
					res
				};
			}
		}
	});
	return {
		lines: module(
			['import contextlib', 'import io', 'import unittest'],
			[
				[`PRICES = {'${have}': ${price}}`],
				classLines(
					cls,
					'unittest.TestCase',
					tests.map((t) => t.lines)
				)
			],
			[cls]
		),
		run: (rules) => {
			const out: string[] = [];
			let errors = 0;
			for (const t of [...tests].sort((a, b) => byName(a.name, b.name))) {
				const w = t.name.slice(5);
				if (t.kind === 'quiet') {
					out.push(`lookup ${w}`, `found ${price}`, `after ${w}`);
					continue;
				}
				const head = t.kind === 'key' ? `lookup ${w}` : `parse ${w}`;
				out.push(head);
				// Whether the exception is suppressed; a resumed block prints its last line without a value.
				const suppressed = t.kind === 'wrong-type' ? rules.suppressAnyType : !rules.suppressIgnored;
				if (suppressed && rules.suppressResumesInside) out.push(t.kind === 'key' ? 'found' : 'parsed');
				if (t.kind === 'stack') out.push(`close ${t.res}`);
				if (suppressed) out.push(`after ${w}`);
				else errors += 1;
			}
			out.push(summary(tests.length, errors, 0));
			return out;
		}
	};
}

function mroFixtures(rng: Rng): Program {
	const [mixin, base, test] = rng.pick([
		['DbMixin', 'BaseTest', 'TestReports'],
		['AuthMixin', 'ApiTestCase', 'TestOrders'],
		['TempDirMixin', 'BaseCase', 'TestExport']
	] as const);
	type Op = 'print' | 'super' | 'cleanup';
	// setUp bodies of the three levels; the base's super() goes to TestCase and does nothing visible.
	const mixinOps = rng.shuffle<Op>(['print', 'super', 'cleanup']);
	const baseOps = rng.shuffle<Op>(['print', 'cleanup']);
	const testOps = rng.shuffle<Op>(['print', 'super']);
	const mixinDown = rng.shuffle<Op>(['print', 'super']);
	const testDown = rng.shuffle<Op>(['print', 'super']);
	const tests = printingTests(rng, rng.int(1, 2));
	const opLine = (op: Op, cls: string, method: 'setUp' | 'tearDown'): string =>
		op === 'print'
			? `    print('${cls} ${method}')`
			: op === 'super'
				? `    super().${method}()`
				: `    self.addCleanup(print, '${cls} cleanup')`;
	const top = [
		classLines(mixin, '', [
			['def setUp(self):', ...mixinOps.map((op) => opLine(op, mixin, 'setUp'))],
			['def tearDown(self):', ...mixinDown.map((op) => opLine(op, mixin, 'tearDown'))]
		]).map((l, i) => (i === 0 ? `class ${mixin}:` : l)),
		classLines(base, 'unittest.TestCase', [
			['def setUp(self):', ...baseOps.map((op) => opLine(op, base, 'setUp'))],
			['def tearDown(self):', `    print('${base} tearDown')`]
		]),
		classLines(test, `${mixin}, ${base}`, [
			['def setUp(self):', ...testOps.map((op) => opLine(op, test, 'setUp'))],
			['def tearDown(self):', ...testDown.map((op) => opLine(op, test, 'tearDown'))],
			...tests.map((t) => t.lines)
		])
	];
	return {
		lines: module(['import io', 'import unittest'], top, [test]),
		run: (rules) => {
			const out: string[] = [];
			for (const t of [...tests].sort((a, b) => byName(a.name, b.name))) {
				const cleanups: string[] = [];
				const levels: [string, Op[]][] = [
					[test, testOps],
					[mixin, mixinOps],
					[base, baseOps]
				];
				const run = (i: number, method: 'setUp' | 'tearDown', downOps: Op[][]) => {
					const level = levels[i];
					if (!level) return;
					const [name] = level;
					const ops = downOps[i] ?? [];
					const sorted = rules.superRunsFirst
						? [...ops].sort((a, b) => (a === 'super' ? -1 : b === 'super' ? 1 : 0))
						: ops;
					for (const op of sorted) {
						if (op === 'print') out.push(`${name} ${method}`);
						else if (op === 'cleanup') cleanups.push(`${name} cleanup`);
						else if (!(name === mixin && rules.superSkipsToTestcase)) run(i + 1, method, downOps);
					}
				};
				run(0, 'setUp', [testOps, mixinOps, baseOps]);
				out.push(t.line);
				run(0, 'tearDown', [testDown, mixinDown, ['print']]);
				out.push(...order(cleanups, rules.cleanupFifo));
			}
			out.push(summary(tests.length, 0, 0));
			return out;
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'middle/setupclass-error': setupclassError,
	'middle/cleanup-error': cleanupError,
	'middle/exit-stack': exitStack,
	'middle/missing-super': missingSuper,
	'senior/class-cleanups': classCleanups,
	'senior/enter-context': enterContext,
	'senior/suppress': suppress,
	'senior/mro-fixtures': mroFixtures
};

const STATEMENT = [
	'Что напечатает программа на Python 3? Тесты запускаются стандартным раннером `unittest`; его отчёт пишется в',
	'отдельный поток `io.StringIO()` и на экран не попадает — на экране только то, что печатает `print`, и итоговая',
	'строка с числом запущенных тестов, ошибок (`errors`) и провалов (`failures`).',
	'',
	'Введите вывод построчно, как он появится на экране: каждая напечатанная строка — отдельной строкой ответа,',
	'значения через один пробел, например `close db` или `run 2 errors 1 failures 0`.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = make(rng);
		const answer = p.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = p.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = p.lines.join('\n');
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
