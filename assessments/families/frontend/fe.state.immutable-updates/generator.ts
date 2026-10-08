// A module of state handlers, each with its specification in a comment; every handler must leave the previous state,
// its arguments and the shared objects of the module untouched. Exactly one line changes such an object in place.
// The candidate names that line. Lines that change a fresh copy in place look the same and are correct: they are the
// traps. The kind of the defect is the essential class; the other handlers, their order and the data are surface.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeDefectProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** A line of a handler (0-based, the header is 0) and what replaces it. */
interface LineChange {
	at: number;
	text: string;
}

/** A line that changes a fresh copy in place, with an equivalent rewrite; `topLevel` — a field of a spread copy. */
interface SafeLine extends LineChange {
	topLevel: boolean;
}

interface Defect {
	kind: string;
	/** The handler with the defect, header first. */
	lines: string[];
	/** The line that changes a shared object in place, and the fix of that line alone. */
	fix: LineChange;
	/** A line of the same handler a candidate may blame, with the change they would make: the defect stays. */
	neighbour: LineChange;
	/**
	 * The line of the same handler that builds the copy, with the deeper copy a candidate would make there: the
	 * in-place change goes through the previous data, so the deeper copy does not repair it.
	 */
	copy: LineChange | null;
	safe: SafeLine[];
}

interface Handler {
	name: string;
	/** Module-level lines the handler needs (a shared default object). */
	prelude: string[];
	doc: string;
	/** The correct handler, header first. */
	lines: string[];
	safe: SafeLine[];
	/** Statements appended to the program; each throws when the specification is broken. */
	checks: string[];
	defects: Defect[];
}

/** The comment of a handler: one line, or a block with a sentence per line. */
function docLines(text: string, block: boolean): string[] {
	if (!block) return [`/** ${text} */`];
	const sentences = text.split(/(?<=\.) (?=[А-ЯA-Z])/u);
	return ['/**', ...sentences.map((s) => ` * ${s}`), ' */'];
}

const INTERN: Handler[] = [
	{
		name: 'addTask',
		prelude: [],
		doc: 'Добавляет задачу в конец списка и увеличивает nextId. Прежнее состояние не меняет.',
		lines: [
			'function addTask(state, title) {',
			'  const task = { id: state.nextId, title, done: false };',
			'  return { ...state, tasks: [...state.tasks, task], nextId: state.nextId + 1 };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { tasks: [{ id: 1, title: 'a', done: false }], nextId: 2 };",
			'const before = json(s);',
			"const r = addTask(s, 'b');",
			"assert(json(r) === json({ tasks: [{ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: false }], nextId: 3 }), 'addTask: result');",
			"assert(json(s) === before, 'addTask: the previous state changed');"
		],
		defects: [
			{
				kind: 'array-mutator',
				lines: [
					'function addTask(state, title) {',
					'  const task = { id: state.nextId, title, done: false };',
					'  state.tasks.push(task);',
					'  return { ...state, nextId: state.nextId + 1 };',
					'}'
				],
				fix: { at: 2, text: '  state = { ...state, tasks: [...state.tasks, task] };' },
				neighbour: { at: 3, text: '  return { ...state, tasks: [...state.tasks], nextId: state.nextId + 1 };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'removeTask',
		prelude: [],
		doc: 'Удаляет задачу id и считает удаления; если задачи нет — возвращает то же состояние. Прежнее не меняет.',
		lines: [
			'function removeTask(state, id) {',
			'  const index = state.tasks.findIndex((t) => t.id === id);',
			'  if (index === -1) return state;',
			'  const tasks = state.tasks.filter((t) => t.id !== id);',
			'  return { ...state, tasks, removed: state.removed + 1 };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { tasks: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }], removed: 0 };",
			'const before = json(s);',
			'const r = removeTask(s, 2);',
			"assert(json(r) === json({ tasks: [{ id: 1, title: 'a' }, { id: 3, title: 'c' }], removed: 1 }), 'removeTask: result');",
			"assert(removeTask(s, 9) === s, 'removeTask: a missing id must return the same state');",
			"assert(json(s) === before, 'removeTask: the previous state changed');"
		],
		defects: [
			{
				kind: 'array-mutator',
				lines: [
					'function removeTask(state, id) {',
					'  const index = state.tasks.findIndex((t) => t.id === id);',
					'  if (index === -1) return state;',
					'  state.tasks.splice(index, 1);',
					'  return { ...state, removed: state.removed + 1 };',
					'}'
				],
				fix: { at: 3, text: '  state = { ...state, tasks: state.tasks.toSpliced(index, 1) };' },
				neighbour: { at: 2, text: '  if (index < 0) return state;' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'addTag',
		prelude: [],
		doc: 'Добавляет тег, если его ещё нет; иначе возвращает то же состояние. Прежнее состояние не меняет.',
		lines: [
			'function addTag(state, tag) {',
			'  if (state.tags.includes(tag)) return state;',
			'  const tags = state.tags.slice();',
			'  tags.push(tag);',
			'  return { ...state, tags };',
			'}'
		],
		safe: [{ at: 3, text: '  tags.splice(tags.length, 0, tag);', topLevel: false }],
		checks: [
			"const s = { tags: ['ui', 'api'] };",
			'const before = json(s);',
			"const r = addTag(s, 'db');",
			"assert(json(r) === json({ tags: ['ui', 'api', 'db'] }), 'addTag: result');",
			"assert(addTag(s, 'ui') === s, 'addTag: a present tag must return the same state');",
			"assert(json(s) === before, 'addTag: the previous state changed');"
		],
		defects: [
			{
				kind: 'array-mutator',
				lines: [
					'function addTag(state, tag) {',
					'  if (state.tags.includes(tag)) return state;',
					'  state.tags.push(tag);',
					'  return { ...state, tags: [...state.tags] };',
					'}'
				],
				fix: { at: 2, text: '  state = { ...state, tags: [...state.tags, tag] };' },
				neighbour: { at: 1, text: '  if (state.tags.indexOf(tag) !== -1) return state;' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'sortByTitle',
		prelude: [],
		doc: 'Новое состояние: задачи отсортированы по названию. Прежнее состояние не меняет.',
		lines: [
			'function sortByTitle(state) {',
			'  const tasks = [...state.tasks].sort((a, b) => a.title.localeCompare(b.title));',
			'  return { ...state, tasks };',
			'}'
		],
		safe: [
			{
				at: 1,
				text: '  const tasks = state.tasks.slice().sort((a, b) => a.title.localeCompare(b.title));',
				topLevel: false
			}
		],
		checks: [
			"const s = { tasks: [{ title: 'b' }, { title: 'c' }, { title: 'a' }] };",
			'const before = json(s);',
			'const r = sortByTitle(s);',
			"assert(json(r.tasks.map((t) => t.title)) === json(['a', 'b', 'c']), 'sortByTitle: result');",
			"assert(json(s) === before, 'sortByTitle: the previous state changed');"
		],
		defects: [
			{
				kind: 'sort-in-place',
				lines: [
					'function sortByTitle(state) {',
					'  const tasks = state.tasks.sort((a, b) => a.title.localeCompare(b.title));',
					'  return { ...state, tasks };',
					'}'
				],
				fix: { at: 1, text: '  const tasks = [...state.tasks].sort((a, b) => a.title.localeCompare(b.title));' },
				neighbour: { at: 2, text: '  return { ...state, tasks: [...tasks] };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'topScores',
		prelude: [],
		doc: 'Три лучших результата по убыванию. Состояние не меняет.',
		lines: [
			'function topScores(state) {',
			'  const sorted = [...state.scores].sort((a, b) => b - a);',
			'  return sorted.slice(0, 3);',
			'}'
		],
		safe: [{ at: 1, text: '  const sorted = state.scores.slice().sort((a, b) => b - a);', topLevel: false }],
		checks: [
			'const s = { scores: [5, 9, 1, 7] };',
			'const before = json(s);',
			"assert(json(topScores(s)) === json([9, 7, 5]), 'topScores: result');",
			"assert(json(s) === before, 'topScores: the state changed');"
		],
		defects: [
			{
				kind: 'sort-in-place',
				lines: [
					'function topScores(state) {',
					'  const sorted = state.scores.sort((a, b) => b - a);',
					'  return sorted.slice(0, 3);',
					'}'
				],
				fix: { at: 1, text: '  const sorted = [...state.scores].sort((a, b) => b - a);' },
				neighbour: { at: 2, text: '  return sorted.slice(0, 3).map((x) => x);' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'lastEvents',
		prelude: [],
		doc: 'Последние n событий журнала, новые первыми. Состояние не меняет.',
		lines: [
			'function lastEvents(state, n) {',
			'  const newestFirst = [...state.log].reverse();',
			'  return newestFirst.slice(0, n);',
			'}'
		],
		safe: [{ at: 1, text: '  const newestFirst = state.log.slice().reverse();', topLevel: false }],
		checks: [
			"const s = { log: ['open', 'edit', 'save'] };",
			'const before = json(s);',
			"assert(json(lastEvents(s, 2)) === json(['save', 'edit']), 'lastEvents: result');",
			"assert(json(s) === before, 'lastEvents: the state changed');"
		],
		defects: [
			{
				kind: 'sort-in-place',
				lines: [
					'function lastEvents(state, n) {',
					'  const newestFirst = state.log.reverse();',
					'  return newestFirst.slice(0, n);',
					'}'
				],
				fix: { at: 1, text: '  const newestFirst = [...state.log].reverse();' },
				neighbour: { at: 2, text: '  return [...newestFirst].slice(0, n);' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'sortByPrice',
		prelude: [],
		doc: 'Новое состояние: позиции по цене, по возрастанию или по убыванию. Прежнее состояние не меняет.',
		lines: [
			'function sortByPrice(state, ascending) {',
			'  const direction = ascending ? 1 : -1;',
			'  const byPrice = (a, b) => (a.price - b.price) * direction;',
			'  const lines = [...state.lines].sort(byPrice);',
			'  return { ...state, lines, ascending };',
			'}'
		],
		safe: [{ at: 3, text: '  const lines = state.lines.slice().sort(byPrice);', topLevel: false }],
		checks: [
			'const s = { lines: [{ price: 5 }, { price: 9 }, { price: 1 }], ascending: false };',
			'const before = json(s);',
			'const r = sortByPrice(s, true);',
			"assert(json(r) === json({ lines: [{ price: 1 }, { price: 5 }, { price: 9 }], ascending: true }), 'sortByPrice: result');",
			"assert(json(s) === before, 'sortByPrice: the previous state changed');"
		],
		defects: [
			{
				kind: 'sort-in-place',
				lines: [
					'function sortByPrice(state, ascending) {',
					'  const direction = ascending ? 1 : -1;',
					'  const byPrice = (a, b) => (a.price - b.price) * direction;',
					'  const lines = state.lines.sort(byPrice);',
					'  return { ...state, lines, ascending };',
					'}'
				],
				fix: { at: 3, text: '  const lines = [...state.lines].sort(byPrice);' },
				neighbour: { at: 2, text: '  const byPrice = (a, b) => direction * (a.price - b.price);' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'renameBoard',
		prelude: [],
		doc: 'Название доски без пробелов по краям и счётчик правок; то же название — то же состояние. Прежнее не меняет.',
		lines: [
			'function renameBoard(state, title) {',
			'  const trimmed = title.trim();',
			'  if (trimmed === state.title) return state;',
			'  return { ...state, title: trimmed, edits: state.edits + 1 };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { title: 'plan', edits: 3 };",
			'const before = json(s);',
			"const r = renameBoard(s, ' sprint ');",
			"assert(r !== s && json(r) === json({ title: 'sprint', edits: 4 }), 'renameBoard: result');",
			"assert(renameBoard(s, 'plan ') === s, 'renameBoard: the same title must return the same state');",
			"assert(json(s) === before, 'renameBoard: the previous state changed');"
		],
		defects: [
			{
				kind: 'same-object',
				lines: [
					'function renameBoard(state, title) {',
					'  const trimmed = title.trim();',
					'  if (trimmed === state.title) return state;',
					'  state.title = trimmed;',
					'  return { ...state, edits: state.edits + 1 };',
					'}'
				],
				fix: { at: 3, text: '  state = { ...state, title: trimmed };' },
				neighbour: { at: 4, text: '  return { ...state, title: trimmed, edits: state.edits + 1 };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'increment',
		prelude: [],
		doc: 'Увеличивает счётчик на by; при by = 0 — то же состояние. Подписчики сравнивают состояния по ссылке. Прежнее состояние не меняет.',
		lines: [
			'function increment(state, by) {',
			'  if (by === 0) return state;',
			'  const count = state.count + by;',
			'  return { ...state, count };',
			'}'
		],
		safe: [],
		checks: [
			'const s = { count: 2, step: 1 };',
			'const before = json(s);',
			'const r = increment(s, 3);',
			"assert(r !== s && r.count === 5 && r.step === 1, 'increment: result');",
			"assert(increment(s, 0) === s, 'increment: by = 0 must return the same state');",
			"assert(json(s) === before, 'increment: the previous state changed');"
		],
		defects: [
			{
				kind: 'same-object',
				lines: [
					'function increment(state, by) {',
					'  if (by === 0) return state;',
					'  state.count = state.count + by;',
					'  return state;',
					'}'
				],
				fix: { at: 2, text: '  state = { ...state, count: state.count + by };' },
				neighbour: { at: 3, text: '  return { ...state };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'setQuery',
		prelude: [],
		doc: 'Меняет строку поиска и сбрасывает страницу; та же строка — то же состояние. Прежнее не меняет.',
		lines: [
			'function setQuery(state, query) {',
			'  if (state.query === query) return state;',
			'  return { ...state, query, page: 1 };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { query: 'a', page: 4 };",
			'const before = json(s);',
			"const r = setQuery(s, 'b');",
			"assert(r !== s && r.query === 'b' && r.page === 1, 'setQuery: result');",
			"assert(setQuery(s, 'a') === s, 'setQuery: the same query must return the same state');",
			"assert(json(s) === before, 'setQuery: the previous state changed');"
		],
		defects: [
			{
				kind: 'same-object',
				lines: [
					'function setQuery(state, query) {',
					'  if (state.query === query) return state;',
					'  state.query = query;',
					'  return { ...state, page: 1 };',
					'}'
				],
				fix: { at: 2, text: '  state = { ...state, query };' },
				neighbour: { at: 1, text: '  if (state.query == query) return state;' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'setSidebar',
		prelude: [],
		doc: 'Открывает или закрывает панель; панель уже в нужном положении — то же состояние. Подписчики сравнивают состояния по ссылке. Прежнее не меняет.',
		lines: [
			'function setSidebar(state, open) {',
			'  if (state.sidebarOpen === open) return state;',
			'  return { ...state, sidebarOpen: open };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { sidebarOpen: false, theme: 'dark' };",
			'const before = json(s);',
			'const r = setSidebar(s, true);',
			"assert(r !== s && r.sidebarOpen === true && r.theme === 'dark', 'setSidebar: result');",
			"assert(setSidebar(s, false) === s, 'setSidebar: the same position must return the same state');",
			"assert(json(s) === before, 'setSidebar: the previous state changed');"
		],
		defects: [
			{
				kind: 'same-object',
				lines: [
					'function setSidebar(state, open) {',
					'  if (state.sidebarOpen === open) return state;',
					'  state.sidebarOpen = open;',
					'  return state;',
					'}'
				],
				fix: { at: 2, text: '  state = { ...state, sidebarOpen: open };' },
				neighbour: { at: 3, text: '  return Object.assign({}, state);' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'markDone',
		prelude: [],
		doc: 'Отмечает выполненной задачу на позиции index. Прежнее состояние не меняет.',
		lines: [
			'function markDone(state, index) {',
			'  const tasks = [...state.tasks];',
			'  tasks[index] = { ...tasks[index], done: true };',
			'  return { ...state, tasks };',
			'}'
		],
		safe: [{ at: 2, text: '  tasks.splice(index, 1, { ...tasks[index], done: true });', topLevel: false }],
		checks: [
			'const s = { tasks: [{ id: 1, done: false }, { id: 2, done: false }] };',
			'const before = json(s);',
			'const r = markDone(s, 1);',
			"assert(json(r) === json({ tasks: [{ id: 1, done: false }, { id: 2, done: true }] }), 'markDone: result');",
			"assert(json(s) === before, 'markDone: the previous state changed');"
		],
		defects: [
			{
				kind: 'index-or-delete',
				lines: [
					'function markDone(state, index) {',
					'  state.tasks[index] = { ...state.tasks[index], done: true };',
					'  return { ...state, tasks: [...state.tasks] };',
					'}'
				],
				fix: {
					at: 1,
					text: '  state = { ...state, tasks: state.tasks.with(index, { ...state.tasks[index], done: true }) };'
				},
				neighbour: { at: 2, text: '  return { ...state, tasks: state.tasks.slice() };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'clearError',
		prelude: [],
		doc: 'Сбрасывает ошибку поля field в null. Прежнее состояние не меняет.',
		lines: [
			'function clearError(state, field) {',
			'  const errors = { ...state.errors };',
			'  errors[field] = null;',
			'  return { ...state, errors };',
			'}'
		],
		safe: [{ at: 2, text: '  Object.assign(errors, { [field]: null });', topLevel: false }],
		checks: [
			"const s = { errors: { email: 'required', name: 'short' } };",
			'const before = json(s);',
			"const r = clearError(s, 'email');",
			"assert(json(r) === json({ errors: { email: null, name: 'short' } }), 'clearError: result');",
			"assert(json(s) === before, 'clearError: the previous state changed');"
		],
		defects: [
			{
				kind: 'index-or-delete',
				lines: [
					'function clearError(state, field) {',
					'  state.errors[field] = null;',
					'  return { ...state, errors: { ...state.errors } };',
					'}'
				],
				fix: {
					at: 1,
					text: '  state = { ...state, errors: { ...state.errors, [field]: null } };'
				},
				neighbour: { at: 2, text: '  return { ...state, errors: Object.assign({}, state.errors) };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'setPriority',
		prelude: [],
		doc: 'Меняет приоритет задачи на позиции index. Прежнее состояние не меняет.',
		lines: [
			'function setPriority(state, index, priority) {',
			'  const tasks = state.tasks.map((t, i) => (i === index ? { ...t, priority } : t));',
			'  return { ...state, tasks };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { tasks: [{ id: 1, priority: 'low' }, { id: 2, priority: 'low' }] };",
			'const before = json(s);',
			"const r = setPriority(s, 0, 'high');",
			"assert(json(r) === json({ tasks: [{ id: 1, priority: 'high' }, { id: 2, priority: 'low' }] }), 'setPriority: result');",
			"assert(json(s) === before, 'setPriority: the previous state changed');"
		],
		defects: [
			{
				kind: 'index-or-delete',
				lines: [
					'function setPriority(state, index, priority) {',
					'  state.tasks[index].priority = priority;',
					'  return { ...state, tasks: [...state.tasks] };',
					'}'
				],
				fix: {
					at: 1,
					text: '  state = { ...state, tasks: state.tasks.with(index, { ...state.tasks[index], priority }) };'
				},
				neighbour: { at: 2, text: '  return { ...state, tasks: state.tasks.map((t) => ({ ...t })) };' },
				copy: null,
				safe: []
			}
		]
	}
];

INTERN.push({
	name: 'dropDraft',
	prelude: [],
	doc: 'Удаляет черновик id и уменьшает счётчик; нет такого черновика — то же состояние. Прежнее состояние не меняет.',
	lines: [
		'function dropDraft(state, id) {',
		'  if (!Object.hasOwn(state.drafts, id)) return state;',
		'  const count = state.count - 1;',
		'  const { [id]: dropped, ...drafts } = state.drafts;',
		'  return { ...state, drafts, count };',
		'}'
	],
	safe: [],
	checks: [
		"const s = { drafts: { a: 'x', b: 'y' }, count: 2 };",
		'const before = json(s);',
		"const r = dropDraft(s, 'a');",
		"assert(json(r) === json({ drafts: { b: 'y' }, count: 1 }), 'dropDraft: result');",
		"assert(dropDraft(s, 'z') === s, 'dropDraft: a missing draft must return the same state');",
		"assert(dropDraft(s, 'toString') === s, 'dropDraft: a missing draft must return the same state');",
		"assert(json(s) === before, 'dropDraft: the previous state changed');"
	],
	defects: []
});

const JUNIOR: Handler[] = [
	{
		name: 'renameUser',
		prelude: [],
		doc: 'Новое имя в профиле и время изменения. Прежнее состояние не меняет.',
		lines: [
			'function renameUser(state, name, now) {',
			'  const next = { ...state, profile: { ...state.profile } };',
			'  next.profile.name = name;',
			'  next.updatedAt = now;',
			'  return next;',
			'}'
		],
		safe: [
			{ at: 2, text: '  Object.assign(next.profile, { name });', topLevel: false },
			{ at: 3, text: '  Object.assign(next, { updatedAt: now });', topLevel: true }
		],
		checks: [
			"const s = { profile: { name: 'ann', city: 'Omsk' }, updatedAt: 0 };",
			'const before = json(s);',
			"const r = renameUser(s, 'bob', 7);",
			"assert(json(r) === json({ profile: { name: 'bob', city: 'Omsk' }, updatedAt: 7 }), 'renameUser: result');",
			"assert(json(s) === before, 'renameUser: the previous state changed');"
		],
		defects: [
			{
				kind: 'nested-after-spread',
				lines: [
					'function renameUser(state, name, now) {',
					'  const next = { ...state, updatedAt: now };',
					'  state.profile.name = name;',
					'  return next;',
					'}'
				],
				fix: { at: 2, text: '  next.profile = { ...state.profile, name };' },
				neighbour: { at: 3, text: '  return { ...next };' },
				copy: { at: 1, text: '  const next = { ...state, profile: { ...state.profile }, updatedAt: now };' },
				safe: []
			}
		]
	},
	{
		name: 'addLine',
		prelude: [],
		doc: 'Добавляет позицию в заказ и пересчитывает сумму. Прежний заказ не меняет.',
		lines: [
			'function addLine(order, line) {',
			'  const next = { ...order, lines: [...order.lines] };',
			'  next.lines.push(line);',
			'  next.total = order.total + line.price * line.qty;',
			'  return next;',
			'}'
		],
		safe: [
			{ at: 2, text: '  next.lines.splice(next.lines.length, 0, line);', topLevel: false },
			{ at: 3, text: '  Object.assign(next, { total: order.total + line.price * line.qty });', topLevel: true }
		],
		checks: [
			"const s = { lines: [{ sku: 'a', price: 5, qty: 2 }], total: 10 };",
			'const before = json(s);',
			"const r = addLine(s, { sku: 'b', price: 3, qty: 3 });",
			"assert(r.total === 19 && json(r.lines.map((l) => l.sku)) === json(['a', 'b']), 'addLine: result');",
			"assert(json(s) === before, 'addLine: the previous order changed');"
		],
		defects: [
			{
				kind: 'nested-after-spread',
				lines: [
					'function addLine(order, line) {',
					'  const next = { ...order, total: order.total + line.price * line.qty };',
					'  order.lines.push(line);',
					'  return next;',
					'}'
				],
				fix: { at: 2, text: '  next.lines = [...order.lines, line];' },
				neighbour: { at: 3, text: '  return { ...next, lines: [...next.lines] };' },
				copy: {
					at: 1,
					text: '  const next = { ...order, lines: [...order.lines], total: order.total + line.price * line.qty };'
				},
				safe: []
			}
		]
	},
	{
		name: 'updateSetting',
		prelude: [],
		doc: 'Меняет одну настройку раздела section и версию. Прежнее состояние не меняет.',
		lines: [
			'function updateSetting(state, section, key, value) {',
			'  const next = { ...state, settings: { ...state.settings } };',
			'  next.settings[section] = { ...state.settings[section], [key]: value };',
			'  next.version = state.version + 1;',
			'  return next;',
			'}'
		],
		safe: [
			{
				at: 2,
				text: '  Object.assign(next.settings, { [section]: { ...state.settings[section], [key]: value } });',
				topLevel: false
			},
			{ at: 3, text: '  Object.assign(next, { version: state.version + 1 });', topLevel: true }
		],
		checks: [
			"const s = { settings: { ui: { theme: 'dark', dense: false }, mail: { daily: true } }, version: 1 };",
			'const before = json(s);',
			"const r = updateSetting(s, 'ui', 'dense', true);",
			"assert(json(r) === json({ settings: { ui: { theme: 'dark', dense: true }, mail: { daily: true } }, version: 2 }), 'updateSetting: result');",
			"assert(json(s) === before, 'updateSetting: the previous state changed');"
		],
		defects: [
			{
				kind: 'nested-after-spread',
				lines: [
					'function updateSetting(state, section, key, value) {',
					'  const next = { ...state, settings: { ...state.settings }, version: state.version + 1 };',
					'  state.settings[section][key] = value;',
					'  return next;',
					'}'
				],
				fix: { at: 2, text: '  next.settings[section] = { ...state.settings[section], [key]: value };' },
				neighbour: { at: 3, text: '  return { ...next };' },
				copy: {
					at: 1,
					text: '  const next = { ...state, settings: structuredClone(state.settings), version: state.version + 1 };'
				},
				safe: []
			}
		]
	},
	{
		name: 'addToCart',
		prelude: ['const EMPTY_CART = { lines: [], total: 0 };'],
		doc: 'Корзина с новой строкой; без корзины берётся EMPTY_CART. Аргументы и EMPTY_CART не меняются.',
		lines: [
			'function addToCart(line, cart = EMPTY_CART) {',
			'  const next = { ...cart, lines: [...cart.lines, line] };',
			'  next.total = cart.total + line.price;',
			'  return next;',
			'}'
		],
		safe: [{ at: 2, text: '  Object.assign(next, { total: cart.total + line.price });', topLevel: true }],
		checks: [
			"const first = addToCart({ sku: 'a', price: 4 });",
			"const second = addToCart({ sku: 'b', price: 6 });",
			"assert(second.total === 6 && json(second.lines.map((l) => l.sku)) === json(['b']), 'addToCart: a cart from EMPTY_CART');",
			"assert(first.lines.length === 1 && json(EMPTY_CART) === json({ lines: [], total: 0 }), 'addToCart: EMPTY_CART changed');",
			"const own = { lines: [{ sku: 'c', price: 1 }], total: 1 };",
			'const before = json(own);',
			"const r = addToCart({ sku: 'd', price: 2 }, own);",
			"assert(r.total === 3 && r.lines.length === 2 && json(own) === before, 'addToCart: the cart changed');"
		],
		defects: [
			{
				kind: 'shared-default',
				lines: [
					'function addToCart(line, cart = EMPTY_CART) {',
					'  const next = { ...cart, total: cart.total + line.price };',
					'  cart.lines.push(line);',
					'  return next;',
					'}'
				],
				fix: { at: 2, text: '  next.lines = [...cart.lines, line];' },
				neighbour: { at: 0, text: 'function addToCart(line, cart = { ...EMPTY_CART }) {' },
				copy: { at: 1, text: '  const next = { ...cart, lines: [...cart.lines], total: cart.total + line.price };' },
				safe: []
			}
		]
	},
	{
		name: 'withTag',
		prelude: ["const DEFAULT_FILTERS = { tags: [], sort: 'date' };"],
		doc: 'Фильтры с новым тегом; без фильтров берутся DEFAULT_FILTERS. Аргументы и DEFAULT_FILTERS не меняются.',
		lines: [
			'function withTag(tag, filters = DEFAULT_FILTERS) {',
			'  const next = Object.assign({}, filters);',
			'  next.tags = [...filters.tags, tag];',
			'  return next;',
			'}'
		],
		safe: [{ at: 2, text: '  Object.assign(next, { tags: [...filters.tags, tag] });', topLevel: true }],
		checks: [
			"withTag('new');",
			"const r = withTag('hot');",
			"assert(json(r) === json({ tags: ['hot'], sort: 'date' }), 'withTag: filters from DEFAULT_FILTERS');",
			"assert(json(DEFAULT_FILTERS) === json({ tags: [], sort: 'date' }), 'withTag: DEFAULT_FILTERS changed');",
			"const own = { tags: ['a'], sort: 'name' };",
			'const before = json(own);',
			"assert(json(withTag('b', own).tags) === json(['a', 'b']) && json(own) === before, 'withTag: the filters changed');"
		],
		defects: [
			{
				kind: 'shared-default',
				lines: [
					'function withTag(tag, filters = DEFAULT_FILTERS) {',
					'  const next = Object.assign({}, filters);',
					'  filters.tags.push(tag);',
					'  return next;',
					'}'
				],
				fix: { at: 2, text: '  next.tags = [...filters.tags, tag];' },
				neighbour: { at: 0, text: 'function withTag(tag, filters = Object.assign({}, DEFAULT_FILTERS)) {' },
				copy: { at: 1, text: '  const next = { ...filters, tags: [...filters.tags] };' },
				safe: []
			}
		]
	},
	{
		name: 'typeInto',
		prelude: ['const BLANK_FORM = { values: {}, touched: [] };'],
		doc: 'Форма после ввода в поле field; без формы берётся BLANK_FORM. Аргументы и BLANK_FORM не меняются.',
		lines: [
			'function typeInto(field, value, form = BLANK_FORM) {',
			'  const values = { ...form.values, [field]: value };',
			'  const touched = form.touched.includes(field) ? form.touched : [...form.touched, field];',
			'  return { values, touched };',
			'}'
		],
		safe: [],
		checks: [
			"typeInto('email', 'a@b');",
			"const r = typeInto('name', 'ann');",
			"assert(json(r) === json({ values: { name: 'ann' }, touched: ['name'] }), 'typeInto: a form from BLANK_FORM');",
			"assert(json(BLANK_FORM) === json({ values: {}, touched: [] }), 'typeInto: BLANK_FORM changed');",
			"const own = { values: { name: 'x' }, touched: ['name'] };",
			'const before = json(own);',
			"assert(json(typeInto('city', 'Ufa', own).touched) === json(['name', 'city']) && json(own) === before, 'typeInto: the form changed');"
		],
		defects: [
			{
				kind: 'shared-default',
				lines: [
					'function typeInto(field, value, form = BLANK_FORM) {',
					'  const values = { ...form.values, [field]: value };',
					'  if (!form.touched.includes(field)) form.touched.push(field);',
					'  return { values, touched: [...form.touched] };',
					'}'
				],
				fix: {
					at: 2,
					text: '  if (!form.touched.includes(field)) form = { ...form, touched: [...form.touched, field] };'
				},
				neighbour: { at: 0, text: 'function typeInto(field, value, form = { ...BLANK_FORM }) {' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'completeOverdue',
		prelude: [],
		doc: 'Отмечает выполненными задачи со сроком раньше today; остальные задачи — те же объекты. Прежнее состояние и его задачи не меняет.',
		lines: [
			'function completeOverdue(state, today) {',
			'  const tasks = state.tasks.map((t) => {',
			'    if (t.due >= today) return t;',
			'    const copy = { ...t };',
			'    copy.done = true;',
			'    return copy;',
			'  });',
			'  return { ...state, tasks };',
			'}'
		],
		safe: [{ at: 4, text: '    Object.assign(copy, { done: true });', topLevel: true }],
		checks: [
			'const s = { tasks: [{ id: 1, due: 3, done: false }, { id: 2, due: 9, done: false }] };',
			'const before = json(s);',
			'const r = completeOverdue(s, 5);',
			"assert(json(r) === json({ tasks: [{ id: 1, due: 3, done: true }, { id: 2, due: 9, done: false }] }), 'completeOverdue: result');",
			"assert(r.tasks[1] === s.tasks[1], 'completeOverdue: a task in time must stay the same object');",
			"assert(json(s) === before, 'completeOverdue: the previous state changed');"
		],
		defects: [
			{
				kind: 'mutating-callback',
				lines: [
					'function completeOverdue(state, today) {',
					'  const tasks = state.tasks.map((t) => {',
					'    if (t.due < today) t.done = true;',
					'    return t;',
					'  });',
					'  return { ...state, tasks };',
					'}'
				],
				fix: { at: 2, text: '    if (t.due < today) t = { ...t, done: true };' },
				neighbour: { at: 5, text: '  return { ...state, tasks: [...tasks] };' },
				copy: { at: 1, text: '  const tasks = state.tasks.map((t) => ({ ...t })).map((t) => {' },
				safe: []
			}
		]
	},
	{
		name: 'toggleById',
		prelude: [],
		doc: 'Переключает отметку задачи id; остальные задачи — те же объекты. Прежнее состояние и его задачи не меняет.',
		lines: [
			'function toggleById(state, id) {',
			'  const tasks = state.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t));',
			'  return { ...state, tasks };',
			'}'
		],
		safe: [],
		checks: [
			'const s = { tasks: [{ id: 1, done: false }, { id: 2, done: false }] };',
			'const before = json(s);',
			'const r = toggleById(s, 2);',
			"assert(json(r) === json({ tasks: [{ id: 1, done: false }, { id: 2, done: true }] }), 'toggleById: result');",
			"assert(r.tasks[0] === s.tasks[0], 'toggleById: an untouched task must stay the same object');",
			"assert(json(s) === before, 'toggleById: the previous state changed');"
		],
		defects: [
			{
				kind: 'mutating-callback',
				lines: [
					'function toggleById(state, id) {',
					'  const tasks = state.tasks.map((t) => {',
					'    if (t.id === id) t.done = !t.done;',
					'    return t;',
					'  });',
					'  return { ...state, tasks };',
					'}'
				],
				fix: { at: 2, text: '    if (t.id === id) t = { ...t, done: !t.done };' },
				neighbour: { at: 5, text: '  return { ...state, tasks: tasks.slice() };' },
				copy: { at: 1, text: '  const tasks = state.tasks.map((t) => ({ ...t })).map((t) => {' },
				safe: []
			}
		]
	},
	{
		name: 'renameTag',
		prelude: [],
		doc: 'Переименовывает тег from в to во всех заметках; заметки без этого тега — те же объекты. Прежнее состояние и его заметки не меняет.',
		lines: [
			'function renameTag(state, from, to) {',
			'  const notes = state.notes.map((n) =>',
			'    n.tags.includes(from) ? { ...n, tags: n.tags.map((t) => (t === from ? to : t)) } : n',
			'  );',
			'  return { ...state, notes };',
			'}'
		],
		safe: [],
		checks: [
			"const s = { notes: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: ['c'] }] };",
			'const before = json(s);',
			"const r = renameTag(s, 'b', 'x');",
			"assert(json(r) === json({ notes: [{ id: 1, tags: ['a', 'x'] }, { id: 2, tags: ['c'] }] }), 'renameTag: result');",
			"assert(r.notes[1] === s.notes[1], 'renameTag: a note without the tag must stay the same object');",
			"assert(json(s) === before, 'renameTag: the previous state changed');"
		],
		defects: [
			{
				kind: 'mutating-callback',
				lines: [
					'function renameTag(state, from, to) {',
					'  const notes = state.notes.map((n) => {',
					'    if (n.tags.includes(from)) n.tags = n.tags.map((t) => (t === from ? to : t));',
					'    return n;',
					'  });',
					'  return { ...state, notes };',
					'}'
				],
				fix: {
					at: 2,
					text: '    if (n.tags.includes(from)) n = { ...n, tags: n.tags.map((t) => (t === from ? to : t)) };'
				},
				neighbour: { at: 5, text: '  return { ...state, notes: [...notes] };' },
				copy: { at: 1, text: '  const notes = state.notes.map((n) => ({ ...n })).map((n) => {' },
				safe: []
			}
		]
	},
	{
		name: 'setPrefs',
		prelude: [],
		doc: 'Применяет patch к настройкам. Прежнее состояние не меняет.',
		lines: [
			'function setPrefs(state, patch) {',
			'  const prefs = Object.assign({}, state.prefs, patch);',
			'  return { ...state, prefs };',
			'}'
		],
		safe: [{ at: 1, text: '  const prefs = { ...state.prefs, ...patch };', topLevel: false }],
		checks: [
			"const s = { prefs: { lang: 'ru', beta: false } };",
			'const before = json(s);',
			'const r = setPrefs(s, { beta: true });',
			"assert(json(r) === json({ prefs: { lang: 'ru', beta: true } }), 'setPrefs: result');",
			"assert(json(s) === before, 'setPrefs: the previous state changed');"
		],
		defects: [
			{
				kind: 'object-assign',
				lines: [
					'function setPrefs(state, patch) {',
					'  const prefs = Object.assign(state.prefs, patch);',
					'  return { ...state, prefs };',
					'}'
				],
				fix: { at: 1, text: '  const prefs = Object.assign({}, state.prefs, patch);' },
				neighbour: { at: 2, text: '  return { ...state, prefs: { ...prefs } };' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'selectView',
		prelude: [],
		doc: 'Переключает вид и сбрасывает страницу; тот же вид — то же состояние. Иначе — новый объект, прежний не меняет.',
		lines: [
			'function selectView(state, view) {',
			'  if (state.view === view) return state;',
			'  return Object.assign({}, state, { view, page: 1 });',
			'}'
		],
		safe: [{ at: 2, text: '  return { ...state, view, page: 1 };', topLevel: false }],
		checks: [
			"const s = { view: 'list', page: 3 };",
			'const before = json(s);',
			"const r = selectView(s, 'grid');",
			"assert(r !== s && json(r) === json({ view: 'grid', page: 1 }), 'selectView: result');",
			"assert(selectView(s, 'list') === s, 'selectView: the same view must return the same state');",
			"assert(json(s) === before, 'selectView: the previous state changed');"
		],
		defects: [
			{
				kind: 'object-assign',
				lines: [
					'function selectView(state, view) {',
					'  if (state.view === view) return state;',
					'  return Object.assign(state, { view, page: 1 });',
					'}'
				],
				fix: { at: 2, text: '  return Object.assign({}, state, { view, page: 1 });' },
				neighbour: { at: 1, text: '  if (state.view == view) return state;' },
				copy: null,
				safe: []
			}
		]
	},
	{
		name: 'mergeDraft',
		prelude: [],
		doc: 'Черновик формы с новыми значениями полей и отметкой dirty. Прежнее состояние и его черновик не меняет.',
		lines: [
			'function mergeDraft(state, values) {',
			'  const draft = { ...state.draft };',
			'  Object.assign(draft, values);',
			'  return { ...state, draft, dirty: true };',
			'}'
		],
		safe: [{ at: 2, text: '  for (const [key, value] of Object.entries(values)) draft[key] = value;', topLevel: true }],
		checks: [
			"const s = { draft: { title: 'a', body: '' }, dirty: false };",
			'const before = json(s);',
			"const r = mergeDraft(s, { body: 'text' });",
			"assert(json(r) === json({ draft: { title: 'a', body: 'text' }, dirty: true }), 'mergeDraft: result');",
			"assert(json(s) === before, 'mergeDraft: the previous state changed');"
		],
		defects: [
			{
				kind: 'object-assign',
				lines: [
					'function mergeDraft(state, values) {',
					'  Object.assign(state.draft, values);',
					'  return { ...state, draft: { ...state.draft }, dirty: true };',
					'}'
				],
				fix: { at: 1, text: '  state = { ...state, draft: { ...state.draft, ...values } };' },
				neighbour: { at: 2, text: '  return { ...state, draft: Object.assign({}, state.draft), dirty: true };' },
				copy: null,
				safe: []
			}
		]
	}
];

interface Program {
	source: string;
	check: string;
	/** 1-based line of the defect, its fix, the neighbour line of the same handler. */
	line: number;
	fix: string;
	neighbour: { line: number; text: string };
	/** The line of the defective handler that builds the copy, with a deeper copy that does not repair it. */
	copyOfTarget: { line: number; text: string } | null;
	/** A correct line that changes a fresh copy (an element, an array) in place. */
	copyLine: { line: number; text: string } | null;
	/** A correct assignment to a field of a spread copy. */
	topLevelLine: { line: number; text: string } | null;
}

function compose(rng: Rng, library: readonly Handler[], kind: string, contextCount: number, junior: boolean): Program {
	const targets = library.filter((h) => h.defects.some((d) => d.kind === kind));
	const target = rng.pick(targets);
	const defect = rng.pick(target.defects.filter((d) => d.kind === kind));
	const others = [...INTERN, ...(junior ? JUNIOR : [])].filter((h) => h.name !== target.name);
	// The context always holds a correct in-place change of a copy and, at junior, an assignment to a field of a
	// spread copy: the traps of the wrong solutions.
	const hasCopy = (h: Handler) => h.safe.some((s) => !s.topLevel);
	const hasTop = (h: Handler) => h.safe.some((s) => s.topLevel);
	let context: Handler[] = rng.sample(others, contextCount);
	const needTop = junior && !defect.safe.some((s) => s.topLevel);
	if (!context.some(hasCopy)) context[0] = rng.pick(others.filter((h) => hasCopy(h) && !context.includes(h)));
	if (needTop && !context.some(hasTop)) {
		const slot = context.findIndex((h) => !hasCopy(h) || context.filter(hasCopy).length > 1);
		context[slot === -1 ? context.length - 1 : slot] = rng.pick(
			others.filter((h) => hasTop(h) && hasCopy(h) && !context.includes(h))
		);
	}
	context = context.filter((h, i) => context.indexOf(h) === i);
	const order = rng.shuffle([target, ...context]);

	const lines: string[] = [];
	const checks: string[] = [];
	let program: Omit<Program, 'source' | 'check' | 'copyLine' | 'topLevelLine'> | null = null;
	const copies: { line: number; text: string }[] = [];
	const tops: { line: number; text: string }[] = [];
	for (const h of order) {
		if (lines.length > 0) lines.push('');
		if (h.prelude.length > 0) lines.push(...h.prelude, '');
		lines.push(...docLines(h.doc, rng.bool()));
		const start = lines.length + 1;
		const isTarget = h === target;
		const body = isTarget ? defect.lines : h.lines;
		const safe = isTarget ? defect.safe : h.safe;
		lines.push(...body);
		for (const s of safe) (s.topLevel ? tops : copies).push({ line: start + s.at, text: s.text });
		if (isTarget) {
			program = {
				line: start + defect.fix.at,
				fix: defect.fix.text,
				neighbour: { line: start + defect.neighbour.at, text: defect.neighbour.text },
				copyOfTarget: defect.copy === null ? null : { line: start + defect.copy.at, text: defect.copy.text }
			};
		}
		checks.push('{', ...h.checks.map((c) => `  ${c}`), '}');
	}
	if (!program) throw new Error('the target handler is not in the program');
	const check = [
		'(() => {',
		'  const json = (x) => JSON.stringify(x);',
		'  const assert = (ok, what) => {',
		'    if (!ok) throw new Error(what);',
		'  };',
		...checks.map((c) => `  ${c}`),
		"  console.log('ok');",
		'})();'
	].join('\n');
	return {
		...program,
		source: lines.join('\n'),
		check,
		copyLine: copies.length > 0 ? rng.pick(copies) : null,
		topLevelLine: tops.length > 0 ? rng.pick(tops) : null
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const p = junior
		? compose(rng, JUNIOR, input.classId, rng.int(4, 5), true)
		: compose(rng, INTERN, input.classId, rng.int(3, 4), false);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль обработчиков состояния интерфейса на JavaScript. Над каждой функцией в комментарии записана её ' +
				'спецификация. Подписчики сравнивают состояния по ссылке, поэтому каждый обработчик обязан не менять на ' +
				'месте прежнее состояние, свои аргументы и общие объекты модуля — ни сами объекты, ни вложенные в них ' +
				'массивы и объекты. Менять на месте свежую копию можно. Строковые ключи и id в данных — обычные имена: не ' +
				'совпадают с именами свойств `Object.prototype` (`__proto__`, `constructor`, `toString` и т. п.).\n\n' +
				'В модуле один дефект: одна строка меняет на месте объект или массив, который принадлежит прежнему ' +
				'состоянию, аргументу или общему объекту. Введите номер строки, замена которой одной инструкцией ' +
				'восстанавливает спецификацию всех функций (нумерация с 1). Если исправить можно в нескольких строках — ' +
				'засчитывается любая из них, где замена одной инструкцией восстанавливает спецификацию. Исправление — одна ' +
				'простая инструкция того же вида, что исправляемая строка (изменение на месте можно заменить присваиванием ' +
				'новой копии): не добавляйте конструкций, которых в ней нет (стрелочные функции, циклы, обёртки, новые ' +
				'функции), и не переносите в неё логику из другой строки.',
			code: { language: 'javascript', source: p.source }
		},
		answer: { kind: 'line_no', value: p.line }
	});
	const distractors = [p.neighbour, p.copyOfTarget, p.copyLine, p.topLevelLine]
		.filter((d) => d !== null)
		.map((d) => ({ line: d.line, replacement: d.text }));
	const lineAnswer = (line: number) => ({ kind: 'answer' as const, answer: { kind: 'line_no' as const, value: line } });
	return {
		instance,
		reference: () =>
			nodeDefectProbe({
				source: p.source,
				language: 'javascript',
				check: p.check,
				line: p.line,
				fix: p.fix,
				distractors
			}),
		wrong: () => ({
			'neighbour-line': lineAnswer(p.neighbour.line),
			'copy-mutation': p.copyLine === null ? null : lineAnswer(p.copyLine.line),
			'shallow-copy-line': p.copyOfTarget === null ? null : lineAnswer(p.copyOfTarget.line),
			'top-level-on-copy': p.topLevelLine === null ? null : lineAnswer(p.topLevelLine.line)
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
