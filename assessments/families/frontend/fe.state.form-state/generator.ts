// The state of form fields under a series of focus, input, blur and submit events: `touched` after the first blur,
// `dirty` while the value differs from the initial one, an error shown by the rule of the form (after blur, after the
// first submit, while the field is changed) and a submit button disabled by errors. The rules are given in the
// statement; the generator runs them on the events, and the reference is an independent Python model of the same
// rules.
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

type Rule =
	| { kind: 'required' }
	| { kind: 'email' }
	| { kind: 'minlen'; n: number }
	| { kind: 'range'; min: number; max: number }
	| { kind: 'digits'; n: number };

interface Field {
	name: string;
	rule: Rule;
	initial: string;
	/** Values an input event may set. */
	values: readonly string[];
}

type FormEvent =
	| { kind: 'focus'; field: string }
	| { kind: 'input'; field: string; value: string }
	| { kind: 'blur'; field: string }
	| { kind: 'submit' };

/** When an error is shown; `flags` — the class asks for the flags of the fields, not for errors. */
type Mode = 'flags' | 'blur' | 'submit' | 'dirty';

const MODES: Record<string, Mode> = {
	'touched-dirty': 'flags',
	'after-blur': 'blur',
	'after-submit': 'submit',
	'while-dirty': 'dirty'
};

interface Rules {
	focusTouches: boolean;
	inputTouches: boolean;
	dirtySticky: boolean;
	errorImmediately: boolean;
	buttonByShown: boolean;
	buttonByValidity: boolean;
	submitResets: boolean;
	blurShows: boolean;
}

const RIGHT: Rules = {
	focusTouches: false,
	inputTouches: false,
	dirtySticky: false,
	errorImmediately: false,
	buttonByShown: false,
	buttonByValidity: false,
	submitResets: false,
	blurShows: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'focus-touches': { focusTouches: true },
	'input-touches': { inputTouches: true },
	'dirty-sticky': { dirtySticky: true },
	'error-immediately': { errorImmediately: true },
	'button-by-shown': { buttonByShown: true },
	'button-by-validity': { buttonByValidity: true },
	'submit-resets': { submitResets: true },
	'blur-shows': { blurShows: true }
};

/** The misconceptions each class applies to; every one of them is built to change the answer. */
const APPLIES: Record<Mode, readonly string[]> = {
	flags: ['focus-touches', 'input-touches', 'dirty-sticky'],
	blur: ['focus-touches', 'input-touches', 'error-immediately', 'button-by-shown'],
	submit: ['error-immediately', 'button-by-validity', 'submit-resets', 'blur-shows'],
	dirty: ['error-immediately', 'dirty-sticky', 'button-by-shown']
};

function valid(rule: Rule, value: string): boolean {
	switch (rule.kind) {
		case 'required':
			return value.length > 0;
		case 'email':
			return value.includes('@');
		case 'minlen':
			return value.length >= rule.n;
		case 'range': {
			if (!/^[0-9]+$/.test(value)) return false;
			const n = Number(value);
			return n >= rule.min && n <= rule.max;
		}
		case 'digits':
			return value.length === rule.n && /^[0-9]+$/.test(value);
	}
}

const list = (names: readonly string[]): string => (names.length > 0 ? names.join(',') : '-');

/** The line after every event. */
function run(fields: readonly Field[], events: readonly FormEvent[], mode: Mode, rules: Rules): string[] {
	const value = new Map(fields.map((f) => [f.name, f.initial]));
	const touched = new Set<string>();
	const typed = new Set<string>();
	let submitted = false;
	const invalid = (f: Field): boolean => !valid(f.rule, value.get(f.name) ?? '');
	const dirty = (f: Field): boolean =>
		rules.dirtySticky ? typed.has(f.name) : (value.get(f.name) ?? '') !== f.initial;
	const shown = (f: Field): boolean => {
		if (!invalid(f)) return false;
		if (rules.errorImmediately) return true;
		if (rules.blurShows && touched.has(f.name)) return true;
		if (mode === 'blur') return touched.has(f.name);
		if (mode === 'submit') return submitted;
		return dirty(f);
	};
	const active = (): boolean => {
		if (mode === 'submit') return rules.buttonByValidity ? !fields.some(invalid) : !submitted || !fields.some(invalid);
		return rules.buttonByShown ? !fields.some(shown) : !fields.some(invalid);
	};
	const out: string[] = [];
	for (const event of events) {
		if (event.kind === 'focus') {
			if (rules.focusTouches) touched.add(event.field);
		} else if (event.kind === 'input') {
			value.set(event.field, event.value);
			typed.add(event.field);
			if (rules.inputTouches) touched.add(event.field);
			if (rules.submitResets) submitted = false;
		} else if (event.kind === 'blur') touched.add(event.field);
		else if (active()) submitted = true;
		if (mode === 'flags')
			out.push(
				`${list(fields.filter((f) => touched.has(f.name)).map((f) => f.name))} ${list(fields.filter(dirty).map((f) => f.name))}`
			);
		else out.push(`${list(fields.filter(shown).map((f) => f.name))} ${active() ? 'on' : 'off'}`);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

/** The fields a form takes three of; `n` — the minimum length of a password, `min`–`max` — the range of an age. */
function fieldPool(n: number, min: number, max: number): Field[] {
	return [
		{ name: 'name', rule: { kind: 'required' }, initial: '', values: ['anna', 'ivan', 'oleg', 'vera', 'kira'] },
		{
			name: 'email',
			rule: { kind: 'email' },
			initial: '',
			values: ['anna@mail.ru', 'ivan@ya.ru', 'kira@site.io', 'anna.mail.ru', 'ivan', 'kira-site.io']
		},
		{
			name: 'password',
			rule: { kind: 'minlen', n },
			initial: '',
			values: ['qwerty', 'abc', 'secret', 'pass1234', 'kitten', 'dragon77', 'x9', 'letmein1']
		},
		{
			name: 'age',
			rule: { kind: 'range', min, max },
			initial: '',
			values: ['17', '25', '9', '120', '42', '15', '70', '88']
		},
		{
			name: 'zip',
			rule: { kind: 'digits', n: 6 },
			initial: '',
			values: ['123456', '12345', '6543210', '190000', '10101', '620014']
		}
	];
}

interface Scenario {
	fields: Field[];
	events: FormEvent[];
}

function scenario(rng: Rng, mode: Mode): Scenario {
	const fields = rng.sample(fieldPool(rng.pick([6, 8]), rng.pick([14, 16, 18]), rng.pick([65, 80, 99])), 3);
	// Some fields start empty (and so wrong), the others with a right value, as in a profile being edited.
	for (const f of fields) {
		if (rng.bool(0.5)) {
			const good = f.values.filter((v) => valid(f.rule, v));
			if (good.length > 0) f.initial = rng.pick(good);
		}
	}
	const length = rng.int(7, 8);
	const events: FormEvent[] = [];
	const value = new Map(fields.map((f) => [f.name, f.initial]));
	let focused: Field | null = null;
	let inputs = 0;
	let submits = 0;
	while (events.length < length) {
		if (focused === null) {
			focused = rng.pick(fields);
			inputs = 0;
			events.push({ kind: 'focus', field: focused.name });
			continue;
		}
		const roll = rng.next();
		if (mode === 'submit' && submits < 2 && roll < 0.2 && events.length >= 2) {
			events.push({ kind: 'submit' });
			submits += 1;
		} else if (inputs < 2 && roll < 0.7) {
			const current = value.get(focused.name) ?? '';
			const back = focused.initial !== current && rng.bool(0.35);
			const options = [...focused.values, ''].filter((v) => v !== current);
			const next = back ? focused.initial : rng.pick(options);
			value.set(focused.name, next);
			events.push({ kind: 'input', field: focused.name, value: next });
			inputs += 1;
		} else {
			events.push({ kind: 'blur', field: focused.name });
			focused = null;
		}
	}
	return { fields, events };
}

/** Hand-checked scenarios for a seed whose random draws keep failing: each exposes every misconception of the class. */
function fallback(mode: Mode): Scenario {
	const [name, email, password] = fieldPool(8, 16, 99) as [Field, Field, Field];
	const fields: Field[] = [name, { ...email, initial: 'ivan@ya.ru' }, password];
	const ev = {
		focus: (field: string): FormEvent => ({ kind: 'focus', field }),
		input: (field: string, value: string): FormEvent => ({ kind: 'input', field, value }),
		blur: (field: string): FormEvent => ({ kind: 'blur', field }),
		submit: (): FormEvent => ({ kind: 'submit' })
	};
	if (mode === 'submit')
		return {
			fields,
			events: [
				ev.focus('name'),
				ev.blur('name'),
				ev.focus('email'),
				ev.input('email', 'ivan'),
				ev.submit(),
				ev.input('email', 'ivan@ya.ru'),
				ev.blur('email'),
				ev.focus('password')
			]
		};
	if (mode === 'blur')
		return {
			fields,
			events: [
				ev.focus('name'),
				ev.blur('name'),
				ev.focus('email'),
				ev.input('email', 'ivan'),
				ev.blur('email'),
				ev.focus('name'),
				ev.input('name', 'anna'),
				ev.blur('name')
			]
		};
	if (mode === 'dirty')
		return {
			fields,
			events: [
				ev.focus('email'),
				ev.input('email', 'ivan'),
				ev.input('email', 'ivan@ya.ru'),
				ev.blur('email'),
				ev.focus('password'),
				ev.input('password', 'abc'),
				ev.input('password', ''),
				ev.blur('password')
			]
		};
	return {
		fields,
		events: [
			ev.focus('email'),
			ev.input('email', 'ivan'),
			ev.input('email', 'ivan@ya.ru'),
			ev.blur('email'),
			ev.focus('name'),
			ev.input('name', 'anna'),
			ev.input('name', ''),
			ev.blur('name')
		]
	};
}

interface Evaluated {
	s: Scenario;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

const differs = (a: readonly string[], b: readonly string[]): boolean =>
	a.length !== b.length || a.some((x, i) => x !== b[i]);

function evaluate(s: Scenario, mode: Mode): Evaluated | null {
	const answer = run(s.fields, s.events, mode, RIGHT);
	// The answer moves: at least three different lines, and with a display rule some error is shown at some step.
	if (new Set(answer).size < 3) return null;
	if (mode !== 'flags' && answer.every((line) => line.startsWith('- '))) return null;
	const wrong: Record<string, string[] | null> = {};
	for (const [id, change] of Object.entries(WRONG)) {
		if (!APPLIES[mode].includes(id)) {
			wrong[id] = null;
			continue;
		}
		const values = run(s.fields, s.events, mode, { ...RIGHT, ...change });
		if (!differs(values, answer)) return null;
		wrong[id] = values;
	}
	return { s, answer, wrong };
}

// ---------------------------------------------------------------------------------------------------------------
// Statement and reference.

function ruleText(rule: Rule): string {
	switch (rule.kind) {
		case 'required':
			return 'не пустое';
		case 'email':
			return 'содержит символ `@`';
		case 'minlen':
			return `не короче ${rule.n} символов`;
		case 'range':
			return `только цифры, целое число от ${rule.min} до ${rule.max}`;
		case 'digits':
			return `ровно ${rule.n} цифр`;
	}
}

const DISPLAY: Record<Exclude<Mode, 'flags'>, string[]> = {
	blur: [
		'- ошибка поля **показывается**, когда поле тронуто (`touched`) и его значение нарушает правило;',
		'- кнопка «Отправить» **неактивна**, пока хотя бы одно поле нарушает правило — показана его ошибка или ещё нет.'
	],
	submit: [
		'- до первой отправки ошибки **не показываются**; первая отправка — событие `submit` при активной кнопке;',
		'- после первой отправки ошибка **показывается** у каждого поля, значение которого нарушает правило, — и при дальнейшем вводе тоже;',
		'- кнопка «Отправить» **активна** до первой отправки; после неё кнопка неактивна, пока хотя бы одно поле нарушает правило;',
		'- `submit` при неактивной кнопке ничего не делает; после отправки страница остаётся той же.'
	],
	dirty: [
		'- ошибка поля **показывается** сразу при вводе: когда поле изменено (`dirty`) и его значение нарушает правило; у поля с исходным значением ошибка не показывается;',
		'- кнопка «Отправить» **неактивна**, пока хотя бы одно поле нарушает правило — показана его ошибка или нет.'
	]
};

const quote = (value: string): string => `\`"${value}"\``;

function eventText(e: FormEvent): string {
	if (e.kind === 'focus') return `focus ${e.field}`;
	if (e.kind === 'blur') return `blur ${e.field}`;
	if (e.kind === 'submit') return 'submit';
	return `input ${e.field} "${e.value}"`;
}

function describe(s: Scenario, mode: Mode): string {
	const order = s.fields.map((f) => `\`${f.name}\``).join(', ');
	const table =
		mode === 'flags'
			? ['| Поле | Исходное значение |', '|---|---|', ...s.fields.map((f) => `| \`${f.name}\` | ${quote(f.initial)} |`)]
			: [
					'| Поле | Исходное значение | Правило |',
					'|---|---|---|',
					...s.fields.map((f) => `| \`${f.name}\` | ${quote(f.initial)} | ${ruleText(f.rule)} |`)
				];
	const model = [
		'Состояние каждого поля в форме устроено так:',
		'',
		'- `value` — текущее значение; событие `input` заменяет его целиком строкой в кавычках;',
		'- `touched` — поле становится тронутым при первом уходе фокуса (`blur`) и остаётся тронутым; `focus` и ввод его не меняют;',
		'- `dirty` — значение отличается от исходного; если значение вернулось к исходному, поле снова не изменено;'
	];
	const tail =
		mode === 'flags'
			? [
					'',
					'После каждого события запишите строку: тронутые поля через запятую в порядке формы (или `-`), пробел, ' +
						'изменённые (`dirty`) поля через запятую в порядке формы (или `-`). Пример строки: `name email,age`.'
				]
			: [
					...DISPLAY[mode],
					'',
					'`submit` — нажатие Enter в поле: фокус остаётся на месте, других событий не происходит.',
					'',
					'После каждого события запишите строку: поля с показанной ошибкой через запятую в порядке формы (или `-`), пробел, ' +
						'`on`, если кнопка «Отправить» активна, или `off`, если нет. Пример строки: `email,age off`.'
				];
	return [
		`Форма с тремя полями (в порядке на странице: ${order}):`,
		'',
		...table,
		'',
		...model,
		...tail,
		'',
		'События по порядку:',
		'',
		...s.events.map((e, i) => `${i + 1}. \`${eventText(e)}\``),
		'',
		`Введите ${s.events.length} строк — по одной на событие.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
import re
import sys

data = json.loads(sys.stdin.read())
mode = data["mode"]
fields = data["fields"]
names = [f["name"] for f in fields]
initial = {f["name"]: f["initial"] for f in fields}
rule = {f["name"]: f["rule"] for f in fields}


def ok(name, v):
    r = rule[name]
    k = r["kind"]
    if k == "required":
        return v != ""
    if k == "email":
        return "@" in v
    if k == "minlen":
        return len(v) >= r["n"]
    if k == "range":
        return re.fullmatch(r"[0-9]+", v) is not None and r["min"] <= int(v) <= r["max"]
    if k == "digits":
        return re.fullmatch(r"[0-9]{%d}" % r["n"], v) is not None
    raise ValueError(k)


current = dict(initial)
touched = {n: False for n in names}
submitted = False


def errors():
    return [n for n in names if not ok(n, current[n])]


def visible_errors():
    bad = errors()
    if mode == "blur":
        return [n for n in bad if touched[n]]
    if mode == "submit":
        return bad if submitted else []
    return [n for n in bad if current[n] != initial[n]]


def enabled():
    if mode == "submit":
        return (not submitted) or not errors()
    return not errors()


def joined(items):
    return ",".join(items) if items else "-"


for e in data["events"]:
    kind = e["kind"]
    if kind == "input":
        current[e["field"]] = e["value"]
    elif kind == "blur":
        touched[e["field"]] = True
    elif kind == "submit" and enabled():
        submitted = True
    if mode == "flags":
        t = [n for n in names if touched[n]]
        d = [n for n in names if current[n] != initial[n]]
        print(joined(t) + " " + joined(d))
    else:
        print(joined(visible_errors()) + " " + ("on" if enabled() else "off"))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const mode = MODES[input.classId];
	if (!mode) throw new Error(`${descriptor.key}: no mode for class ${input.classId}`);
	const rng = instanceRng(descriptor, input);
	let chosen: Evaluated | null = null;
	for (let tries = 0; tries < 300 && chosen === null; tries += 1) chosen = evaluate(scenario(rng, mode), mode);
	if (chosen === null) {
		const s = fallback(mode);
		chosen = evaluate(s, mode);
		if (chosen === null) throw new Error(`${descriptor.key}: the fallback of ${input.classId} misses a misconception`);
	}
	const { s, answer, wrong } = chosen;
	const toAnswer = (values: readonly string[]) => ({ kind: 'sequence' as const, value: [...values] });
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(s, mode), code: null },
		answer: toAnswer(answer)
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({
				mode,
				fields: s.fields.map((f) => ({ name: f.name, initial: f.initial, rule: f.rule })),
				events: s.events
			})
		}),
		wrong: () =>
			Object.fromEntries(
				Object.keys(WRONG).map((id) => {
					const values = wrong[id] ?? null;
					return [id, values === null ? null : { kind: 'answer' as const, answer: toAnswer(values) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
