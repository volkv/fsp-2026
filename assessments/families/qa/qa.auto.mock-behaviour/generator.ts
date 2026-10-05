// Test doubles of unittest.mock: what a Mock returns when it is configured with return_value, a list or a function
// as side_effect, what it records about its calls and what it creates on its own. The shown program configures a
// mock, calls it and prints; the candidate writes what it prints.
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
	returnValueWins: boolean;
	returnValueAfterExhaust: boolean;
	sideEffectCycles: boolean;
	exceptionReturned: boolean;
	raisingCallNotCounted: boolean;
	defaultAsIs: boolean;
	childCounted: boolean;
	callArgsFirst: boolean;
	resetClearsConfig: boolean;
	freshReturnEachCall: boolean;
	mockHasMagic: boolean;
	magicFalsy: boolean;
}

const RIGHT: Rules = {
	returnValueWins: false,
	returnValueAfterExhaust: false,
	sideEffectCycles: false,
	exceptionReturned: false,
	raisingCallNotCounted: false,
	defaultAsIs: false,
	childCounted: false,
	callArgsFirst: false,
	resetClearsConfig: false,
	freshReturnEachCall: false,
	mockHasMagic: false,
	magicFalsy: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'return-value-wins': { returnValueWins: true },
	'return-value-after-exhaust': { returnValueAfterExhaust: true },
	'side-effect-cycles': { sideEffectCycles: true },
	'exception-returned': { exceptionReturned: true },
	'raising-call-not-counted': { raisingCallNotCounted: true },
	'default-as-is': { defaultAsIs: true },
	'child-counted': { childCounted: true },
	'call-args-first': { callArgsFirst: true },
	'reset-clears-config': { resetClearsConfig: true },
	'fresh-return-each-call': { freshReturnEachCall: true },
	'mock-has-magic': { mockHasMagic: true },
	'magic-falsy': { magicFalsy: true }
};

const REQUIRED: Record<string, string[]> = {
	'side-effect-list': [
		'return-value-wins',
		'return-value-after-exhaust',
		'side-effect-cycles',
		'exception-returned',
		'raising-call-not-counted'
	],
	'side-effect-function': ['return-value-wins', 'default-as-is', 'raising-call-not-counted'],
	'call-records': ['child-counted', 'call-args-first', 'reset-clears-config'],
	'auto-attributes': ['fresh-return-each-call', 'mock-has-magic', 'magic-falsy']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const EXCEPTIONS = ['TimeoutError', 'ConnectionError', 'ValueError', 'RuntimeError', 'PermissionError'] as const;
const MESSAGES = ['slow', 'refused', 'broken', 'denied', 'busy', 'offline'] as const;
const ITEMS = ['tea', 'jam', 'pie', 'soup', 'rice', 'milk', 'bread', 'corn', 'salt', 'cake'] as const;
const ENTITIES = ['users', 'orders', 'items', 'tickets', 'invoices'] as const;

function sideEffectList(rng: Rng): Program {
	const [fn, arg] = rng.pick([
		['charge', 'amount'],
		['fetch', 'page'],
		['send', 'batch'],
		['reserve', 'qty']
	] as const);
	const fallback = rng.int(100, 999);
	const values = Array.from({ length: rng.int(2, 3) }, () => rng.int(1, 99));
	const exception = { name: rng.pick(EXCEPTIONS), message: rng.pick(MESSAGES) };
	type Item = { value: number } | { error: string; message: string };
	const items: Item[] = values.map((value) => ({ value }));
	items.splice(rng.int(0, items.length - 1), 0, { error: exception.name, message: exception.message });
	const calls = items.length + rng.int(1, 2);
	const args = Array.from({ length: calls }, () => rng.int(1, 50));
	const literal = (item: Item) => ('value' in item ? String(item.value) : `${item.error}('${item.message}')`);
	return {
		lines: [
			'from unittest.mock import Mock',
			'',
			`${fn} = Mock(return_value=${fallback})`,
			`${fn}.side_effect = [${items.map(literal).join(', ')}]`,
			'',
			`for ${arg} in [${args.join(', ')}]:`,
			'    try:',
			`        print('ok', ${fn}(${arg}))`,
			'    except Exception as e:',
			"        print('error', type(e).__name__)",
			`print('calls', ${fn}.call_count)`
		],
		run: (rules) => {
			const out: string[] = [];
			let raised = 0;
			for (let i = 0; i < calls; i += 1) {
				if (rules.returnValueWins) {
					out.push(`ok ${fallback}`);
					continue;
				}
				let item: Item | undefined = items[i];
				if (item === undefined) {
					if (rules.returnValueAfterExhaust) {
						out.push(`ok ${fallback}`);
						continue;
					}
					if (rules.sideEffectCycles) item = items[i % items.length];
				}
				if (item === undefined) {
					out.push('error StopIteration');
					raised += 1;
				} else if ('value' in item) out.push(`ok ${item.value}`);
				else if (rules.exceptionReturned) out.push(`ok ${item.message}`);
				else {
					out.push(`error ${item.error}`);
					raised += 1;
				}
			}
			out.push(`calls ${calls - (rules.raisingCallNotCounted ? raised : 0)}`);
			return out;
		}
	};
}

function sideEffectFunction(rng: Rng): Program {
	const [k1, k2, missing, u1, u2] = rng.sample(ITEMS, 5) as [string, string, string, string, string];
	const known = [k1, k2];
	const unknowns = [u1, u2];
	const prices = new Map(known.map((k) => [k, rng.int(10, 99) * 10]));
	const fallback = rng.int(1, 9);
	const queries = rng.shuffle([...known, missing, ...unknowns.slice(0, 1), rng.pick([...known, ...unknowns])]);
	return {
		lines: [
			'from unittest.mock import DEFAULT, Mock',
			'',
			`PRICES = {${[...prices].map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
			'',
			'',
			'def fake_price(item):',
			'    if item in PRICES:',
			'        return PRICES[item]',
			`    if item == '${missing}':`,
			'        raise LookupError(item)',
			'    return DEFAULT',
			'',
			'',
			`price = Mock(return_value=${fallback})`,
			'price.side_effect = fake_price',
			`for item in [${queries.map((q) => `'${q}'`).join(', ')}]:`,
			'    try:',
			'        print(item, price(item))',
			'    except LookupError:',
			"        print(item, 'missing')",
			"print('calls', price.call_count)"
		],
		run: (rules) => {
			const out: string[] = [];
			let raised = 0;
			for (const q of queries) {
				if (rules.returnValueWins) out.push(`${q} ${fallback}`);
				else if (prices.has(q)) out.push(`${q} ${prices.get(q) ?? 0}`);
				else if (q === missing) {
					out.push(`${q} missing`);
					raised += 1;
				} else out.push(`${q} ${rules.defaultAsIs ? 'sentinel.DEFAULT' : fallback}`);
			}
			out.push(`calls ${queries.length - (rules.raisingCallNotCounted ? raised : 0)}`);
			return out;
		}
	};
}

function callRecords(rng: Rng): Program {
	const [svc, method, other] = rng.pick([
		['notifier', 'send', 'flush'],
		['mailer', 'deliver', 'close'],
		['client', 'post', 'ping'],
		['storage', 'save', 'sync']
	] as const);
	const people = rng.sample(PERSON_NAMES, 4);
	type Call = { code: string; target: 'method' | 'other' | 'self'; repr: string };
	const methodCall = (person: string): Call => {
		const n = rng.int(1, 9);
		const keyword = rng.bool();
		const args = keyword ? `'${person}', priority=${n}` : `'${person}', ${n}`;
		return { code: `${svc}.${method}(${args})`, target: 'method', repr: `call(${args})` };
	};
	const calls: Call[] = rng.shuffle([
		methodCall(people[0] ?? 'anna'),
		methodCall(people[1] ?? 'boris'),
		...(rng.bool() ? [methodCall(people[2] ?? 'vera')] : []),
		{ code: `${svc}.${other}()`, target: 'other', repr: 'call()' },
		...(rng.bool() ? [{ code: `${svc}('${people[3] ?? 'gleb'}')`, target: 'self' as const, repr: '' }] : [])
	]);
	const mine = calls.filter((c) => c.target === 'method');
	const after = people[3] ?? 'gleb';
	return {
		lines: [
			'from unittest.mock import Mock',
			'',
			`${svc} = Mock()`,
			`${svc}.${method}.return_value = True`,
			...calls.map((c) => c.code),
			'',
			`print(${svc}.call_count, ${svc}.${method}.call_count, len(${svc}.mock_calls))`,
			`print(${svc}.${method}.call_args)`,
			`${svc}.reset_mock()`,
			`print(${svc}.${method}.call_count, ${svc}.${method}('${after}') is True)`
		],
		run: (rules) => {
			const own = calls.filter((c) => c.target === 'self').length;
			const parent = rules.childCounted ? calls.length : own;
			const args = rules.callArgsFirst ? mine[0] : mine[mine.length - 1];
			return [
				`${parent} ${mine.length} ${calls.length}`,
				args?.repr ?? '',
				`0 ${rules.resetClearsConfig ? 'False' : 'True'}`
			];
		}
	};
}

function autoAttributes(rng: Rng): Program {
	const entity = rng.pick(ENTITIES);
	const status = rng.pick([200, 201, 202, 204, 400, 404, 409, 500, 503]);
	const id = rng.int(10, 99);
	const total = rng.int(100, 999);
	const [k1, k2] = rng.sample(
		Array.from({ length: 40 }, (_, i) => i + 1),
		2
	) as [number, number];
	const [client, cart] = rng.pick([
		['client', 'cart'],
		['api', 'basket'],
		['session', 'queue'],
		['http', 'bucket']
	] as const);
	const checks: Program[] = rng.shuffle([
		{
			lines: ['print(first is second, second.status_code)'],
			run: (rules: Rules) => [`${rules.freshReturnEachCall ? 'False' : 'True'} ${status}`]
		},
		{
			lines: [`print(first.json()['total'], ${client}.get.call_count, ${client}.get.call_args)`],
			run: () => [`${total} 2 call('/${entity}/${k2}')`]
		},
		{
			lines: [`print(len(${cart}), 'empty' if not ${cart} else 'not empty')`],
			run: (rules: Rules) => [`0 ${rules.magicFalsy ? 'empty' : 'not empty'}`]
		},
		{
			lines: [
				`for probe in (${cart}, ${client}):`,
				'    try:',
				"        print('len', len(probe))",
				'    except TypeError:',
				"        print('no len')"
			],
			run: (rules: Rules) => ['len 0', rules.mockHasMagic ? 'len 0' : 'no len']
		}
	]);
	return {
		lines: [
			'from unittest.mock import MagicMock, Mock',
			'',
			`${client} = Mock()`,
			`${client}.get.return_value.status_code = ${status}`,
			`${client}.get.return_value.json.return_value = {'id': ${id}, 'total': ${total}}`,
			`${cart} = MagicMock()`,
			'',
			`first = ${client}.get('/${entity}/${k1}')`,
			`second = ${client}.get('/${entity}/${k2}')`,
			...checks.flatMap((c) => c.lines)
		],
		run: (rules) => checks.flatMap((c) => c.run(rules))
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'side-effect-list': sideEffectList,
	'side-effect-function': sideEffectFunction,
	'call-records': callRecords,
	'auto-attributes': autoAttributes
};

const STATEMENT = [
	'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране: каждая напечатанная',
	'строка — отдельной строкой ответа, значения через один пробел, например `ok 42` или `call(1, 2)`.'
].join('\n');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for ${input.classId}`);
	const required = REQUIRED[input.classId] ?? [];
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
	throw new Error(`${descriptor.key}: no program for ${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
