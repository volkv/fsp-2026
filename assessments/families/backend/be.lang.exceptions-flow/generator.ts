// Control flow of exceptions: which handler runs, when else and finally run, what a re-raise, a return in finally,
// an exception raised inside a handler and the chain of causes do to the output.
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
	mostSpecific: boolean;
	elseAfterExcept: boolean;
	elseAfterReturn: boolean;
	finallyAfterCaller: boolean;
	reraiseHandled: boolean;
	finallyBeforeExcept: boolean;
	tryReturnWins: boolean;
	finallyKeepsException: boolean;
	returnReadsLate: boolean;
	siblingHandler: boolean;
	causeImplicit: boolean;
	fromClearsContext: boolean;
	finallySkippedOnJump: boolean;
	loopElseAlways: boolean;
	firstExceptionWins: boolean;
	contextLost: boolean;
}

const RIGHT: Rules = {
	mostSpecific: false,
	elseAfterExcept: false,
	elseAfterReturn: false,
	finallyAfterCaller: false,
	reraiseHandled: false,
	finallyBeforeExcept: false,
	tryReturnWins: false,
	finallyKeepsException: false,
	returnReadsLate: false,
	siblingHandler: false,
	causeImplicit: false,
	fromClearsContext: false,
	finallySkippedOnJump: false,
	loopElseAlways: false,
	firstExceptionWins: false,
	contextLost: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'most-specific': { mostSpecific: true },
	'else-after-except': { elseAfterExcept: true },
	'else-after-return': { elseAfterReturn: true },
	'finally-after-caller': { finallyAfterCaller: true },
	'reraise-handled': { reraiseHandled: true },
	'finally-before-except': { finallyBeforeExcept: true },
	'try-return-wins': { tryReturnWins: true },
	'finally-keeps-exception': { finallyKeepsException: true },
	'return-reads-late': { returnReadsLate: true },
	'sibling-handler': { siblingHandler: true },
	'cause-implicit': { causeImplicit: true },
	'from-clears-context': { fromClearsContext: true },
	'finally-skipped-on-jump': { finallySkippedOnJump: true },
	'loop-else-always': { loopElseAlways: true },
	'first-exception-wins': { firstExceptionWins: true },
	'context-lost': { contextLost: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/handler-order': ['most-specific', 'else-after-except'],
	'intern/return-else': ['else-after-return', 'finally-after-caller'],
	'intern/reraise': ['reraise-handled', 'finally-before-except'],
	'junior/finally-return': ['try-return-wins', 'finally-keeps-exception', 'return-reads-late'],
	'junior/raise-in-except': ['sibling-handler', 'finally-after-caller'],
	'junior/chain': ['cause-implicit', 'from-clears-context'],
	'intern/loop-jump': ['finally-skipped-on-jump', 'loop-else-always'],
	'junior/finally-raise': ['first-exception-wins', 'context-lost']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const WORDS = ['tea', 'cake', 'pie', 'jam', 'soup', 'rice', 'milk', 'bread', 'salt', 'corn'] as const;
const BAD_INPUTS = ['n/a', 'abc', 'x7', 'none', 'ten', '?', 'null', 'oops'] as const;

/** Exception classes of the programs with their bases, most specific first. */
const BASES: Record<string, string[]> = {
	ZeroDivisionError: ['ZeroDivisionError', 'ArithmeticError', 'Exception'],
	KeyError: ['KeyError', 'LookupError', 'Exception']
};
const LABELS: Record<string, string> = {
	ZeroDivisionError: 'zero price',
	ArithmeticError: 'bad math',
	KeyError: 'no price',
	LookupError: 'lookup failed',
	Exception: 'failed'
};

function handlerOrder(rng: Rng): Program {
	const fn = rng.pick(['handle', 'quote', 'price_of', 'charge']);
	const total = rng.pick([60, 120, 240, 360]);
	const keys = rng.sample(WORDS, 4);
	const [zeroKey, okKey, okKey2, missing] = keys as [string, string, string, string];
	const prices: [string, number][] = rng.shuffle([
		[zeroKey, 0],
		[okKey, rng.pick([2, 3, 4, 5, 6])],
		[okKey2, rng.pick([8, 10, 12])]
	]);
	// A base class precedes a subclass that also matches: the trap of the class.
	const pair = rng.pick([
		['ArithmeticError', 'ZeroDivisionError'],
		['LookupError', 'KeyError'],
		['Exception', 'KeyError'],
		['Exception', 'ZeroDivisionError']
	] as const);
	const other =
		pair[1] === 'KeyError' ? rng.pick(['ZeroDivisionError', 'ArithmeticError']) : rng.pick(['KeyError', 'LookupError']);
	const handlers =
		pair[0] === 'Exception'
			? [other, pair[0], pair[1]]
			: rng.pick([
					[pair[0], pair[1], other],
					[other, pair[0], pair[1]],
					[pair[0], other, pair[1]]
				]);
	const calls = rng.shuffle([zeroKey, missing, rng.pick([okKey, okKey2]), rng.pick([zeroKey, missing])]).slice(0, 4);
	const priceOf = new Map(prices);
	return {
		lines: [
			`prices = {${prices.map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
			'',
			`def ${fn}(key):`,
			'    try:',
			"        print('try', key)",
			`        value = ${total} // prices[key]`,
			"        print('value', value)",
			...handlers.flatMap((h) => [`    except ${h}:`, `        print('${LABELS[h] ?? h}', key)`]),
			'    else:',
			"        print('else', key)",
			'    finally:',
			"        print('done', key)",
			'',
			`for key in [${calls.map((k) => `'${k}'`).join(', ')}]:`,
			`    ${fn}(key)`
		],
		run: (rules) => {
			const out: string[] = [];
			for (const key of calls) {
				out.push(`try ${key}`);
				const price = priceOf.get(key);
				const raised = price === undefined ? 'KeyError' : price === 0 ? 'ZeroDivisionError' : null;
				if (raised === null) {
					out.push(`value ${Math.floor(total / (price ?? 1))}`);
					out.push(`else ${key}`);
				} else {
					const chain = BASES[raised] ?? [];
					const matching = handlers.filter((h) => chain.includes(h));
					const chosen = rules.mostSpecific
						? [...matching].sort((x, y) => chain.indexOf(x) - chain.indexOf(y))[0]
						: matching[0];
					out.push(`${LABELS[chosen ?? ''] ?? ''} ${key}`);
					if (rules.elseAfterExcept) out.push(`else ${key}`);
				}
				out.push(`done ${key}`);
			}
			return out;
		}
	};
}

function returnElse(rng: Rng): Program {
	const fn = rng.pick(['parse', 'read_limit', 'to_int', 'clamp']);
	const limit = rng.int(20, 60);
	const above = Array.from({ length: 2 }, () => String(rng.int(limit + 1, 99)));
	const below = Array.from({ length: 2 }, () => String(rng.int(1, limit - 1)));
	const bad = rng.sample(BAD_INPUTS, 1);
	const inputs = rng.shuffle([rng.pick(above), rng.pick(below), ...bad, rng.pick([...above, ...below])]);
	return {
		lines: [
			`LIMIT = ${limit}`,
			'',
			`def ${fn}(raw):`,
			'    try:',
			'        n = int(raw)',
			'        if n > LIMIT:',
			'            return LIMIT',
			'    except ValueError:',
			"        print('bad', raw)",
			'        return 0',
			'    else:',
			"        print('else', raw)",
			'        return n',
			'    finally:',
			"        print('finally', raw)",
			'',
			`for raw in [${inputs.map((s) => `'${s}'`).join(', ')}]:`,
			`    print('got', ${fn}(raw))`
		],
		run: (rules) => {
			const out: string[] = [];
			for (const raw of inputs) {
				const inner: string[] = [];
				const n = /^\d+$/.test(raw) ? Number(raw) : null;
				let value: number;
				if (n === null) {
					inner.push(`bad ${raw}`);
					value = 0;
				} else if (n > limit) {
					if (rules.elseAfterReturn) inner.push(`else ${raw}`);
					value = limit;
				} else {
					inner.push(`else ${raw}`);
					value = n;
				}
				const got = `got ${value}`;
				const fin = `finally ${raw}`;
				out.push(...inner, ...(rules.finallyAfterCaller ? [got, fin] : [fin, got]));
			}
			return out;
		}
	};
}

function reraise(rng: Rng): Program {
	const [check, process] = rng.pick([
		['validate', 'process'],
		['check', 'handle'],
		['verify', 'apply'],
		['ensure', 'run']
	] as const);
	const divisor = rng.int(3, 7);
	const values = new Set<number>();
	// At least one failing and one passing value.
	values.add(divisor * rng.int(2, 9));
	while (values.size < 2) {
		const v = rng.int(10, 60);
		if (v % divisor !== 0) values.add(v);
	}
	while (values.size < 4) values.add(rng.int(10, 60));
	const xs = rng.shuffle([...values]);
	return {
		lines: [
			`def ${check}(x):`,
			`    if x % ${divisor} == 0:`,
			'        raise ValueError(x)',
			'    return x',
			'',
			`def ${process}(x):`,
			'    try:',
			"        print('check', x)",
			`        ${check}(x)`,
			'    except ValueError:',
			"        print('log', x)",
			'        raise',
			'    finally:',
			"        print('cleanup', x)",
			"    print('processed', x)",
			'',
			`for x in [${xs.join(', ')}]:`,
			'    try:',
			`        ${process}(x)`,
			'    except ValueError:',
			"        print('failed', x)"
		],
		run: (rules) => {
			const out: string[] = [];
			for (const x of xs) {
				out.push(`check ${x}`);
				if (x % divisor !== 0) {
					out.push(`cleanup ${x}`, `processed ${x}`);
					continue;
				}
				const handled = [`log ${x}`];
				const cleanup = `cleanup ${x}`;
				out.push(...(rules.finallyBeforeExcept ? [cleanup, ...handled] : [...handled, cleanup]));
				out.push(rules.reraiseHandled ? `processed ${x}` : `failed ${x}`);
			}
			return out;
		}
	};
}

function finallyReturn(rng: Rng): Program {
	const fn = rng.pick(['load', 'fetch', 'resolve', 'lookup']);
	const p = rng.pick([3, 5, 7]);
	const q = rng.int(12, 30);
	const evenReturns = rng.bool();
	const parity = evenReturns ? 0 : 1;
	// Inputs that cover the paths: failing and re-raised, failing and handled, normal; with and without the
	// return in finally.
	const pool = Array.from({ length: 60 }, (_, i) => i + 1);
	const kinds = {
		raisedFinal: pool.filter((n) => n % p === 0 && n > q && n % 2 === parity),
		raisedEscapes: pool.filter((n) => n % p === 0 && n > q && n % 2 !== parity),
		handled: pool.filter((n) => n % p === 0 && n <= q),
		normalFinal: pool.filter((n) => n % p !== 0 && n % 2 === parity),
		normal: pool.filter((n) => n % p !== 0 && n % 2 !== parity)
	};
	const ns = rng.shuffle([
		rng.pick(kinds.raisedFinal),
		rng.pick(kinds.raisedEscapes),
		rng.pick(kinds.normalFinal),
		rng.pick([...kinds.normal, ...kinds.handled]),
		rng.pick([...kinds.handled, ...kinds.normal])
	]);
	return {
		lines: [
			`def ${fn}(n):`,
			"    status = 'start'",
			'    try:',
			"        status = 'try'",
			`        if n % ${p} == 0:`,
			'            raise KeyError(n)',
			'        return status',
			'    except KeyError:',
			"        status = 'except'",
			`        if n > ${q}:`,
			'            raise',
			'        return status',
			'    finally:',
			"        status = 'finally'",
			`        if n % 2 == ${parity}:`,
			'            return status',
			'',
			`for n in [${ns.join(', ')}]:`,
			'    try:',
			`        print(n, ${fn}(n))`,
			'    except KeyError:',
			"        print(n, 'error')"
		],
		run: (rules) =>
			ns.map((n) => {
				const finallyReturns = n % 2 === parity;
				let pending: { value: string } | { error: true };
				if (n % p !== 0) pending = { value: 'try' };
				else if (n <= q) pending = { value: 'except' };
				else pending = { error: true };
				if ('error' in pending) {
					if (finallyReturns && !rules.finallyKeepsException) return `${n} finally`;
					return `${n} error`;
				}
				if (finallyReturns && !rules.tryReturnWins) return `${n} finally`;
				return `${n} ${rules.returnReadsLate ? 'finally' : pending.value}`;
			})
	};
}

function raiseInExcept(rng: Rng): Program {
	const fn = rng.pick(['lookup', 'resolve', 'find_rate', 'get_price']);
	const table = new Map<number, number>();
	while (table.size < 3) table.set(rng.int(1, 40), rng.int(100, 999));
	const keys = [...table.keys()];
	const absent: number[] = [];
	while (absent.length < 2) {
		const v = rng.int(1, 40);
		if (!table.has(v) && !absent.includes(v)) absent.push(v);
	}
	const fallback = rng.int(1, 9);
	const bad = rng.sample(BAD_INPUTS, 1);
	const inputs = rng.shuffle([
		String(rng.pick(keys)),
		String(rng.pick(absent)),
		...bad,
		rng.pick([String(rng.pick(keys)), String(rng.pick(absent)), rng.pick(BAD_INPUTS)])
	]);
	return {
		lines: [
			`table = {${[...table].map(([k, v]) => `${k}: ${v}`).join(', ')}}`,
			'',
			`def ${fn}(raw):`,
			'    try:',
			'        return table[int(raw)]',
			'    except ValueError:',
			"        print('bad', raw)",
			'        raise KeyError(raw)',
			'    except KeyError:',
			"        print('missing', raw)",
			`        return ${fallback}`,
			'    finally:',
			"        print('done', raw)",
			'',
			`for raw in [${inputs.map((s) => `'${s}'`).join(', ')}]:`,
			'    try:',
			`        print('got', ${fn}(raw))`,
			'    except KeyError:',
			"        print('error', raw)"
		],
		run: (rules) => {
			const out: string[] = [];
			for (const raw of inputs) {
				const n = /^\d+$/.test(raw) ? Number(raw) : null;
				const inner: string[] = [];
				let result: string;
				if (n === null) {
					inner.push(`bad ${raw}`);
					if (rules.siblingHandler) {
						inner.push(`missing ${raw}`);
						result = `got ${fallback}`;
					} else result = `error ${raw}`;
				} else if (table.has(n)) result = `got ${table.get(n) ?? 0}`;
				else {
					inner.push(`missing ${raw}`);
					result = `got ${fallback}`;
				}
				const done = `done ${raw}`;
				out.push(...inner, ...(rules.finallyAfterCaller ? [result, done] : [done, result]));
			}
			return out;
		}
	};
}

type ChainKind = 'from' | 'implicit' | 'outside' | 'ok';

function chain(rng: Rng): Program {
	const [fetch, parse] = rng.pick([
		['fetch', 'parse'],
		['load', 'convert'],
		['get', 'decode'],
		['read', 'to_number']
	] as const);
	const data = new Map<string, number>();
	const words = rng.sample(WORDS, 5);
	for (const w of words.slice(0, 3)) data.set(w, rng.int(1, 9));
	const absent = words.slice(3) as [string, string];
	// fetch: `from` on a missing key; parse: implicit chaining on a bad string, a plain raise for a negative number.
	const fetchError = rng.pick(['LookupError', 'RuntimeError']);
	const parseError = rng.pick(['RuntimeError', 'TypeError']);
	const negativeError = rng.pick(['OverflowError', 'AssertionError']);
	type Call = { text: string; kind: ChainKind; error: string; inner: string };
	const calls: Call[] = rng.shuffle([
		{ text: `${fetch}('${absent[0]}')`, kind: 'from', error: fetchError, inner: 'KeyError' },
		{ text: `${parse}('${rng.pick(BAD_INPUTS)}')`, kind: 'implicit', error: parseError, inner: 'ValueError' },
		{ text: `${parse}('-${rng.int(1, 9)}')`, kind: 'outside', error: negativeError, inner: '' },
		rng.pick<Call>([
			{ text: `${fetch}('${absent[1]}')`, kind: 'from', error: fetchError, inner: 'KeyError' },
			{ text: `${fetch}('${rng.pick(words.slice(0, 3))}')`, kind: 'ok', error: '', inner: '' },
			{ text: `${parse}('${rng.int(10, 99)}')`, kind: 'ok', error: '', inner: '' }
		])
	]);
	return {
		lines: [
			'def name(e):',
			'    return type(e).__name__ if e is not None else None',
			'',
			`data = {${[...data].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
			'',
			`def ${fetch}(key):`,
			'    try:',
			'        return data[key]',
			'    except KeyError as exc:',
			`        raise ${fetchError}(key) from exc`,
			'',
			`def ${parse}(text):`,
			'    try:',
			'        n = int(text)',
			'    except ValueError:',
			`        raise ${parseError}(text)`,
			'    if n < 0:',
			`        raise ${negativeError}(n)`,
			'    return n',
			'',
			`for call in [${calls.map((c) => `lambda: ${c.text}`).join(', ')}]:`,
			'    try:',
			"        print('ok', call())",
			'    except Exception as e:',
			'        print(name(e), name(e.__cause__), name(e.__context__))'
		],
		run: (rules) =>
			calls.map((call) => {
				if (call.kind === 'ok') {
					const arg = /\('(.*)'\)$/.exec(call.text)?.[1] ?? '';
					return `ok ${data.get(arg) ?? Number(arg)}`;
				}
				if (call.kind === 'outside') return `${call.error} None None`;
				if (call.kind === 'from') return `${call.error} ${call.inner} ${rules.fromClearsContext ? 'None' : call.inner}`;
				return `${call.error} ${rules.causeImplicit ? call.inner : 'None'} ${call.inner}`;
			})
	};
}

function loopJump(rng: Rng): Program {
	const fn = rng.pick(['process', 'consume', 'drain', 'handle_all']);
	const limit = rng.int(40, 60);
	const small = () => rng.int(1, limit - 1);
	const negative = () => -rng.int(1, 9);
	// The first batch stops at a big value, the second runs to its end; both skip negatives.
	const first = rng.shuffle([small(), negative(), small()]);
	first.splice(rng.int(1, first.length), 0, rng.int(limit + 1, 99));
	first.push(small());
	const second = rng.shuffle([small(), negative(), small()]);
	return {
		lines: [
			`def ${fn}(items):`,
			'    for x in items:',
			'        try:',
			'            if x < 0:',
			"                print('skip', x)",
			'                continue',
			`            if x > ${limit}:`,
			"                print('stop', x)",
			'                break',
			"            print('item', x)",
			'        finally:',
			"            print('fin', x)",
			'    else:',
			"        print('all done')",
			"    print('end')",
			'',
			`${fn}([${first.join(', ')}])`,
			`${fn}([${second.join(', ')}])`
		],
		run: (rules) => {
			const out: string[] = [];
			for (const items of [first, second]) {
				let broke = false;
				for (const x of items) {
					if (x < 0) {
						out.push(`skip ${x}`);
						if (!rules.finallySkippedOnJump) out.push(`fin ${x}`);
						continue;
					}
					if (x > limit) {
						out.push(`stop ${x}`);
						if (!rules.finallySkippedOnJump) out.push(`fin ${x}`);
						broke = true;
						break;
					}
					out.push(`item ${x}`, `fin ${x}`);
				}
				if (!broke || rules.loopElseAlways) out.push('all done');
				out.push('end');
			}
			return out;
		}
	};
}

function finallyRaise(rng: Rng): Program {
	const fn = rng.pick(['run', 'apply', 'commit', 'execute']);
	const [p, q] = rng.sample([2, 3, 5], 2) as [number, number];
	const pool = Array.from({ length: 40 }, (_, i) => i + 1);
	const pick = (pred: (n: number) => boolean) => rng.pick(pool.filter(pred));
	const ns = rng.shuffle([
		pick((n) => n % p === 0 && n % q === 0),
		pick((n) => n % p !== 0 && n % q === 0),
		pick((n) => n % p === 0 && n % q !== 0),
		pick((n) => n % p !== 0 && n % q !== 0)
	]);
	return {
		lines: [
			'def name(e):',
			'    return type(e).__name__ if e is not None else None',
			'',
			`def ${fn}(n):`,
			'    try:',
			`        if n % ${p} == 0:`,
			'            raise ValueError(n)',
			'        return n * 10',
			'    finally:',
			`        if n % ${q} == 0:`,
			'            raise KeyError(n)',
			'',
			`for n in [${ns.join(', ')}]:`,
			'    try:',
			`        print('ok', ${fn}(n))`,
			'    except ValueError as e:',
			"        print('value', n, name(e.__context__))",
			'    except KeyError as e:',
			"        print('key', n, name(e.__context__))"
		],
		run: (rules) =>
			ns.map((n) => {
				const fails = n % p === 0;
				const finallyRaises = n % q === 0;
				if (finallyRaises && !rules.firstExceptionWins)
					return `key ${n} ${fails && !rules.contextLost ? 'ValueError' : 'None'}`;
				return fails ? `value ${n} None` : `ok ${n * 10}`;
			})
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/handler-order': handlerOrder,
	'intern/return-else': returnElse,
	'intern/reraise': reraise,
	'junior/finally-return': finallyReturn,
	'junior/raise-in-except': raiseInExcept,
	'junior/chain': chain,
	'intern/loop-jump': loopJump,
	'junior/finally-raise': finallyRaise
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 200; tries += 1) {
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
			statement: {
				markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
				code: { language: 'python3', source }
			},
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
