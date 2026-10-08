// unittest.mock.patch replaces a name where it is looked up. The shown program builds small modules in sys.modules
// (types.ModuleType), patches names in them in several ways and prints what the code under test sees; it removes
// its modules when it ends. The candidate writes what it prints.
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
	sourceEverywhere: boolean;
	importerOnly: boolean;
	missingCreated: boolean;
	persists: boolean;
	topDownArgs: boolean;
	existingUnaffected: boolean;
	instanceAffectsClass: boolean;
	plainChecksSignature: boolean;
	autospecIgnoresSignature: boolean;
	rejectedCounted: boolean;
	reachesCaptured: boolean;
	dictReplaced: boolean;
	dictKeepsAdded: boolean;
	clearIgnored: boolean;
	capturedFollows: boolean;
	coversSetup: boolean;
	sharedMock: boolean;
}

const RIGHT: Rules = {
	sourceEverywhere: false,
	importerOnly: false,
	missingCreated: false,
	persists: false,
	topDownArgs: false,
	existingUnaffected: false,
	instanceAffectsClass: false,
	plainChecksSignature: false,
	autospecIgnoresSignature: false,
	rejectedCounted: false,
	reachesCaptured: false,
	dictReplaced: false,
	dictKeepsAdded: false,
	clearIgnored: false,
	capturedFollows: false,
	coversSetup: false,
	sharedMock: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'patch-source-everywhere': { sourceEverywhere: true },
	'patch-importer-only': { importerOnly: true },
	'missing-attribute-created': { missingCreated: true },
	'patch-persists': { persists: true },
	'top-down-args': { topDownArgs: true },
	'existing-instances-unaffected': { existingUnaffected: true },
	'instance-patch-affects-class': { instanceAffectsClass: true },
	'plain-mock-checks-signature': { plainChecksSignature: true },
	'autospec-ignores-signature': { autospecIgnoresSignature: true },
	'rejected-call-counted': { rejectedCounted: true },
	'patch-reaches-captured': { reachesCaptured: true },
	'dict-replaced': { dictReplaced: true },
	'dict-keeps-added': { dictKeepsAdded: true },
	'clear-ignored': { clearIgnored: true },
	'captured-constant-follows': { capturedFollows: true },
	'class-patch-covers-setup': { coversSetup: true },
	'class-patch-shared-mock': { sharedMock: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/from-import': ['patch-source-everywhere', 'patch-persists'],
	'middle/module-attribute': ['patch-importer-only', 'missing-attribute-created'],
	'middle/decorator-order': ['top-down-args', 'patch-persists'],
	'middle/patch-object': ['existing-instances-unaffected', 'instance-patch-affects-class', 'patch-persists'],
	'senior/autospec': ['plain-mock-checks-signature', 'autospec-ignores-signature', 'rejected-call-counted'],
	'senior/captured-reference': ['patch-source-everywhere', 'patch-reaches-captured'],
	'senior/patch-dict': ['dict-replaced', 'dict-keeps-added', 'clear-ignored', 'captured-constant-follows'],
	'senior/class-decorator': ['class-patch-covers-setup', 'class-patch-shared-mock', 'patch-persists']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const PREFIXES = ['shop', 'crm', 'pay', 'geo', 'ads', 'erp', 'cms', 'hr'] as const;
const WORDS = ['total', 'refund', 'invoice', 'quote', 'export', 'limit', 'report', 'payout', 'tariff', 'basket'];

interface Module {
	/** The variable the program binds the module to and the constant holding its source. */
	variable: string;
	name: string;
	source: string[];
}

/** A program that builds modules from sources, runs the body and removes the modules in any case. */
function withModules(modules: Module[], body: string[], imports: string[] = []): string[] {
	const indent = (lines: string[]) => lines.map((l) => (l === '' ? '' : `    ${l}`));
	return [
		...[...imports, 'import sys', 'import types'].sort(),
		'from unittest import mock',
		'',
		...modules.flatMap((m) => [`${m.variable.toUpperCase()} = '''`, ...m.source, "'''", '']),
		'',
		'def make_module(name, source):',
		'    module = types.ModuleType(name)',
		'    exec(source, module.__dict__)',
		'    sys.modules[name] = module',
		'    return module',
		'',
		'',
		'try:',
		...indent([
			...modules.map((m) => `${m.variable} = make_module('${m.name}', ${m.variable.toUpperCase()})`),
			...body
		]),
		'finally:',
		`    for name in (${modules.map((m) => `'${m.name}'`).join(', ')}):`,
		'        sys.modules.pop(name, None)'
	];
}

/** The rate module: one function returning a fixed rate. */
function ratesModule(p: string, rate: number): Module {
	return { variable: 'rates', name: `${p}_rates`, source: ['def get_rate(currency):', `    return ${rate}`] };
}

/** Patch blocks over the rate and billing modules: which binding each target replaces under the rules. */
type Binding = 'rates' | 'billing' | 'billing-view' | 'missing';

interface PatchProbe {
	target: string;
	value: number;
	lines: string[];
	print: (val: (b: Binding) => number) => string;
}

/** Runs patch blocks one after another; a binding without a patch has the real rate. */
function runPatches(
	probes: PatchProbe[],
	resolve: (target: string, rules: Rules) => Binding[] | 'AttributeError',
	rate: number,
	after: (val: (b: Binding) => number) => string,
	rules: Rules
): string[] {
	const persisted = new Map<Binding, number>();
	const out: string[] = [];
	for (const probe of probes) {
		const bindings = resolve(probe.target, rules);
		if (bindings === 'AttributeError') {
			out.push('AttributeError');
			continue;
		}
		const active = new Map(persisted);
		for (const b of bindings) active.set(b, probe.value);
		out.push(probe.print((b) => active.get(b) ?? rate));
		if (rules.persists) for (const b of bindings) persisted.set(b, probe.value);
	}
	out.push(after((b) => persisted.get(b) ?? rate));
	return out;
}

function distinctValues(rng: Rng, count: number, min: number, max: number): number[] {
	return rng.sample(
		Array.from({ length: max - min + 1 }, (_, i) => min + i),
		count
	);
}

function fromImport(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [rate, v1, v2, v3] = distinctValues(rng, 4, 2, 99) as [number, number, number, number];
	const [a1, a2, a3, a4] = distinctValues(rng, 4, 2, 9) as [number, number, number, number];
	const fn = rng.pick(WORDS);
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [`from ${p}_rates import get_rate`, '', '', `def ${fn}(amount):`, "    return amount * get_rate('usd')"]
	};
	const block = (target: string, value: number, label: string, a: number, direct: boolean): PatchProbe => ({
		target,
		value,
		lines: [
			`with mock.patch('${target}', return_value=${value}):`,
			direct
				? `    print('${label}', rates.get_rate('usd'), billing.${fn}(${a}))`
				: `    print('${label}', billing.${fn}(${a}))`
		],
		print: (val) => (direct ? `${label} ${val('rates')} ${a * val('billing')}` : `${label} ${a * val('billing')}`)
	});
	const probes = rng.shuffle([
		block(`${p}_rates.get_rate`, v1, 'rates', a1, rng.bool()),
		block(`${p}_billing.get_rate`, v2, 'billing', a2, false),
		...(rng.bool() ? [block(`${p}_rates.get_rate`, v3, 'again', a3, true)] : [])
	]);
	const resolve = (target: string, rules: Rules): Binding[] =>
		target.endsWith('_rates.get_rate')
			? ['rates', ...(rules.sourceEverywhere ? (['billing'] as const) : [])]
			: ['billing'];
	return {
		lines: withModules(
			[ratesModule(p, rate), billing],
			[...probes.flatMap((pr) => pr.lines), `print('after', billing.${fn}(${a4}))`]
		),
		run: (rules) => runPatches(probes, resolve, rate, (val) => `after ${a4 * val('billing')}`, rules)
	};
}

function moduleAttribute(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [rate, v1, v2, v3] = distinctValues(rng, 4, 2, 99) as [number, number, number, number];
	const [a1, a2, a3, a4] = distinctValues(rng, 4, 2, 9) as [number, number, number, number];
	const fn = rng.pick(WORDS);
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [`import ${p}_rates`, '', '', `def ${fn}(amount):`, `    return amount * ${p}_rates.get_rate('usd')`]
	};
	const block = (target: string, value: number, label: string, a: number, direct: boolean): PatchProbe => {
		const print = direct
			? `print('${label}', rates.get_rate('usd'), billing.${fn}(${a}))`
			: `print('${label}', billing.${fn}(${a}))`;
		const guarded = target.endsWith('_billing.get_rate');
		const withLines = [`with mock.patch('${target}', return_value=${value}):`, `    ${print}`];
		return {
			target,
			value,
			lines: guarded
				? ['try:', ...withLines.map((l) => `    ${l}`), 'except AttributeError:', "    print('AttributeError')"]
				: withLines,
			print: (val) =>
				direct ? `${label} ${val('rates')} ${a * val('billing-view')}` : `${label} ${a * val('billing-view')}`
		};
	};
	const probes = rng.shuffle([
		block(`${p}_rates.get_rate`, v1, 'rates', a1, rng.bool()),
		block(`${p}_billing.get_rate`, v2, 'billing', a2, false),
		block(`${p}_billing.${p}_rates.get_rate`, v3, 'nested', a3, rng.bool())
	]);
	const resolve = (target: string, rules: Rules): Binding[] | 'AttributeError' => {
		if (target.endsWith('_billing.get_rate')) return rules.missingCreated ? ['missing'] : 'AttributeError';
		if (target.startsWith(`${p}_billing.`)) return rules.importerOnly ? ['billing-view'] : ['rates', 'billing-view'];
		return rules.importerOnly ? ['rates'] : ['rates', 'billing-view'];
	};
	return {
		lines: withModules(
			[ratesModule(p, rate), billing],
			[...probes.flatMap((pr) => pr.lines), `print('after', billing.${fn}(${a4}))`]
		),
		run: (rules) => runPatches(probes, resolve, rate, (val) => `after ${a4 * val('billing-view')}`, rules)
	};
}

function decoratorOrder(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [rate, tax, x, y] = distinctValues(rng, 4, 2, 60) as [number, number, number, number];
	const a = rng.int(2, 9);
	const fn = rng.pick(WORDS);
	const taxModule: Module = {
		variable: 'tax',
		name: `${p}_tax`,
		source: ['def tax_rate(region):', `    return ${tax}`]
	};
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [
			`import ${p}_rates`,
			`import ${p}_tax`,
			'',
			'',
			`def ${fn}(amount):`,
			`    return amount * ${p}_rates.get_rate('usd') + ${p}_tax.tax_rate('msk')`
		]
	};
	// Decorators from the top; the first argument gets the mock of the bottom one.
	const rateOnTop = rng.bool();
	const decorators = rateOnTop
		? [`@mock.patch('${p}_rates.get_rate')`, `@mock.patch('${p}_tax.tax_rate')`]
		: [`@mock.patch('${p}_tax.tax_rate')`, `@mock.patch('${p}_rates.get_rate')`];
	const checker = rng.pick(['check', 'probe', 'verify', 'scenario']);
	return {
		lines: withModules(
			[ratesModule(p, rate), taxModule, billing],
			[
				'',
				...decorators,
				`def ${checker}(first, second):`,
				`    first.return_value = ${x}`,
				`    second.return_value = ${y}`,
				`    print('inside', billing.${fn}(${a}))`,
				'    print(first.call_args, second.call_count)',
				'',
				'',
				`${checker}()`,
				`print('after', billing.${fn}(${a}))`
			]
		),
		run: (rules) => {
			// Is the first argument the mock of get_rate?
			const firstIsRate = rules.topDownArgs ? rateOnTop : !rateOnTop;
			const [r, t] = firstIsRate ? [x, y] : [y, x];
			const after = rules.persists ? a * r + t : a * rate + tax;
			return [`inside ${a * r + t}`, `${firstIsRate ? "call('usd')" : "call('msk')"} 1`, `after ${after}`];
		}
	};
}

function patchObject(rng: Rng): Program {
	const [cls, method] = rng.pick([
		['Courier', 'fee'],
		['Tariff', 'price'],
		['Account', 'limit'],
		['Printer', 'cost']
	] as const);
	const base = rng.int(3, 12);
	const [z1, z2, z3] = distinctValues(rng, 3, 2, 9) as [number, number, number];
	const [v1, v2] = distinctValues(rng, 2, 100, 999) as [number, number];
	const classFirst = rng.bool();
	const classBlock = [
		`with mock.patch.object(${cls}, '${method}', return_value=${v1}):`,
		`    second = ${cls}(${z2})`,
		`    print('class', first.${method}(), second.${method}())`
	];
	const instanceBlock = [
		`with mock.patch.object(first, '${method}', return_value=${v2}):`,
		`    print('instance', first.${method}(), ${cls}(${z3}).${method}())`
	];
	return {
		lines: [
			'from unittest import mock',
			'',
			'',
			`class ${cls}:`,
			'    def __init__(self, zone):',
			'        self.zone = zone',
			'',
			`    def ${method}(self):`,
			`        return ${base} * self.zone`,
			'',
			'',
			`first = ${cls}(${z1})`,
			...(classFirst ? [...classBlock, ...instanceBlock] : [...instanceBlock, ...classBlock]),
			`print('after', first.${method}())`
		],
		run: (rules) => {
			let classPatched = false;
			let instancePatched = false;
			const out: string[] = [];
			// The method of an instance: its own patch first, then the class patch.
			const call = (isFirst: boolean, zone: number, createdInBlock: boolean): number => {
				if (instancePatched && (isFirst || rules.instanceAffectsClass)) return v2;
				if (classPatched && (createdInBlock || !rules.existingUnaffected)) return v1;
				return base * zone;
			};
			for (const block of classFirst ? ['class', 'instance'] : ['instance', 'class']) {
				if (block === 'class') {
					classPatched = true;
					out.push(`class ${call(true, z1, false)} ${call(false, z2, true)}`);
					classPatched = rules.persists;
				} else {
					instancePatched = true;
					out.push(`instance ${call(true, z1, false)} ${call(false, z3, false)}`);
					instancePatched = rules.persists;
				}
			}
			out.push(`after ${call(true, z1, false)}`);
			return out;
		}
	};
}

function autospec(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const rate = rng.int(2, 9);
	const value = rng.int(10, 99);
	const a = rng.int(2, 9);
	// Operations of the billing module: one calls the rate function right, the others with a wrong signature.
	const kinds = rng.shuffle([
		{ name: 'charge', call: `${p}_rates.convert(amount, 'usd')`, ok: true, sign: '' },
		rng.pick([
			{ name: 'refund', call: `${p}_rates.convert(amount)`, ok: false, sign: '-' },
			{ name: 'refund', call: `${p}_rates.convert(amount, currancy='usd')`, ok: false, sign: '-' }
		]),
		...(rng.bool() ? [{ name: 'fee', call: `${p}_rates.convert(amount, 'usd', 2)`, ok: false, sign: '' }] : [])
	]);
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [
			`import ${p}_rates`,
			...kinds.flatMap((k) => ['', '', `def ${k.name}(amount):`, `    return ${k.sign}${k.call}`])
		]
	};
	const rates: Module = {
		variable: 'rates',
		name: `${p}_rates`,
		source: ['def convert(amount, currency):', `    return amount * ${rate}`]
	};
	const order = rng.bool() ? [false, true] : [true, false];
	return {
		lines: withModules(
			[rates, billing],
			[
				`for strict in (${order.map((s) => (s ? 'True' : 'False')).join(', ')}):`,
				`    with mock.patch('${p}_rates.convert', autospec=strict, return_value=${value}) as fake:`,
				`        for operation in (${kinds.map((k) => `billing.${k.name}`).join(', ')}):`,
				'            try:',
				`                print(strict, operation.__name__, operation(${a}))`,
				'            except TypeError:',
				"                print(strict, operation.__name__, 'TypeError')",
				"        print(strict, 'calls', fake.call_count)"
			]
		),
		run: (rules) =>
			order.flatMap((strict) => {
				const label = strict ? 'True' : 'False';
				let calls = 0;
				const lines = kinds.map((k) => {
					const rejected = !k.ok && (strict ? !rules.autospecIgnoresSignature : rules.plainChecksSignature);
					if (!rejected || rules.rejectedCounted) calls += 1;
					return `${label} ${k.name} ${rejected ? 'TypeError' : `${k.sign}${value}`}`;
				});
				return [...lines, `${label} calls ${calls}`];
			})
	};
}

type Capture = 'name' | 'module' | 'alias' | 'registry' | 'default';

function capturedReference(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [rate, v1, v2] = distinctValues(rng, 3, 2, 99) as [number, number, number];
	const a = rng.int(2, 9);
	const captured = rng.sample<Capture>(['alias', 'registry', 'default'], rng.int(2, 3));
	const mechanisms = rng.shuffle<Capture>(['name', 'module', ...captured]);
	const names = rng.sample(WORDS, mechanisms.length);
	const body: Record<Capture, (fn: string) => string[]> = {
		name: (fn) => [`def ${fn}(amount):`, "    return amount * get_rate('usd')"],
		module: (fn) => [`def ${fn}(amount):`, `    return amount * ${p}_rates.get_rate('usd')`],
		alias: (fn) => [`def ${fn}(amount):`, "    return amount * RATE('usd')"],
		registry: (fn) => [`def ${fn}(amount):`, "    return amount * HANDLERS['usd']('usd')"],
		default: (fn) => [`def ${fn}(amount, rate=get_rate):`, "    return amount * rate('usd')"]
	};
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [
			`import ${p}_rates`,
			`from ${p}_rates import get_rate`,
			...(captured.includes('alias') ? ['', `RATE = ${p}_rates.get_rate`] : []),
			...(captured.includes('registry') ? ['', "HANDLERS = {'usd': get_rate}"] : []),
			...mechanisms.flatMap((m, i) => ['', '', ...body[m](names[i] ?? 'total')])
		]
	};
	const calls = mechanisms.map((_, i) => `billing.${names[i] ?? 'total'}(${a})`).join(', ');
	const blocks = rng.shuffle([
		{ target: `${p}_rates.get_rate`, value: v1, label: 'rates' },
		{ target: `${p}_billing.get_rate`, value: v2, label: 'billing' }
	]);
	return {
		lines: withModules(
			[ratesModule(p, rate), billing],
			blocks.flatMap((b) => [
				`with mock.patch('${b.target}', return_value=${b.value}):`,
				`    print('${b.label}', ${calls})`
			])
		),
		run: (rules) =>
			blocks.map((b) => {
				const affected = (m: Capture): boolean => {
					if (b.label === 'rates') {
						if (rules.sourceEverywhere) return true;
						return m === 'module' || (rules.reachesCaptured && m === 'alias');
					}
					return m === 'name' || (rules.reachesCaptured && (m === 'registry' || m === 'default'));
				};
				return [b.label, ...mechanisms.map((m) => String(a * (affected(m) ? b.value : rate)))].join(' ');
			})
	};
}

function patchDict(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [limit, v1, v2] = distinctValues(rng, 3, 5, 99) as [number, number, number];
	const extra = rng.pick(['debug', 'retries', 'region', 'trace']);
	const extraValue = rng.int(1, 9);
	const keys = ['limit', 'mode', ...(rng.bool() ? ['currency'] : [])];
	const mode = rng.pick(['live', 'sandbox', 'batch']);
	const settings = keys.map((k) =>
		k === 'limit' ? `'limit': ${limit}` : k === 'mode' ? `'mode': '${mode}'` : "'currency': 'RUB'"
	);
	const config: Module = {
		variable: 'config',
		name: `${p}_config`,
		source: [`SETTINGS = {${settings.join(', ')}}`, "LIMIT = SETTINGS['limit']"]
	};
	const service: Module = {
		variable: 'service',
		name: `${p}_service`,
		source: [
			`import ${p}_config`,
			`from ${p}_config import SETTINGS`,
			'',
			'',
			'def limit():',
			"    return SETTINGS['limit']",
			'',
			'',
			'def mode():',
			"    return SETTINGS.get('mode', 'off')",
			'',
			'',
			'def startup_limit():',
			`    return ${p}_config.LIMIT`
		]
	};
	const sorted = (xs: string[]) =>
		`[${[...xs]
			.sort()
			.map((k) => `'${k}'`)
			.join(', ')}]`;
	return {
		lines: withModules(
			[config, service],
			[
				`with mock.patch.dict('${p}_config.SETTINGS', {'limit': ${v1}, '${extra}': ${extraValue}}):`,
				"    print('patched', service.limit(), service.startup_limit(), sorted(service.SETTINGS))",
				"print('restored', service.limit(), sorted(service.SETTINGS))",
				`with mock.patch.dict('${p}_config.SETTINGS', {'limit': ${v2}}, clear=True):`,
				"    print('cleared', service.limit(), service.mode(), sorted(service.SETTINGS))",
				"print('restored', service.mode(), sorted(service.SETTINGS))"
			]
		),
		run: (rules) => {
			// The dictionary the service sees: the original object, changed in place.
			let current = new Map<string, string>(
				keys.map((k) => [k, k === 'limit' ? String(limit) : k === 'mode' ? mode : 'RUB'])
			);
			const view = () =>
				rules.dictReplaced
					? new Map(keys.map((k) => [k, k === 'limit' ? String(limit) : k === 'mode' ? mode : 'RUB']))
					: current;
			const out: string[] = [];
			let before = new Map(current);
			current.set('limit', String(v1));
			current.set(extra, String(extraValue));
			out.push(
				`patched ${view().get('limit') ?? ''} ${rules.capturedFollows ? v1 : limit} ${sorted([...view().keys()])}`
			);
			current = rules.dictKeepsAdded ? new Map([...before, [extra, String(extraValue)]]) : before;
			out.push(`restored ${view().get('limit') ?? ''} ${sorted([...view().keys()])}`);
			before = new Map(current);
			if (!rules.clearIgnored) current.clear();
			current.set('limit', String(v2));
			out.push(`cleared ${view().get('limit') ?? ''} ${view().get('mode') ?? 'off'} ${sorted([...view().keys()])}`);
			current = before;
			out.push(`restored ${view().get('mode') ?? 'off'} ${sorted([...view().keys()])}`);
			return out;
		}
	};
}

function classDecorator(rng: Rng): Program {
	const p = rng.pick(PREFIXES);
	const [rate, value] = distinctValues(rng, 2, 2, 60) as [number, number];
	const fn = rng.pick(WORDS);
	const billing: Module = {
		variable: 'billing',
		name: `${p}_billing`,
		source: [`import ${p}_rates`, '', '', `def ${fn}(amount):`, `    return amount * ${p}_rates.get_rate('usd')`]
	};
	const tests = rng.sample(['cart', 'coupon', 'invoice', 'payment', 'refund', 'report'], rng.int(2, 3)).map((w) => {
		const amounts = Array.from({ length: rng.int(1, 3) }, () => rng.int(2, 9));
		return { name: `test_${w}`, word: w, amounts };
	});
	const after = rng.int(2, 9);
	const indent = (lines: string[]) => lines.map((l) => (l === '' ? '' : `    ${l}`));
	const classLines = [
		`@mock.patch('${p}_rates.get_rate', return_value=${value})`,
		'class TestBilling(unittest.TestCase):',
		...indent([
			'def setUp(self):',
			`    self.base = billing.${fn}(1)`,
			...tests.flatMap((t) => [
				'',
				`def ${t.name}(self, rate):`,
				...t.amounts.slice(0, -1).map((x) => `    billing.${fn}(${x})`),
				`    print('${t.word}', self.base, billing.${fn}(${t.amounts[t.amounts.length - 1] ?? 1}), rate.call_count)`
			])
		])
	];
	return {
		lines: withModules(
			[ratesModule(p, rate), billing],
			[
				'',
				...classLines,
				'',
				'',
				'suite = unittest.defaultTestLoader.loadTestsFromTestCase(TestBilling)',
				'unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)',
				`print('after', billing.${fn}(${after}))`
			],
			['import io', 'import unittest']
		),
		run: (rules) => {
			const ordered = [...tests].sort((x, y) => (x.name < y.name ? -1 : 1));
			let shared = 0;
			const out = ordered.map((t) => {
				const base = rules.coversSetup ? value : rate;
				let count = rules.coversSetup ? 1 : 0;
				count += t.amounts.length;
				shared += count;
				const last = t.amounts[t.amounts.length - 1] ?? 1;
				return `${t.word} ${base} ${last * value} ${rules.sharedMock ? shared : count}`;
			});
			out.push(`after ${after * (rules.persists ? value : rate)}`);
			return out;
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'middle/from-import': fromImport,
	'middle/module-attribute': moduleAttribute,
	'middle/decorator-order': decoratorOrder,
	'middle/patch-object': patchObject,
	'senior/autospec': autospec,
	'senior/captured-reference': capturedReference,
	'senior/patch-dict': patchDict,
	'senior/class-decorator': classDecorator
};

const STATEMENT = [
	'Что напечатает программа на CPython 3.12–3.13? Программа сама собирает модули из исходного текста и кладёт их в',
	'`sys.modules`, поэтому `import` и `mock.patch` находят их так же, как модули на диске; в конце она их убирает.',
	'Отчёт раннера `unittest`, если он есть, пишется в отдельный поток и на экран не попадает. Методы `test*` одного',
	'класса загрузчик `unittest` запускает в порядке сортировки их имён, а не в порядке объявления.',
	'',
	'Введите вывод построчно, как он появится на экране: каждая напечатанная строка — отдельной строкой ответа,',
	"значения через один пробел, например `rates 42 7` или `call('usd') 1`."
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
