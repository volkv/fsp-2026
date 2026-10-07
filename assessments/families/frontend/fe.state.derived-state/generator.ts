// Derived state: values computed from the state on every read (selectors) against values stored in the state once
// and left behind by later changes. The program is a small store with `getState`/`setState` and prints after each
// step. The generator runs the same steps on plain objects and prints what the shown program prints; the gate runs
// the shown program with Node.
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
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Program {
	lines: string[];
	answer: string[];
	/** Output a misconception predicts; `null` — it does not apply to the class. */
	wrong: Record<string, string[] | null>;
}

const WRONG_IDS = [
	'copy-follows',
	'view-cached',
	'source-sorted',
	'sort-desc',
	'count-ids',
	'total-stale',
	'select-all-mode',
	'page-clamps',
	'page-resets',
	'page-count-stored'
] as const;

type WrongId = (typeof WRONG_IDS)[number];

/** Every wrong solution marked as not applying, with the ones of the class filled in. */
function wrongOf(applying: Partial<Record<WrongId, string[]>>): Record<string, string[] | null> {
	return Object.fromEntries(WRONG_IDS.map((id) => [id, applying[id] ?? null]));
}

const STORE = [
	'function createStore(initial) {',
	'  let state = initial;',
	'  return {',
	'    getState: () => state,',
	'    setState: (patch) => {',
	'      state = { ...state, ...patch };',
	'    }',
	'  };',
	'}',
	''
];

// ---------------------------------------------------------------------------------------------------------------
// stale-copy: a count and a total stored at creation against the same values from selectors.

interface CopyPlot {
	field: string;
	titles: readonly string[];
	value: (rng: Rng) => number;
}

const COPY_PLOTS: readonly CopyPlot[] = [
	{
		field: 'price',
		titles: ['tea', 'milk', 'bread', 'rice', 'eggs', 'cheese', 'apples', 'honey'],
		value: (rng) => 10 * rng.int(4, 30)
	},
	{
		field: 'points',
		titles: ['docs', 'tests', 'deploy', 'review', 'design', 'budget', 'search', 'login'],
		value: (rng) => rng.int(1, 13)
	},
	{
		field: 'minutes',
		titles: ['intro', 'storm', 'river', 'night', 'echo', 'dawn', 'waves', 'stars'],
		value: (rng) => rng.int(2, 9)
	},
	{
		field: 'weight',
		titles: ['tent', 'stove', 'rope', 'lamp', 'map', 'knife', 'boots', 'flask'],
		value: (rng) => 100 * rng.int(1, 25)
	}
];

interface Entry {
	title: string;
	value: number;
}

type CopyStep =
	| { kind: 'add'; title: string; value: number }
	| { kind: 'remove'; title: string }
	| { kind: 'set'; title: string; value: number }
	| { kind: 'resync' };

function staleCopy(rng: Rng): Program {
	const plot = rng.pick(COPY_PLOTS);
	const pool = rng.shuffle(plot.titles);
	const initial: Entry[] = pool.slice(0, rng.int(3, 4)).map((title) => ({ title, value: plot.value(rng) }));
	const spare = pool.slice(initial.length);
	const steps: CopyStep[] = [];
	let items = [...initial];
	const count = rng.int(4, 5);
	const resyncAt = rng.bool(0.6) ? rng.int(1, count - 2) : -1;
	for (let i = 0; i < count; i += 1) {
		if (i === resyncAt) {
			steps.push({ kind: 'resync' });
			continue;
		}
		const kinds: CopyStep['kind'][] = ['set'];
		if (spare.length > 0) kinds.push('add');
		if (items.length > 2) kinds.push('remove');
		const kind = rng.pick(kinds);
		if (kind === 'add') {
			const title = spare.shift() as string;
			const value = plot.value(rng);
			steps.push({ kind, title, value });
			items = [...items, { title, value }];
		} else if (kind === 'remove') {
			const title = rng.pick(items).title;
			steps.push({ kind, title });
			items = items.filter((e) => e.title !== title);
		} else {
			const target = rng.pick(items);
			let value = plot.value(rng);
			if (value === target.value) value += plot.value(rng);
			steps.push({ kind: 'set', title: target.title, value });
			items = items.map((e) => (e.title === target.title ? { ...e, value } : e));
		}
	}

	const sum = (list: readonly Entry[]): number => list.reduce((s, e) => s + e.value, 0);
	const run = (follows: boolean): string[] => {
		let list = [...initial];
		let storedCount = initial.length;
		let storedTotal = sum(initial);
		const out: string[] = [];
		for (const step of steps) {
			if (step.kind === 'add') list = [...list, { title: step.title, value: step.value }];
			else if (step.kind === 'remove') list = list.filter((e) => e.title !== step.title);
			else if (step.kind === 'set') list = list.map((e) => (e.title === step.title ? { ...e, value: step.value } : e));
			else storedTotal = sum(list);
			if (follows) {
				storedCount = list.length;
				storedTotal = sum(list);
			}
			out.push(`${storedCount} ${list.length} ${storedTotal} ${sum(list)}`);
		}
		return out;
	};

	const F = plot.field;
	const used = new Set(steps.map((s) => s.kind));
	const lines = [
		...STORE,
		'const items = [',
		...initial.map((e, i) => `  { title: '${e.title}', ${F}: ${e.value} }${i === initial.length - 1 ? '' : ','}`),
		'];',
		'const store = createStore({',
		'  items,',
		'  count: items.length,',
		`  total: items.reduce((sum, i) => sum + i.${F}, 0)`,
		'});',
		'',
		'const getCount = (s) => s.items.length;',
		`const getTotal = (s) => s.items.reduce((sum, i) => sum + i.${F}, 0);`,
		''
	];
	if (used.has('add'))
		lines.push(
			`function add(title, ${F}) {`,
			'  const s = store.getState();',
			`  store.setState({ items: [...s.items, { title, ${F} }] });`,
			'}'
		);
	if (used.has('remove'))
		lines.push(
			'function remove(title) {',
			'  const s = store.getState();',
			'  store.setState({ items: s.items.filter((i) => i.title !== title) });',
			'}'
		);
	const setter = `set${F[0]?.toUpperCase() ?? ''}${F.slice(1)}`;
	if (used.has('set')) {
		lines.push(
			`function ${setter}(title, ${F}) {`,
			'  const s = store.getState();',
			`  store.setState({ items: s.items.map((i) => (i.title === title ? { ...i, ${F} } : i)) });`,
			'}'
		);
	}
	lines.push(
		'function print() {',
		'  const s = store.getState();',
		'  console.log(s.count, getCount(s), s.total, getTotal(s));',
		'}',
		''
	);
	for (const step of steps) {
		if (step.kind === 'add') lines.push(`add('${step.title}', ${step.value});`);
		else if (step.kind === 'remove') lines.push(`remove('${step.title}');`);
		else if (step.kind === 'set') lines.push(`${setter}('${step.title}', ${step.value});`);
		else lines.push('store.setState({ total: getTotal(store.getState()) });');
		lines.push('print();');
	}
	return { lines, answer: run(false), wrong: wrongOf({ 'copy-follows': run(true) }) };
}

// ---------------------------------------------------------------------------------------------------------------
// filter-sort: the visible list filtered and sorted from the current state on every read.

const SHOP_TITLES: readonly (readonly string[])[] = [
	['lamp', 'desk', 'chair', 'shelf', 'rug', 'sofa', 'stool', 'bench'],
	['kettle', 'mixer', 'toaster', 'blender', 'grill', 'scale', 'juicer', 'oven'],
	['tent', 'stove', 'rope', 'map', 'knife', 'boots', 'flask', 'torch']
];

interface Good {
	title: string;
	price: number;
	stock: number;
}

type ShopStep =
	| { kind: 'sort' }
	| { kind: 'inStock' }
	| { kind: 'stock'; title: string; stock: number }
	| { kind: 'add'; good: Good };

interface ShopRules {
	cached: boolean;
	sourceSorted: boolean;
	desc: boolean;
}

function runShop(initial: readonly Good[], steps: readonly ShopStep[], rules: ShopRules): string[] {
	let items = [...initial];
	let inStock = false;
	let sort: 'title' | 'price' = 'title';
	const order = (a: Good, b: Good): number =>
		sort === 'price' ? (rules.desc ? b.price - a.price : a.price - b.price) : a.title < b.title ? -1 : 1;
	const view = (): Good[] => items.filter((g) => !inStock || g.stock > 0).sort(order);
	let cached = view();
	const out: string[] = [];
	for (const step of steps) {
		if (step.kind === 'sort') sort = 'price';
		else if (step.kind === 'inStock') inStock = true;
		else if (step.kind === 'stock')
			items = items.map((g) => (g.title === step.title ? { ...g, stock: step.stock } : g));
		else items = [...items, step.good];
		if (!rules.cached || step.kind === 'sort' || step.kind === 'inStock') cached = view();
		const shown = rules.cached ? cached : view();
		const first = rules.sourceSorted ? [...items].sort(order)[0] : items[0];
		out.push(`${shown.length} ${shown.map((g) => g.title).join(',')} ${first?.title ?? ''}`);
	}
	return out;
}

function filterSort(rng: Rng): Program {
	const pool = rng.shuffle(rng.pick(SHOP_TITLES));
	const prices = rng.sample(
		Array.from({ length: 30 }, (_, i) => 10 * (i + 2)),
		6
	);
	// Stock: one or two items sold out, the rest in stock.
	const soldOutCount = rng.int(1, 2);
	const goods: Good[] = pool.slice(0, 5).map((title, i) => ({
		title,
		price: prices[i] as number,
		stock: i < soldOutCount ? 0 : rng.int(1, 5)
	}));
	const initial = rng.shuffle(goods);
	// The first item of the source is neither the first by title nor the cheapest, so a sorted view never starts
	// with it by chance.
	const byTitle = [...initial].sort((a, b) => (a.title < b.title ? -1 : 1));
	const byPrice = [...initial].sort((a, b) => a.price - b.price);
	const firstOk = (g: Good) => g !== byTitle[0] && g !== byPrice[0];
	const head = initial.findIndex(firstOk);
	const ordered = [initial[head] as Good, ...initial.filter((_, i) => i !== head)];

	const fresh: Good = {
		title: pool[5] as string,
		price: prices[5] as number,
		stock: rng.int(1, 4)
	};
	const soldOut = rng.pick(ordered.filter((g) => g.stock === 0));
	const inStockNow = rng.pick(ordered.filter((g) => g.stock > 0));
	const views: ShopStep[] = rng.shuffle([{ kind: 'sort' }, { kind: 'inStock' }]);
	const data: ShopStep[] = rng.shuffle([
		{ kind: 'stock', title: inStockNow.title, stock: 0 },
		{ kind: 'add', good: fresh },
		{ kind: 'stock', title: soldOut.title, stock: rng.int(1, 5) }
	]);
	const steps: ShopStep[] = [views[0] as ShopStep, data[0] as ShopStep, views[1] as ShopStep, data[1] as ShopStep];
	steps.push(data[2] as ShopStep);

	const right: ShopRules = { cached: false, sourceSorted: false, desc: false };
	const run = (change: Partial<ShopRules>) => runShop(ordered, steps, { ...right, ...change });
	const lines = [
		...STORE,
		'const store = createStore({',
		'  items: [',
		...ordered.map(
			(g, i) =>
				`    { title: '${g.title}', price: ${g.price}, stock: ${g.stock} }${i === ordered.length - 1 ? '' : ','}`
		),
		'  ],',
		'  inStock: false,',
		"  sort: 'title'",
		'});',
		'',
		'const visible = (s) =>',
		'  s.items',
		'    .filter((i) => !s.inStock || i.stock > 0)',
		"    .sort((a, b) => (s.sort === 'price' ? a.price - b.price : a.title < b.title ? -1 : 1));",
		'',
		'function setStock(title, stock) {',
		'  const s = store.getState();',
		'  store.setState({ items: s.items.map((i) => (i.title === title ? { ...i, stock } : i)) });',
		'}',
		'function add(item) {',
		'  store.setState({ items: [...store.getState().items, item] });',
		'}',
		'function print() {',
		'  const s = store.getState();',
		'  const v = visible(s);',
		"  console.log(v.length, v.map((i) => i.title).join(','), s.items[0].title);",
		'}',
		''
	];
	for (const step of steps) {
		if (step.kind === 'sort') lines.push("store.setState({ sort: 'price' });");
		else if (step.kind === 'inStock') lines.push('store.setState({ inStock: true });');
		else if (step.kind === 'stock') lines.push(`setStock('${step.title}', ${step.stock});`);
		else lines.push(`add({ title: '${step.good.title}', price: ${step.good.price}, stock: ${step.good.stock} });`);
		lines.push('print();');
	}
	return {
		lines,
		answer: run({}),
		wrong: wrongOf({
			'view-cached': run({ cached: true }),
			'source-sorted': run({ sourceSorted: true }),
			'sort-desc': run({ desc: true })
		})
	};
}

// ---------------------------------------------------------------------------------------------------------------
// selected-count: «N of M» from the list and the selected ids.

const PICK_TITLES: readonly (readonly string[])[] = [
	['inbox', 'promo', 'invoice', 'report', 'digest', 'alert', 'notice', 'reply'],
	['photo', 'video', 'scan', 'draft', 'slide', 'sheet', 'memo', 'chart'],
	['anna', 'boris', 'vera', 'gleb', 'dina', 'egor', 'zoya', 'ilya']
];

interface Row {
	id: number;
	title: string;
}

type PickStep =
	{ kind: 'toggle'; id: number } | { kind: 'remove'; id: number } | { kind: 'selectAll' } | { kind: 'add'; row: Row };

interface PickRules {
	countIds: boolean;
	totalStale: boolean;
	allMode: boolean;
}

function runPick(initial: readonly Row[], steps: readonly PickStep[], rules: PickRules): string[] {
	let items = [...initial];
	let selected: number[] = [];
	const out: string[] = [];
	for (const step of steps) {
		const n0 = items.filter((r) => selected.includes(r.id)).length;
		const allBefore = items.length > 0 && n0 === items.length;
		if (step.kind === 'toggle')
			selected = selected.includes(step.id) ? selected.filter((x) => x !== step.id) : [...selected, step.id];
		else if (step.kind === 'remove') items = items.filter((r) => r.id !== step.id);
		else if (step.kind === 'selectAll') selected = items.map((r) => r.id);
		else {
			items = [...items, step.row];
			if (rules.allMode && allBefore) selected = [...selected, step.row.id];
		}
		const chosen = items.filter((r) => selected.includes(r.id));
		const n = rules.countIds ? selected.length : chosen.length;
		const m = rules.totalStale ? initial.length : items.length;
		out.push(`${n}/${m} ${String(m > 0 && n === m)} ${chosen.map((r) => r.title).join(',') || '-'}`);
	}
	return out;
}

function selectedCount(rng: Rng): Program {
	const pool = rng.shuffle(rng.pick(PICK_TITLES));
	const firstId = rng.int(1, 6);
	const initial: Row[] = pool.slice(0, 5).map((title, i) => ({ id: firstId + i, title }));
	const ids = rng.shuffle(initial.map((r) => r.id));
	const [a, b, c] = ids as [number, number, number];
	const steps: PickStep[] = [
		{ kind: 'toggle', id: a },
		{ kind: 'toggle', id: b }
	];
	const deselect = rng.bool();
	steps.push({ kind: 'toggle', id: deselect ? a : c });
	const selectedNow = deselect ? [b] : [a, b, c];
	const unselected = initial.map((r) => r.id).filter((id) => id !== a && id !== b && id !== c);
	if (rng.bool()) steps.splice(rng.int(1, steps.length), 0, { kind: 'remove', id: unselected[0] as number });
	steps.push({ kind: 'remove', id: rng.pick(selectedNow) });
	steps.push({ kind: 'selectAll' });
	const row: Row = { id: firstId + 5 + rng.int(0, 3), title: pool[5] as string };
	steps.push({ kind: 'add', row });
	steps.push(rng.bool() ? { kind: 'toggle', id: row.id } : { kind: 'remove', id: row.id });

	const right: PickRules = { countIds: false, totalStale: false, allMode: false };
	const run = (change: Partial<PickRules>) => runPick(initial, steps, { ...right, ...change });
	const lines = [
		...STORE,
		'const store = createStore({',
		'  items: [',
		...initial.map((r, i) => `    { id: ${r.id}, title: '${r.title}' }${i === initial.length - 1 ? '' : ','}`),
		'  ],',
		'  selected: []',
		'});',
		'',
		'const selectedItems = (s) => s.items.filter((i) => s.selected.includes(i.id));',
		'const allSelected = (s) => s.items.length > 0 && selectedItems(s).length === s.items.length;',
		'',
		'function toggle(id) {',
		'  const s = store.getState();',
		'  const selected = s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id];',
		'  store.setState({ selected });',
		'}',
		'function remove(id) {',
		'  store.setState({ items: store.getState().items.filter((i) => i.id !== id) });',
		'}',
		'function selectAll() {',
		'  store.setState({ selected: store.getState().items.map((i) => i.id) });',
		'}',
		'function add(item) {',
		'  store.setState({ items: [...store.getState().items, item] });',
		'}',
		'function print() {',
		'  const s = store.getState();',
		'  const chosen = selectedItems(s);',
		"  console.log(`${chosen.length}/${s.items.length}`, allSelected(s), chosen.map((i) => i.title).join(',') || '-');",
		'}',
		''
	];
	for (const step of steps) {
		if (step.kind === 'toggle') lines.push(`toggle(${step.id});`);
		else if (step.kind === 'remove') lines.push(`remove(${step.id});`);
		else if (step.kind === 'selectAll') lines.push('selectAll();');
		else lines.push(`add({ id: ${step.row.id}, title: '${step.row.title}' });`);
		lines.push('print();');
	}
	return {
		lines,
		answer: run({}),
		wrong: wrongOf({
			'count-ids': run({ countIds: true }),
			'total-stale': run({ totalStale: true }),
			'select-all-mode': run({ allMode: true })
		})
	};
}

// ---------------------------------------------------------------------------------------------------------------
// pagination: a stored page number against a computed page count and computed page items.

const FEED_PLOTS: readonly { tags: readonly [string, string]; titles: readonly string[] }[] = [
	{
		tags: ['open', 'closed'],
		titles: ['login', 'cache', 'export', 'search', 'theme', 'upload', 'menu', 'chat', 'sync']
	},
	{ tags: ['draft', 'live'], titles: ['home', 'about', 'blog', 'pricing', 'docs', 'careers', 'faq', 'terms', 'team'] },
	{ tags: ['sale', 'new'], titles: ['lamp', 'desk', 'chair', 'shelf', 'rug', 'sofa', 'stool', 'bench', 'vase'] },
	{
		tags: ['todo', 'done'],
		titles: ['docs', 'tests', 'deploy', 'review', 'design', 'budget', 'audit', 'backup', 'release']
	}
];

interface Post {
	title: string;
	tag: string;
}

type PageStep = { kind: 'page'; page: number } | { kind: 'tag'; tag: string } | { kind: 'add'; post: Post };

interface PageRules {
	clamps: boolean;
	resets: boolean;
	countStored: boolean;
}

function runPages(initial: readonly Post[], size: number, steps: readonly PageStep[], rules: PageRules): string[] {
	let items = [...initial];
	let tag = 'all';
	let page = 1;
	const visible = () => items.filter((p) => tag === 'all' || p.tag === tag);
	const count = () => Math.max(1, Math.ceil(visible().length / size));
	const storedCount = count();
	const out: string[] = [];
	for (const step of steps) {
		if (step.kind === 'page') page = step.page;
		else if (step.kind === 'tag') {
			tag = step.tag;
			if (rules.resets) page = 1;
		} else items = [...items, step.post];
		if (rules.clamps) page = Math.min(page, count());
		const shown = visible()
			.slice((page - 1) * size, page * size)
			.map((p) => p.title)
			.join(',');
		out.push(`${page} ${rules.countStored ? storedCount : count()} ${shown || '-'}`);
	}
	return out;
}

function pagination(rng: Rng): Program {
	const plot = rng.pick(FEED_PLOTS);
	const titles = rng.shuffle(plot.titles);
	const size = rng.int(2, 3);
	const total = rng.int(7, 8);
	const [major, minor] = rng.shuffle(plot.tags) as [string, string];
	// The minor tag fits on fewer pages than the page the reader goes to first.
	const minorCount = rng.int(1, size);
	const tags = rng.shuffle([
		...Array.from({ length: minorCount }, () => minor),
		...Array.from({ length: total - minorCount }, () => major)
	]);
	const initial: Post[] = tags.map((tag, i) => ({ tag, title: titles[i] as string }));
	const pages = Math.ceil(total / size);
	const steps: PageStep[] = [{ kind: 'page', page: rng.int(Math.max(2, pages - 1), pages) }];
	steps.push({ kind: 'tag', tag: minor });
	steps.push({ kind: 'add', post: { title: titles[total] as string, tag: minor } });
	const after = Math.ceil((minorCount + 1) / size);
	steps.push({ kind: 'page', page: rng.int(1, after) });
	if (rng.bool()) steps.push({ kind: 'tag', tag: rng.pick(['all', major]) });
	else steps.splice(3, 0, { kind: 'tag', tag: rng.pick(['all', major]) });

	const right: PageRules = { clamps: false, resets: false, countStored: false };
	const run = (change: Partial<PageRules>) => runPages(initial, size, steps, { ...right, ...change });
	const lines = [
		...STORE,
		`const PAGE_SIZE = ${size};`,
		'const store = createStore({',
		'  items: [',
		...initial.map((p, i) => `    { title: '${p.title}', tag: '${p.tag}' }${i === initial.length - 1 ? '' : ','}`),
		'  ],',
		"  tag: 'all',",
		'  page: 1',
		'});',
		'',
		"const visible = (s) => s.items.filter((i) => s.tag === 'all' || i.tag === s.tag);",
		'const pageCount = (s) => Math.max(1, Math.ceil(visible(s).length / PAGE_SIZE));',
		'const shown = (s) => visible(s).slice((s.page - 1) * PAGE_SIZE, s.page * PAGE_SIZE);',
		'',
		'function add(item) {',
		'  store.setState({ items: [...store.getState().items, item] });',
		'}',
		'function print() {',
		'  const s = store.getState();',
		"  console.log(s.page, pageCount(s), shown(s).map((i) => i.title).join(',') || '-');",
		'}',
		''
	];
	for (const step of steps) {
		if (step.kind === 'page') lines.push(`store.setState({ page: ${step.page} });`);
		else if (step.kind === 'tag') lines.push(`store.setState({ tag: '${step.tag}' });`);
		else lines.push(`add({ title: '${step.post.title}', tag: '${step.post.tag}' });`);
		lines.push('print();');
	}
	return {
		lines,
		answer: run({}),
		wrong: wrongOf({
			'page-clamps': run({ clamps: true }),
			'page-resets': run({ resets: true }),
			'page-count-stored': run({ countStored: true })
		})
	};
}

// ---------------------------------------------------------------------------------------------------------------

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'stale-copy': staleCopy,
	'filter-sort': filterSort,
	'selected-count': selectedCount,
	pagination
};

const differs = (a: readonly string[], b: readonly string[]): boolean =>
	a.length !== b.length || a.some((x, i) => x !== b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draw = PROGRAMS[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	// Every misconception of the class is built to change the output; a draw where one does not is drawn again, and
	// the last draw is kept with that misconception marked as not applying to this instance.
	let program = draw(rng);
	for (let tries = 0; tries < 30; tries += 1) {
		if (Object.values(program.wrong).every((w) => w === null || differs(w, program.answer))) break;
		program = draw(rng);
	}
	const source = program.lines.join('\n');
	const toAnswer = (values: readonly string[]) => ({ kind: 'sequence' as const, value: [...values] });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа (Node.js)? Введите вывод построчно, как он появится в консоли: значения в строке — ' +
				'через один пробел, как их печатает `console.log`.',
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
					const values = program.wrong[id] ?? null;
					return [
						id,
						values === null || !differs(values, program.answer)
							? null
							: { kind: 'answer' as const, answer: toAnswer(values) }
					];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
