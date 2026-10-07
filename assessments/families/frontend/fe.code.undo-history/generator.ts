// Practice: the undo/redo history of a form editor over a log of commands. The class sets how edits become records
// (runs of edits of one field merged, a depth limit, transactions, runs merged within a time window); Senior has
// transactions with rollback in every class and nested ones in the anchor. The step «измени своё решение» adds a
// limit on the total size of the history.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['javascript', 'typescript'] as const;
const CHANGE_WEIGHT = 0.3;

const descriptor = readDescriptor(import.meta.url);

type Ev =
	| { t: number; op: 'set'; field: number; value: string }
	| { t: number; op: 'undo' | 'redo' | 'begin' | 'commit' | 'rollback' };

interface Input {
	fields: string[];
	init: string[];
	/** D of the depth class, W of the time class, 0 otherwise. */
	param: number;
	memory: number | null;
	events: Ev[];
}

/** The wrong solutions and, for the boundary tests, each edge of the rule shifted alone. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'window-strict' | 'depth-plus';
const WRONG_IDS = [
	'redo-kept',
	'noop-recorded',
	'run-survives-undo',
	'depth-before-truncate',
	'empty-transaction-recorded'
] as const;

interface Change {
	field: number;
	old: string;
	now: string;
}

const isMerge = (classId: string): boolean => classId === 'merge-runs' || classId === 'time-merge';

/** The editor with its history; a variant other than `right` reproduces a wrong solution. */
class Editor {
	readonly state: string[];
	readonly hist: Change[][] = [];
	p = 0;
	run: { field: number; t: number } | null = null;
	readonly snaps: string[][] = [];
	readonly merge: boolean;
	readonly tx: boolean;
	readonly nested: boolean;
	readonly senior: boolean;
	readonly depth: number;
	readonly window: number;
	readonly memory: number | null;
	readonly variant: Variant;

	constructor(classId: string, senior: boolean, input: Input, variant: Variant) {
		this.state = [...input.init];
		this.merge = isMerge(classId);
		this.tx = senior || classId === 'transactions';
		this.nested = senior && classId === 'transactions';
		this.senior = senior;
		this.depth = classId === 'depth-limit' ? input.param + (variant === 'depth-plus' ? 1 : 0) : Infinity;
		this.window = classId === 'time-merge' ? input.param : Infinity;
		this.memory = input.memory;
		this.variant = variant;
	}

	trim(): void {
		while (this.hist.length > this.depth) this.drop();
		const size = (): number => this.hist.flat().reduce((s, c) => s + c.old.length + c.now.length, 0);
		while (this.memory !== null && size() > this.memory) this.drop();
	}

	drop(): void {
		this.hist.shift();
		this.p -= 1;
	}

	add(rec: Change[]): void {
		if (this.variant === 'depth-before-truncate' && this.p > 0 && this.hist.length >= this.depth) this.drop();
		if (this.variant !== 'redo-kept') this.hist.length = this.p;
		this.hist.push(rec);
		this.p = this.hist.length;
		this.trim();
	}

	show(): string {
		return this.state.join(' ');
	}

	/** Applies a command; the line it prints, if any. */
	apply(e: Ev): string | null {
		const keepRun = this.variant === 'run-survives-undo';
		if (e.op === 'set') {
			const f = e.field;
			if (e.value === this.state[f] && this.variant !== 'noop-recorded') return null;
			if (this.snaps.length > 0) {
				this.state[f] = e.value;
				return null;
			}
			const old = this.state[f] ?? '';
			const gap = this.run === null ? 0 : e.t - this.run.t;
			const near = this.variant === 'window-strict' ? gap < this.window : gap <= this.window;
			if (this.merge && this.run?.field === f && near && (!keepRun || this.p > 0)) {
				if (keepRun) this.hist.length = this.p;
				const top = this.hist[this.hist.length - 1] ?? [];
				const change = top.find((c) => c.field === f);
				if (change) change.now = e.value;
				else top.push({ field: f, old, now: e.value });
				this.trim();
			} else this.add([{ field: f, old, now: e.value }]);
			this.state[f] = e.value;
			if (this.merge) this.run = this.hist.length > 0 ? { field: f, t: e.t } : null;
			return null;
		}
		if (e.op === 'undo' || e.op === 'redo') {
			if (!keepRun) this.run = null;
			const blocked = this.senior && this.snaps.length > 0;
			if (e.op === 'undo') {
				const rec = this.hist[this.p - 1];
				if (blocked || !rec) return 'skip';
				this.p -= 1;
				for (const c of rec) this.state[c.field] = c.old;
			} else {
				const rec = this.hist[this.p];
				if (blocked || !rec) return 'skip';
				for (const c of rec) this.state[c.field] = c.now;
				this.p += 1;
			}
			return this.show();
		}
		if (!this.tx) return null;
		this.run = null;
		if (e.op === 'begin') {
			if (this.nested || this.snaps.length === 0) this.snaps.push([...this.state]);
			return null;
		}
		const start = this.snaps.pop();
		if (!start) return null;
		if (e.op === 'rollback') {
			start.forEach((v, i) => (this.state[i] = v));
			return null;
		}
		if (this.snaps.length === 0) {
			const rec = start.flatMap((old, i) =>
				old === this.state[i] ? [] : [{ field: i, old, now: this.state[i] ?? '' }]
			);
			if (rec.length > 0 || this.variant === 'empty-transaction-recorded') this.add(rec);
		}
		return null;
	}
}

function simulate(classId: string, senior: boolean, input: Input, variant: Variant = 'right'): string {
	const editor = new Editor(classId, senior, input, variant);
	const out: string[] = [];
	for (const e of input.events) {
		const line = editor.apply(e);
		if (line !== null) out.push(line);
	}
	out.push(editor.show());
	return `${out.join('\n')}\n`;
}

function render(input: Input): string {
	const head = [
		input.fields.length,
		input.events.length,
		...(input.param > 0 ? [input.param] : []),
		...(input.memory === null ? [] : [input.memory])
	].join(' ');
	const events = input.events.map((e) =>
		e.op === 'set' ? `${e.t} set ${input.fields[e.field] ?? ''} ${e.value}` : `${e.t} ${e.op}`
	);
	return `${[head, ...input.fields.map((f, i) => `${f} ${input.init[i] ?? ''}`), ...events].join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Logs of commands.

const FIELDS = ['title', 'price', 'color', 'size', 'note', 'tag', 'city', 'qty', 'email', 'status'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const token = (rng: Rng): string =>
	Array.from({ length: rng.int(1, 5) }, () => ALPHABET[rng.int(0, ALPHABET.length - 1)] ?? 'a').join('');

type GroupId = 'basic' | 'branch' | 'mechanism' | 'edge' | 'scale';
type Move = 'set' | 'noop' | 'revert' | 'burst' | 'undo' | 'redo' | 'fork' | 'unwind' | 'tx' | 'emptyTx' | 'txUndo';

function moves(classId: string, senior: boolean, group: GroupId): [Move, number][] {
	const merge = isMerge(classId);
	const tx = senior || classId === 'transactions';
	const depth = classId === 'depth-limit';
	const list: [Move, number][] = [
		['set', 26],
		['revert', 6],
		['noop', group === 'edge' ? 16 : 3],
		['burst', merge ? (group === 'mechanism' ? 35 : 10) : 4],
		['undo', group === 'edge' ? 20 : 12],
		['redo', group === 'edge' ? 16 : 8],
		['fork', group === 'branch' ? 30 : depth && group === 'mechanism' ? 20 : 6],
		['unwind', depth ? (group === 'mechanism' || group === 'edge' ? 25 : 10) : 3]
	];
	if (tx) {
		const heavy = group === 'mechanism' && classId === 'transactions';
		list.push(['tx', heavy ? 40 : 8], ['emptyTx', heavy || group === 'mechanism' ? 12 : 2]);
		if (senior) list.push(['txUndo', group === 'edge' ? 10 : 2]);
	}
	return list;
}

function makeInput(
	rng: Rng,
	classId: string,
	senior: boolean,
	group: GroupId,
	withMemory: boolean,
	size: number | null = null
): Input {
	const count = group === 'scale' ? 5 : rng.int(3, 5);
	const fields = rng.sample(FIELDS, count);
	const input: Input = {
		fields,
		init: fields.map(() => token(rng)),
		param: classId === 'depth-limit' ? rng.int(3, 6) : classId === 'time-merge' ? rng.pick([10, 20, 30, 50]) : 0,
		memory: withMemory ? rng.int(6, 20) : null,
		events: []
	};
	const editor = new Editor(classId, senior, input, 'right');
	const target = size ?? (group === 'scale' ? rng.int(1200, 1500) : rng.int(20, 32));
	const list = moves(classId, senior, group);
	const total = list.reduce((s, [, w]) => s + w, 0);
	let t = rng.int(0, 100);
	const recent = new Map<number, string>();
	const gap = (): number => {
		if (classId !== 'time-merge') return rng.int(0, 40);
		const w = input.param;
		return rng.pick([0, rng.int(1, w - 1), w, w, w + 1, rng.int(w + 2, 3 * w)]);
	};
	const push = (e: Ev): void => {
		if (e.op === 'set') recent.set(e.field, editor.state[e.field] ?? '');
		editor.apply(e);
		input.events.push(e);
	};
	const set = (field: number, value: string): void => {
		push({ t: (t += gap()), op: 'set', field, value });
	};
	const cmd = (op: 'undo' | 'redo' | 'begin' | 'commit' | 'rollback'): void => {
		push({ t: (t += rng.int(0, 2)), op });
	};
	const field = (): number => rng.int(0, count - 1);
	const other = (f: number): number => (f + rng.int(1, count - 1)) % count;
	const undos = (k: number, op: 'undo' | 'redo' = 'undo'): void => {
		for (let i = 0; i < k; i += 1) cmd(op);
	};
	/** Often follows a move with an undo, so that the record the move made shows. */
	const reveal = (chance: number): void => {
		if (rng.bool(chance)) undos(rng.int(1, 2));
	};
	let last = 0;
	while (input.events.length < target) {
		let roll = rng.int(1, total);
		const move = list.find(([, w]) => (roll -= w) <= 0)?.[0] ?? 'set';
		if (move === 'set') set((last = field()), token(rng));
		else if (move === 'noop') {
			const f = field();
			set(f, editor.state[f] ?? '');
			reveal(0.7);
		} else if (move === 'revert') {
			const f = field();
			set(f, recent.get(f) ?? token(rng));
		} else if (move === 'burst') {
			last = field();
			for (let k = rng.int(2, 4); k > 0; k -= 1) set(last, token(rng));
			reveal(0.6);
		} else if (move === 'undo' || move === 'redo') undos(rng.int(1, move === 'undo' ? 3 : 2), move);
		else if (move === 'fork') {
			// Records of alternating fields, an undo, an edit (often of the field of the last record), then undo past
			// the new record; the depth class fills its history first.
			const k = rng.int(1, 2);
			const depth = classId === 'depth-limit' ? input.param : 0;
			for (let i = Math.max(k + 1, depth); i > 0; i -= 1) set((last = other(last)), token(rng));
			undos(k);
			set(rng.bool(0.7) ? last : field(), token(rng));
			undos(depth > 0 ? depth + 1 : k + rng.int(1, 2));
		} else if (move === 'unwind') {
			const d = classId === 'depth-limit' ? input.param : 3;
			for (let k = rng.int(d, d + 2); k > 0; k -= 1) set((last = field()), token(rng));
			undos(rng.int(d, d + 2));
		} else if (move === 'emptyTx') {
			cmd('begin');
			if (rng.bool()) {
				const f = field();
				const before = editor.state[f] ?? '';
				set(f, token(rng));
				set(f, before);
			}
			cmd('commit');
			reveal(0.7);
		} else if (move === 'txUndo') {
			cmd('begin');
			set(field(), token(rng));
			cmd(rng.bool() ? 'undo' : 'redo');
			cmd(rng.bool(0.7) ? 'commit' : 'rollback');
		} else {
			cmd('begin');
			for (let k = rng.int(1, 3); k > 0; k -= 1) set(field(), token(rng));
			if (editor.nested && rng.bool(0.6)) {
				cmd('begin');
				for (let k = rng.int(1, 2); k > 0; k -= 1) set(field(), token(rng));
				cmd(rng.bool() ? 'commit' : 'rollback');
				if (rng.bool(0.5)) set(field(), token(rng));
			}
			cmd(senior && rng.bool(0.3) ? 'rollback' : 'commit');
			reveal(0.5);
		}
	}
	return input;
}

/** The mistakes a group must expose on every test of the main task, by class. */
function traps(classId: string, senior: boolean, group: GroupId): Variant[] {
	const list: Variant[] = [];
	const merge = isMerge(classId);
	const tx = senior || classId === 'transactions';
	if (group === 'branch') list.push('redo-kept', ...(merge ? (['run-survives-undo'] as const) : []));
	if (group === 'mechanism') {
		if (classId === 'depth-limit') list.push('depth-before-truncate', 'depth-plus');
		if (classId === 'time-merge') list.push('window-strict');
		if (tx) list.push('empty-transaction-recorded');
	}
	if (group === 'edge') {
		list.push('noop-recorded');
		if (classId === 'time-merge') list.push('window-strict');
		if (classId === 'depth-limit') list.push('depth-plus');
	}
	return list;
}

/** Hidden tests of the class; every test tells the class from the others, and the step's tests feel the limit. */
function groups(
	rng: Rng,
	classId: string,
	others: readonly string[],
	senior: boolean,
	withMemory: boolean
): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'branch', 'mechanism', 'edge', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 5;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${classId}`);
			const input = makeInput(rng, classId, senior, id, withMemory);
			const expected = simulate(classId, senior, input);
			if (withMemory) {
				// The step's tests feel the limit; the main tests tell the class from the others and expose the mistakes.
				if (simulate(classId, senior, { ...input, memory: null }) === expected) continue;
			} else if (
				others.some((other) => simulate(other, senior, input) === expected) ||
				traps(classId, senior, id).some((v) => simulate(classId, senior, input, v) === expected)
			)
				continue;
			tests.push({ stdin: render(input), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function classRule(classId: string, senior: boolean): string[] {
	const runEnd = senior
		? 'Серию прерывает любая другая команда: `set` другого поля, `undo` и `redo` (даже `skip`), `begin`, `commit`, `rollback`; правки внутри транзакции в серии не участвуют.'
		: 'Серию прерывает любая другая команда: `set` другого поля, `undo` и `redo` (даже `skip`).';
	switch (classId) {
		case 'merge-runs':
			return [
				'**Серии правок.** `set`, меняющий значение поля, не создаёт новую запись, а дополняет последнюю, если предыдущая команда журнала (не считая `set` без изменения значения) — тоже `set` этого поля, который создал или дополнил эту запись. Дополненная запись хранит «было» до первой правки серии и «стало» последней правки.',
				runEnd
			];
		case 'time-merge':
			return [
				'**Серии правок по времени.** `set`, меняющий значение поля в момент `t`, не создаёт новую запись, а дополняет последнюю, если предыдущая команда журнала (не считая `set` без изменения значения) — `set` этого поля в момент `t′`, который создал или дополнил эту запись, и `t − t′ ≤ W`. Дополненная запись хранит «было» до первой правки серии и «стало» последней правки.',
				runEnd
			];
		case 'depth-limit':
			return [
				'**Глубина истории.** После добавления записи, если записей в истории больше `D`, самые старые удаляются, пока их не станет `D`: отменить удалённую запись уже нельзя.'
			];
		default:
			return senior
				? [
						'**Вложенные транзакции.** `begin` внутри открытой транзакции открывает вложенную. `commit` вложенной транзакции закрывает её, её правки остаются частью внешней; `rollback` вложенной возвращает поля к значениям на момент её `begin`. Запись в истории создаёт только `commit` самой внешней транзакции — по полям, значения которых отличаются от значений на момент её `begin`.'
					]
				: [];
	}
}

function transactionRule(classId: string, senior: boolean): string[] {
	if (!senior && classId !== 'transactions') return [];
	return [
		`**Транзакции.** \`set\` между \`begin\` и \`commit\` меняет поле сразу, но записи не создаёт. \`commit\` создаёт одну запись по всем полям, значение которых на момент \`commit\` отличается от значения на момент \`begin\` («было» — на \`begin\`, «стало» — на \`commit\`); если таких полей нет, запись не создаётся и отменённые записи остаются.${
			senior
				? ' `rollback` закрывает транзакцию, возвращает поля к значениям на момент `begin` и записи не создаёт. Внутри открытой транзакции `undo` и `redo` печатают `skip` и ничего не меняют.'
				: ' Внутри транзакции `undo` и `redo` не встречаются.'
		}${senior && classId !== 'transactions' ? ' Транзакции не вложены.' : ''}${!senior ? ' Транзакции не вложены.' : ''}`
	];
}

function headerText(classId: string, withMemory: boolean): string {
	const param = classId === 'depth-limit' ? ' D' : classId === 'time-merge' ? ' W' : '';
	return `\`F E${param}${withMemory ? ' M' : ''}\``;
}

function statement(classId: string, senior: boolean, example: Input): string {
	const tx = senior || classId === 'transactions';
	const param =
		classId === 'depth-limit'
			? ', глубина истории `D` (1 ≤ D ≤ 100)'
			: classId === 'time-merge'
				? ', окно `W` в мс (1 ≤ W ≤ 10⁴)'
				: '';
	return [
		'Редактор формы хранит историю изменений для отмены и повтора (как Ctrl+Z и Ctrl+Shift+Z). Напишите программу, которая выполняет журнал команд редактора и печатает, что видит пользователь.',
		'',
		'## Вход',
		'',
		`В первой строке — ${headerText(classId, false)}: число полей (1 ≤ F ≤ 10), число команд (1 ≤ E ≤ 2000)${param}. Далее \`F\` строк \`<поле> <значение>\` — поля формы и их начальные значения. Далее \`E\` строк команд \`t <команда>\`, где \`t\` — момент в мс (0 ≤ t ≤ 10⁹, моменты не убывают):`,
		'',
		'- `t set <поле> <значение>` — пользователь меняет значение поля;',
		'- `t undo` — отменить; `t redo` — повторить;',
		...(tx ? [`- \`t begin\`, \`t commit\`${senior ? ', `t rollback`' : ''} — транзакция (см. ниже).`] : []),
		'',
		'Имена полей и значения — непустые строки из латинских строчных букв и цифр.',
		'',
		'## Правила',
		'',
		'История — список записей и указатель в нём. Запись хранит для одного или нескольких полей значения «было» и «стало». Записи левее указателя применены и их можно отменить, правее — отменены и их можно повторить.',
		'',
		'- `set` со значением, равным текущему значению поля, ничего не делает.',
		'- `set`, меняющий значение, меняет поле и добавляет запись «поле: было → стало». Добавление записи удаляет все отменённые записи (правее указателя); запись встаёт в конец, указатель — за ней.',
		'- `undo`: если применённых записей нет — печатается `skip`; иначе последняя применённая запись отменяется (её поля получают значения «было»), указатель сдвигается влево.',
		'- `redo`: если отменённых записей нет — печатается `skip`; иначе первая отменённая запись применяется снова (её поля получают значения «стало»), указатель сдвигается вправо.',
		'',
		...transactionRule(classId, senior).flatMap((line) => [line, '']),
		...classRule(classId, senior).flatMap((line) => [line, '']),
		'## Выход',
		'',
		'Для каждой команды `undo` и `redo` — строка: `skip` или значения всех полей после команды через пробел в порядке полей во входе. В конце — ещё одна строка: значения всех полей после всего журнала.',
		'',
		'## Пример',
		'',
		'Вход:',
		'',
		'```',
		render(example).trimEnd(),
		'```',
		'',
		'Выход:',
		'',
		'```',
		simulate(classId, senior, example).trimEnd(),
		'```',
		'',
		'Скрытые тесты — пять групп: обычные журналы, отмена с новой правкой после неё, правило истории, граничные случаи, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

function changeStatement(classId: string): string {
	return [
		'**Новое условие.** История ограничена по памяти. Запись занимает сумму длин значений «было» и «стало» всех своих полей. После каждого добавления записи' +
			(isMerge(classId) ? ' и каждого дополнения записи серией' : '') +
			' самые старые записи удаляются, пока суммарный размер истории больше `M`; может удалиться и только что добавленная запись, тогда история пуста' +
			(isMerge(classId) ? ', и следующая правка начинает новую запись' : '') +
			'.' +
			(classId === 'depth-limit' ? ' Лимит глубины `D` действует, как прежде.' : ''),
		`Первая строка входа теперь ${headerText(classId, true)} (1 ≤ M ≤ 1000). Измените решение и отправьте его снова; формат вывода прежний.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The reference in Python and the wrong solutions.

function referenceSource(classId: string, senior: boolean, withMemory: boolean, variant: Variant): string {
	const merge = isMerge(classId);
	const tx = senior || classId === 'transactions';
	const depth = classId === 'depth-limit';
	const timed = classId === 'time-merge';
	const keepRun = variant === 'run-survives-undo';
	const head = ['f', 'e', ...(depth ? ['depth'] : timed ? ['window'] : []), ...(withMemory ? ['cap'] : [])];
	const trimmed = depth || withMemory;
	const blocked = senior ? 'snaps or ' : '';
	const lines: string[] = [
		'import sys',
		'',
		"data = sys.stdin.read().split('\\n')",
		`${head.join(', ')} = map(int, data[0].split())`,
		'state = dict(line.split() for line in data[1:f + 1])',
		'hist, p, run, snaps = [], 0, None, []',
		''
	];
	if (trimmed) {
		lines.push(
			'',
			'def trim():',
			'    global p',
			...(depth ? ['    while len(hist) > depth:', '        hist.pop(0)', '        p -= 1'] : []),
			...(withMemory
				? [
						'    while sum(len(old) + len(new) for rec in hist for old, new in rec.values()) > cap:',
						'        hist.pop(0)',
						'        p -= 1'
					]
				: []),
			''
		);
	}
	lines.push(
		'',
		'def add(rec):',
		'    global p',
		...(variant === 'depth-before-truncate'
			? ['    if p and len(hist) >= depth:', '        hist.pop(0)', '        p -= 1']
			: []),
		...(variant === 'redo-kept' ? [] : ['    del hist[p:]']),
		'    hist.append(rec)',
		'    p = len(hist)',
		...(trimmed ? ['    trim()'] : []),
		'',
		'',
		'for line in data[f + 1:f + 1 + e]:',
		'    t, op, *args = line.split()',
		"    if op == 'set':",
		'        name, value = args',
		...(variant === 'noop-recorded' ? [] : ['        if value == state[name]:', '            continue']),
		...(tx ? ['        if snaps:', '            state[name] = value', '            continue'] : [])
	);
	if (merge) {
		const near = timed ? ' and int(t) - run[1] <= window' : '';
		lines.push(
			keepRun ? `        if run and run[0] == name${near} and p:` : `        if run and run[0] == name${near}:`,
			...(keepRun
				? ['            del hist[p:]', '            hist[-1].setdefault(name, [state[name], value])[1] = value']
				: ['            hist[-1][name][1] = value']),
			...(trimmed ? ['            trim()'] : []),
			'        else:',
			'            add({name: [state[name], value]})',
			'        state[name] = value',
			'        run = (name, int(t)) if hist else None'
		);
	} else lines.push('        add({name: [state[name], value]})', '        state[name] = value');
	const reset = merge && !keepRun ? ['        run = None'] : [];
	lines.push(
		"    elif op == 'undo':",
		...reset,
		`        if ${blocked}p == 0:`,
		"            print('skip')",
		'        else:',
		'            p -= 1',
		'            for name, (old, new) in hist[p].items():',
		'                state[name] = old',
		"            print(' '.join(state.values()))",
		"    elif op == 'redo':",
		...reset,
		`        if ${blocked}p == len(hist):`,
		"            print('skip')",
		'        else:',
		'            for name, (old, new) in hist[p].items():',
		'                state[name] = new',
		'            p += 1',
		"            print(' '.join(state.values()))"
	);
	if (tx) {
		const runReset = merge ? ['        run = None'] : [];
		lines.push(
			"    elif op == 'begin':",
			...runReset,
			...(senior && classId === 'transactions'
				? ['        snaps.append(dict(state))']
				: ['        if not snaps:', '            snaps.append(dict(state))']),
			"    elif op == 'commit':",
			...runReset,
			'        if snaps:',
			'            start = snaps.pop()',
			'            if not snaps:',
			'                rec = {name: [start[name], state[name]] for name in state if start[name] != state[name]}',
			...(variant === 'empty-transaction-recorded'
				? ['                add(rec)']
				: ['                if rec:', '                    add(rec)'])
		);
		if (senior) {
			lines.push("    elif op == 'rollback':", ...runReset, '        if snaps:', '            state = snaps.pop()');
		}
	}
	lines.push("print(' '.join(state.values()))");
	return lines.join('\n');
}

function applies(id: (typeof WRONG_IDS)[number], classId: string, senior: boolean): boolean {
	switch (id) {
		case 'redo-kept':
		case 'noop-recorded':
			return true;
		case 'run-survives-undo':
			return isMerge(classId);
		case 'depth-before-truncate':
			return classId === 'depth-limit';
		case 'empty-transaction-recorded':
			return senior || classId === 'transactions';
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const classId = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== classId);
	const main = groups(rng, classId, others, senior, false);
	const step = groups(rng, classId, others, senior, true);
	const example = makeInput(rng, classId, senior, 'basic', false, 10);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(classId, senior, example), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(classId), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(classId, senior, false, 'right'),
			changeSource: referenceSource(classId, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, classId, senior)
						? { kind: 'program' as const, source: referenceSource(classId, senior, false, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
