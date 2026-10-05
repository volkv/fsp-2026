// The expected body of a list response: given the stored records and one request with filters, sorting and
// pagination (page/per_page or limit/offset), the tester predicts `total`, the ids on the page and `next`.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Rec {
	id: number;
	name: string;
	city: string;
	score: number;
	status: string;
}

type SortField = 'name' | 'city' | 'score' | 'status';

interface Query {
	city: string | null;
	status: string | null;
	scoreGte: number | null;
	scoreLte: number | null;
	/** Fields in order; `desc` — with a minus. */
	sort: { field: SortField; desc: boolean }[];
	paging: { mode: 'page'; page: number; perPage: number } | { mode: 'offset'; offset: number; limit: number };
}

interface Params {
	records: Rec[];
	query: Query;
}

interface Rules {
	pageFromZero: boolean;
	totalPageSize: boolean;
	totalUnfiltered: boolean;
	tiesTableOrder: boolean;
	nextAlways: boolean;
	nextIfFull: boolean;
	exclusiveRange: boolean;
	firstKeyOnly: boolean;
	offsetAsPage: boolean;
}

const RIGHT: Rules = {
	pageFromZero: false,
	totalPageSize: false,
	totalUnfiltered: false,
	tiesTableOrder: false,
	nextAlways: false,
	nextIfFull: false,
	exclusiveRange: false,
	firstKeyOnly: false,
	offsetAsPage: false
};

/** `total | ids | next` under a model of the contract. */
function respond(p: Params, rules: Rules): string {
	const q = p.query;
	const matched = p.records.filter(
		(r) =>
			(q.city === null || r.city === q.city) &&
			(q.status === null || r.status === q.status) &&
			(q.scoreGte === null || (rules.exclusiveRange ? r.score > q.scoreGte : r.score >= q.scoreGte)) &&
			(q.scoreLte === null || (rules.exclusiveRange ? r.score < q.scoreLte : r.score <= q.scoreLte))
	);
	const keys = rules.firstKeyOnly ? q.sort.slice(0, 1) : q.sort;
	const position = new Map(p.records.map((r, i) => [r.id, i]));
	const sorted = [...matched].sort((a, b) => {
		for (const { field, desc } of keys) {
			const x = a[field];
			const y = b[field];
			if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
		}
		return rules.tiesTableOrder ? (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0) : a.id - b.id;
	});
	let start: number;
	let size: number;
	let nextValue: number;
	if (q.paging.mode === 'page') {
		const { page, perPage } = q.paging;
		start = rules.pageFromZero ? page * perPage : (page - 1) * perPage;
		size = perPage;
		nextValue = page + 1;
	} else {
		const { offset, limit } = q.paging;
		start = rules.offsetAsPage ? offset * limit : offset;
		size = limit;
		nextValue = rules.offsetAsPage ? offset + 1 : offset + limit;
	}
	const items = sorted.slice(start, start + size);
	const more = rules.nextAlways ? true : rules.nextIfFull ? items.length === size : start + size < sorted.length;
	const total = rules.totalPageSize ? items.length : rules.totalUnfiltered ? p.records.length : sorted.length;
	const ids = items.length ? items.map((r) => r.id).join(' ') : '-';
	return `${total} | ${ids} | ${more ? nextValue : 'null'}`;
}

const STATUSES = ['active', 'paused'] as const;

function makeRecords(rng: Rng, n: number, scores: () => number): Rec[] {
	const ids = rng.sample(
		Array.from({ length: 190 }, (_, i) => i + 10),
		n
	);
	const names = rng.sample(PERSON_NAMES, n);
	const cities = rng.sample(CITY_NAMES, 3);
	return ids.map((id, i) => ({
		id,
		name: names[i] ?? 'anna',
		city: rng.pick(cities),
		score: scores(),
		status: rng.pick(STATUSES)
	}));
}

/** Scores that rarely tie, or scores from a few values that tie often. */
const distinctScores = (rng: Rng): (() => number) => {
	const pool = rng.shuffle(Array.from({ length: 50 }, (_, i) => 50 + i));
	return () => pool.pop() ?? 50;
};
const tiedScores = (rng: Rng): (() => number) => {
	const values = rng.sample(
		Array.from({ length: 50 }, (_, i) => 50 + i),
		rng.int(3, 4)
	);
	return () => rng.pick(values);
};

const emptyQuery = (): Omit<Query, 'paging' | 'sort'> => ({ city: null, status: null, scoreGte: null, scoreLte: null });

/** How many records a query without paging selects. */
function matchedCount(records: readonly Rec[], q: Omit<Query, 'paging' | 'sort'>): number {
	return records.filter(
		(r) =>
			(q.city === null || r.city === q.city) &&
			(q.status === null || r.status === q.status) &&
			(q.scoreGte === null || r.score >= q.scoreGte) &&
			(q.scoreLte === null || r.score <= q.scoreLte)
	).length;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		const n = rng.int(8, 10);
		const records = makeRecords(rng, n, classId === 'sort-ties' ? tiedScores(rng) : distinctScores(rng));
		const filter = emptyQuery();
		if (classId === 'total-filtered' || (classId === 'last-page' && rng.bool())) {
			if (rng.bool(0.6)) filter.city = rng.pick(records).city;
			else filter.status = rng.pick(STATUSES);
		} else if (classId === 'sort-ties' && rng.bool(0.3)) filter.status = rng.pick(STATUSES);
		const sortField: SortField = classId === 'sort-ties' ? 'score' : rng.pick(['name', 'score'] as const);
		const sort = [{ field: sortField, desc: rng.bool() }];
		const total = matchedCount(records, filter);
		const perPage = rng.int(2, 3);
		const pages = Math.max(1, Math.ceil(total / perPage));
		const page =
			classId === 'last-page'
				? pages
				: classId === 'page-numbering'
					? rng.int(2, Math.max(2, pages))
					: rng.int(1, Math.min(2, pages));
		return { records, query: { ...filter, sort, paging: { mode: 'page', page, perPage } } };
	}
	const n = rng.int(11, 14);
	const records = makeRecords(rng, n, classId === 'multi-sort' ? tiedScores(rng) : distinctScores(rng));
	const filter = emptyQuery();
	let sort: Query['sort'] = [{ field: rng.pick(['name', 'score'] as const), desc: rng.bool() }];
	if (classId === 'range-filter') {
		// Bounds sit exactly on stored scores.
		const scores = rng.sample(
			records.map((r) => r.score),
			2
		);
		const lo = Math.min(...scores);
		const hi = Math.max(...scores);
		const which = rng.int(0, 2);
		if (which !== 1) filter.scoreGte = lo;
		if (which !== 0) filter.scoreLte = hi;
		if (rng.bool(0.3)) filter.status = rng.pick(STATUSES);
	} else if (classId === 'multi-sort') {
		sort = [
			{ field: rng.pick(['city', 'status'] as const), desc: rng.bool(0.4) },
			{ field: 'score', desc: rng.bool(0.6) }
		];
		if (rng.bool(0.3)) filter.scoreGte = rng.pick(records).score;
	} else {
		if (rng.bool(0.5)) filter.city = rng.pick(records).city;
		else filter.status = rng.pick(STATUSES);
		if (rng.bool(0.3)) filter.scoreGte = rng.pick(records).score;
	}
	const total = matchedCount(records, filter);
	const limit = rng.int(3, 5);
	let offset: number;
	if (classId === 'exact-boundary') offset = Math.max(0, total - limit);
	else if (classId === 'odd-offset') {
		const odd = Array.from({ length: Math.max(0, total) }, (_, i) => i).filter((o) => o % limit !== 0 && o > 0);
		offset = odd.length ? rng.pick(odd) : 1;
	} else offset = rng.pick([0, limit, rng.int(1, Math.max(1, total - 1))]);
	return { records, query: { ...filter, sort, paging: { mode: 'offset', offset, limit } } };
}

function queryString(q: Query): string {
	const parts: string[] = [];
	if (q.city !== null) parts.push(`city=${q.city}`);
	if (q.status !== null) parts.push(`status=${q.status}`);
	if (q.scoreGte !== null) parts.push(`score_gte=${q.scoreGte}`);
	if (q.scoreLte !== null) parts.push(`score_lte=${q.scoreLte}`);
	parts.push(`sort=${q.sort.map((s) => `${s.desc ? '-' : ''}${s.field}`).join(',')}`);
	if (q.paging.mode === 'page') parts.push(`page=${q.paging.page}`, `per_page=${q.paging.perPage}`);
	else parts.push(`limit=${q.paging.limit}`, `offset=${q.paging.offset}`);
	return parts.join('&');
}

function describe(p: Params): string {
	const paging = p.query.paging.mode;
	const width = Math.max(...p.records.map((r) => r.name.length), 4) + 2;
	const cityWidth = Math.max(...p.records.map((r) => r.city.length), 4) + 2;
	const row = (cells: readonly string[]): string =>
		[
			(cells[0] ?? '').padEnd(5),
			(cells[1] ?? '').padEnd(width),
			(cells[2] ?? '').padEnd(cityWidth),
			(cells[3] ?? '').padEnd(7),
			cells[4] ?? ''
		]
			.join('')
			.trimEnd();
	return [
		'Тестировщик проверяет метод `GET /api/v1/candidates` и заранее считает ожидаемое тело ответа.',
		'',
		'## Контракт',
		'',
		'- Фильтры: `city` и `status` — точное совпадение; `score_gte` — балл не меньше значения, `score_lte` — не больше значения (границы включены). Если фильтров несколько, запись должна подходить под все.',
		'- `sort` — поля через запятую: первое поле главное, следующее упорядочивает записи, равные по предыдущим. Поле без знака — по возрастанию, с минусом (`-score`) — по убыванию; строки сравниваются по алфавиту. Записи, равные по всем полям `sort`, идут по возрастанию `id`.',
		paging === 'page'
			? '- Пагинация: `per_page` — размер страницы, `page` — номер страницы, страницы нумеруются с 1: страница `page` — записи отсортированного списка с номерами от (page − 1) · per_page + 1 до page · per_page.'
			: '- Пагинация: `offset` — сколько первых записей отсортированного списка пропустить, `limit` — сколько записей вернуть после них.',
		paging === 'page'
			? '- Ответ — `{"total": …, "items": […], "next": …}`: `total` — сколько записей подходит под фильтры на всех страницах вместе; `items` — записи запрошенной страницы; `next` — номер следующей страницы, если после этой страницы есть ещё подходящие записи, иначе `null`.'
			: '- Ответ — `{"total": …, "items": […], "next": …}`: `total` — сколько записей подходит под фильтры на всех страницах вместе; `items` — записи запрошенной страницы; `next` — значение `offset` для следующей страницы (`offset + limit`), если после этой страницы есть ещё подходящие записи, иначе `null`.',
		'',
		'## Данные',
		'',
		'Строки — в порядке хранения в базе:',
		'',
		'```',
		row(['id', 'name', 'city', 'score', 'status']),
		...p.records.map((r) => row([String(r.id), r.name, r.city, String(r.score), r.status])),
		'```',
		'',
		'## Запрос',
		'',
		`\`GET /api/v1/candidates?${queryString(p.query)}\``,
		'',
		'Введите через пробел: `total`, знак `|`, `id` записей из `items` по порядку (если `items` пуст — `-`), знак `|`, `next` (число или `null`). Например: `7 | 12 4 9 | 3`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
q = p["query"]
rows = [r for r in p["records"]
        if (q["city"] is None or r["city"] == q["city"])
        and (q["status"] is None or r["status"] == q["status"])
        and (q["scoreGte"] is None or r["score"] >= q["scoreGte"])
        and (q["scoreLte"] is None or r["score"] <= q["scoreLte"])]
rows.sort(key=lambda r: r["id"])
for s in reversed(q["sort"]):
    rows.sort(key=lambda r: r[s["field"]], reverse=s["desc"])
pg = q["paging"]
if pg["mode"] == "page":
    start, size, nxt = (pg["page"] - 1) * pg["perPage"], pg["perPage"], pg["page"] + 1
else:
    start, size, nxt = pg["offset"], pg["limit"], pg["offset"] + pg["limit"]
items = rows[start:start + size]
ids = " ".join(str(r["id"]) for r in items) or "-"
print(len(rows), "|", ids, "|", nxt if start + size < len(rows) else "null")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'page-from-zero': { pageFromZero: true },
	'total-page-size': { totalPageSize: true },
	'total-unfiltered': { totalUnfiltered: true },
	'ties-table-order': { tiesTableOrder: true },
	'next-always': { nextAlways: true },
	'next-if-full': { nextIfFull: true },
	'exclusive-range': { exclusiveRange: true },
	'first-key-only': { firstKeyOnly: true },
	'offset-as-page': { offsetAsPage: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/page-numbering': ['page-from-zero'],
	'intern/total-filtered': ['total-page-size', 'total-unfiltered'],
	'intern/sort-ties': ['ties-table-order'],
	'intern/last-page': ['next-always'],
	'junior/exact-boundary': ['next-if-full'],
	'junior/range-filter': ['exclusive-range'],
	'junior/multi-sort': ['first-key-only'],
	'junior/odd-offset': ['offset-as-page']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Data and requests are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = respond(p, RIGHT);
		if (answer.includes('| - |')) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = respond(p, { ...RIGHT, ...change });
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
