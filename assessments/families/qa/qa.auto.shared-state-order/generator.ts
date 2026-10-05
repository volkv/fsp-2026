// Isolation of tests: a new TestCase instance per test does not reset what lives in the class or the module. The
// shown program runs one or two test cases whose tests share state through a class attribute, a default value, a
// setUpClass fixture, a module cache, inheritance, a shallow copy or +=; a result object prints every test's outcome
// in the order of the run, then the program prints the shared state. The candidate writes what it prints.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Rules {
	freshPerTest: boolean;
	declarationOrder: boolean;
	rebindShares: boolean;
	defaultFresh: boolean;
	setupclassPerTest: boolean;
	sharedAcrossClasses: boolean;
	cachePerTest: boolean;
	globalRestored: boolean;
	inheritedNotRerun: boolean;
	subclassOwnCopy: boolean;
	restoreAfterFailure: boolean;
	shallowIsDeep: boolean;
	copyIsAlias: boolean;
	iaddRebinds: boolean;
	intIaddShared: boolean;
}

const RIGHT: Rules = {
	freshPerTest: false,
	declarationOrder: false,
	rebindShares: false,
	defaultFresh: false,
	setupclassPerTest: false,
	sharedAcrossClasses: false,
	cachePerTest: false,
	globalRestored: false,
	inheritedNotRerun: false,
	subclassOwnCopy: false,
	restoreAfterFailure: false,
	shallowIsDeep: false,
	copyIsAlias: false,
	iaddRebinds: false,
	intIaddShared: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'fresh-per-test': { freshPerTest: true },
	'declaration-order': { declarationOrder: true },
	'rebind-shares': { rebindShares: true },
	'default-fresh': { defaultFresh: true },
	'setupclass-per-test': { setupclassPerTest: true },
	'shared-across-classes': { sharedAcrossClasses: true },
	'cache-per-test': { cachePerTest: true },
	'global-restored': { globalRestored: true },
	'inherited-not-rerun': { inheritedNotRerun: true },
	'subclass-own-copy': { subclassOwnCopy: true },
	'restore-after-failure': { restoreAfterFailure: true },
	'shallow-is-deep': { shallowIsDeep: true },
	'copy-is-alias': { copyIsAlias: true },
	'iadd-rebinds': { iaddRebinds: true },
	'int-iadd-shared': { intIaddShared: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/class-attribute': ['fresh-per-test', 'declaration-order', 'rebind-shares'],
	'middle/mutable-default': ['default-fresh', 'declaration-order'],
	'middle/setupclass-state': ['setupclass-per-test', 'shared-across-classes'],
	'middle/module-cache': ['cache-per-test', 'global-restored'],
	'senior/inherited-state': ['inherited-not-rerun', 'subclass-own-copy', 'fresh-per-test'],
	'senior/partial-mutation': ['restore-after-failure', 'global-restored'],
	'senior/shallow-copy': ['shallow-is-deep', 'copy-is-alias'],
	'senior/augmented-assignment': ['iadd-rebinds', 'int-iadd-shared', 'fresh-per-test']
};

type Outcome = 'ok' | 'FAIL' | 'ERROR';

/** A test method: its lines (without the class indentation) and its run over the shared state of the program. */
interface Test<S> {
	name: string;
	lines: string[];
	run: (state: S, rules: Rules, cls: string) => Outcome;
}

interface Case<S> {
	name: string;
	parent: string | null;
	/** Class attributes and fixtures, before the tests. */
	body: string[];
	tests: Test<S>[];
	/** Tests inherited from the parent, in their declaration order. */
	inherited: Test<S>[];
}

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const WORDS = ['add', 'apply', 'count', 'merge', 'remove', 'reset', 'share', 'sync', 'tag', 'total', 'undo', 'view'];
const GOODS = ['tea', 'jam', 'pie', 'soup', 'rice', 'milk', 'bread', 'corn', 'salt', 'cake'];

const byName = <S>(a: Test<S>, b: Test<S>) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const pyList = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(', ')}]`;

/** The tests a case runs, in the order of the run. */
function runOrder<S>(c: Case<S>, rules: Rules): Test<S>[] {
	const all = rules.inheritedNotRerun ? c.tests : [...c.inherited, ...c.tests];
	return rules.declarationOrder ? all : [...all].sort(byName);
}

/** Distinct test names for a program. */
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

function renderProgram<S>(header: string[], cases: Case<S>[], finals: string[]): string[] {
	const indent = (lines: string[]) => lines.map((l) => (l === '' ? '' : `    ${l}`));
	const classes = cases.flatMap((c) => {
		const blocks = [...(c.body.length ? [c.body] : []), ...c.tests.map((t) => t.lines)];
		return [
			`class ${c.name}(${c.parent ?? 'unittest.TestCase'}):`,
			...indent(blocks.flatMap((b, i) => [...(i > 0 ? [''] : []), ...b])),
			'',
			''
		];
	});
	return [
		...header,
		'',
		'',
		...classes,
		'class Log(unittest.TestResult):',
		'    def addSuccess(self, test):',
		"        print(type(test).__name__, test._testMethodName, 'ok')",
		'',
		'    def addFailure(self, test, err):',
		"        print(type(test).__name__, test._testMethodName, 'FAIL')",
		'',
		'    def addError(self, test, err):',
		"        print(type(test).__name__, test._testMethodName, 'ERROR')",
		'',
		'',
		'loader = unittest.defaultTestLoader',
		`suite = unittest.TestSuite([${cases.map((c) => `loader.loadTestsFromTestCase(${c.name})`).join(', ')}])`,
		'suite.run(Log())',
		...finals
	];
}

/** Runs the cases in order; `before` resets what the rules reset before a test of the case. */
function runCases<S>(
	cases: Case<S>[],
	state: S,
	rules: Rules,
	hooks: { classSetUp?: (c: Case<S>) => void; before?: (c: Case<S>) => void; after?: () => void } = {}
): string[] {
	const out: string[] = [];
	for (const c of cases) {
		hooks.classSetUp?.(c);
		for (const test of runOrder(c, rules)) {
			hooks.before?.(c);
			out.push(`${c.name} ${test.name} ${test.run(state, rules, c.name)}`);
			hooks.after?.();
		}
	}
	return out;
}

const check = (ok: boolean): Outcome => (ok ? 'ok' : 'FAIL');

// ---- middle -------------------------------------------------------------------------------------------------

/** Tests over a list attribute `items` of their class; `lists` maps a class to the list object it sees. */
type ListState = Map<string, string[]>;

function listTest(names: Names, kind: 'append' | 'contains' | 'empty' | 'rebind', value: string): Test<ListState> {
	const name = names.next();
	const list = (s: ListState, cls: string) => s.get(cls) ?? [];
	switch (kind) {
		case 'append':
			return {
				name,
				lines: [
					`def ${name}(self):`,
					`    self.items.append('${value}')`,
					`    self.assertEqual(self.items, ['${value}'])`
				],
				run: (s, rules, cls) => {
					const items = rules.freshPerTest ? [] : list(s, cls);
					const ok = items.length === 0;
					items.push(value);
					return check(ok);
				}
			};
		case 'contains':
			return {
				name,
				lines: [`def ${name}(self):`, `    self.assertIn('${value}', self.items)`],
				run: (s, rules, cls) => check(!rules.freshPerTest && list(s, cls).includes(value))
			};
		case 'empty':
			return {
				name,
				lines: [`def ${name}(self):`, '    self.assertEqual(self.items, [])'],
				run: (s, rules, cls) => check(rules.freshPerTest || list(s, cls).length === 0)
			};
		case 'rebind':
			return {
				name,
				lines: [
					`def ${name}(self):`,
					`    self.items = ['${value}']`,
					`    self.assertEqual(self.items, ['${value}'])`
				],
				run: (s, rules, cls) => {
					if (rules.rebindShares && !rules.freshPerTest) {
						const items = list(s, cls);
						items.splice(0, items.length, value);
					}
					return 'ok';
				}
			};
	}
}

function classAttribute(rng: Rng): Program {
	const names = new Names(rng);
	const [c1, c2] = rng.pick([
		['TestCart', 'TestWishlist'],
		['TestInbox', 'TestArchive'],
		['TestQueue', 'TestBacklog']
	] as const);
	const values = rng.sample(GOODS, 4);
	const makeTests = (own: string[]): Test<ListState>[] => {
		const [v1, v2] = own as [string, string];
		const pool = [
			listTest(names, 'append', v1),
			listTest(names, rng.pick(['append', 'rebind'] as const), v2),
			listTest(names, rng.pick(['contains', 'empty'] as const), rng.pick([v1, v2])),
			...(rng.bool() ? [listTest(names, rng.pick(['rebind', 'empty', 'contains'] as const), rng.pick(values))] : [])
		];
		return rng.shuffle(pool);
	};
	const cases: Case<ListState>[] = [
		{ name: c1, parent: null, body: ['items = []'], tests: makeTests(values.slice(0, 2)), inherited: [] },
		{ name: c2, parent: null, body: ['items = []'], tests: makeTests(values.slice(2, 4)), inherited: [] }
	];
	return {
		lines: renderProgram(['import unittest'], cases, [`print(${c1}.items, ${c2}.items)`]),
		run: (rules) => {
			const state: ListState = new Map([
				[c1, []],
				[c2, []]
			]);
			const out = runCases(cases, state, rules);
			out.push(`${pyList(state.get(c1) ?? [])} ${pyList(state.get(c2) ?? [])}`);
			return out;
		}
	};
}

function mutableDefault(rng: Rng): Program {
	const names = new Names(rng);
	const values = rng.sample(GOODS, 6);
	let next = 0;
	const value = () => values[next++ % values.length] ?? 'tea';
	type S = { shared: string[] };
	const call = (s: S, rules: Rules, v: string): string[] => {
		const lines = rules.defaultFresh ? [] : s.shared;
		lines.push(v);
		return lines;
	};
	const make = (kind: 'single' | 'explicit' | 'last' | 'pair'): Test<S> => {
		const name = names.next();
		const v = value();
		switch (kind) {
			case 'single':
				return {
					name,
					lines: [`def ${name}(self):`, `    lines = add_line('${v}')`, `    self.assertEqual(lines, ['${v}'])`],
					run: (s, rules) => check(call(s, rules, v).length === 1)
				};
			case 'explicit':
				return {
					name,
					lines: [`def ${name}(self):`, `    lines = add_line('${v}', [])`, `    self.assertEqual(lines, ['${v}'])`],
					run: () => 'ok'
				};
			case 'last':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(add_line('${v}')[-1], '${v}')`],
					run: (s, rules) => {
						call(s, rules, v);
						return 'ok';
					}
				};
			case 'pair': {
				const w = value();
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    add_line('${v}')`,
						`    lines = add_line('${w}')`,
						`    self.assertEqual(lines, ['${v}', '${w}'])`
					],
					run: (s, rules) => {
						const fresh = rules.defaultFresh;
						call(s, rules, v);
						const lines = call(s, rules, w);
						// A fresh default gives a list of one item for each call.
						return check(!fresh && lines.length === 2);
					}
				};
			}
		}
	};
	const [c1, c2] = rng.pick([
		['TestOrder', 'TestInvoice'],
		['TestReceipt', 'TestRefund'],
		['TestBasket', 'TestReport']
	] as const);
	const cases: Case<S>[] = [
		{
			name: c1,
			parent: null,
			body: [],
			tests: rng.shuffle([
				make('single'),
				make(rng.pick(['pair', 'last'] as const)),
				make(rng.pick(['explicit', 'single'] as const))
			]),
			inherited: []
		},
		{
			name: c2,
			parent: null,
			body: [],
			tests: rng.shuffle([
				make(rng.pick(['single', 'pair'] as const)),
				...(rng.bool() ? [make('explicit')] : [make('last')])
			]),
			inherited: []
		}
	];
	return {
		lines: renderProgram(
			['import unittest', '', '', 'def add_line(name, lines=[]):', '    lines.append(name)', '    return lines'],
			cases,
			["print(add_line('end'))"]
		),
		run: (rules) => {
			const state: S = { shared: [] };
			const out = runCases(cases, state, rules);
			out.push(pyList(call(state, rules, 'end')));
			return out;
		}
	};
}

function setupclassState(rng: Rng): Program {
	const names = new Names(rng);
	const keys = rng.sample(PERSON_NAMES, 3);
	type S = { dbs: Map<string, Map<string, number>> };
	const db = (s: S, cls: string, rules: Rules) => {
		const key = rules.sharedAcrossClasses ? 'shared' : cls;
		let found = s.dbs.get(key);
		if (!found) {
			found = new Map();
			s.dbs.set(key, found);
		}
		return found;
	};
	const make = (kind: 'insert-count' | 'insert' | 'absent' | 'present', key: string, n: number): Test<S> => {
		const name = names.next();
		switch (kind) {
			case 'insert-count':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.db['${key}'] = ${n}`, '    self.assertEqual(len(self.db), 1)'],
					run: (s, rules, cls) => {
						const d = db(s, cls, rules);
						d.set(key, n);
						return check(d.size === 1);
					}
				};
			case 'insert':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.db['${key}'] = ${n}`, `    self.assertIn('${key}', self.db)`],
					run: (s, rules, cls) => {
						db(s, cls, rules).set(key, n);
						return 'ok';
					}
				};
			case 'absent':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertNotIn('${key}', self.db)`],
					run: (s, rules, cls) => check(!db(s, cls, rules).has(key))
				};
			case 'present':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(self.db['${key}'], ${n})`],
					run: (s, rules, cls) => {
						const d = db(s, cls, rules);
						if (!d.has(key)) return 'ERROR';
						return check(d.get(key) === n);
					}
				};
		}
	};
	const [c1, c2] = rng.pick([
		['TestUsers', 'TestGroups'],
		['TestAccounts', 'TestTeams'],
		['TestClients', 'TestPartners']
	] as const);
	const nums = Array.from({ length: 8 }, () => rng.int(1, 9));
	const k = (i: number) => keys[i] ?? 'anna';
	const n = (i: number) => nums[i] ?? 1;
	const fixture = ['@classmethod', 'def setUpClass(cls):', '    cls.db = {}'];
	const cases: Case<S>[] = [
		{
			name: c1,
			parent: null,
			body: fixture,
			tests: rng.shuffle([
				make('insert-count', k(0), n(0)),
				make('insert', k(1), n(1)),
				make(rng.pick(['present', 'absent'] as const), rng.pick([k(0), k(1)]), rng.pick([n(0), n(1), n(2)]))
			]),
			inherited: []
		},
		{
			name: c2,
			parent: null,
			body: fixture,
			tests: rng.shuffle([
				make(rng.pick(['absent', 'present'] as const), rng.pick([k(0), k(1)]), rng.pick([n(0), n(1)])),
				make(rng.pick(['insert-count', 'insert'] as const), k(2), n(3)),
				...(rng.bool() ? [make('insert-count', rng.pick([k(0), k(2)]), n(4))] : [])
			]),
			inherited: []
		}
	];
	const dict = (m: Map<string, number> | undefined) => pyList([...(m?.keys() ?? [])].sort());
	return {
		lines: renderProgram(['import unittest'], cases, [`print(sorted(${c1}.db), sorted(${c2}.db))`]),
		run: (rules) => {
			const state: S = { dbs: new Map() };
			const out = runCases(cases, state, rules, {
				classSetUp: (c) => {
					if (!rules.sharedAcrossClasses) state.dbs.set(c.name, new Map());
					else if (!state.dbs.has('shared')) state.dbs.set('shared', new Map());
				},
				before: (c) => {
					if (rules.setupclassPerTest) state.dbs.set(rules.sharedAcrossClasses ? 'shared' : c.name, new Map());
				}
			});
			const key = (c: string) => (rules.sharedAcrossClasses ? 'shared' : c);
			out.push(`${dict(state.dbs.get(key(c1)))} ${dict(state.dbs.get(key(c2)))}`);
			return out;
		}
	};
}

function moduleCache(rng: Rng): Program {
	const names = new Names(rng);
	const items = rng.sample(GOODS, 2) as [string, string];
	const base = new Map(items.map((i) => [i, rng.int(4, 40) * 5]));
	const vat = (x: number) => Math.floor((x * 6) / 5);
	type S = { prices: Map<string, number>; cache: Map<string, number> };
	const price = (s: S, item: string) => {
		if (!s.cache.has(item)) s.cache.set(item, vat(s.prices.get(item) ?? 0));
		return s.cache.get(item) ?? 0;
	};
	const make = (kind: 'vat' | 'reprice' | 'raw', item: string): Test<S> => {
		const name = names.next();
		const b = base.get(item) ?? 0;
		switch (kind) {
			case 'vat':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(price_with_vat('${item}'), ${vat(b)})`],
					run: (s) => check(price(s, item) === vat(b))
				};
			case 'reprice': {
				const fresh = b + rng.int(1, 20) * 5;
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    PRICES['${item}'] = ${fresh}`,
						`    self.assertEqual(price_with_vat('${item}'), ${vat(fresh)})`
					],
					run: (s) => {
						s.prices.set(item, fresh);
						return check(price(s, item) === vat(fresh));
					}
				};
			}
			case 'raw':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(PRICES['${item}'], ${b})`],
					run: (s) => check(s.prices.get(item) === b)
				};
		}
	};
	const [i1, i2] = items;
	const tests = rng.shuffle([
		make('vat', i1),
		make('reprice', rng.pick(items)),
		make('raw', rng.pick(items)),
		make(rng.pick(['vat', 'reprice'] as const), i2),
		...(rng.bool() ? [make(rng.pick(['raw', 'vat'] as const), rng.pick(items))] : [])
	]);
	const cls = rng.pick(['TestPricing', 'TestCheckout', 'TestCatalog']);
	const cases: Case<S>[] = [{ name: cls, parent: null, body: [], tests, inherited: [] }];
	const dict = (m: Map<string, number>) => `{${[...m].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`;
	return {
		lines: renderProgram(
			[
				'import unittest',
				'',
				`PRICES = ${dict(base)}`,
				'_cache = {}',
				'',
				'',
				'def price_with_vat(item):',
				'    if item not in _cache:',
				'        _cache[item] = PRICES[item] * 6 // 5',
				'    return _cache[item]'
			],
			cases,
			['print(PRICES, _cache)']
		),
		run: (rules) => {
			const state: S = { prices: new Map(base), cache: new Map() };
			const out = runCases(cases, state, rules, {
				before: () => {
					if (rules.cachePerTest) state.cache.clear();
				},
				after: () => {
					if (rules.globalRestored) state.prices = new Map(base);
				}
			});
			out.push(`${dict(state.prices)} ${dict(state.cache)}`);
			return out;
		}
	};
}

// ---- senior -------------------------------------------------------------------------------------------------

function inheritedState(rng: Rng): Program {
	const names = new Names(rng);
	const values = rng.sample(GOODS, 4);
	const [base, sub] = rng.pick([
		['TestCart', 'TestPromoCart'],
		['TestInbox', 'TestSharedInbox'],
		['TestQueue', 'TestPriorityQueue']
	] as const);
	const ownAttribute = rng.bool(0.3);
	type S = { lists: Map<string, string[]> };
	const listOf = (s: S, cls: string, rules: Rules) => {
		const separate = cls === sub && (ownAttribute || rules.subclassOwnCopy);
		const key = separate ? sub : base;
		let found = s.lists.get(key);
		if (!found) {
			found = [];
			s.lists.set(key, found);
		}
		return found;
	};
	const make = (kind: 'append' | 'count' | 'contains' | 'empty', value: string, count: number): Test<S> => {
		const name = names.next();
		switch (kind) {
			case 'append':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.items.append('${value}')`,
						`    self.assertIn('${value}', self.items)`
					],
					run: (s, rules, cls) => {
						if (!rules.freshPerTest) listOf(s, cls, rules).push(value);
						return 'ok';
					}
				};
			case 'count':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.items.append('${value}')`,
						`    self.assertEqual(len(self.items), ${count})`
					],
					run: (s, rules, cls) => {
						if (rules.freshPerTest) return check(count === 1);
						const items = listOf(s, cls, rules);
						items.push(value);
						return check(items.length === count);
					}
				};
			case 'contains':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertIn('${value}', self.items)`],
					run: (s, rules, cls) => check(!rules.freshPerTest && listOf(s, cls, rules).includes(value))
				};
			case 'empty':
				return {
					name,
					lines: [`def ${name}(self):`, '    self.assertEqual(self.items, [])'],
					run: (s, rules, cls) => check(rules.freshPerTest || listOf(s, cls, rules).length === 0)
				};
		}
	};
	const [v1, v2, v3] = values as [string, string, string];
	const baseTests = rng.shuffle([make('append', v1, 0), make('count', v2, rng.int(1, 3))]);
	const subTests = rng.shuffle([
		make(rng.pick(['contains', 'empty'] as const), rng.pick([v1, v2, v3]), 0),
		...(rng.bool() ? [make('count', v3, rng.int(1, 5))] : [])
	]);
	const cases: Case<S>[] = [
		{ name: base, parent: null, body: ['items = []'], tests: baseTests, inherited: [] },
		{ name: sub, parent: base, body: ownAttribute ? ['items = []'] : [], tests: subTests, inherited: baseTests }
	];
	return {
		lines: renderProgram(['import unittest'], cases, [`print(len(${base}.items), len(${sub}.items))`]),
		run: (rules) => {
			const state: S = { lists: new Map() };
			const out = runCases(cases, state, rules);
			out.push(`${listOf(state, base, rules).length} ${listOf(state, sub, rules).length}`);
			return out;
		}
	};
}

function partialMutation(rng: Rng): Program {
	const names = new Names(rng);
	const users = rng.sample(PERSON_NAMES, 3);
	const limits = new Map<string, number>(users.map((u) => [u, rng.int(2, 9)]));
	type S = { limits: Map<string, number> };
	const make = (kind: 'inline' | 'cleanup' | 'read' | 'spend', user: string): Test<S> => {
		const name = names.next();
		const base = limits.get(user) ?? 0;
		switch (kind) {
			case 'inline': {
				const tmp = rng.int(10, 20);
				const amount = rng.int(tmp - 6, tmp + 6);
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    old = LIMITS['${user}']`,
						`    LIMITS['${user}'] = ${tmp}`,
						`    self.assertTrue(can_spend('${user}', ${amount}))`,
						`    LIMITS['${user}'] = old`
					],
					run: (s, rules) => {
						const old = s.limits.get(user) ?? 0;
						s.limits.set(user, tmp);
						const ok = amount <= tmp;
						if (ok || rules.restoreAfterFailure) s.limits.set(user, old);
						return check(ok);
					}
				};
			}
			case 'cleanup': {
				const tmp = rng.int(0, 3);
				const amount = rng.int(1, 6);
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.addCleanup(LIMITS.__setitem__, '${user}', LIMITS['${user}'])`,
						`    LIMITS['${user}'] = ${tmp}`,
						`    self.assertFalse(can_spend('${user}', ${amount}))`
					],
					run: (s) => {
						const old = s.limits.get(user) ?? 0;
						s.limits.set(user, tmp);
						const ok = amount > tmp;
						s.limits.set(user, old);
						return check(ok);
					}
				};
			}
			case 'read':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(LIMITS['${user}'], ${base})`],
					run: (s) => check(s.limits.get(user) === base)
				};
			case 'spend': {
				const amount = base + rng.int(1, 6);
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertFalse(can_spend('${user}', ${amount}))`],
					run: (s) => check(amount > (s.limits.get(user) ?? 0))
				};
			}
		}
	};
	const [u1, u2] = users as [string, string];
	const tests = rng.shuffle([
		make('inline', u1),
		make(rng.pick(['read', 'spend'] as const), u1),
		make('cleanup', u2),
		make(rng.pick(['read', 'spend'] as const), u2),
		...(rng.bool() ? [make(rng.pick(['inline', 'read'] as const), rng.pick([u1, u2]))] : [])
	]);
	const cls = rng.pick(['TestLimits', 'TestWallet', 'TestBudget']);
	const cases: Case<S>[] = [{ name: cls, parent: null, body: [], tests, inherited: [] }];
	const dict = (m: Map<string, number>) => `{${[...m].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`;
	return {
		lines: renderProgram(
			[
				'import unittest',
				'',
				`LIMITS = ${dict(limits)}`,
				'',
				'',
				'def can_spend(user, amount):',
				'    return amount <= LIMITS[user]'
			],
			cases,
			['print(LIMITS)']
		),
		run: (rules) => {
			const state: S = { limits: new Map(limits) };
			const out = runCases(cases, state, rules, {
				after: () => {
					if (rules.globalRestored) state.limits = new Map(limits);
				}
			});
			out.push(dict(state.limits));
			return out;
		}
	};
}

function shallowCopy(rng: Rng): Program {
	const names = new Names(rng);
	const plan = rng.pick(['basic', 'pro', 'team']);
	const firstTag = rng.pick(['new', 'trial', 'beta']);
	const limit = rng.int(2, 9);
	const tags = rng.sample(['vip', 'promo', 'late', 'blocked', 'gift'], 3);
	type Template = { tags: string[]; limit: number };
	type S = { template: Template; profile: Template };
	const copies = rng.shuffle([
		rng.pick(['dict(TEMPLATE)', 'TEMPLATE.copy()', 'copy.copy(TEMPLATE)']),
		'copy.deepcopy(TEMPLATE)'
	]);
	const [c1, c2] = rng.pick([
		['TestProfile', 'TestSettings'],
		['TestAccount', 'TestPlan'],
		['TestUser', 'TestTariff']
	] as const);
	const copyOf = new Map<string, string>([
		[c1, copies[0] ?? ''],
		[c2, copies[1] ?? '']
	]);
	const make = (kind: 'add-tag' | 'set-limit' | 'check-tags' | 'check-limit', value: string, n: number): Test<S> => {
		const name = names.next();
		switch (kind) {
			case 'add-tag':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.profile['tags'].append('${value}')`,
						`    self.assertEqual(self.profile['tags'], ['${firstTag}', '${value}'])`
					],
					run: (s) => {
						const ok = s.profile.tags.length === 1;
						s.profile.tags.push(value);
						return check(ok);
					}
				};
			case 'set-limit':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.profile['limit'] = ${n}`,
						`    self.assertEqual(self.profile['limit'], ${n})`
					],
					run: (s) => {
						s.profile.limit = n;
						return 'ok';
					}
				};
			case 'check-tags':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(self.profile['tags'], ['${firstTag}'])`],
					run: (s) => check(s.profile.tags.length === 1)
				};
			case 'check-limit':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.assertEqual(self.profile['limit'], ${limit})`],
					run: (s) => check(s.profile.limit === limit)
				};
		}
	};
	const [t1, t2, t3] = tags as [string, string, string];
	const fixture = (cls: string) => ['def setUp(self):', `    self.profile = ${copyOf.get(cls) ?? ''}`];
	const cases: Case<S>[] = [
		{
			name: c1,
			parent: null,
			body: fixture(c1),
			tests: rng.shuffle([
				make('add-tag', t1, 0),
				make('set-limit', '', rng.int(10, 30)),
				make(rng.pick(['check-tags', 'check-limit'] as const), '', 0)
			]),
			inherited: []
		},
		{
			name: c2,
			parent: null,
			body: fixture(c2),
			tests: rng.shuffle([
				make(rng.pick(['add-tag', 'check-tags'] as const), t2, 0),
				make(rng.pick(['check-limit', 'check-tags'] as const), '', 0),
				...(rng.bool() ? [make('add-tag', t3, 0)] : [])
			]),
			inherited: []
		}
	];
	return {
		lines: renderProgram(
			[
				'import copy',
				'import unittest',
				'',
				`TEMPLATE = {'plan': '${plan}', 'tags': ['${firstTag}'], 'limit': ${limit}}`
			],
			cases,
			['print(TEMPLATE)']
		),
		run: (rules) => {
			const state: S = { template: { tags: [firstTag], limit }, profile: { tags: [firstTag], limit } };
			const out = runCases(cases, state, rules, {
				before: (c) => {
					const how = copyOf.get(c.name) ?? '';
					const deep = how.startsWith('copy.deepcopy') || rules.shallowIsDeep;
					if (rules.copyIsAlias && !how.startsWith('copy.deepcopy')) state.profile = state.template;
					else if (deep) state.profile = { tags: [...state.template.tags], limit: state.template.limit };
					else state.profile = { tags: state.template.tags, limit: state.template.limit };
				}
			});
			out.push(`{'plan': '${plan}', 'tags': ${pyList(state.template.tags)}, 'limit': ${state.template.limit}}`);
			return out;
		}
	};
}

function augmentedAssignment(rng: Rng): Program {
	const names = new Names(rng);
	const values = rng.sample(GOODS, 4);
	type S = { seen: string[]; total: number };
	const make = (
		kind: 'iadd-list' | 'concat' | 'iadd-int' | 'read-total' | 'read-seen',
		value: string,
		n: number
	): Test<S> => {
		const name = names.next();
		switch (kind) {
			case 'iadd-list':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.seen += ['${value}']`,
						`    self.assertEqual(self.seen, ['${value}'])`
					],
					run: (s, rules) => {
						if (rules.iaddRebinds || rules.freshPerTest) return 'ok';
						const ok = s.seen.length === 0;
						s.seen.push(value);
						return check(ok);
					}
				};
			case 'concat':
				return {
					name,
					lines: [
						`def ${name}(self):`,
						`    self.seen = self.seen + ['${value}']`,
						`    self.assertEqual(self.seen[-1], '${value}')`
					],
					run: () => 'ok'
				};
			case 'iadd-int':
				return {
					name,
					lines: [`def ${name}(self):`, `    self.total += ${n}`, `    self.assertEqual(self.total, ${n})`],
					run: (s, rules) => {
						if (!rules.intIaddShared || rules.freshPerTest) return 'ok';
						const ok = s.total === 0;
						s.total += n;
						return check(ok);
					}
				};
			case 'read-total':
				return {
					name,
					lines: [`def ${name}(self):`, '    self.assertEqual(self.total, 0)'],
					run: (s, rules) => check(rules.freshPerTest || s.total === 0)
				};
			case 'read-seen':
				return {
					name,
					lines: [`def ${name}(self):`, '    self.assertEqual(self.seen, [])'],
					run: (s, rules) => check(rules.freshPerTest || s.seen.length === 0)
				};
		}
	};
	const [v1, v2, v3] = values as [string, string, string];
	const tests = rng.shuffle([
		make('iadd-list', v1, 0),
		make('iadd-int', '', rng.int(2, 9)),
		make(rng.pick(['iadd-list', 'concat'] as const), v2, 0),
		make(rng.pick(['read-total', 'iadd-int'] as const), '', rng.int(2, 9)),
		...(rng.bool() ? [make(rng.pick(['read-seen', 'concat', 'iadd-list'] as const), v3, 0)] : [])
	]);
	const cls = rng.pick(['TestCounter', 'TestTracker', 'TestAudit']);
	const cases: Case<S>[] = [{ name: cls, parent: null, body: ['seen = []', 'total = 0'], tests, inherited: [] }];
	return {
		lines: renderProgram(['import unittest'], cases, [`print(${cls}.seen, ${cls}.total)`]),
		run: (rules) => {
			const state: S = { seen: [], total: 0 };
			const out = runCases(cases, state, rules);
			out.push(`${pyList(state.seen)} ${state.total}`);
			return out;
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'middle/class-attribute': classAttribute,
	'middle/mutable-default': mutableDefault,
	'middle/setupclass-state': setupclassState,
	'middle/module-cache': moduleCache,
	'senior/inherited-state': inheritedState,
	'senior/partial-mutation': partialMutation,
	'senior/shallow-copy': shallowCopy,
	'senior/augmented-assignment': augmentedAssignment
};

const STATEMENT = [
	'Что напечатает программа на Python 3? Объект `Log` печатает исход каждого теста в момент, когда тест закончился:',
	'имя класса, имя теста и `ok`, `FAIL` (проверка не прошла) или `ERROR` (исключение). Классы тестов запускаются в',
	'том порядке, в каком они перечислены в `TestSuite`.',
	'',
	'Введите вывод построчно, как он появится на экране: каждая напечатанная строка — отдельной строкой ответа,',
	"значения через один пробел, например `TestCart test_add ok` или `['tea'] 3`."
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
		const program = make(rng);
		const answer = program.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = program.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = program.lines.join('\n');
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
