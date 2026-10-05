// Pagination drift: a client walks a list page by page (offset, or a cursor with a stated condition) while items are
// created, deleted and edited between the requests; the tester predicts which items the client gets twice and which it
// never gets.
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

/** `score` — by score descending, equal scores by id ascending; `updated` — by updated_at descending, then id descending. */
type Sort = 'id-desc' | 'id-asc' | 'updated' | 'score';
type Paging = 'offset' | 'cursor-tuple' | 'cursor-score' | 'cursor-flipped';

interface Item {
	id: number;
	/** The sort value besides id: updated_at in minutes or the score; equals id for the id sorts. */
	key: number;
}

interface Event {
	/** Happens after the response to this page and before the next request. */
	afterPage: number;
	kind: 'insert' | 'delete' | 'update';
	id: number;
	key: number;
}

interface Params {
	sort: Sort;
	paging: Paging;
	limit: number;
	items: Item[];
	events: Event[];
}

interface Rules {
	offsetStable: boolean;
	sidesSwapped: boolean;
	deletedMissed: boolean;
	cursorAsOffset: boolean;
	updateIgnored: boolean;
	tupleAssumed: boolean;
}

const RIGHT: Rules = {
	offsetStable: false,
	sidesSwapped: false,
	deletedMissed: false,
	cursorAsOffset: false,
	updateIgnored: false,
	tupleAssumed: false
};

function compare(sort: Sort, a: Item, b: Item): number {
	switch (sort) {
		case 'id-desc':
			return b.id - a.id;
		case 'id-asc':
			return a.id - b.id;
		case 'updated':
			return b.key - a.key || b.id - a.id;
		case 'score':
			return b.key - a.key || a.id - b.id;
	}
}

function after(sort: Sort, paging: Paging, item: Item, cursor: Item): boolean {
	if (paging === 'cursor-score') return item.key < cursor.key;
	if (paging === 'cursor-flipped') return item.key < cursor.key || (item.key === cursor.key && item.id < cursor.id);
	return compare(sort, item, cursor) > 0;
}

interface Walk {
	received: number[];
	deleted: Set<number>;
	pages: number;
}

function walk(p: Params, paging: Paging, applyUpdates: boolean): Walk {
	const state = new Map(p.items.map((i) => [i.id, i.key]));
	const received: number[] = [];
	const deleted = new Set<number>();
	let offset = 0;
	let cursor: Item | null = null;
	let pages = 0;
	for (let page = 1; page <= 40; page += 1) {
		pages = page;
		const list = [...state.entries()].map(([id, key]) => ({ id, key })).sort((a, b) => compare(p.sort, a, b));
		const from: Item | null = cursor;
		const chunk: Item[] =
			paging === 'offset'
				? list.slice(offset, offset + p.limit)
				: from === null
					? list.slice(0, p.limit)
					: list.filter((i) => after(p.sort, paging, i, from)).slice(0, p.limit);
		received.push(...chunk.map((i) => i.id));
		offset += p.limit;
		cursor = chunk.at(-1) ?? cursor;
		if (chunk.length < p.limit) break;
		for (const e of p.events.filter((x) => x.afterPage === page)) {
			if (e.kind === 'insert') state.set(e.id, e.key);
			else if (e.kind === 'delete') {
				state.delete(e.id);
				deleted.add(e.id);
			} else if (applyUpdates) state.set(e.id, e.key);
		}
	}
	return { received, deleted, pages };
}

/** `twice | missed` under a model of the client's walk. */
function outcome(p: Params, rules: Rules): string {
	if (rules.offsetStable) return '- | -';
	const paging: Paging = rules.cursorAsOffset ? 'offset' : rules.tupleAssumed ? 'cursor-tuple' : p.paging;
	const w = walk(p, paging, !rules.updateIgnored);
	const counts = new Map<number, number>();
	for (const id of w.received) counts.set(id, (counts.get(id) ?? 0) + 1);
	const twice = [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
	const missed = p.items
		.map((i) => i.id)
		.filter((id) => !counts.has(id) && (rules.deletedMissed || !w.deleted.has(id)));
	const text = (ids: number[]): string => (ids.length ? [...ids].sort((a, b) => a - b).join(' ') : '-');
	return rules.sidesSwapped ? `${text(missed)} | ${text(twice)}` : `${text(twice)} | ${text(missed)}`;
}

interface Shape {
	sort: Sort;
	paging: Paging;
}

const SHAPES: Record<string, Shape> = {
	'middle/offset-insert': { sort: 'id-desc', paging: 'offset' },
	'middle/offset-delete': { sort: 'id-desc', paging: 'offset' },
	'middle/cursor-edits': { sort: 'updated', paging: 'cursor-tuple' },
	'middle/offset-ascending': { sort: 'id-asc', paging: 'offset' },
	'senior/score-only-cursor': { sort: 'score', paging: 'cursor-score' },
	'senior/score-updates': { sort: 'score', paging: 'cursor-tuple' },
	'senior/comparator-mismatch': { sort: 'score', paging: 'cursor-flipped' },
	'senior/offset-reranking': { sort: 'score', paging: 'offset' }
};

function scenario(rng: Rng, grade: string, classId: string): Params {
	const shape = SHAPES[`${grade}/${classId}`];
	if (!shape) throw new Error(`${descriptor.key}: no shape for ${grade}/${classId}`);
	const n = grade === 'middle' ? rng.int(9, 12) : rng.int(10, 13);
	const limit = rng.int(3, 4);
	const ids = rng
		.sample(
			Array.from({ length: 80 }, (_, i) => i + 10),
			n
		)
		.sort((a, b) => a - b);
	let nextId = (ids.at(-1) ?? 90) + rng.int(1, 3);
	const newId = (): number => {
		const id = nextId;
		nextId += rng.int(1, 3);
		return id;
	};
	const events: Event[] = [];
	const page = (): number => rng.int(1, 2);
	let items: Item[];
	if (shape.sort === 'score') {
		const values = rng.sample(
			Array.from({ length: 60 }, (_, i) => 40 + i),
			rng.int(4, 5)
		);
		items = ids.map((id) => ({ id, key: rng.pick(values) }));
		const order = [...items].sort((a, b) => compare('score', a, b));
		if (classId === 'score-updates' || classId === 'offset-reranking') {
			for (let k = rng.int(2, 3); k > 0; k -= 1) {
				const at = page();
				// Items around the window move up or down through it.
				const target = rng.pick(order.slice(at * limit - 1, Math.min(order.length, at * limit + limit + 2)));
				events.push({ afterPage: at, kind: 'update', id: target.id, key: rng.pick([...values, rng.int(40, 99)]) });
			}
		} else if (rng.bool(0.4)) {
			events.push({ afterPage: page(), kind: 'insert', id: newId(), key: rng.pick(values) });
		}
	} else if (shape.sort === 'updated') {
		const times = rng.sample(
			Array.from({ length: 180 }, (_, i) => i),
			n
		);
		items = ids.map((id, i) => ({ id, key: times[i] ?? i }));
		const order = [...items].sort((a, b) => compare('updated', a, b));
		let now = 180 + rng.int(1, 10);
		// Pages first, in order, so event times grow along the walk.
		const ats = Array.from({ length: rng.int(2, 3) }, page).sort((a, b) => a - b);
		for (const at of ats) {
			const roll = rng.int(0, 5);
			// An item is touched by one event at most.
			const free = order.filter((i) => !events.some((e) => e.id === i.id));
			if (roll <= 3) {
				// Mostly items the client has not reached yet.
				const pool = roll <= 2 ? free.filter((i) => order.indexOf(i) >= at * limit) : free;
				const target = rng.pick(pool.length ? pool : free);
				events.push({ afterPage: at, kind: 'update', id: target.id, key: now });
			} else if (roll === 4) events.push({ afterPage: at, kind: 'insert', id: newId(), key: now });
			else events.push({ afterPage: at, kind: 'delete', id: rng.pick(free).id, key: 0 });
			now += rng.int(1, 9);
		}
	} else {
		items = ids.map((id) => ({ id, key: id }));
		const order = [...items].sort((a, b) => compare(shape.sort, a, b));
		const seen = (at: number): Item[] => order.slice(0, at * limit);
		const unseen = (at: number): Item[] => order.slice(at * limit + 1);
		const remove = (at: number, pool: Item[]): void => {
			const free = pool.filter((i) => !events.some((e) => e.id === i.id));
			if (free.length) events.push({ afterPage: at, kind: 'delete', id: rng.pick(free).id, key: 0 });
		};
		if (classId === 'offset-insert') {
			for (let k = rng.int(1, 3); k > 0; k -= 1) {
				const id = newId();
				events.push({ afterPage: page(), kind: 'insert', id, key: id });
			}
			if (rng.bool(0.4)) remove(page(), unseen(2));
		} else if (classId === 'offset-delete') {
			for (let k = rng.int(1, 2); k > 0; k -= 1) {
				const at = page();
				remove(at, seen(at));
			}
			if (rng.bool(0.7)) remove(page(), unseen(2));
			if (rng.bool(0.3)) {
				const id = newId();
				events.push({ afterPage: page(), kind: 'insert', id, key: id });
			}
		} else {
			for (let k = rng.int(0, 2); k > 0; k -= 1) {
				const id = newId();
				events.push({ afterPage: page(), kind: 'insert', id, key: id });
			}
			const at = page();
			remove(at, seen(at));
			if (rng.bool(0.7)) remove(page(), unseen(2));
		}
	}
	events.sort((a, b) => a.afterPage - b.afterPage);
	return { sort: shape.sort, paging: shape.paging, limit, items, events };
}

const clock = (minutes: number): string =>
	`${String(9 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function describe(p: Params): string {
	const order = [...p.items].sort((a, b) => compare(p.sort, a, b));
	const sortText: Record<Sort, string> = {
		'id-desc': 'по `id` по убыванию: новые элементы получают `id` больше всех существующих и встают в начало списка',
		'id-asc': 'по `id` по возрастанию: новые элементы получают `id` больше всех существующих и встают в конец списка',
		updated:
			'по `updated_at` по убыванию, при равенстве — по `id` по убыванию; создание и любая правка элемента ставят ему `updated_at` = время события',
		score: 'по `score` по убыванию, при равных `score` — по `id` по возрастанию'
	};
	const pagingText: Record<Paging, string> = {
		offset:
			'`offset`: страница — элементы текущего списка с позиции `offset + 1` по `offset + limit`; первая страница — с `offset=0`, каждая следующая — с `offset`, больше предыдущего на `limit`.',
		'cursor-tuple':
			p.sort === 'updated'
				? 'курсор: в ответе есть курсор — `updated_at` и `id` последнего элемента страницы; следующая страница — первые `limit` элементов текущего списка, у которых `updated_at` меньше, чем в курсоре, или `updated_at` равен, а `id` меньше.'
				: 'курсор: в ответе есть курсор — `score` и `id` последнего элемента страницы; следующая страница — первые `limit` элементов текущего списка, у которых `score` меньше, чем в курсоре, или `score` равен, а `id` больше.',
		'cursor-score':
			'курсор: в ответе есть курсор — `score` последнего элемента страницы; следующая страница — первые `limit` элементов текущего списка, у которых `score` меньше, чем в курсоре.',
		'cursor-flipped':
			'курсор: в ответе есть курсор — `score` и `id` последнего элемента страницы; следующая страница — первые `limit` элементов текущего списка, у которых `score` меньше, чем в курсоре, или `score` равен, а `id` меньше.'
	};
	const head = p.sort === 'updated' ? 'id   updated_at' : p.sort === 'score' ? 'id   score' : null;
	const rows =
		head === null
			? [order.map((i) => i.id).join(' ')]
			: [head, ...order.map((i) => `${String(i.id).padEnd(5)}${p.sort === 'updated' ? clock(i.key) : String(i.key)}`)];
	const pages = [...new Set(p.events.map((e) => e.afterPage))];
	const eventText = (e: Event): string => {
		if (e.kind === 'delete') return `удалён элемент ${e.id}`;
		if (p.sort === 'updated')
			return e.kind === 'insert'
				? `в ${clock(e.key)} создан элемент ${e.id}`
				: `в ${clock(e.key)} изменён элемент ${e.id}`;
		if (p.sort === 'score')
			return e.kind === 'insert'
				? `создан элемент ${e.id} со score ${e.key}`
				: `у элемента ${e.id} score стал ${e.key}`;
		return `создан элемент ${e.id}`;
	};
	return [
		`Клиент выгружает ленту \`GET /api/v1/vacancies?limit=${p.limit}\` постранично, а тестировщик проверяет, что он увидит, если список меняется между запросами.`,
		'',
		'## Как устроена выдача',
		'',
		`- Сортировка ${sortText[p.sort]}.`,
		`- Пагинация — ${pagingText[p.paging]}`,
		`- Клиент запрашивает первую страницу, затем следующие, пока не получит страницу, где меньше ${p.limit} элементов (в том числе пустую).`,
		'',
		'## Список перед первым запросом',
		'',
		'В порядке выдачи:',
		'',
		'```',
		...rows,
		'```',
		'',
		'## События между запросами',
		'',
		...(pages.length
			? pages.map(
					(k) =>
						`- После ответа на страницу ${k} и до запроса страницы ${k + 1}: ${p.events
							.filter((e) => e.afterPage === k)
							.map(eventText)
							.join('; ')}.`
				)
			: ['- Список между запросами не меняется.']),
		'',
		'## Что посчитать',
		'',
		'- Получен дважды — элемент, который пришёл клиенту больше одного раза за весь обход.',
		'- Пропущен — элемент, который был в списке перед первым запросом, не был удалён до конца обхода, но ни разу не пришёл клиенту.',
		'',
		'Введите через пробел номера элементов, полученных дважды, по возрастанию (если таких нет — `-`), затем знак `|` и номера пропущенных по возрастанию (если таких нет — `-`). Например: `41 57 | 12`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
sort, paging, limit = p["sort"], p["paging"], p["limit"]

def order_key(item):
    i, k = item
    if sort == "id-desc":
        return (-i,)
    if sort == "id-asc":
        return (i,)
    if sort == "updated":
        return (-k, -i)
    return (-k, i)

def comes_after(item, cur):
    if paging == "cursor-score":
        return item[1] < cur[1]
    if paging == "cursor-flipped":
        return item[1] < cur[1] or (item[1] == cur[1] and item[0] < cur[0])
    return order_key(item) > order_key(cur)

state = {it["id"]: it["key"] for it in p["items"]}
got, gone = [], set()
offset, cur, page = 0, None, 0
while True:
    page += 1
    rows = sorted(state.items(), key=order_key)
    if paging == "offset":
        chunk = rows[offset:offset + limit]
    elif cur is None:
        chunk = rows[:limit]
    else:
        chunk = [r for r in rows if comes_after(r, cur)][:limit]
    got += [r[0] for r in chunk]
    offset += limit
    if chunk:
        cur = chunk[-1]
    if len(chunk) < limit:
        break
    for e in p["events"]:
        if e["afterPage"] != page:
            continue
        if e["kind"] == "delete":
            state.pop(e["id"], None)
            gone.add(e["id"])
        else:
            state[e["id"]] = e["key"]
twice = sorted(i for i in set(got) if got.count(i) > 1)
missed = sorted(it["id"] for it in p["items"] if it["id"] not in got and it["id"] not in gone)
fmt = lambda xs: " ".join(map(str, xs)) if xs else "-"
print(fmt(twice), "|", fmt(missed))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'offset-stable': { offsetStable: true },
	'sides-swapped': { sidesSwapped: true },
	'deleted-missed': { deletedMissed: true },
	'cursor-as-offset': { cursorAsOffset: true },
	'update-ignored': { updateIgnored: true },
	'tuple-assumed': { tupleAssumed: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/offset-insert': ['offset-stable', 'sides-swapped'],
	'middle/offset-delete': ['sides-swapped', 'deleted-missed'],
	'middle/cursor-edits': ['update-ignored', 'cursor-as-offset'],
	'middle/offset-ascending': ['offset-stable', 'deleted-missed'],
	'senior/score-only-cursor': ['tuple-assumed'],
	'senior/score-updates': ['update-ignored'],
	'senior/comparator-mismatch': ['tuple-assumed'],
	'senior/offset-reranking': ['update-ignored', 'offset-stable']
};

/** Misconceptions about offset pages apply to offset walks only, those about cursors — to cursor walks only. */
function applies(id: string, p: Params): boolean {
	if (id === 'offset-stable') return p.paging === 'offset';
	if (id === 'cursor-as-offset') return p.paging !== 'offset';
	if (id === 'tuple-assumed') return p.paging === 'cursor-score' || p.paging === 'cursor-flipped';
	return true;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Lists and events are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		// Every event must happen before the walk ends.
		const lastEvent = Math.max(0, ...p.events.map((e) => e.afterPage));
		if (walk(p, p.paging, true).pages <= lastEvent) continue;
		const answer = outcome(p, RIGHT);
		if (answer === '- | -') continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = applies(id, p) ? outcome(p, { ...RIGHT, ...change }) : answer;
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
