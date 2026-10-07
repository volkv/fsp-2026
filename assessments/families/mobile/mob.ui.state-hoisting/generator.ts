// Unidirectional data flow in plain Kotlin: an immutable screen state in a data class changed by `copy` on every
// event, a value hoisted to the parent with an `onValueChange` callback and the parent's validation, a local copy in
// the child, a derived value computed from the state against a stored copy of it, a shallow `copy()` sharing a mutable
// list, and a parameter that is a snapshot of the value at the call. The program prints the "rendering" after every
// event; the model computes it, and the gate runs the program with the real Kotlin compiler.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { kotlinOutputProbe, kotlinProgram } from '../../_lib/kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Program {
	lines: string[];
	answer: string[];
	/** Answers of the misconceptions that apply to the class; a missing one does not apply. */
	wrong: Record<string, string[]>;
	/** Misconceptions every instance of the class must expose. */
	required: string[];
}

const kt = (s: string): string => JSON.stringify(s);

// --- Intern -------------------------------------------------------------------------------------------------------

const COPY_PLOTS = [
	{ cls: 'ProfileState', s: 'name', n: 'likes', def: 'guest', values: ['anna', 'oleg', 'mila', 'ivan', 'yana'] },
	{ cls: 'ChatState', s: 'title', n: 'unread', def: 'chat', values: ['work', 'family', 'news', 'sport', 'school'] },
	{ cls: 'OrderState', s: 'status', n: 'items', def: 'new', values: ['paid', 'sent', 'packed', 'done', 'held'] }
] as const;

type CopyEvent = 'inc' | 'dec' | 'set';

function copyEvent(rng: Rng): Program {
	const plot = rng.pick(COPY_PLOTS);
	const [first = '', second = ''] = rng.sample(plot.values, 2);
	const n0 = rng.int(1, 6);
	const up = rng.int(1, 3);
	const down = rng.int(1, 2);
	const lost: CopyEvent = rng.pick(['inc', 'dec', 'set'] as const);
	const events: CopyEvent[] = rng.shuffle<CopyEvent>([
		'inc',
		'dec',
		'set',
		...Array.from({ length: rng.int(1, 3) }, () => rng.pick(['inc', 'dec', 'set'] as const))
	]);
	const run = (mutates: boolean, resets: boolean): string[] => {
		let s: string = first;
		let n = n0;
		return events.map((e) => {
			if (e !== lost || mutates) {
				if (e === 'set') {
					s = second;
					if (resets) n = 0;
				} else {
					n += e === 'inc' ? up : -down;
					if (resets) s = plot.def;
				}
			}
			return `${s} ${n}`;
		});
	};
	const assign = (e: CopyEvent): string => (e === lost ? '' : 'state = ');
	const lines = [
		`data class ${plot.cls}(val ${plot.s}: String = ${kt(plot.def)}, val ${plot.n}: Int = 0)`,
		'',
		'fun main() {',
		`    var state = ${plot.cls}(${kt(first)}, ${n0})`,
		`    for (e in listOf(${events.map(kt).join(', ')})) {`,
		'        when (e) {',
		`            "inc" -> ${assign('inc')}state.copy(${plot.n} = state.${plot.n} + ${up})`,
		`            "dec" -> ${assign('dec')}state.copy(${plot.n} = state.${plot.n} - ${down})`,
		`            "set" -> ${assign('set')}state.copy(${plot.s} = ${kt(second)})`,
		'        }',
		`        println("\${state.${plot.s}} \${state.${plot.n}}")`,
		'    }',
		'}'
	];
	return {
		lines,
		answer: run(false, false),
		wrong: { 'copy-mutates': run(true, false), 'copy-resets-others': run(false, true) },
		required: ['copy-mutates', 'copy-resets-others']
	};
}

const FIELD_PLOTS = [
	{ cls: 'FormState', field: 'code', fn: 'codeField' },
	{ cls: 'PaymentState', field: 'amount', fn: 'amountField' },
	{ cls: 'LoginState', field: 'pin', fn: 'pinField' }
] as const;

const LETTERS = 'abcxyz';

function typedText(rng: Rng, length: number, extra = ''): string {
	const pool = `0123456789${LETTERS}${extra}`;
	return Array.from({ length }, () => pool.charAt(rng.int(0, pool.length - 1))).join('');
}

function hoistedCallback(rng: Rng): Program {
	const plot = rng.pick(FIELD_PLOTS);
	const rule = rng.pick(['digits', 'max', 'both'] as const);
	const max = rng.int(3, 4);
	const typed = typedText(rng, rng.int(5, 6));
	const accepts = (v: string): boolean => (rule === 'max' || /^\d*$/.test(v)) && (rule === 'digits' || v.length <= max);
	const check =
		rule === 'digits'
			? 'v.all { it.isDigit() }'
			: rule === 'max'
				? `v.length <= ${max}`
				: `v.all { it.isDigit() } && v.length <= ${max}`;
	let value = '';
	let shown = '';
	const answer: string[] = [];
	const keeps: string[] = [];
	for (const c of typed) {
		if (accepts(value + c)) value += c;
		shown += c;
		answer.push(value || '-');
		keeps.push(shown);
	}
	const lines = [
		`data class ${plot.cls}(val ${plot.field}: String = "")`,
		'',
		`fun ${plot.fn}(value: String, typed: Char, onValueChange: (String) -> Unit) {`,
		'    onValueChange(value + typed)',
		'}',
		'',
		'fun main() {',
		`    var state = ${plot.cls}()`,
		`    for (c in ${kt(typed)}) {`,
		`        ${plot.fn}(state.${plot.field}, c) { v -> if (${check}) state = state.copy(${plot.field} = v) }`,
		`        println(state.${plot.field}.ifEmpty { "-" })`,
		'    }',
		'}'
	];
	return { lines, answer, wrong: { 'child-keeps-input': keeps }, required: ['child-keeps-input'] };
}

function derivedVsStored(rng: Rng): Program {
	const cls = rng.pick(['CartState', 'BasketState', 'OrderState']);
	const count = rng.int(4, 6);
	const events: number[] = [];
	for (let i = 0; i < count; i += 1) {
		const pick = rng.int(0, 9);
		events.push(i >= 1 && pick < 3 ? -1 : i >= 2 && pick < 4 ? 0 : rng.int(1, 60) * 5);
	}
	const run = (inSync: boolean): string[] => {
		let items: number[] = [];
		let stored = 0;
		return events.map((e) => {
			if (e > 0) {
				items = [...items, e];
				stored += 1;
			} else if (e < 0) items = items.slice(0, -1);
			else items = [];
			const sum = items.reduce((a, b) => a + b, 0);
			return `${inSync ? items.length : stored} ${items.length} ${sum}`;
		});
	};
	const lines = [
		`data class ${cls}(val items: List<Int> = emptyList(), val count: Int = 0) {`,
		'    val total: Int get() = items.sum()',
		'}',
		'',
		'fun main() {',
		`    var state = ${cls}()`,
		`    for (e in listOf(${events.join(', ')})) {`,
		'        state = when {',
		'            e > 0 -> state.copy(items = state.items + e, count = state.count + 1)',
		'            e < 0 -> state.copy(items = state.items.dropLast(1))',
		'            else -> state.copy(items = emptyList())',
		'        }',
		'        println("${state.count} ${state.items.size} ${state.total}")',
		'    }',
		'}'
	];
	return { lines, answer: run(false), wrong: { 'stored-in-sync': run(true) }, required: ['stored-in-sync'] };
}

function localVsHoisted(rng: Rng): Program {
	const cls = rng.pick(['Stepper', 'Counter', 'Rating']);
	const start = rng.int(1, 5);
	const reset = rng.int(0, 2);
	const events = Array.from({ length: rng.int(4, 6) }, (_, i) => (i > 0 && rng.bool(0.35) ? 'reset' : 'tap'));
	const run = (follows: boolean): string[] => {
		let hoisted = start;
		let local = start;
		return events.map((e) => {
			if (e === 'tap') {
				local += 1;
				hoisted += 1;
			} else hoisted = reset;
			return `${hoisted} ${follows ? hoisted : local}`;
		});
	};
	const lines = [
		`class ${cls}(initial: Int) {`,
		'    var local = initial',
		'    fun tap(onTap: () -> Unit) { local++; onTap() }',
		'}',
		'',
		'fun main() {',
		`    var hoisted = ${start}`,
		`    val child = ${cls}(hoisted)`,
		`    for (e in listOf(${events.map(kt).join(', ')})) {`,
		`        if (e == "tap") child.tap { hoisted++ } else hoisted = ${reset}`,
		'        println("$hoisted ${child.local}")',
		'    }',
		'}'
	];
	return {
		lines,
		answer: run(false),
		wrong: { 'local-follows-parent': run(true) },
		required: ['local-follows-parent']
	};
}

// --- Junior -------------------------------------------------------------------------------------------------------

function validationDerived(rng: Rng): Program {
	const plot = rng.pick(FIELD_PLOTS);
	const cls = plot.cls;
	const size = rng.int(3, 5);
	const typed = typedText(rng, rng.int(6, 8), '<<');
	const next = (value: string, c: string): string => (c === '<' ? value.slice(0, -1) : value + c);
	const accepts = (v: string): boolean => /^\d*$/.test(v) && v.length <= size;
	let value = '';
	let own = '';
	const answer: string[] = [];
	const keeps: string[] = [];
	const fromAttempt: string[] = [];
	for (const c of typed) {
		const attempt = next(value, c);
		if (accepts(attempt)) value = attempt;
		own = next(own, c);
		answer.push(`${value || '-'} ${value.length === size}`);
		keeps.push(`${own || '-'} ${own.length === size}`);
		fromAttempt.push(`${value || '-'} ${attempt.length === size}`);
	}
	const f = plot.field;
	const lines = [
		`data class ${cls}(val ${f}: String = "") {`,
		`    val canSubmit: Boolean get() = ${f}.length == ${size}`,
		'}',
		'',
		`fun ${plot.fn}(value: String, typed: Char, onValueChange: (String) -> Unit) {`,
		"    onValueChange(if (typed == '<') value.dropLast(1) else value + typed)",
		'}',
		'',
		'fun main() {',
		`    var state = ${cls}()`,
		`    for (c in ${kt(typed)}) {`,
		`        ${plot.fn}(state.${f}, c) { v ->`,
		`            if (v.all { it.isDigit() } && v.length <= ${size}) state = state.copy(${f} = v)`,
		'        }',
		`        println("\${state.${f}.ifEmpty { "-" }} \${state.canSubmit}")`,
		'    }',
		'}'
	];
	return {
		lines,
		answer,
		wrong: { 'child-keeps-input': keeps, 'derived-from-attempt': fromAttempt },
		required: ['child-keeps-input', 'derived-from-attempt']
	};
}

const TITLES = ['milk', 'bread', 'eggs', 'tea', 'rice', 'jam', 'salt', 'figs', 'nuts', 'kale'];

function staleCopy(rng: Rng): Program {
	const pool = rng.shuffle(TITLES);
	const items = [1, 2, 3].map((id) => ({ id, title: pool.shift() ?? '' }));
	const count = rng.int(5, 6);
	const events: string[] = [];
	let current = items.map((x) => ({ ...x }));
	const select = rng.int(1, 3);
	events.push(`select ${select}`);
	for (let i = 1; i < count; i += 1) {
		const pick = rng.int(0, 9);
		if (pick < 4) {
			const target = rng.pick(current);
			const title = pool.shift() ?? 'pie';
			events.push(`rename ${target.id} ${title}`);
			current = current.map((x) => (x.id === target.id ? { ...x, title } : x));
		} else if (pick < 6 && current.length > 1) {
			const target = rng.pick(current);
			events.push(`remove ${target.id}`);
			current = current.filter((x) => x.id !== target.id);
		} else events.push(`select ${rng.int(1, 3)}`);
	}
	const run = (inSync: boolean): string[] => {
		let list = items.map((x) => ({ ...x }));
		let selectedId: number | null = null;
		let stored: string | null = null;
		return events.map((e) => {
			const [kind = '', idText = '', title = ''] = e.split(' ');
			const id = Number(idText);
			if (kind === 'select') {
				selectedId = id;
				stored = list.find((x) => x.id === id)?.title ?? null;
			} else if (kind === 'rename') list = list.map((x) => (x.id === id ? { ...x, title } : x));
			else list = list.filter((x) => x.id !== id);
			const derived = list.find((x) => x.id === selectedId)?.title ?? '-';
			return `${inSync ? derived : (stored ?? '-')} ${derived}`;
		});
	};
	const lines = [
		'data class Item(val id: Int, val title: String)',
		'',
		'data class ListState(val items: List<Item>, val selectedId: Int? = null, val selectedTitle: String? = null) {',
		'    val selected: Item? get() = items.find { it.id == selectedId }',
		'}',
		'',
		'fun main() {',
		`    var state = ListState(listOf(${items.map((x) => `Item(${x.id}, ${kt(x.title)})`).join(', ')}))`,
		`    for (e in listOf(${events.map(kt).join(', ')})) {`,
		'        val p = e.split(" ")',
		'        val id = p[1].toInt()',
		'        state = when (p[0]) {',
		'            "select" -> state.copy(selectedId = id, selectedTitle = state.items.find { it.id == id }?.title)',
		'            "rename" -> state.copy(items = state.items.map { if (it.id == id) it.copy(title = p[2]) else it })',
		'            else -> state.copy(items = state.items.filter { it.id != id })',
		'        }',
		'        println("${state.selectedTitle ?: "-"} ${state.selected?.title ?: "-"}")',
		'    }',
		'}'
	];
	return { lines, answer: run(false), wrong: { 'stored-in-sync': run(true) }, required: ['stored-in-sync'] };
}

const TAGS = ['kotlin', 'ui', 'draft', 'work', 'idea', 'todo', 'news', 'home'];

function shallowCopy(rng: Rng): Program {
	const cls = rng.pick(['DraftState', 'NoteState', 'PostState']);
	const tags = rng.shuffle(TAGS);
	const titles = rng.sample(['Notes', 'Plan', 'Trip', 'Ideas', 'Recipe'], 3);
	const count = rng.int(4, 6);
	const events: string[] = Array.from({ length: count }, () => {
		const kind = rng.pick(['tag', 'tag', 'pin', 'title'] as const);
		return `${kind}:${kind === 'title' ? (titles.shift() ?? 'Memo') : (tags.shift() ?? 'misc')}`;
	});
	type Snapshot = { title: string; tags: string[] };
	const run = (mode: 'right' | 'deep' | 'shared'): string[] => {
		const shared: string[] = [];
		let state: Snapshot = { title: 'new', tags: shared };
		const history: Snapshot[] = [state];
		return events.map((e) => {
			const [kind = '', v = ''] = e.split(':');
			if (kind === 'tag') {
				state = { ...state, tags: mode === 'deep' ? [...state.tags] : state.tags };
				state.tags.push(v);
			} else if (kind === 'pin') {
				if (mode === 'shared') state.tags.push(v);
				else state = { ...state, tags: [...state.tags, v] };
				if (mode === 'shared') state = { ...state };
			} else state = { title: v, tags: mode === 'deep' ? [...state.tags] : state.tags };
			history.push(state);
			const first = history[0] as Snapshot;
			const previous = history[history.length - 2] as Snapshot;
			return `${state.title} ${state.tags.length} ${first.tags.length} ${previous.tags.length}`;
		});
	};
	const lines = [
		`data class ${cls}(val title: String, val tags: MutableList<String>)`,
		'',
		'fun main() {',
		`    var state = ${cls}("new", mutableListOf())`,
		`    val history = mutableListOf(state)`,
		`    for (e in listOf(${events.map(kt).join(', ')})) {`,
		'        val (kind, v) = e.split(":")',
		'        state = when (kind) {',
		'            "tag" -> state.copy().also { it.tags.add(v) }',
		'            "pin" -> state.copy(tags = (state.tags + v).toMutableList())',
		'            else -> state.copy(title = v)',
		'        }',
		'        history.add(state)',
		'        println("${state.title} ${state.tags.size} ${history.first().tags.size} ${history[history.size - 2].tags.size}")',
		'    }',
		'}'
	];
	return {
		lines,
		answer: run('right'),
		wrong: { 'deep-copy': run('deep'), 'all-shared': run('shared') },
		required: ['deep-copy', 'all-shared']
	};
}

const SUGGESTIONS = ['#news', '#sale', '#ui', '#kotlin', '#top'];

function staleParam(rng: Rng): Program {
	const cls = rng.pick(['SearchState', 'FilterState', 'QueryState']);
	const tag = rng.pick(SUGGESTIONS);
	const limit = rng.int(7, 10);
	const length = rng.int(5, 6);
	const chars = Array.from({ length }, (_, i) =>
		i > 0 && rng.bool(0.35) ? '#' : LETTERS.charAt(rng.int(0, LETTERS.length - 1))
	);
	const typed = chars.join('');
	const run = (updates: boolean): string[] => {
		let query = '';
		let edits = 0;
		const change = (v: string): void => {
			if (v.length <= limit) {
				query = v;
				edits += 1;
			}
		};
		return chars.map((c) => {
			const value = query;
			change(value + c);
			if (c === '#') change((updates ? query : value) + tag);
			return `${query || '-'} ${edits}`;
		});
	};
	const lines = [
		`data class ${cls}(val query: String = "", val edits: Int = 0)`,
		'',
		'fun searchBar(value: String, typed: Char, onValueChange: (String) -> Unit) {',
		'    onValueChange(value + typed)',
		`    if (typed == '#') onValueChange(value + ${kt(tag)})`,
		'}',
		'',
		'fun main() {',
		`    var state = ${cls}()`,
		`    for (c in ${kt(typed)}) {`,
		'        searchBar(state.query, c) { v ->',
		`            if (v.length <= ${limit}) state = state.copy(query = v, edits = state.edits + 1)`,
		'        }',
		'        println("${state.query.ifEmpty { "-" }} ${state.edits}")',
		'    }',
		'}'
	];
	return {
		lines,
		answer: run(false),
		wrong: { 'param-updates-in-call': run(true) },
		required: ['param-updates-in-call']
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/copy-event': copyEvent,
	'intern/hoisted-callback': hoistedCallback,
	'intern/derived-vs-stored': derivedVsStored,
	'intern/local-vs-hoisted': localVsHoisted,
	'junior/validation-derived': validationDerived,
	'junior/stale-copy': staleCopy,
	'junior/shallow-copy': shallowCopy,
	'junior/stale-param': staleParam
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = PROGRAMS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId}`);
	// Programs are drawn until every misconception the class must expose changes the output.
	for (let tries = 0; tries < 400; tries += 1) {
		const program = make(rng);
		const same = (lines: readonly string[]): boolean => lines.join('\n') === program.answer.join('\n');
		if (program.required.some((id) => same(program.wrong[id] ?? program.answer))) continue;
		const source = program.lines.join('\n');
		const run = kotlinProgram(source);
		const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown:
					'Программа моделирует однонаправленный поток данных экрана без Compose: каждое событие меняет состояние, после события печатается «отрисовка». Что напечатает программа на Kotlin? Введите вывод построчно, как он появится на экране.',
				code: { language: 'kotlin', source }
			},
			answer: toAnswer(program.answer)
		});
		return {
			instance,
			reference: () => kotlinOutputProbe(run),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						// A misconception that gives the right output on this instance does not apply to it.
						const lines = program.wrong[id];
						return [id, !lines || same(lines) ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
