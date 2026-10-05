// Pagination: which records a page holds under a sort with a tie-break and a filter, how many pages there are, and
// what a client walking the pages sees when records are added and removed between its requests — offset pagination
// shifts, keyset pagination by (created_at, id) does not.
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

// Intern: one request for one page.

interface Product {
	id: number;
	price: number;
	active: boolean;
	/** Only in the class with two sort keys. */
	category: string | null;
}

interface InternParams {
	rows: Product[];
	limit: number;
	page: number;
	desc: boolean;
	filter: boolean;
	/** `ORDER BY category ASC, price DESC, id ASC`. */
	twoKeys: boolean;
}

interface InternRules {
	pageFromOne: boolean;
	ceilPages: boolean;
	tiebreak: 'id-asc' | 'table' | 'id-desc';
	filterFirst: boolean;
	categoryDesc: boolean;
}

const INTERN_RIGHT: InternRules = {
	pageFromOne: true,
	ceilPages: true,
	tiebreak: 'id-asc',
	filterFirst: true,
	categoryDesc: false
};

function sortProducts(
	rows: readonly Product[],
	desc: boolean,
	tiebreak: InternRules['tiebreak'],
	categoryDesc: boolean
): Product[] {
	// Array.prototype.sort is stable: equal keys keep the order of the table.
	return [...rows].sort((a, b) => {
		const byCategory = (a.category ?? '').localeCompare(b.category ?? '') * (categoryDesc ? -1 : 1);
		if (byCategory !== 0) return byCategory;
		const byPrice = desc ? b.price - a.price : a.price - b.price;
		if (byPrice !== 0 || tiebreak === 'table') return byPrice;
		return tiebreak === 'id-asc' ? a.id - b.id : b.id - a.id;
	});
}

function internAnswer(p: InternParams, rules: InternRules): string {
	const sorted = sortProducts(p.rows, p.desc, rules.tiebreak, rules.categoryDesc);
	const counted = p.filter && rules.filterFirst ? sorted.filter((r) => r.active) : sorted;
	const total = counted.length;
	const pages = rules.ceilPages ? Math.ceil(total / p.limit) : Math.floor(total / p.limit);
	const offset = (rules.pageFromOne ? p.page - 1 : p.page) * p.limit;
	let page = counted.slice(offset, offset + p.limit);
	if (p.filter && !rules.filterFirst) page = page.filter((r) => r.active);
	return [pages, ...page.map((r) => r.id)].join(' ');
}

function internScenario(rng: Rng, classId: string): InternParams {
	const filter = classId === 'filtered';
	const limit = rng.pick([3, 4, 5]);
	const count = rng.int(11, 16);
	const ids = rng.sample(
		Array.from({ length: 99 }, (_, i) => 101 + i),
		count
	);
	// Few distinct prices, so that equal prices are common.
	const prices = rng.sample(
		Array.from({ length: 40 }, (_, i) => 90 + i * 10),
		rng.int(4, 7)
	);
	const twoKeys = classId === 'two-keys';
	const categories = rng.sample(['books', 'games', 'music', 'tools', 'toys'], 3);
	const rows = ids.map((id) => ({
		id,
		price: rng.pick(prices),
		active: filter ? rng.bool(0.65) : true,
		category: twoKeys ? rng.pick(categories) : null
	}));
	const visible = filter ? rows.filter((r) => r.active).length : rows.length;
	const pages = Math.max(1, Math.ceil(visible / limit));
	return {
		rows,
		limit,
		page: rng.int(Math.min(2, pages), pages),
		desc: classId === 'desc-ties' || twoKeys,
		filter,
		twoKeys
	};
}

function describeIntern(p: InternParams): string {
	const field = p.filter
		? '| id | price | status |\n|---|---|---|'
		: p.twoKeys
			? '| id | category | price |\n|---|---|---|'
			: '| id | price |\n|---|---|';
	const table = p.rows.map((r) =>
		p.filter
			? `| ${r.id} | ${r.price} | ${r.active ? 'active' : 'archived'} |`
			: p.twoKeys
				? `| ${r.id} | ${r.category ?? ''} | ${r.price} |`
				: `| ${r.id} | ${r.price} |`
	);
	const order = p.twoKeys ? 'category ASC, price DESC, id ASC' : p.desc ? 'price DESC, id ASC' : 'price ASC, id ASC';
	const query = p.filter
		? `GET /api/products?status=active&sort=price&page=${p.page}&limit=${p.limit}`
		: p.twoKeys
			? `GET /api/products?sort=category,-price&page=${p.page}&limit=${p.limit}`
			: `GET /api/products?sort=price${p.desc ? '&order=desc' : ''}&page=${p.page}&limit=${p.limit}`;
	return [
		'Таблица `products` (строки в порядке хранения):',
		'',
		field,
		...table,
		'',
		`Клиент запрашивает \`${query}\`. Сервер:`,
		'',
		...(p.filter ? ["- оставляет только записи со `status = 'active'`;"] : []),
		`- сортирует записи по \`ORDER BY ${order}\`;`,
		`- делит отсортированный список на страницы по ${p.limit} ${p.limit < 5 ? 'записи' : 'записей'}, страницы нумеруются с 1, последняя страница может быть неполной;`,
		'- возвращает записи запрошенной страницы и поле `total_pages` — сколько всего страниц.',
		'',
		'Введите через пробел значение `total_pages`, затем id записей на запрошенной странице в порядке выдачи. Например: `5 101 102 103`.'
	].join('\n');
}

const INTERN_REFERENCE = `import json

p = json.loads(input())
rows = p["rows"]
if p["filter"]:
    rows = [r for r in rows if r["active"]]
if p["twoKeys"]:
    rows = sorted(rows, key=lambda r: (r["category"], -r["price"], r["id"]))
elif p["desc"]:
    rows = sorted(rows, key=lambda r: (-r["price"], r["id"]))
else:
    rows = sorted(rows, key=lambda r: (r["price"], r["id"]))
limit = p["limit"]
pages = (len(rows) + limit - 1) // limit
start = (p["page"] - 1) * limit
print(pages, *[r["id"] for r in rows[start:start + limit]])
`;

const INTERN_WRONG: Record<string, Partial<InternRules>> = {
	'page-from-zero': { pageFromOne: false },
	'pages-floor': { ceilPages: false },
	'ignore-tiebreak': { tiebreak: 'table' },
	'tiebreak-reversed': { tiebreak: 'id-desc' },
	'filter-after-page': { filterFirst: false },
	'direction-all-keys': { categoryDesc: true, tiebreak: 'id-desc' }
};

// Junior: a client walks three pages while records come and go.

interface Post {
	id: number;
	minute: number;
}

type Change = { kind: 'insert'; post: Post } | { kind: 'delete'; id: number };

interface JuniorParams {
	rows: Post[];
	limit: number;
	keyset: boolean;
	/** Oldest first: `ORDER BY created_at ASC, id ASC`, the cursor compares with `>`. */
	asc: boolean;
	/** Changes between request 1 and 2, and between request 2 and 3. */
	between: [Change[], Change[]];
}

interface JuniorRules {
	method: 'offset' | 'keyset';
	frozen: boolean;
	cursorBothColumns: boolean;
}

/** Feed order: newest first, equal moments by greater id first. */
const feedOrder = (a: Post, b: Post): number => b.minute - a.minute || b.id - a.id;
const ascOrder = (a: Post, b: Post): number => -feedOrder(a, b);

function applyChanges(rows: readonly Post[], changes: readonly Change[]): Post[] {
	let next = [...rows];
	for (const change of changes) {
		if (change.kind === 'insert') next.push(change.post);
		else next = next.filter((r) => r.id !== change.id);
	}
	return next;
}

function juniorAnswer(p: JuniorParams, rules: JuniorRules): string {
	let rows = [...p.rows];
	const pages: Post[][] = [];
	for (let request = 0; request < 3; request += 1) {
		if (request > 0 && !rules.frozen) rows = applyChanges(rows, p.between[request - 1] ?? []);
		const sorted = [...rows].sort(p.asc ? ascOrder : feedOrder);
		const sign = p.asc ? -1 : 1;
		const last = pages[pages.length - 1]?.at(-1);
		if (rules.method === 'offset' || request === 0) {
			pages.push(sorted.slice(request * p.limit, (request + 1) * p.limit));
		} else if (last === undefined) {
			pages.push([]);
		} else {
			// Past the cursor in the order of the feed: smaller pairs when newest first, greater when oldest first.
			const after = sorted.filter((r) =>
				rules.cursorBothColumns
					? sign * (last.minute - r.minute) > 0 || (r.minute === last.minute && sign * (last.id - r.id) > 0)
					: sign * (last.minute - r.minute) > 0
			);
			pages.push(after.slice(0, p.limit));
		}
	}
	// Tokens: an empty page leaves two separators side by side.
	return pages
		.map((page) => page.map((r) => r.id).join(' '))
		.join(' | ')
		.split(/\s+/)
		.filter(Boolean)
		.join(' ');
}

const clock = (minute: number): string =>
	`${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function juniorScenario(rng: Rng, classId: string): JuniorParams {
	const limit = rng.pick([3, 4]);
	const count =
		classId === 'keyset-ascending' ? 2 * limit + rng.int(1, limit - 1) : rng.int(Math.max(9, 2 * limit + 2), 12);
	const base = rng.int(20, 80) * 10;
	const rows: Post[] = [];
	let minute = rng.int(0, 20);
	const tieStep = classId === 'keyset-ties' ? [0, 0, 1, 2] : [0, 1, 1, 2, 3];
	for (let i = 0; i < count; i += 1) {
		rows.push({ id: base + i, minute });
		minute += rng.pick(tieStep);
	}
	let nextId = base + count;
	const top = (): Change => {
		minute += rng.int(1, 3);
		const post = { id: nextId, minute };
		nextId += 1;
		return { kind: 'insert', post };
	};
	const backdated = (): Change => {
		const anchor = rng.pick(rows.slice(0, count - limit));
		const post = { id: nextId, minute: anchor.minute };
		nextId += 1;
		return { kind: 'insert', post };
	};
	const remove = (from: number, to: number): Change => {
		const sorted = [...rows].sort(feedOrder);
		return { kind: 'delete', id: rng.pick(sorted.slice(from, to)).id };
	};
	const first: Change[] = [];
	const second: Change[] = [];
	if (classId === 'offset-shift') {
		for (let i = rng.int(1, 2); i > 0; i -= 1) first.push(top());
		second.push(remove(0, 2 * limit));
		if (rng.bool()) second.push(top());
	} else if (classId === 'keyset-changes') {
		for (let i = rng.int(1, 2); i > 0; i -= 1) first.push(top());
		first.push(backdated());
		second.push(remove(0, 2 * limit));
		if (rng.bool()) second.push(top());
	} else if (classId === 'keyset-ascending') {
		// Oldest first: the first page holds the oldest; new records land at the end of the walk.
		const oldest = [...rows].sort(ascOrder);
		for (let i = rng.int(1, 2); i > 0; i -= 1) first.push(top());
		first.push({ kind: 'delete', id: rng.pick(oldest.slice(0, limit)).id });
		if (rng.bool()) second.push(top());
		else second.push({ kind: 'delete', id: rng.pick(oldest.slice(2 * limit)).id });
	} else {
		for (let i = rng.int(1, 2); i > 0; i -= 1) first.push(top());
		if (rng.bool()) second.push(top());
		else second.push(remove(0, limit));
	}
	// A deletion may name a record twice; keep the changes meaningful.
	const unique = (changes: Change[]): Change[] =>
		changes.filter(
			(c, i) => c.kind === 'insert' || changes.findIndex((o) => o.kind === 'delete' && o.id === c.id) === i
		);
	return {
		rows,
		limit,
		keyset: classId !== 'offset-shift',
		asc: classId === 'keyset-ascending',
		between: [unique(first), unique(second)]
	};
}

function describeChanges(changes: readonly Change[]): string {
	return changes
		.map((c) =>
			c.kind === 'insert'
				? `добавлена запись id = ${c.post.id}, created_at = ${clock(c.post.minute)}`
				: `удалена запись id = ${c.id}`
		)
		.join('; ');
}

function describeJunior(p: JuniorParams): string {
	const requests = p.keyset
		? [
				`1. \`GET /api/feed?limit=${p.limit}\` — первая страница;`,
				`2. \`GET /api/feed?limit=${p.limit}&after=<курсор>\` — курсор из ответа 1;`,
				`3. \`GET /api/feed?limit=${p.limit}&after=<курсор>\` — курсор из ответа 2.`
			]
		: [
				`1. \`GET /api/feed?limit=${p.limit}&offset=0\`;`,
				`2. \`GET /api/feed?limit=${p.limit}&offset=${p.limit}\`;`,
				`3. \`GET /api/feed?limit=${p.limit}&offset=${2 * p.limit}\`.`
			];
	const order = p.asc ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';
	const method = p.keyset
		? [
				'Курсор в ответе — пара `(created_at, id)` последней записи страницы. Следующая страница — запрос',
				`\`... WHERE (created_at, id) ${p.asc ? '>' : '<'} (:created_at, :id) ORDER BY ${order} LIMIT n\`: сравнение пар —`,
				'сначала по `created_at`, при равенстве — по `id`. Если страница пустая, курсора нет и следующая страница тоже пустая.'
			].join(' ')
		: `Страница — \`ORDER BY ${order} LIMIT n OFFSET m\` по данным на момент запроса.`;
	return [
		'Лента `posts` на момент первого запроса (строки по возрастанию id):',
		'',
		'| id | created_at |',
		'|---|---|',
		...p.rows.map((r) => `| ${r.id} | ${clock(r.minute)} |`),
		'',
		`Лента отдаётся ${p.asc ? 'от старых к новым' : 'от новых к старым'}: \`ORDER BY ${order}\`. ${method}`,
		'',
		'Клиент по очереди делает три запроса:',
		'',
		...requests,
		'',
		`Между запросами 1 и 2: ${describeChanges(p.between[0])}.`,
		`Между запросами 2 и 3: ${describeChanges(p.between[1])}.`,
		'',
		'Каждый запрос видит данные на момент своего выполнения. Введите id записей, которые клиент получит, по страницам в порядке выдачи; страницы разделите знаком `|`, пустую страницу оставьте пустой. Например: `310 309 308 | 307 306 305 | 304`.'
	].join('\n');
}

const JUNIOR_REFERENCE = `import json

p = json.loads(input())
rows = {r["id"]: r["minute"] for r in p["rows"]}
limit = p["limit"]
pages = []
for request in range(3):
    if request > 0:
        for c in p["between"][request - 1]:
            if c["kind"] == "insert":
                rows[c["post"]["id"]] = c["post"]["minute"]
            else:
                rows.pop(c["id"], None)
    feed = sorted(rows.items(), key=lambda kv: (kv[1], kv[0]), reverse=not p["asc"])
    if not p["keyset"]:
        page = feed[request * limit:(request + 1) * limit]
    elif request == 0:
        page = feed[:limit]
    elif not pages[-1]:
        page = []
    else:
        cursor_id, cursor_minute = pages[-1][-1]
        cursor = (cursor_minute, cursor_id)
        if p["asc"]:
            page = [kv for kv in feed if (kv[1], kv[0]) > cursor][:limit]
        else:
            page = [kv for kv in feed if (kv[1], kv[0]) < cursor][:limit]
    pages.append(page)
print(" | ".join(" ".join(str(i) for i, _ in page) for page in pages))
`;

/** A misconception of the junior level as a change of the rules for the class's method. */
function juniorWrong(id: string, keyset: boolean): Partial<JuniorRules> | null {
	switch (id) {
		case 'frozen-snapshot':
			return { frozen: true };
		case 'offset-as-keyset':
			return keyset ? null : { method: 'keyset' };
		case 'keyset-as-offset':
			return keyset ? { method: 'offset' } : null;
		case 'cursor-created-only':
			return keyset ? { cursorBothColumns: false } : null;
		default:
			return null;
	}
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/asc-ties': ['ignore-tiebreak', 'page-from-zero', 'pages-floor'],
	'intern/desc-ties': ['tiebreak-reversed', 'page-from-zero', 'pages-floor'],
	'intern/filtered': ['filter-after-page', 'pages-floor'],
	'junior/offset-shift': ['frozen-snapshot', 'offset-as-keyset'],
	'junior/keyset-changes': ['frozen-snapshot', 'keyset-as-offset'],
	'junior/keyset-ties': ['cursor-created-only', 'keyset-as-offset'],
	'intern/two-keys': ['direction-all-keys', 'page-from-zero', 'pages-floor'],
	'junior/keyset-ascending': ['frozen-snapshot', 'keyset-as-offset']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 300; tries += 1) {
		let answer: string;
		let wrong: Record<string, string | null>;
		let markdown: string;
		let reference: string;
		let stdin: string;
		if (input.grade === 'intern') {
			const p = internScenario(rng, input.classId);
			answer = internAnswer(p, INTERN_RIGHT);
			wrong = Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					// Several sort keys exist only in one class.
					const change = id === 'direction-all-keys' && !p.twoKeys ? undefined : INTERN_WRONG[id];
					const value = change === undefined ? answer : internAnswer(p, { ...INTERN_RIGHT, ...change });
					return [id, value === answer ? null : value];
				})
			);
			markdown = describeIntern(p);
			reference = INTERN_REFERENCE;
			stdin = JSON.stringify(p);
		} else {
			const p = juniorScenario(rng, input.classId);
			const right: JuniorRules = { method: p.keyset ? 'keyset' : 'offset', frozen: false, cursorBothColumns: true };
			answer = juniorAnswer(p, right);
			wrong = Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const change = juniorWrong(id, p.keyset);
					const value = change === null ? answer : juniorAnswer(p, { ...right, ...change });
					return [id, value === answer ? null : value];
				})
			);
			markdown = describeJunior(p);
			reference = JUNIOR_REFERENCE;
			stdin = JSON.stringify(p);
		}
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown, code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: reference, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
