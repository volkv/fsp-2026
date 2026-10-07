// Collections in Kotlin: what `filter`, `partition`, `flatMap`, `associateBy`, `groupBy`, `distinctBy`, `fold`,
// `reduce`, `windowed`, `chunked`, `zip` and the sorts print, and which lists are copies. The operation that decides
// the output is the essential class; names, values and constants are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { ktList, ktMap, type TraceProgram, traceBuild } from '../../_lib/mob-kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const SCREENS = ['home', 'cart', 'chat', 'feed', 'help', 'card', 'favs', 'hist', 'map', 'menu', 'search', 'store'];
const USERS = ['ann', 'bob', 'eva', 'max', 'kim', 'leo'];

const main = (body: string[]): string[] => ['fun main() {', ...body.map((l) => `    ${l}`), '}'];
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const distinctInts = (rng: Rng, count: number, min: number, max: number): number[] => {
	const all = Array.from({ length: max - min + 1 }, (_, i) => min + i);
	return rng.sample(all, count);
};

/** Entries of a map built by keys in the order of their first insertion; `last` — the later value replaces. */
function associate<T, K>(items: readonly T[], key: (t: T) => K, last: boolean): [K, T][] {
	const order: K[] = [];
	const map = new Map<K, T>();
	for (const item of items) {
		const k = key(item);
		if (!map.has(k)) {
			order.push(k);
			map.set(k, item);
		} else if (last) map.set(k, item);
	}
	return order.map((k) => [k, map.get(k) as T]);
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): [K, T[]][] {
	const map = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		const group = map.get(k);
		if (group) group.push(item);
		else map.set(k, [item]);
	}
	return [...map.entries()];
}

// Intern.

/** `filter` keeps the elements matching the predicate; `partition` puts them first; `flatMap` flattens. */
function filterMap(rng: Rng): TraceProgram {
	// Both sides of each threshold are present: three prices below `t`, three above; two page numbers above `p`.
	const t = rng.pick([50, 100, 150, 200]);
	const prices = rng.shuffle([...distinctInts(rng, 3, 10, t - 1), ...distinctInts(rng, 3, t + 1, 400)]);
	const numbers = distinctInts(rng, 5, 1, 40);
	const pages = [numbers.slice(0, 3), numbers.slice(3)];
	const p = [...numbers].sort((a, b) => a - b)[rng.int(1, 3)] as number;
	const run = (inverted: boolean, swapped: boolean): string[] => {
		const keep = (match: boolean): boolean => match !== inverted;
		const flat = pages.flat();
		const cheap = prices.filter((x) => x < t);
		const rest = prices.filter((x) => x >= t);
		const [first, second] = swapped ? [rest, cheap] : [cheap, rest];
		return [
			ktList(prices.filter((x) => keep(x > t))),
			ktList(flat.filter((x) => keep(x > p))),
			ktList(first),
			String(second.length)
		];
	};
	return {
		lines: main([
			`val prices = listOf(${prices.join(', ')})`,
			`val pages = listOf(listOf(${pages[0]?.join(', ')}), listOf(${pages[1]?.join(', ')}))`,
			`println(prices.filter { it > ${t} })`,
			`println(pages.flatMap { it }.filter { it > ${p} })`,
			`val (cheap, rest) = prices.partition { it < ${t} }`,
			'println(cheap)',
			'println(rest.size)'
		]),
		answer: run(false, false),
		wrong: { 'filter-inverted': run(true, false), 'partition-swapped': run(false, true) }
	};
}

/** `associateBy` with repeated keys: the key keeps its first place, the value is the last element with that key. */
function associateBy(rng: Rng): TraceProgram {
	// Six names over three or four first letters, so that keys repeat.
	const letters = rng.sample([...new Set(SCREENS.map((s) => s[0] as string))], rng.int(3, 4));
	const pool = SCREENS.filter((s) => letters.includes(s[0] as string));
	const screens = rng.shuffle(pool).slice(0, 6);
	const probe = rng.pick(screens)[0] as string;
	const run = (last: boolean): string[] => {
		const entries = associate(screens, (s) => s[0] as string, last);
		return [ktMap(entries), String(entries.length), entries.find(([k]) => k === probe)?.[1] ?? 'null'];
	};
	return {
		lines: main([
			`val screens = listOf(${screens.map((s) => `"${s}"`).join(', ')})`,
			'val byLetter = screens.associateBy { it.first() }',
			'println(byLetter)',
			'println(byLetter.size)',
			`println(byLetter['${probe}'])`
		]),
		answer: run(true),
		wrong: { 'first-wins': run(false) }
	};
}

/** `fold` starts from its initial value, `reduce` from the first element without applying the operation to it. */
function foldReduce(rng: Rng): TraceProgram {
	const steps = Array.from({ length: rng.int(4, 5) }, () => rng.int(1, 9));
	const init = rng.int(5, 50);
	const k = rng.int(2, 4);
	const head = steps[0] as number;
	const tail = steps.slice(1);
	const fold = init + k * sum(steps);
	const reduce = head + k * sum(tail);
	const joined = steps.join('');
	return {
		lines: main([
			`val steps = listOf(${steps.join(', ')})`,
			`val a = steps.fold(${init}) { acc, x -> acc + x * ${k} }`,
			`val b = steps.reduce { acc, x -> acc + x * ${k} }`,
			'val c = steps.fold("") { acc, x -> acc + x }',
			'println(a)',
			'println(b)',
			'println(c)'
		]),
		answer: [String(fold), String(reduce), joined],
		wrong: { 'reduce-from-zero': [String(fold), String(k * sum(steps)), joined] }
	};
}

/** `toMutableList` makes a copy; `val c = a` is the same list under another name. */
function mutableCopy(rng: Rng): TraceProgram {
	const init = distinctInts(rng, 3, 1, 50);
	const [x, y] = distinctInts(rng, 2, 51, 99) as [number, number];
	const name = rng.pick(['ids', 'queue', 'pending']);
	const copy = rng.pick(['backup', 'saved', 'draft']);
	const alias = rng.pick(['current', 'live', 'shown']);
	const run = (copyShared: boolean, aliasCopies: boolean): string[] => {
		const a = [...init];
		const b = copyShared ? a : [...init];
		const c = aliasCopies ? [...init] : a;
		b.push(x);
		c.push(y);
		a.shift();
		return [ktList(a), ktList(b), ktList(c)];
	};
	return {
		lines: main([
			`val ${name} = mutableListOf(${init.join(', ')})`,
			`val ${copy} = ${name}.toMutableList()`,
			`val ${alias} = ${name}`,
			`${copy}.add(${x})`,
			`${alias}.add(${y})`,
			`${name}.removeAt(0)`,
			`println(${name})`,
			`println(${copy})`,
			`println(${alias})`
		]),
		answer: run(false, false),
		wrong: { 'copy-shared': run(true, false), 'alias-copies': run(false, true) }
	};
}

// Junior.

interface Order {
	user: string;
	sum: number;
}

const orderLines = (orders: readonly Order[]): string[] => [
	'val orders = listOf(',
	...orders.map((o, i) => `    Order("${o.user}", ${o.sum})${i < orders.length - 1 ? ',' : ''}`),
	')'
];

function randomOrders(rng: Rng, users: readonly string[], count: number): Order[] {
	const sums = distinctInts(rng, count, 1, 40).map((x) => x * 10);
	// Every user has at least one order, the rest at random.
	const owners = rng.shuffle([...users, ...Array.from({ length: count - users.length }, () => rng.pick(users))]);
	return owners.map((user, i) => ({ user, sum: sums[i] as number }));
}

/** filter → groupBy → mapValues: keys in the order of first appearance among the kept orders, the first maximum. */
function pipeline(rng: Rng): TraceProgram {
	const users = rng.sample(USERS, 3);
	const orders = randomOrders(rng, users, 7);
	const t = rng.pick([100, 150, 200]);
	const run = (inverted: boolean, sortedKeys: boolean): string[] => {
		const kept = orders.filter((o) => o.sum >= t !== inverted);
		const groups = groupBy(kept, (o) => o.user).map(([u, g]) => [u, sum(g.map((o) => o.sum))] as [string, number]);
		if (sortedKeys) groups.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		let best: [string, number] | null = null;
		for (const g of groups) if (best === null || g[1] > best[1]) best = g;
		return [ktMap(groups), best === null ? 'empty' : best[0], String(groups.length)];
	};
	return {
		lines: [
			'data class Order(val user: String, val sum: Int)',
			'',
			...main([
				...orderLines(orders),
				'val totals = orders',
				`    .filter { it.sum >= ${t} }`,
				'    .groupBy { it.user }',
				'    .mapValues { (_, list) -> list.sumOf { it.sum } }',
				'println(totals)',
				'println(totals.maxByOrNull { it.value }?.key ?: "empty")',
				'println(totals.size)'
			])
		],
		answer: run(false, false),
		wrong: { 'filter-inverted': run(true, false), 'map-keys-sorted': run(false, true) }
	};
}

/** `distinctBy` keeps the first element of each key, `associateBy` the last one, `groupBy` all of them. */
function distinctVsAssociate(rng: Rng): TraceProgram {
	const users = rng.sample(USERS, 3);
	const orders = randomOrders(rng, users, 6);
	const run = (associateLast: boolean, distinctLast: boolean): string[] => {
		const distinct = associate(orders, (o) => o.user, distinctLast).map(([, o]) => o.sum);
		const latest = associate(orders, (o) => o.user, associateLast).map(([, o]) => o.sum);
		const counts = groupBy(orders, (o) => o.user).map(([u, g]) => [u, g.length] as [string, number]);
		return [ktList(distinct), ktList(latest), ktMap(counts)];
	};
	return {
		lines: [
			'data class Order(val user: String, val sum: Int)',
			'',
			...main([
				...orderLines(orders),
				'println(orders.distinctBy { it.user }.map { it.sum })',
				'println(orders.associateBy { it.user }.values.map { it.sum })',
				'println(orders.groupBy { it.user }.mapValues { it.value.size })'
			])
		],
		answer: run(true, false),
		wrong: { 'first-wins': run(false, false), 'distinct-last-wins': run(true, true) }
	};
}

/** `sortedWith(compareBy { … }.thenByDescending { … })`, and `sortedBy` keeps the order of equal keys. */
function sortThen(rng: Rng): TraceProgram {
	const names = rng.sample(SCREENS, 5);
	const unread = distinctInts(rng, 5, 0, 30);
	// Two priorities, each used at least twice.
	const priorities = rng.shuffle([1, 1, 2, 2, rng.int(1, 2)]);
	const chats = names.map((name, i) => ({ name, priority: priorities[i] as number, unread: unread[i] as number }));
	type Chat = (typeof chats)[number];
	const by = (cmp: (a: Chat, b: Chat) => number): string => ktList([...chats].sort(cmp).map((c) => c.name));
	const lines = (thenAsc: boolean, tiesByName: boolean): string[] => [
		by((a, b) => a.priority - b.priority || (thenAsc ? a.unread - b.unread : b.unread - a.unread)),
		by((a, b) => a.priority - b.priority || (tiesByName ? (a.name < b.name ? -1 : 1) : 0))
	];
	return {
		lines: [
			'data class Chat(val name: String, val priority: Int, val unread: Int)',
			'',
			...main([
				'val chats = listOf(',
				...chats.map((c, i) => `    Chat("${c.name}", ${c.priority}, ${c.unread})${i < chats.length - 1 ? ',' : ''}`),
				')',
				'val ranked = chats.sortedWith(compareBy<Chat> { it.priority }.thenByDescending { it.unread })',
				'println(ranked.map { it.name })',
				'println(chats.sortedBy { it.priority }.map { it.name })'
			])
		],
		answer: lines(false, false),
		wrong: { 'then-ascending': lines(true, false), 'ties-by-name': lines(false, true) }
	};
}

/** `windowed` gives only full windows that overlap, `chunked` keeps the short last chunk, `zip` stops at the shorter. */
function windows(rng: Rng): TraceProgram {
	const n = rng.pick([7, 8]);
	const w = 3;
	const c = n === 7 ? rng.pick([2, 3]) : 3;
	const xs = Array.from({ length: n }, () => rng.int(1, 20));
	const labels = rng.sample(SCREENS, rng.int(3, 4));
	const windowSums = (partial: boolean): number[] => {
		const out: number[] = [];
		for (let i = 0; i < xs.length; i += 1) {
			const win = xs.slice(i, i + w);
			if (win.length === w || (partial && win.length > 0)) out.push(sum(win));
		}
		return out;
	};
	const chunks = (dropPartial: boolean): number[] => {
		const out: number[] = [];
		for (let i = 0; i < xs.length; i += c) {
			const chunk = xs.slice(i, i + c);
			if (chunk.length === c || !dropPartial) out.push(Math.max(...chunk));
		}
		return out;
	};
	const zipped = labels.map((l, i) => `${l}=${xs[i]}`);
	const out = (partial: boolean, dropPartial: boolean): string[] => {
		const sums = windowSums(partial);
		const peaks = chunks(dropPartial);
		return [ktList(sums), ktList(peaks), ktList(zipped), String(sums.length + peaks.length + zipped.length)];
	};
	return {
		lines: main([
			`val load = listOf(${xs.join(', ')})`,
			`val tabs = listOf(${labels.map((l) => `"${l}"`).join(', ')})`,
			`val sums = load.windowed(${w}).map { it.sum() }`,
			`val peaks = load.chunked(${c}).map { it.max() }`,
			'val labels = tabs.zip(load) { tab, n -> "$tab=$n" }',
			'println(sums)',
			'println(peaks)',
			'println(labels)',
			'println(sums.size + peaks.size + labels.size)'
		]),
		answer: out(false, false),
		wrong: { 'windowed-partial': out(true, false), 'chunked-drops-partial': out(false, true) }
	};
}

function program(rng: Rng, grade: string, classId: string): TraceProgram {
	if (grade === 'intern') {
		if (classId === 'filter-partition') return filterMap(rng);
		if (classId === 'associate-by') return associateBy(rng);
		if (classId === 'fold-reduce') return foldReduce(rng);
		return mutableCopy(rng);
	}
	if (classId === 'pipeline') return pipeline(rng);
	if (classId === 'distinct-vs-associate') return distinctVsAssociate(rng);
	if (classId === 'sort-then') return sortThen(rng);
	return windows(rng);
}

export function build(input: GenerateInput): Built {
	return traceBuild(descriptor, input, program);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
