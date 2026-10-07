// `this` in JavaScript: a method called on an object or extracted from it, arrow functions against regular ones,
// call/apply/bind (and a second bind), class methods passed as callbacks, `new` and what a constructor returns.
// Every program runs in strict mode, so a plain call has `this === undefined` and reading a property of it throws.
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
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Out = string | number;

interface Program {
	lines: string[];
	answer: Out[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, Out[]>;
}

const OBJECT_NAMES = ['cart', 'order', 'profile', 'ticket', 'invoice'] as const;
const METHOD_NAMES = ['describe', 'label', 'summary', 'caption'] as const;
const ARROW_METHODS = ['compute', 'measure', 'collect', 'resolve', 'evaluate'] as const;
const CALC_NAMES = ['total', 'charge', 'cost', 'quote'] as const;
const ITEM_PAIRS = [
	['tea', 'cake'],
	['pen', 'book'],
	['bus', 'taxi'],
	['soup', 'salad']
] as const;
const CLASS_PAIRS = [
	['Plan', 'ProPlan'],
	['Account', 'Savings'],
	['Shape', 'Square'],
	['Tariff', 'NightTariff']
] as const;

/** Guarded output of one expression: the value, or the name of the error it throws. */
const guarded = (expr: string): string[] => [
	'try {',
	`  console.log(${expr});`,
	'} catch (e) {',
	'  console.log(e.name);',
	'}'
];

function internProgram(rng: Rng, classId: string): Program {
	if (classId === 'extracted-method') {
		const obj = rng.pick(OBJECT_NAMES);
		const method = rng.pick(METHOD_NAMES);
		const [owner, borrower] = rng.sample(PERSON_NAMES, 2) as [string, string];
		const [t1, t2] = [rng.int(10, 99), rng.int(10, 99)];
		const own = `${owner}:${t1}`;
		const other = `${borrower}:${t2}`;
		return {
			lines: [
				"'use strict';",
				`const ${obj} = {`,
				`  owner: '${owner}',`,
				`  total: ${t1},`,
				`  ${method}() {`,
				"    return this.owner + ':' + this.total;",
				'  },',
				'};',
				`console.log(${obj}.${method}());`,
				`const ${method} = ${obj}.${method};`,
				...guarded(`${method}()`),
				`const other = { owner: '${borrower}', total: ${t2}, ${method}: ${obj}.${method} };`,
				`console.log(other.${method}());`
			],
			answer: [own, 'TypeError', other],
			wrong: {
				'method-remembers-object': [own, own, own],
				'sloppy-global': [own, 'undefined:undefined', other]
			}
		};
	}
	if (classId === 'arrow-vs-regular') {
		const obj = rng.pick(OBJECT_NAMES);
		const [arrowName, plainName] = rng.sample(ARROW_METHODS, 2) as [string, string];
		const [base, base2, arg] = [rng.int(10, 60), rng.int(61, 99), rng.int(2, 9)];
		const arrowMethod = [
			`  ${arrowName}() {`,
			`    const add = (x) => this.base + x;`,
			`    return add(${arg});`,
			'  },'
		];
		const plainMethod = [
			`  ${plainName}() {`,
			'    const add = function (x) {',
			'      return this.base + x;',
			'    };',
			`    return add(${arg});`,
			'  },'
		];
		const methods = rng.bool() ? [...arrowMethod, ...plainMethod] : [...plainMethod, ...arrowMethod];
		const own = base + arg;
		const borrowed = base2 + arg;
		return {
			lines: [
				"'use strict';",
				`const ${obj} = {`,
				`  base: ${base},`,
				...methods,
				'};',
				`console.log(${obj}.${arrowName}());`,
				...guarded(`${obj}.${plainName}()`),
				`const other = { base: ${base2}, ${arrowName}: ${obj}.${arrowName} };`,
				`console.log(other.${arrowName}());`,
				`const run = ${obj}.${arrowName};`,
				...guarded('run()')
			],
			answer: [own, 'TypeError', borrowed, 'TypeError'],
			wrong: {
				'arrow-own-this': ['TypeError', 'TypeError', 'TypeError', 'TypeError'],
				'inner-function-inherits': [own, own, borrowed, 'TypeError'],
				'arrow-binds-object': [own, 'TypeError', own, own]
			}
		};
	}
	if (classId === 'call-apply-bind') {
		const fn = rng.pick(CALC_NAMES);
		const [a, b] = rng.pick(ITEM_PAIRS);
		const [pa, pb] = rng.sample([3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15], 2) as [number, number];
		const r = Array.from({ length: 3 }, () => rng.int(2, 6));
		const e = Array.from({ length: 4 }, () => rng.int(1, 30));
		const [r1, r2, r3] = r as [number, number, number];
		const [e1, e2, e3, e4] = e as [number, number, number, number];
		const bound = `for${a[0]?.toUpperCase() ?? ''}${a.slice(1)}`;
		const answer = [pa * r1 + e1, pb * r2 + e2, pa * r3 + e3, pa * r3 + e4];
		return {
			lines: [
				`function ${fn}(rate, extra) {`,
				'  return this.price * rate + extra;',
				'}',
				`const ${a} = { price: ${pa} };`,
				`const ${b} = { price: ${pb} };`,
				`console.log(${fn}.call(${a}, ${r1}, ${e1}));`,
				`console.log(${fn}.apply(${b}, [${r2}, ${e2}]));`,
				`const ${bound} = ${fn}.bind(${a}, ${r3});`,
				`console.log(${bound}(${e3}));`,
				`console.log(${bound}.call(${b}, ${e4}));`
			],
			answer,
			wrong: {
				'call-overrides-bind': [answer[0] ?? 0, answer[1] ?? 0, answer[2] ?? 0, pb * r3 + e4],
				'bind-partial-ignored': [answer[0] ?? 0, answer[1] ?? 0, 'NaN', 'NaN'],
				'apply-like-call': [answer[0] ?? 0, 'NaN', answer[2] ?? 0, answer[3] ?? 0]
			}
		};
	}
	// new-binding: each `new` makes its own object; a borrowed method sees the object it is called on; an object
	// returned from a constructor replaces the new one.
	const [ctor, field] = rng.pick([
		['Point', 'x'],
		['Meter', 'value'],
		['Gauge', 'level']
	] as const);
	const method = rng.pick(['scale', 'times', 'stretch']);
	const [va, vb] = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 11, 12], 2) as [number, number];
	const [k1, k2, k3] = [rng.int(2, 9), rng.int(2, 9), rng.int(2, 9)];
	const box = rng.int(3, 40);
	return {
		lines: [
			"'use strict';",
			`function ${ctor}(start) {`,
			`  this.${field} = start;`,
			`  this.${method} = function (k) {`,
			`    return this.${field} * k;`,
			'  };',
			'}',
			`const p = new ${ctor}(${va});`,
			`const q = new ${ctor}(${vb});`,
			`q.${method} = p.${method};`,
			`console.log(p.${method}(${k1}));`,
			`console.log(q.${method}(${k2}));`,
			'function Box(v) {',
			'  this.v = v;',
			'  return { v: v * 2 };',
			'}',
			`console.log(new Box(${box}).v);`,
			`const s = p.${method};`,
			...guarded(`s(${k3})`)
		],
		answer: [va * k1, vb * k2, box * 2, 'TypeError'],
		wrong: {
			'method-remembers-object': [va * k1, va * k2, box * 2, va * k3],
			'constructor-return-ignored': [va * k1, vb * k2, box, 'TypeError'],
			'sloppy-global': [va * k1, vb * k2, box * 2, 'NaN']
		}
	};
}

function juniorProgram(rng: Rng, classId: string): Program {
	if (classId === 'class-callback') {
		const cls = rng.pick(['Wallet', 'Counter', 'Meter', 'Ledger']);
		const rate = rng.int(2, 9);
		const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => rng.int(1, 9)) as [
			number,
			number,
			number,
			number,
			number,
			number
		];
		type Model = 'right' | 'method-remembers-object' | 'sloppy-global' | 'thisarg-ignored' | 'field-arrow-unbound';
		const run = (model: Model): Out[] => {
			let total = 0;
			const add = (x: number): number => (total += x * rate);
			const out: Out[] = [];
			out.push(add(a));
			if (model === 'method-remembers-object') out.push(add(b));
			else if (model === 'sloppy-global') out.push('NaN');
			else out.push('TypeError');
			out.push(model === 'field-arrow-unbound' ? 'TypeError' : add(c));
			if (model === 'thisarg-ignored') out.push('TypeError');
			else out.push(`${add(d)},${add(e)}`);
			if (model === 'method-remembers-object') out.push(String(add(f)));
			else if (model === 'sloppy-global') out.push('NaN');
			else out.push('TypeError');
			out.push(total);
			return out;
		};
		return {
			lines: [
				`class ${cls} {`,
				'  constructor(rate) {',
				'    this.rate = rate;',
				'    this.total = 0;',
				'  }',
				'  add(x) {',
				'    this.total += x * this.rate;',
				'    return this.total;',
				'  }',
				'  addLater = (x) => this.add(x);',
				'}',
				`const w = new ${cls}(${rate});`,
				'const plain = w.add;',
				'const bound = w.add.bind(w);',
				'const later = w.addLater;',
				`console.log(bound(${a}));`,
				...guarded(`plain(${b})`),
				`console.log(later(${c}));`,
				`console.log([${d}, ${e}].map(w.add, w).join(','));`,
				...guarded(`[${f}].map(w.add).join(',')`),
				'console.log(w.total);'
			],
			answer: run('right'),
			wrong: {
				'method-remembers-object': run('method-remembers-object'),
				'sloppy-global': run('sloppy-global'),
				'thisarg-ignored': run('thisarg-ignored'),
				'field-arrow-unbound': run('field-arrow-unbound')
			}
		};
	}
	if (classId === 'rebind') {
		const fn = rng.pick(['measure', 'weigh', 'score', 'rank']);
		const [na, nb, nc] = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13], 3) as [number, number, number];
		const off = rng.int(1, 20);
		const [k1, k2, k3, k4, k5] = Array.from({ length: 5 }, () => rng.int(2, 9)) as [
			number,
			number,
			number,
			number,
			number
		];
		const f = (n: number, k: number): number => n * k + off;
		const answer = [f(na, k1), f(na, k2), f(na, k3), f(nc, k4), nb * k5];
		return {
			lines: [
				"'use strict';",
				`function ${fn}(k) {`,
				`  return this.n * k + ${off};`,
				'}',
				`const a = { n: ${na} };`,
				`const b = { n: ${nb} };`,
				`const forA = ${fn}.bind(a);`,
				'const again = forA.bind(b);',
				`console.log(again(${k1}));`,
				`console.log(forA.call(b, ${k2}));`,
				`const holder = { n: ${nc}, run: forA, plain: ${fn} };`,
				`console.log(holder.run(${k3}));`,
				`console.log(holder.plain(${k4}));`,
				'function makeReader() {',
				'  return (k) => this.n * k;',
				'}',
				'const reader = makeReader.call(b);',
				`console.log(reader.call(a, ${k5}));`
			],
			answer,
			wrong: {
				'rebind-overrides': [f(nb, k1), ...answer.slice(1)],
				'call-overrides-bind': [answer[0] ?? 0, f(nb, k2), ...answer.slice(2)],
				'method-call-overrides-bind': [...answer.slice(0, 2), f(nc, k3), ...answer.slice(3)],
				'call-overrides-arrow': [...answer.slice(0, 4), na * k5]
			}
		};
	}
	if (classId === 'prototype-methods') {
		const [base, child] = rng.pick(CLASS_PAIRS);
		const [r1, r2] = rng.sample([2, 3, 4, 5, 6, 7, 8, 9], 2) as [number, number];
		const [v1, v2] = [rng.int(2, 12), rng.int(2, 12)];
		const extra = rng.int(10, 50);
		const [k1, k2, k3, k4] = Array.from({ length: 4 }, () => rng.int(1, 9)) as [number, number, number, number];
		const answer: Out[] = [v1 * r1 + k1, v2 * r2 + k2 + extra, v2 * r2 + k3, 'TypeError'];
		return {
			lines: [
				`class ${base} {`,
				'  constructor(v) {',
				'    this.v = v;',
				'  }',
				'  rate() {',
				`    return ${r1};`,
				'  }',
				'  total(k) {',
				'    return this.v * this.rate() + k;',
				'  }',
				'}',
				`class ${child} extends ${base} {`,
				'  rate() {',
				`    return ${r2};`,
				'  }',
				'  total(k) {',
				`    return super.total(k) + ${extra};`,
				'  }',
				'}',
				`const b = new ${base}(${v1});`,
				`const c = new ${child}(${v2});`,
				`console.log(b.total(${k1}));`,
				`console.log(c.total(${k2}));`,
				`console.log(${base}.prototype.total.call(c, ${k3}));`,
				'const t = c.total;',
				...guarded(`t(${k4})`)
			],
			answer,
			wrong: {
				'super-uses-base': [answer[0] ?? 0, v2 * r1 + k2 + extra, ...answer.slice(2)],
				'call-proto-uses-base': [...answer.slice(0, 2), v2 * r1 + k3, 'TypeError'],
				'method-remembers-object': [...answer.slice(0, 3), v2 * r2 + k4 + extra]
			}
		};
	}
	// new-and-bind: `new` ignores the bound this, an arrow function is not a constructor, an object returned from a
	// constructor replaces the new one and a primitive is ignored.
	const ctor = rng.pick(['Item', 'Entry', 'Record']);
	const [p0, p1, p2, p3, p4] = rng.sample(
		Array.from({ length: 60 }, (_, i) => i + 2),
		5
	) as [number, number, number, number, number];
	const answer: Out[] = [p1, p0, 'TypeError', p3 * 2, p4];
	return {
		lines: [
			"'use strict';",
			`function ${ctor}(price) {`,
			'  this.price = price;',
			'}',
			`const ctx = { price: ${p0} };`,
			`const Bound = ${ctor}.bind(ctx, ${p1});`,
			'const made = new Bound();',
			'console.log(made.price);',
			'console.log(ctx.price);',
			'const make = (price) => ({ price });',
			...guarded(`new make(${p2}).price`),
			'function Box(v) {',
			'  this.v = v;',
			'  return { v: v * 2 };',
			'}',
			`console.log(new Box(${p3}).v);`,
			'function Cell(v) {',
			'  this.v = v;',
			'  return v + 1;',
			'}',
			`console.log(new Cell(${p4}).v);`
		],
		answer,
		wrong: {
			'bind-beats-new': ['undefined', p1, ...answer.slice(2)],
			'arrow-constructible': [p1, p0, p2, p3 * 2, p4],
			'constructor-return-ignored': [p1, p0, 'TypeError', p3, p4],
			'primitive-return-wins': [p1, p0, 'TypeError', p3 * 2, 'undefined']
		}
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const program = input.grade === 'intern' ? internProgram(rng, input.classId) : juniorProgram(rng, input.classId);
	const source = program.lines.join('\n');
	const toAnswer = (values: Out[]) => ({ kind: 'sequence' as const, value: values.map(String) });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js 24, обычный скрипт)? Введите вывод построчно, как он появится в консоли.',
			code: { language: 'javascript', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const values = program.wrong[id];
					return [id, values === undefined ? null : { kind: 'answer' as const, answer: toAnswer(values) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
