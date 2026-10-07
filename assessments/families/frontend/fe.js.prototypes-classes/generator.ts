// Prototypes and classes in JavaScript: where a property is found along the prototype chain, what `extends`, `super`
// and static members resolve to, accessors, and on the middle level the order in which class fields, base constructors
// and overridden methods run, private fields and `Object.create`. The generator models each program and computes its
// output; the gate runs the shown program with Node.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Program {
	lines: string[];
	answer: string[];
	/** Outputs of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, string[]>;
}

/** `count` distinct integers in [min, max]. */
function distinct(rng: Rng, count: number, min: number, max: number): number[] {
	const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
	return rng.sample(values, count);
}

// ---------------------------------------------------------------------------------------------------------------
// Junior.

const COUNTER_CLASSES = ['Counter', 'Meter', 'Gauge', 'Quota', 'Budget'] as const;
const LIMIT_PROPS = ['limit', 'max', 'step', 'rate', 'size'] as const;

/** An own property shadows the prototype's; changing the prototype reaches every instance without its own; for…in sees both. */
function shadowing(rng: Rng): Program {
	const cls = rng.pick(COUNTER_CLASSES);
	const prop = rng.pick(LIMIT_PROPS);
	const [l1, l2, l3] = distinct(rng, 3, 10, 99) as [number, number, number];
	const [s1, s2] = [rng.int(1, 9), rng.int(1, 9)];
	const lines = [
		`class ${cls} {`,
		'  constructor(start) {',
		'    this.value = start;',
		'  }',
		'}',
		`${cls}.prototype.${prop} = ${l1};`,
		`const a = new ${cls}(${s1});`,
		`const b = new ${cls}(${s2});`,
		`a.${prop} = ${l2};`,
		`console.log(a.${prop}, b.${prop});`,
		`${cls}.prototype.${prop} = ${l3};`,
		`console.log(a.${prop}, b.${prop});`,
		`delete a.${prop};`,
		`console.log(a.${prop}, Object.hasOwn(a, '${prop}'));`,
		`delete a.${prop};`,
		`console.log(a.${prop});`,
		'const keys = [];',
		'for (const key in b) keys.push(key);',
		"console.log(keys.join(','), Object.keys(b).join(','));"
	];
	const keys = `value,${prop} value`;
	return {
		lines,
		answer: [`${l2} ${l1}`, `${l2} ${l3}`, `${l3} false`, `${l3}`, keys],
		wrong: {
			// Instances copy the prototype's properties when they are created.
			'copied-at-creation': [
				`${l2} ${l1}`,
				`${l2} ${l1}`,
				'undefined false',
				'undefined',
				`value,${prop} value,${prop}`
			],
			// Assigning through an instance writes the prototype's property.
			'assign-writes-prototype': [`${l2} ${l2}`, `${l3} ${l3}`, `${l3} false`, `${l3}`, keys],
			// `delete` on an instance without its own property removes the inherited one.
			'delete-reaches-prototype': [`${l2} ${l1}`, `${l2} ${l3}`, `${l3} false`, 'undefined', 'value value'],
			// for…in lists only own properties, like Object.keys.
			'for-in-own-only': [`${l2} ${l1}`, `${l2} ${l3}`, `${l3} false`, `${l3}`, 'value value']
		}
	};
}

/** `new this` in a static method builds the class it is called on; statics are inherited, and assigning one creates an own static. */
function superStatic(rng: Rng): Program {
	const [base, child] = rng.pick([
		['Shape', 'Square'],
		['Account', 'Savings'],
		['Order', 'Express'],
		['Task', 'Timed']
	] as const);
	const counter = rng.pick(['created', 'made', 'total', 'instances'] as const);
	const k = rng.int(2, 9);
	const dflt = rng.int(11, 19);
	const [a, b, d, e, f] = [rng.int(2, 9), rng.int(2, 9), rng.int(20, 40), rng.int(2, 9), rng.int(2, 9)];
	const reset = rng.int(50, 99);
	const lines = [
		`class ${base} {`,
		`  static ${counter} = 0;`,
		'  constructor(x) {',
		'    this.x = x;',
		`    ${base}.${counter} += 1;`,
		'  }',
		'  total() {',
		`    return this.x * ${k};`,
		'  }',
		'  static of(x) {',
		'    return new this(x);',
		'  }',
		'}',
		`class ${child} extends ${base} {`,
		`  constructor(x, y = ${dflt}) {`,
		'    super(x);',
		'    this.y = y;',
		'  }',
		'  total() {',
		'    return super.total() + this.y;',
		'  }',
		'}',
		`const p = new ${base}(${a});`,
		`const c = new ${child}(${b}, ${d});`,
		`const m = ${child}.of(${e});`,
		'console.log(p.total(), c.total(), m.total());',
		`console.log(m instanceof ${child}, ${base}.${counter}, ${child}.${counter});`,
		`${child}.${counter} = ${reset};`,
		`${base}.of(${f});`,
		`console.log(${base}.${counter}, ${child}.${counter});`
	];
	const first = `${a * k} ${b * k + d} ${e * k + dflt}`;
	return {
		lines,
		answer: [first, 'true 3 3', `4 ${reset}`],
		wrong: {
			// `new this` in a static method of the base always builds the base.
			'new-this-is-base': [`${a * k} ${b * k + d} ${e * k}`, 'false 3 3', `4 ${reset}`],
			// Static members are not inherited by the subclass.
			'static-not-inherited': [first, 'true 3 undefined', `4 ${reset}`],
			// Assigning an inherited static through the subclass changes the base's static.
			'static-assign-writes-base': [first, 'true 3 3', `${reset + 1} ${reset + 1}`]
		}
	};
}

/** A getter runs on every read and lives on the prototype: spread and Object.keys do not see it; a setter can clamp. */
function accessors(rng: Rng): Program {
	const cls = rng.pick(['Cart', 'Basket', 'Invoice', 'Bill'] as const);
	const max = rng.pick([50, 100, 150, 200]);
	const over = max + rng.int(1, 9) * 10;
	const [p1, p2, p3] = [rng.int(30, 99) * 10, rng.int(30, 99) * 10, rng.int(5, 49) * 10];
	const lines = [
		`class ${cls} {`,
		'  constructor() {',
		'    this.items = [];',
		'    this._discount = 0;',
		'  }',
		'  get total() {',
		'    let sum = 0;',
		'    for (const price of this.items) sum += price;',
		'    return sum - this._discount;',
		'  }',
		'  set discount(value) {',
		`    this._discount = Math.min(value, ${max});`,
		'  }',
		'  get discount() {',
		'    return this._discount;',
		'  }',
		'}',
		`const cart = new ${cls}();`,
		`cart.items.push(${p1}, ${p2});`,
		`cart.discount = ${over};`,
		'console.log(cart.total, cart.discount);',
		'const before = cart.total;',
		`cart.items.push(${p3});`,
		'console.log(before, cart.total);',
		'const copy = { ...cart };',
		'console.log(copy.total, copy._discount);',
		"console.log(Object.keys(cart).join(','));"
	];
	const t2 = p1 + p2 - max;
	const t3 = p1 + p2 + p3 - max;
	return {
		lines,
		answer: [`${t2} ${max}`, `${t2} ${t3}`, `undefined ${max}`, 'items,_discount'],
		wrong: {
			// A getter is computed once, like a field.
			'getter-computed-once': [`${t2} ${max}`, `${t2} ${t2}`, `${t2} ${max}`, 'items,_discount,total,discount'],
			// Spread copies accessors as live properties or their values.
			'spread-copies-accessors': [`${t2} ${max}`, `${t2} ${t3}`, `${t3} ${max}`, 'items,_discount'],
			// Assigning to an accessor property bypasses the setter and stores the value as is.
			'setter-bypassed': [`${p1 + p2} ${over}`, `${p1 + p2} ${p1 + p2 + p3}`, 'undefined 0', 'items,_discount,discount']
		}
	};
}

/** A class field (an arrow function) is an own property and shadows a method of the subclass with the same name. */
function fieldShadowsMethod(rng: Rng): Program {
	const [base, child] = rng.pick([
		['Widget', 'Button'],
		['View', 'Panel'],
		['Control', 'Slider'],
		['Item', 'Link']
	] as const);
	const method = rng.pick(['name', 'label', 'title', 'kind'] as const);
	const [n1, n2, n3, n4] = distinct(rng, 4, 10, 99) as [number, number, number, number];
	const lines = [
		`class ${base} {`,
		`  ${method} = () => ${n1};`,
		'  size() {',
		`    return ${n2};`,
		'  }',
		'}',
		`class ${child} extends ${base} {`,
		`  ${method}() {`,
		`    return ${n3};`,
		'  }',
		'  size() {',
		`    return super.size() + ${n4};`,
		'  }',
		'}',
		`const b = new ${child}();`,
		`console.log(b.${method}(), b.size());`,
		`console.log(Object.hasOwn(b, '${method}'), Object.hasOwn(b, 'size'));`,
		`delete b.${method};`,
		`console.log(b.${method}());`,
		`console.log(b.${method} === ${child}.prototype.${method});`
	];
	return {
		lines,
		answer: [`${n1} ${n2 + n4}`, 'true false', `${n3}`, 'true'],
		wrong: {
			// Fields go to the prototype like methods, so the subclass method overrides the base field.
			'method-overrides-field': [`${n3} ${n2 + n4}`, 'false false', `${n3}`, 'true'],
			// An overriding method replaces the base method entirely, super included.
			'override-drops-super': [`${n1} ${n4}`, 'true false', `${n3}`, 'true']
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Middle.

/** Fields of a subclass are set after the base constructor returns: an overridden method called from it sees none. */
function fieldInitOrder(rng: Rng): Program {
	const [base, child] = rng.pick([
		['Base', 'Store'],
		['Model', 'User'],
		['Component', 'Form'],
		['Resource', 'Cache']
	] as const);
	const kind = rng.pick(['store', 'user', 'form', 'cache', 'list'] as const);
	const declaredOnly = rng.bool(0.4);
	const v0 = rng.int(100, 999);
	const [n, m, add] = [rng.int(2, 9), rng.int(2, 9), rng.int(100, 900)];
	const id = rng.int(10, 99);
	const lines = [
		`class ${base} {`,
		`  id = ${id};`,
		'  constructor(n) {',
		"    console.log('base', this.id, this.kind);",
		'    this.setup(n);',
		'  }',
		'  setup(n) {',
		'    this.value = n;',
		'  }',
		'}',
		`class ${child} extends ${base} {`,
		`  kind = '${kind}';`,
		declaredOnly ? '  value;' : `  value = ${v0};`,
		'  constructor(n) {',
		'    super(n);',
		"    console.log('ready', this.kind, this.value);",
		`    this.value += ${add};`,
		'  }',
		'  setup(n) {',
		"    console.log('setup', this.value);",
		`    this.value = n * ${m};`,
		'  }',
		'}',
		`const s = new ${child}(${n});`,
		'console.log(s.value);'
	];
	const field = declaredOnly ? 'undefined' : `${v0}`;
	const final = declaredOnly ? 'NaN' : `${v0 + add}`;
	const viaSetup = n * m;
	return {
		lines,
		answer: [`base ${id} undefined`, 'setup undefined', `ready ${kind} ${field}`, final],
		wrong: {
			// Fields are initialized before the base constructor runs.
			'fields-before-super': [`base ${id} ${kind}`, `setup ${field}`, `ready ${kind} ${viaSetup}`, `${viaSetup + add}`],
			// A constructor of the base calls the base's own method, not the override.
			'base-calls-own-method': [`base ${id} undefined`, `ready ${kind} ${field}`, final],
			// A field initializer does not overwrite a value already set by the base constructor.
			'field-keeps-existing': [
				`base ${id} undefined`,
				'setup undefined',
				`ready ${kind} ${viaSetup}`,
				`${viaSetup + add}`
			]
		}
	};
}

/** Private fields belong to objects the constructor made: `#x in o` is a brand check, prototypes and copies lack them. */
function privateFields(rng: Rng): Program {
	const cls = rng.pick(['Account', 'Wallet', 'Vault', 'Ledger'] as const);
	const [owner1, owner2] = rng.sample(PERSON_NAMES, 2) as [string, string];
	const [a, b] = [rng.int(20, 99) * 10, rng.int(20, 99) * 10];
	const t = rng.int(1, 19) * 10;
	const lines = [
		`class ${cls} {`,
		'  #balance = 0;',
		'  static #opened = 0;',
		'  constructor(owner, amount) {',
		'    this.owner = owner;',
		'    this.#balance = amount;',
		`    ${cls}.#opened += 1;`,
		'  }',
		'  static isAccount(o) {',
		'    return #balance in o;',
		'  }',
		'  static opened() {',
		`    return ${cls}.#opened;`,
		'  }',
		'  get balance() {',
		'    return this.#balance;',
		'  }',
		'  moveTo(other, sum) {',
		'    other.#balance += sum;',
		'    this.#balance -= sum;',
		'    return this.#balance;',
		'  }',
		'}',
		`const a = new ${cls}('${owner1}', ${a});`,
		`const b = new ${cls}('${owner2}', ${b});`,
		`const fake = Object.create(${cls}.prototype);`,
		'const copy = { ...a };',
		`console.log(${cls}.isAccount(a), ${cls}.isAccount(fake), ${cls}.isAccount(copy));`,
		`console.log(a.moveTo(b, ${t}), b.balance);`,
		'console.log(JSON.stringify(a));',
		'try {',
		'  console.log(fake.balance);',
		'} catch (e) {',
		'  console.log(e.constructor.name);',
		'}',
		`console.log(${cls}.opened(), copy.balance);`
	];
	const moved = `${a - t} ${b + t}`;
	const json = `{"owner":"${owner1}"}`;
	return {
		lines,
		answer: ['true false false', moved, json, 'TypeError', '2 undefined'],
		wrong: {
			// An object made from the prototype inherits private fields like methods.
			'private-via-prototype': ['true true false', moved, json, '0', '2 undefined'],
			// Private fields are hidden properties: spread and JSON copy them.
			'private-is-property': [
				'true false true',
				moved,
				`{"owner":"${owner1}","#balance":${a - t}}`,
				'TypeError',
				`2 ${a - t}`
			],
			// Spread copies the getter along with the data.
			'spread-copies-getter': ['true false false', moved, json, 'TypeError', `2 ${a - t}`]
		}
	};
}

/** Object.create links objects: mutation of an inherited array is shared, assignment (`+=`) creates an own property. */
function objectCreate(rng: Rng): Program {
	const proto = rng.pick(['proto', 'base', 'template', 'shared'] as const);
	const prop = rng.pick(['count', 'hits', 'used', 'seen'] as const);
	const list = rng.pick(['tags', 'notes', 'labels', 'marks'] as const);
	const c0 = rng.int(1, 30);
	const [n1, n2] = [rng.int(2, 5), rng.int(1, 4)];
	const reset = rng.int(100, 200);
	const lines = [
		`const ${proto} = {`,
		`  ${list}: [],`,
		`  ${prop}: ${c0},`,
		'  add(item) {',
		`    this.${list}.push(item);`,
		`    this.${prop} += 1;`,
		`    return this.${prop};`,
		'  }',
		'};',
		`const a = Object.create(${proto});`,
		`const b = Object.create(${proto});`,
		`for (let i = 0; i < ${n1}; i++) a.add('a' + i);`,
		`for (let i = 0; i < ${n2}; i++) b.add('b' + i);`,
		`console.log(a.${prop}, b.${prop}, ${proto}.${prop});`,
		`console.log(a.${list}.length, Object.hasOwn(a, '${list}'));`,
		`${proto}.${prop} = ${reset};`,
		'const c = Object.create(a);',
		`console.log(c.add('c'), a.${prop}, b.${prop});`,
		`a.${list} = ['own'];`,
		`console.log(c.${list}.length, b.${list}.length);`
	];
	const [ca, cb] = [c0 + n1, c0 + n2];
	const shared = n1 + n2 + 1;
	const sharedCount = c0 + n1 + n2;
	return {
		lines,
		answer: [`${ca} ${cb} ${c0}`, `${n1 + n2} false`, `${ca + 1} ${ca} ${cb}`, `1 ${shared}`],
		wrong: {
			// Object.create copies the properties of the prototype into the new object.
			'create-copies': [`${ca} ${cb} ${c0}`, `${n1} true`, `${ca + 1} ${ca} ${cb}`, `${n1 + 1} ${n2}`],
			// `this.x += 1` changes the property where it was found — on the prototype.
			'increment-writes-proto': [
				`${sharedCount} ${sharedCount} ${sharedCount}`,
				`${n1 + n2} false`,
				`${reset + 1} ${reset + 1} ${reset + 1}`,
				`1 ${shared}`
			],
			// Pushing to an inherited array gives the object its own copy, like assignment does.
			'mutation-creates-own': [`${ca} ${cb} ${c0}`, `${n1} true`, `${ca + 1} ${ca} ${cb}`, `1 ${n2}`]
		}
	};
}

/** `super` is resolved from the method's home object, not from `this`, and the home object's prototype is read at call time. */
function superHome(rng: Rng): Program {
	const [a, b, z] = rng.pick([
		['Base', 'Derived', 'Other'],
		['Shape', 'Circle', 'Mock'],
		['Price', 'Sale', 'Fixed'],
		['Score', 'Bonus', 'Flat']
	] as const);
	const m = rng.int(2, 9);
	const [k1, k2] = distinct(rng, 2, 2, 9) as [number, number];
	const d = rng.int(1, 9);
	const zv = rng.int(50, 99) * 10;
	const lines = [
		`class ${a} {`,
		'  val() {',
		`    return this.k * ${m};`,
		'  }',
		'}',
		`class ${b} extends ${a} {`,
		`  k = ${k1};`,
		'  val() {',
		`    return super.val() + ${d};`,
		'  }',
		'}',
		`class ${z} {`,
		'  val() {',
		`    return ${zv};`,
		'  }',
		'}',
		`const x = new ${b}();`,
		`const borrowed = { k: ${k2}, val: ${b}.prototype.val };`,
		`Object.setPrototypeOf(borrowed, ${z}.prototype);`,
		'console.log(x.val(), borrowed.val());',
		`Object.setPrototypeOf(${b}.prototype, ${z}.prototype);`,
		'console.log(x.val(), borrowed.val());',
		`console.log(x instanceof ${a}, x instanceof ${z});`
	];
	const before = `${k1 * m + d} ${k2 * m + d}`;
	return {
		lines,
		answer: [before, `${zv + d} ${zv + d}`, 'false true'],
		wrong: {
			// `super` is looked up from the prototype of `this`.
			'super-from-receiver': [`${k1 * m + d} ${zv + d}`, `${zv + d} ${zv + d}`, 'false true'],
			// `super` is fixed when the class is defined; changing the prototype later does not reach it.
			'super-fixed-at-definition': [before, before, 'false true'],
			// A borrowed method's `super` call runs with the original instance as `this`.
			'super-this-is-original': [`${k1 * m + d} ${k1 * m + d}`, `${zv + d} ${zv + d}`, 'false true']
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	shadowing,
	'super-static': superStatic,
	accessors,
	'field-shadows-method': fieldShadowsMethod,
	'field-init-order': fieldInitOrder,
	'private-fields': privateFields,
	'object-create': objectCreate,
	'super-home': superHome
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	const program = make(rng);
	const source = program.lines.join('\n');
	const toAnswer = (lines: readonly string[]) => ({ kind: 'sequence' as const, value: [...lines] });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js)? Введите вывод построчно, как он появится в консоли: ' +
				'значения из одного вызова `console.log` — в одной строке через пробел.',
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
					const lines = program.wrong[id];
					return [id, lines === undefined ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
