// Keys in a React list: rows keep local state (a typed note, or a draft initialised from props) while the list
// changes. Which state ends up next to which item, and how many row instances are created and removed, follows from
// the keys. The generator simulates reconciliation by keys; the gate checks the answer with an independent Python
// program over the same list and steps.
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

interface Item {
	id: number;
	title: string;
}

type KeyMode = 'index' | 'id' | 'title';
type RowState = 'note' | 'draft';

type Step =
	| { kind: 'type'; row: number; text: string }
	| { kind: 'prepend' | 'append'; item: Item }
	| { kind: 'remove'; id: number }
	| { kind: 'sort' | 'reverse' }
	| { kind: 'top'; id: number }
	| { kind: 'rename'; id: number; title: string };

interface Scenario {
	keyMode: KeyMode;
	rowState: RowState;
	items: Item[];
	steps: Step[];
}

/** What a misconception changes in the model. */
interface Rules {
	/** The keys the reader assumes instead of the shown ones. */
	keyMode: KeyMode | null;
	/** A draft initialised from props follows later changes of the prop. */
	draftSyncs: boolean;
	/** Every change of the list creates every row anew. */
	remountAll: boolean;
}

const RIGHT: Rules = { keyMode: null, draftSyncs: false, remountAll: false };

interface Instance {
	key: string;
	value: string;
	typed: boolean;
}

function keyOf(mode: KeyMode, item: Item, index: number): string {
	return mode === 'index' ? `i${index}` : mode === 'id' ? `d${item.id}` : `t${item.title}`;
}

function applyList(items: readonly Item[], step: Step): Item[] {
	switch (step.kind) {
		case 'prepend':
			return [step.item, ...items];
		case 'append':
			return [...items, step.item];
		case 'remove':
			return items.filter((it) => it.id !== step.id);
		case 'sort':
			return [...items].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
		case 'reverse':
			return [...items].reverse();
		case 'top': {
			const found = items.find((it) => it.id === step.id);
			return found ? [found, ...items.filter((it) => it.id !== step.id)] : [...items];
		}
		case 'rename':
			return items.map((it) => (it.id === step.id ? { ...it, title: step.title } : it));
		case 'type':
			return [...items];
	}
}

function simulate(s: Scenario, rules: Rules): string[] {
	const mode = rules.keyMode ?? s.keyMode;
	const initial = (item: Item): Instance['value'] => (s.rowState === 'draft' ? item.title : '');
	let items = s.items;
	let rows: Instance[] = items.map((item, i) => ({ key: keyOf(mode, item, i), value: initial(item), typed: false }));
	let created = 0;
	let removed = 0;
	for (const step of s.steps) {
		if (step.kind === 'type') {
			const row = rows[step.row];
			if (row) {
				row.value = step.text;
				row.typed = true;
			}
			continue;
		}
		items = applyList(items, step);
		if (rules.remountAll) {
			removed += rows.length;
			created += items.length;
			rows = items.map((item, i) => ({ key: keyOf(mode, item, i), value: initial(item), typed: false }));
			continue;
		}
		const old = new Map(rows.map((r) => [r.key, r]));
		const next = items.map((item, i) => {
			const key = keyOf(mode, item, i);
			const kept = old.get(key);
			if (kept) {
				old.delete(key);
				return kept;
			}
			created += 1;
			return { key, value: initial(item), typed: false };
		});
		removed += old.size;
		rows = next;
	}
	const lines = items.map((item, i) => {
		const row = rows[i];
		const shown =
			row === undefined ? '' : rules.draftSyncs && !row.typed && s.rowState === 'draft' ? item.title : row.value;
		return `${item.title} ${shown === '' ? '-' : shown}`;
	});
	lines.push(`${created} ${removed}`);
	return lines;
}

// ---------------------------------------------------------------------------------------------------------------

const TITLES = [
	'milk',
	'bread',
	'tea',
	'rice',
	'eggs',
	'jam',
	'salt',
	'figs',
	'oats',
	'corn',
	'nuts',
	'plums',
	'beans',
	'honey',
	'kiwi',
	'lime'
] as const;
const NOTES = ['soon', 'later', 'urgent', 'check', 'two', 'gift', 'cheap', 'fresh', 'big', 'small'] as const;

class Draw {
	readonly rng: Rng;
	readonly titles: string[];
	readonly notes: string[];
	nextId: number;
	items: Item[];
	readonly steps: Step[] = [];

	constructor(rng: Rng, size: number) {
		this.rng = rng;
		this.titles = rng.shuffle(TITLES);
		this.notes = rng.shuffle(NOTES);
		const first = rng.int(1, 6);
		this.items = Array.from({ length: size }, (_, i) => ({ id: first + i, title: this.title() }));
		this.nextId = first + size + rng.int(0, 3);
	}

	title(): string {
		const t = this.titles.pop();
		if (!t) throw new Error('out of titles');
		return t;
	}

	newItem(): Item {
		const item = { id: this.nextId, title: this.title() };
		this.nextId += 1;
		return item;
	}

	push(step: Step): void {
		this.steps.push(step);
		this.items = applyList(this.items, step);
	}

	type(row: number): void {
		const text = this.notes.pop() ?? 'ok';
		this.push({ kind: 'type', row, text });
	}

	/** Positions of `count` distinct rows. */
	rows(count: number): number[] {
		return this.rng.sample(
			this.items.map((_, i) => i),
			Math.min(count, this.items.length)
		);
	}

	/** Moves the list so that the order really changes. */
	reorder(kind: 'sort' | 'reverse' | 'top'): void {
		if (kind === 'top') {
			const pick = this.items[this.rng.int(1, this.items.length - 1)];
			if (pick) this.push({ kind: 'top', id: pick.id });
			return;
		}
		// A list that is already sorted is reversed instead: sorting it would move nothing.
		const sorted = applyList(this.items, { kind: 'sort' });
		const moves = !sorted.every((it, i) => it === this.items[i]);
		this.push({ kind: kind === 'sort' && !moves ? 'reverse' : kind });
	}

	scenario(keyMode: KeyMode, rowState: RowState, initial: Item[]): Scenario {
		return { keyMode, rowState, items: initial, steps: this.steps };
	}
}

type ClassDraw = (d: Draw) => { keyMode: KeyMode; rowState: RowState };

const JUNIOR: Record<string, ClassDraw> = {
	// Index keys: a row inserted at the top takes the state of the old first row; the new instance is the last row.
	'index-insert': (d) => {
		for (const r of d.rows(2)) d.type(r);
		d.push({ kind: 'prepend', item: d.newItem() });
		if (d.rng.bool()) d.push({ kind: 'append', item: d.newItem() });
		d.type(d.rng.int(0, d.items.length - 1));
		return { keyMode: 'index', rowState: 'note' };
	},
	// Id keys: the state moves with its item; only the new item gets a new instance.
	'id-insert': (d) => {
		for (const r of d.rows(2)) d.type(r);
		d.push({ kind: 'prepend', item: d.newItem() });
		const victim = d.items[d.rng.int(1, d.items.length - 1)];
		if (victim) d.push({ kind: 'remove', id: victim.id });
		d.type(d.rng.int(0, d.items.length - 1));
		return { keyMode: 'id', rowState: 'note' };
	},
	// Index keys: removing a row in the middle keeps the states in place and removes the last instance.
	'index-remove': (d) => {
		const n = d.items.length;
		const cut = d.rng.int(0, n - 2);
		const typed = [d.rng.int(cut + 1, n - 1), ...d.rows(1)];
		for (const r of [...new Set(typed)]) d.type(r);
		const victim = d.items[cut];
		if (victim) d.push({ kind: 'remove', id: victim.id });
		if (d.rng.bool()) d.push({ kind: 'append', item: d.newItem() });
		return { keyMode: 'index', rowState: 'note' };
	},
	// Id keys: sorting, reversing or moving an item keeps every instance; the states travel with their items.
	'id-reorder': (d) => {
		for (const r of d.rows(3)) d.type(r);
		const kinds = d.rng.shuffle(['sort', 'reverse', 'top'] as const).slice(0, 2);
		for (const k of kinds) d.reorder(k);
		return { keyMode: 'id', rowState: 'note' };
	}
};

const MIDDLE: Record<string, ClassDraw> = {
	// Index keys with a draft initialised from props: after an insert and a sort the drafts stay by position and
	// show old titles; only the instance at the end is new and starts from its own title.
	'index-draft': (d) => {
		d.type(d.rng.int(0, d.items.length - 1));
		d.push({ kind: 'prepend', item: d.newItem() });
		d.reorder(d.rng.pick(['sort', 'reverse'] as const));
		d.type(d.rng.int(0, d.items.length - 1));
		const victim = d.items[d.rng.int(0, d.items.length - 1)];
		if (victim) d.push({ kind: 'remove', id: victim.id });
		return { keyMode: 'index', rowState: 'draft' };
	},
	// Id keys with a draft from props: the drafts move with the items, but a renamed item keeps its old draft.
	'id-mixed': (d) => {
		d.type(d.rng.int(0, d.items.length - 1));
		d.push({ kind: 'prepend', item: d.newItem() });
		const steps = d.rng.shuffle(['rename', 'reorder', 'remove'] as const);
		for (const s of steps) {
			if (s === 'rename') {
				const target = d.items[d.rng.int(0, d.items.length - 1)];
				if (target) d.push({ kind: 'rename', id: target.id, title: d.title() });
			} else if (s === 'reorder') d.reorder(d.rng.pick(['sort', 'reverse', 'top'] as const));
			else {
				const victim = d.items[d.rng.int(0, d.items.length - 1)];
				if (victim) d.push({ kind: 'remove', id: victim.id });
			}
		}
		return { keyMode: 'id', rowState: 'draft' };
	},
	// The key is the title, a field that changes: a rename creates a new instance and loses the typed note, while a
	// sort moves the notes with their items.
	'title-key': (d) => {
		const rows = d.rows(3);
		for (const r of rows) d.type(r);
		const renamed = d.items[rows[0] ?? 0];
		if (renamed) d.push({ kind: 'rename', id: renamed.id, title: d.title() });
		d.reorder(d.rng.pick(['sort', 'reverse'] as const));
		d.push({ kind: 'prepend', item: d.newItem() });
		d.type(d.rng.int(0, d.items.length - 1));
		return { keyMode: 'title', rowState: 'note' };
	},
	// The key is the title and the draft starts from it: a renamed row starts over from the new title; a reorder keeps
	// the drafts with their items.
	'title-key-draft': (d) => {
		const rows = d.rows(2);
		for (const r of rows) d.type(r);
		const untouched = d.items.findIndex((_, i) => !rows.includes(i));
		const steps = d.rng.shuffle(['rename-typed', 'rename-plain', 'reorder'] as const);
		for (const s of steps) {
			if (s === 'reorder') d.reorder(d.rng.pick(['sort', 'reverse', 'top'] as const));
			else {
				const source = s === 'rename-typed' ? d.items[rows[0] ?? 0] : d.items[untouched];
				if (source) d.push({ kind: 'rename', id: source.id, title: d.title() });
			}
		}
		d.push({ kind: 'append', item: d.newItem() });
		return { keyMode: 'title', rowState: 'draft' };
	}
};

// ---------------------------------------------------------------------------------------------------------------
// Showing it.

const showItem = (it: Item): string => `{ id: ${it.id}, title: '${it.title}' }`;

function showProgram(s: Scenario, plot: { list: string; row: string }): string {
	const key = s.keyMode === 'index' ? 'index' : s.keyMode === 'id' ? 'item.id' : 'item.title';
	const stateLine =
		s.rowState === 'note'
			? "  const [note, setNote] = useState('');"
			: '  const [draft, setDraft] = useState(item.title);';
	const input =
		s.rowState === 'note'
			? '<input value={note} onChange={(e) => setNote(e.target.value)} />'
			: '<input value={draft} onChange={(e) => setDraft(e.target.value)} />';
	return [
		"import { useState } from 'react';",
		'',
		`function ${plot.row}({ item }) {`,
		stateLine,
		'  return (',
		'    <li>',
		`      {item.title} ${input}`,
		'    </li>',
		'  );',
		'}',
		'',
		`function ${plot.list}() {`,
		'  const [items, setItems] = useState([',
		...s.items.map((it, i) => `    ${showItem(it)}${i === s.items.length - 1 ? '' : ','}`),
		'  ]);',
		'  return (',
		'    <ul>',
		`      {items.map((item, index) => (`,
		`        <${plot.row} key={${key}} item={item} />`,
		'      ))}',
		'    </ul>',
		'  );',
		'}'
	].join('\n');
}

const ORDINALS = ['первой', 'второй', 'третьей', 'четвёртой', 'пятой', 'шестой', 'седьмой'] as const;

function showStep(step: Step): string {
	switch (step.kind) {
		case 'type':
			return `Пользователь стирает текст в поле ${ORDINALS[step.row] ?? `${step.row + 1}-й`} строки списка (считая сверху) и вводит \`${step.text}\`.`;
		case 'prepend':
			return `Вызывается \`setItems((list) => [${showItem(step.item)}, ...list])\`.`;
		case 'append':
			return `Вызывается \`setItems((list) => [...list, ${showItem(step.item)}])\`.`;
		case 'remove':
			return `Вызывается \`setItems((list) => list.filter((it) => it.id !== ${step.id}))\`.`;
		case 'sort':
			return 'Вызывается `setItems((list) => [...list].sort((a, b) => a.title.localeCompare(b.title)))`.';
		case 'reverse':
			return 'Вызывается `setItems((list) => [...list].reverse())`.';
		case 'top':
			return `Вызывается \`setItems((list) => [list.find((it) => it.id === ${step.id}), ...list.filter((it) => it.id !== ${step.id})])\`.`;
		case 'rename':
			return `Вызывается \`setItems((list) => list.map((it) => (it.id === ${step.id} ? { ...it, title: '${step.title}' } : it)))\`.`;
	}
}

function describe(s: Scenario, plot: { list: string; row: string }): string {
	const field = s.rowState === 'note' ? 'note' : 'draft';
	return [
		`Компонент \`${plot.list}\` выводит список, у каждой строки \`${plot.row}\` — своё состояние \`${field}\` в поле ввода.`,
		'',
		'```jsx',
		showProgram(s, plot),
		'```',
		'',
		'После первого рендера по очереди происходит следующее (каждый шаг — после рендера предыдущего):',
		...s.steps.map((step, i) => `${i + 1}. ${showStep(step)}`),
		'',
		'Считаем, как в React: при новом рендере списка строка с тем же ключом, что и раньше, — тот же экземпляр компонента ' +
			'со своим состоянием (новые пропсы он получает); ключ, которого раньше не было, — новый экземпляр с начальным ' +
			'состоянием; экземпляр, чьего ключа больше нет, удаляется. Ключи в списке всегда различны.',
		'',
		'Введите ответ построчно. Сначала по строке на каждую строку списка сверху вниз после всех шагов: название из ' +
			`\`item.title\` и значение \`${field}\` в её поле через пробел; пустое поле — \`-\`. Последней строкой — два числа ` +
			`через пробел: сколько экземпляров \`${plot.row}\` создано и сколько удалено после первого рендера.`
	].join('\n');
}

const PLOTS = [
	{ list: 'ShoppingList', row: 'Product' },
	{ list: 'TodoList', row: 'Task' },
	{ list: 'Basket', row: 'Line' },
	{ list: 'Pantry', row: 'Shelf' }
] as const;

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: instances in a dictionary by key, rebuilt after every change of the list.

const PYTHON_REFERENCE = `import json

s = json.loads(input())
items = [dict(it) for it in s["items"]]
draft = s["rowState"] == "draft"


def key(item, index):
    mode = s["keyMode"]
    if mode == "index":
        return ("index", index)
    if mode == "id":
        return ("id", item["id"])
    return ("title", item["title"])


def fresh(item):
    return item["title"] if draft else ""


live = {key(it, i): fresh(it) for i, it in enumerate(items)}
order = [key(it, i) for i, it in enumerate(items)]
created = 0
removed = 0
for step in s["steps"]:
    kind = step["kind"]
    if kind == "type":
        live[order[step["row"]]] = step["text"]
        continue
    if kind == "prepend":
        items = [step["item"]] + items
    elif kind == "append":
        items = items + [step["item"]]
    elif kind == "remove":
        items = [it for it in items if it["id"] != step["id"]]
    elif kind == "sort":
        items = sorted(items, key=lambda it: it["title"])
    elif kind == "reverse":
        items = items[::-1]
    elif kind == "top":
        moved = [it for it in items if it["id"] == step["id"]]
        items = moved + [it for it in items if it["id"] != step["id"]]
    elif kind == "rename":
        items = [dict(it, title=step["title"]) if it["id"] == step["id"] else it for it in items]
    new_order = [key(it, i) for i, it in enumerate(items)]
    new_live = {}
    for k, it in zip(new_order, items):
        if k in live:
            new_live[k] = live[k]
        else:
            new_live[k] = fresh(it)
            created += 1
    removed += len([k for k in live if k not in new_live])
    live = new_live
    order = new_order

for k, it in zip(order, items):
    print(it["title"], live[k] if live[k] != "" else "-")
print(created, removed)
`;

// ---------------------------------------------------------------------------------------------------------------

const WRONG: Record<string, Partial<Rules>> = {
	'state-follows-item': { keyMode: 'id' },
	'state-stays-in-place': { keyMode: 'index' },
	'draft-syncs-props': { draftSyncs: true },
	'remount-all': { remountAll: true }
};

/** The misconceptions every instance of a class exposes by construction. */
const REQUIRED: Record<string, readonly string[]> = {
	'junior/index-insert': ['state-follows-item', 'remount-all'],
	'junior/id-insert': ['state-stays-in-place', 'remount-all'],
	'junior/index-remove': ['state-follows-item', 'remount-all'],
	'junior/id-reorder': ['state-stays-in-place', 'remount-all'],
	'middle/index-draft': ['state-follows-item', 'draft-syncs-props', 'remount-all'],
	'middle/id-mixed': ['state-stays-in-place', 'draft-syncs-props', 'remount-all'],
	'middle/title-key': ['state-follows-item', 'state-stays-in-place', 'remount-all'],
	'middle/title-key-draft': ['state-follows-item', 'state-stays-in-place', 'remount-all']
};

const differs = (a: readonly string[], b: readonly string[]): boolean =>
	a.length !== b.length || a.some((x, i) => x !== b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const middle = input.grade === 'middle';
	const classDraw = (middle ? MIDDLE : JUNIOR)[input.classId];
	if (!classDraw) throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// A draw where a required misconception happens to give the right answer (a sort that leaves the typed rows in
	// place, say) is drawn again; the last draw is kept.
	let scenario: Scenario;
	let answer: string[];
	let wrong: Record<string, string[] | null>;
	let tries = 0;
	do {
		const d = new Draw(rng, middle ? rng.int(4, 5) : rng.int(3, 4));
		const initial = d.items;
		const { keyMode, rowState } = classDraw(d);
		scenario = d.scenario(keyMode, rowState, initial);
		const s = scenario;
		answer = simulate(s, RIGHT);
		const right = answer;
		wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(s, { ...RIGHT, ...change });
				return [id, differs(value, right) ? value : null];
			})
		);
		tries += 1;
	} while (tries < 30 && required.some((id) => wrong[id] === null));
	const plot = rng.pick(PLOTS);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(scenario, plot), code: null },
		answer: { kind: 'sequence', value: answer }
	});
	const stdin = JSON.stringify(scenario);
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
