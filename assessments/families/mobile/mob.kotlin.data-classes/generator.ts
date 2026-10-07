// Data classes in Kotlin: `copy` (a new object, a shallow one, without the properties of the body), `equals`,
// `hashCode` and `toString` over the constructor properties only, destructuring by position, `==` against `===`,
// data objects as keys of sets and maps, and what happens to a key changed after it went into a hash set. The mechanism
// that decides the output is the essential class; names and values are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { ktList, ktMap, type TraceProgram, traceBuild } from '../../_lib/mob-kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const USERS = ['ann', 'bob', 'eva', 'max', 'kim', 'leo', 'ivy', 'tom'];
const SCREENS = ['chat', 'feed', 'cart', 'home', 'menu', 'help', 'card', 'news'];
const WORDS = ['hi', 'hello', 'draft', 'note', 'ping', 'todo', 'memo', 'ok'];

const main = (body: string[]): string[] => ['fun main() {', ...body.map((l) => `    ${l}`), '}'];

// Intern.

/** `copy` makes a new object; `==` compares the properties, `===` the references. */
function copyEquals(rng: Rng): TraceProgram {
	const cls = rng.pick(['User', 'Member', 'Player']);
	const name = rng.pick(USERS);
	const l0 = rng.int(1, 9);
	let l1 = rng.int(1, 9);
	if (l1 === l0) l1 = (l0 % 9) + 1;
	const show = (level: number): string => `${cls}(name=${name}, level=${level})`;
	return {
		lines: [
			`data class ${cls}(val name: String, val level: Int)`,
			'',
			...main([
				`val a = ${cls}("${name}", ${l0})`,
				`val b = a.copy(level = ${l1})`,
				`val c = b.copy(level = ${l0})`,
				'println(a)',
				'println(b)',
				'println(a == c)',
				'println(a === c)',
				'println(listOf(a, b, c).count { it == a })'
			])
		],
		answer: [show(l0), show(l1), 'true', 'false', '2'],
		wrong: {
			// One object changed by every copy: the last level wins everywhere.
			'copy-mutates': [show(l0), show(l0), 'true', 'true', '3'],
			'equals-identity': [show(l0), show(l1), 'false', 'false', '1']
		}
	};
}

/** A property declared in the body takes no part in `equals`, `hashCode` and `toString`. */
function bodyProperty(rng: Rng): TraceProgram {
	const id = rng.int(1, 99);
	const title = rng.pick(SCREENS);
	const va = rng.int(1, 20);
	const vb = rng.int(21, 40);
	const shown = `Item(id=${id}, title=${title})`;
	return {
		lines: [
			'data class Item(val id: Int, val title: String) {',
			'    var views = 0',
			'}',
			'',
			...main([
				`val a = Item(${id}, "${title}")`,
				`a.views = ${va}`,
				`val b = Item(${id}, "${title}")`,
				`b.views = ${vb}`,
				'println(a == b)',
				'println(b)',
				'println(setOf(a, b).size)',
				'println(a.views + b.views)'
			])
		],
		answer: ['true', shown, '1', String(va + vb)],
		wrong: {
			'body-counts': ['false', `Item(id=${id}, title=${title}, views=${vb})`, '2', String(va + vb)]
		}
	};
}

/** Destructuring takes `component1`, `component2`, … by position, whatever the variables are named. */
function destructuring(rng: Rng): TraceProgram {
	const props = ['player', 'points', 'level'] as const;
	const values: Record<(typeof props)[number], string> = {
		player: rng.pick(USERS),
		points: String(rng.int(10, 99) * 10),
		level: String(rng.int(1, 9))
	};
	// Two variables named after properties, but not in their order; a third read through placeholders.
	const order = rng.shuffle([...props]);
	let first = order[0] as (typeof props)[number];
	let second = order[1] as (typeof props)[number];
	if (first === 'player' && second === 'points') [first, second] = [second, first];
	const third = rng.pick(props.filter((p) => p !== first && p !== second));
	const position = props.indexOf(third);
	const components = [...Array.from({ length: position }, () => '_'), 'last'].join(', ');
	return {
		lines: [
			'data class Score(val player: String, val points: Int, val level: Int)',
			'',
			...main([
				`val best = Score("${values.player}", ${values.points}, ${values.level})`,
				`val (${first}, ${second}) = best`,
				`println(${first})`,
				`println(${second})`,
				`val (${components}) = best`,
				'println(last)'
			])
		],
		answer: [values.player, values.points, values[third]],
		wrong: { 'destructure-by-name': [values[first], values[second], values[third]] }
	};
}

/** A data class as a map key: equal objects are one key, whatever instances they are. */
function mapKeys(rng: Rng): TraceProgram {
	const screens = rng.sample(SCREENS, 2);
	const routes = Array.from({ length: 5 }, () => ({ screen: rng.pick(screens), id: rng.int(1, 2) }));
	const key = (r: { screen: string; id: number }): string => `Route(screen=${r.screen}, id=${r.id})`;
	const counts = new Map<string, number>();
	for (const r of routes) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
	const entries = [...counts.entries()];
	return {
		lines: [
			'data class Route(val screen: String, val id: Int)',
			'',
			...main([
				'val visits = mutableMapOf<Route, Int>()',
				`val opened = listOf(${routes.map((r) => `Route("${r.screen}", ${r.id})`).join(', ')})`,
				'for (r in opened) {',
				'    visits[r] = (visits[r] ?: 0) + 1',
				'}',
				'println(visits)',
				'println(visits.size)'
			])
		],
		answer: [ktMap(entries), String(entries.length)],
		wrong: { 'equals-identity': [ktMap(routes.map((r) => [key(r), 1])), String(routes.length)] }
	};
}

// Junior.

/** `copy` is shallow: a mutable list property is shared with the original until it is copied explicitly. */
function shallowCopy(rng: Rng): TraceProgram {
	const members = rng.sample(USERS, 4);
	const [m1, m2, added] = members as [string, string, string];
	const title = rng.pick(['team', 'family', 'study', 'work']);
	const removed = rng.pick([m1, m2]);
	const shared = [m1, m2, added];
	const deep = [m1, m2];
	const minus = (xs: string[]): string[] => xs.filter((x) => x !== removed);
	return {
		lines: [
			'data class Chat(val title: String, val members: MutableList<String>)',
			'',
			...main([
				`val a = Chat("${title}", mutableListOf("${m1}", "${m2}"))`,
				'val b = a.copy()',
				`b.members.add("${added}")`,
				'val c = a.copy(members = a.members.toMutableList())',
				`c.members.remove("${removed}")`,
				'println(a.members)',
				'println(b == a)',
				'println(c.members)',
				'println(a == c)'
			])
		],
		answer: [ktList(shared), 'true', ktList(minus(shared)), 'false'],
		wrong: {
			'deep-copy': [ktList(deep), 'false', ktList(minus(deep)), 'false'],
			'equals-identity': [ktList(shared), 'false', ktList(minus(shared)), 'false']
		}
	};
}

/**
 * A key of a hash set changed after it went in: the set looks for it under the new hash and does not find it, nor an
 * equal object with the old values; a scan with `==` finds it, and adding it again stores it twice.
 */
function hashSetMutation(rng: Rng): TraceProgram {
	const names = rng.sample(SCREENS, rng.int(2, 3));
	const badges = names.map(() => rng.int(0, 9));
	const changed = rng.int(0, names.length - 1);
	const was = badges[changed] as number;
	let now = rng.int(10, 30);
	if (now === was) now += 1;
	const target = names[changed] as string;
	const sorted = (xs: number[]): string => ktList([...xs].sort((a, b) => a - b));
	const after = badges.map((b, i) => (i === changed ? now : b));
	return {
		lines: [
			'data class Tab(val name: String, var badge: Int)',
			'',
			...main([
				...names.map((n, i) => `val ${n} = Tab("${n}", ${badges[i]})`),
				`val opened = hashSetOf(${names.join(', ')})`,
				`${target}.badge = ${now}`,
				`println(${target} in opened)`,
				`println(Tab("${target}", ${was}) in opened)`,
				`println(opened.any { it == ${target} })`,
				`opened.add(${target})`,
				'println(opened.size)',
				'println(opened.map { it.badge }.sorted())'
			])
		],
		answer: ['false', 'false', 'true', String(names.length + 1), sorted([...after, now])],
		wrong: {
			'set-tracks-mutation': ['true', 'false', 'true', String(names.length), sorted(after)],
			// The set keeps its own copy with the old values.
			'set-stores-copy': ['false', 'true', 'false', String(names.length + 1), sorted([...badges, now])]
		}
	};
}

/** `copy` calls the constructor: a property of the body starts from its initial value and takes no part in equality. */
function copyBodyReset(rng: Rng): TraceProgram {
	const id = rng.int(1, 99);
	const [t0, t1] = rng.sample(WORDS, 2) as [string, string];
	const edits = rng.int(2, 9);
	const more = rng.int(1, edits - 1);
	const label = rng.pick(['saved', 'synced', 'queued', 'sent']);
	return {
		lines: [
			'data class Draft(val id: Int, val text: String) {',
			'    var edits = 0',
			'}',
			'',
			...main([
				`val a = Draft(${id}, "${t0}")`,
				`a.edits = ${edits}`,
				`val b = a.copy(text = "${t1}")`,
				'val c = a.copy()',
				`c.edits += ${more}`,
				`val status = mapOf(a to "${label}")`,
				'println(b)',
				'println(a.edits + b.edits + c.edits)',
				'println(c == a)',
				'println(status[c] ?: "none")'
			])
		],
		answer: [`Draft(id=${id}, text=${t1})`, String(edits + more), 'true', label],
		wrong: {
			'copy-keeps-body': [`Draft(id=${id}, text=${t1})`, String(edits * 3 + more), 'true', label],
			'body-counts': [`Draft(id=${id}, text=${t1}, edits=0)`, String(edits + more), 'false', 'none']
		}
	};
}

/** An array property is compared by reference in the generated `equals` and `hashCode`; a list — by content. */
function arrayProperty(rng: Rng): TraceProgram {
	const px = [rng.int(1, 9), rng.int(1, 9), rng.int(1, 9)];
	const other = px.map((x, i) => (i === 0 ? x + 1 : x));
	// A frame: its id and its array — the shared `px`, a new literal with the same content, or another content.
	type Frame = { id: number; ref: number; same: boolean };
	// The first frame holds `px`; one of the others is a new array with the same content and the same id.
	const copyAt = rng.int(1, 4);
	const firstId = rng.int(1, 2);
	const frames: Frame[] = Array.from({ length: 5 }, (_, i) => {
		const kind = i === 0 ? 'px' : i === copyAt ? 'copy' : rng.pick(['px', 'px', 'copy', 'other']);
		return {
			id: i === 0 || i === copyAt ? firstId : rng.int(1, 2),
			ref: kind === 'px' ? 0 : i + 1,
			same: kind !== 'other'
		};
	});
	const probeId = rng.int(1, 2);
	const literal = (f: Frame): string => (f.ref === 0 ? 'px' : `intArrayOf(${(f.same ? px : other).join(', ')})`);
	const run = (structural: boolean): string[] => {
		const eq = (a: Frame, b: Frame): boolean => a.id === b.id && (structural ? a.same === b.same : a.ref === b.ref);
		const distinct: Frame[] = [];
		for (const f of frames) if (!distinct.some((d) => eq(d, f))) distinct.push(f);
		const first = frames[0] as Frame;
		const probe: Frame = { id: probeId, ref: 0, same: true };
		return [
			ktList(distinct.map((f) => f.id)),
			String(frames.filter((f) => eq(f, first)).length),
			String(frames.findIndex((f) => eq(f, probe)))
		];
	};
	return {
		lines: [
			'data class Frame(val id: Int, val pixels: IntArray)',
			'',
			...main([
				`val px = intArrayOf(${px.join(', ')})`,
				'val frames = listOf(',
				...frames.map((f, i) => `    Frame(${f.id}, ${literal(f)})${i < frames.length - 1 ? ',' : ''}`),
				')',
				'println(frames.distinct().map { it.id })',
				'println(frames.count { it == frames[0] })',
				`println(frames.indexOf(Frame(${probeId}, px)))`
			])
		],
		answer: run(false),
		wrong: { 'array-structural': run(true) }
	};
}

function program(rng: Rng, grade: string, classId: string): TraceProgram {
	if (grade === 'intern') {
		if (classId === 'copy-equals') return copyEquals(rng);
		if (classId === 'body-property') return bodyProperty(rng);
		if (classId === 'destructuring') return destructuring(rng);
		return mapKeys(rng);
	}
	if (classId === 'shallow-copy') return shallowCopy(rng);
	if (classId === 'hash-set-mutation') return hashSetMutation(rng);
	if (classId === 'copy-body-reset') return copyBodyReset(rng);
	return arrayProperty(rng);
}

export function build(input: GenerateInput): Built {
	return traceBuild(descriptor, input, program);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
