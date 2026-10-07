// State in Jetpack Compose: what a screen shows after a sequence of taps, parameter changes, rotations and list edits,
// given where each value lives — a plain local variable, `remember`, `remember(key)`, `rememberSaveable`, a branch of
// `if` or a row of a list with or without `key`. The answer follows the documented model of composition (State and
// Jetpack Compose, Lifecycle of composables), not a device; the reference is an independent Python model that rebuilds
// the slot table on every recomposition, while the model here applies the reset rules event by event.
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

type Kind = 'remember' | 'saveable' | 'plain';

/** A counter on the screen: where it lives, its first value, whether `remember` takes the key and whether it sits in `if`. */
interface Counter {
	name: string;
	kind: Kind;
	init: number;
	keyed: boolean;
	inBranch: boolean;
}

type Event =
	| { op: 'click'; target: string }
	| { op: 'toggle' }
	| { op: 'key'; value: string }
	| { op: 'rotate' }
	| { op: 'row'; item: string }
	| { op: 'remove'; item: string }
	| { op: 'add'; item: string };

/** The screen and the events; the key and the list come from the parent and survive a rotation. */
interface Scene {
	counters: Counter[];
	flag: { kind: 'remember' | 'saveable'; init: boolean } | null;
	key: string;
	showKey: boolean;
	list: { keyed: boolean; items: string[] } | null;
	events: Event[];
}

interface Rules {
	plainAsState: boolean;
	plainShownLater: boolean;
	keyIgnored: boolean;
	keyCache: boolean;
	rememberSurvivesRotation: boolean;
	saveableResetsOnRotation: boolean;
	keptWhileHidden: boolean;
	stateFollowsItem: boolean;
	positionalWithKey: boolean;
	listChangeResets: boolean;
}

const RIGHT: Rules = {
	plainAsState: false,
	plainShownLater: false,
	keyIgnored: false,
	keyCache: false,
	rememberSurvivesRotation: false,
	saveableResetsOnRotation: false,
	keptWhileHidden: false,
	stateFollowsItem: false,
	positionalWithKey: false,
	listChangeResets: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'plain-as-state': { plainAsState: true },
	'plain-shown-later': { plainShownLater: true },
	'key-ignored': { keyIgnored: true },
	'key-cache': { keyCache: true },
	'remember-survives-rotation': { rememberSurvivesRotation: true },
	'saveable-resets-on-rotation': { saveableResetsOnRotation: true },
	'kept-while-hidden': { keptWhileHidden: true },
	'state-follows-item': { stateFollowsItem: true },
	'positional-with-key': { positionalWithKey: true },
	'list-change-resets': { listChangeResets: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'intern/plain-var': ['plain-as-state', 'plain-shown-later'],
	'intern/remember-key': ['key-ignored', 'key-cache'],
	'intern/saveable-rotation': ['remember-survives-rotation', 'saveable-resets-on-rotation'],
	'intern/if-branch': ['kept-while-hidden'],
	'junior/list-no-key': ['state-follows-item', 'list-change-resets'],
	'junior/saveable-key': ['key-ignored', 'remember-survives-rotation', 'saveable-resets-on-rotation'],
	'junior/branch-saveable': ['kept-while-hidden', 'saveable-resets-on-rotation'],
	'junior/list-key': ['positional-with-key', 'key-cache', 'remember-survives-rotation']
};

/** The screen line after the start and after every event, applying the reset rules event by event. */
function simulate(s: Scene, r: Rules): string[] {
	let flagOn = s.flag?.init ?? true;
	let key = s.key;
	const vals = new Map<string, number>();
	const plainActual = new Map<string, number>();
	const plainShown = new Map<string, number>();
	const cache = new Map<string, number>();
	const ids = [...(s.list?.items ?? [])];
	let rows = ids.map(() => 0);
	const listKeyed = s.list ? (s.list.keyed ? !r.positionalWithKey : r.stateFollowsItem) : false;
	const stored = (c: Counter): boolean => c.kind !== 'plain' || r.plainAsState;
	for (const c of s.counters) {
		if (c.kind === 'plain') {
			plainActual.set(c.name, c.init);
			plainShown.set(c.name, c.init);
		}
		if (stored(c) && (!c.inBranch || flagOn)) vals.set(c.name, c.init);
	}
	const enterBranch = (): void => {
		for (const c of s.counters) if (c.inBranch && stored(c) && !vals.has(c.name)) vals.set(c.name, c.init);
	};
	const leaveBranch = (): void => {
		if (r.keptWhileHidden) return;
		for (const c of s.counters) if (c.inBranch) vals.delete(c.name);
	};
	const screen = (): string => {
		const parts: string[] = s.showKey ? [key] : [];
		for (const c of s.counters) {
			if (c.inBranch && !flagOn) parts.push('-');
			else if (c.kind === 'plain' && !r.plainAsState)
				parts.push(String(r.plainShownLater ? (plainShown.get(c.name) ?? c.init) : c.init));
			else parts.push(String(vals.get(c.name) ?? c.init));
		}
		ids.forEach((id, i) => parts.push(`${id}:${rows[i] ?? 0}`));
		return parts.join(' ');
	};
	const lines = [screen()];
	for (const e of s.events) {
		let recomposes = true;
		switch (e.op) {
			case 'click': {
				const c = s.counters.find((x) => x.name === e.target);
				if (!c) throw new Error(`no counter ${e.target}`);
				if (stored(c)) vals.set(c.name, (vals.get(c.name) ?? c.init) + 1);
				else {
					plainActual.set(c.name, (plainActual.get(c.name) ?? c.init) + 1);
					recomposes = false;
				}
				break;
			}
			case 'toggle':
				flagOn = !flagOn;
				if (flagOn) enterBranch();
				else leaveBranch();
				break;
			case 'key':
				if (e.value !== key && !r.keyIgnored) {
					for (const c of s.counters) {
						if (!c.keyed || !vals.has(c.name)) continue;
						cache.set(`${c.name}|${key}`, vals.get(c.name) ?? c.init);
						vals.set(c.name, r.keyCache ? (cache.get(`${c.name}|${e.value}`) ?? c.init) : c.init);
					}
				}
				key = e.value;
				break;
			case 'rotate': {
				if (s.flag) {
					const resets = s.flag.kind === 'remember' ? !r.rememberSurvivesRotation : r.saveableResetsOnRotation;
					if (resets) flagOn = s.flag.init;
				}
				for (const c of s.counters) {
					if (!vals.has(c.name)) continue;
					const resets = c.kind === 'saveable' ? r.saveableResetsOnRotation : !r.rememberSurvivesRotation;
					if (resets) vals.set(c.name, c.init);
				}
				if (flagOn) enterBranch();
				else leaveBranch();
				if (!r.rememberSurvivesRotation) rows = rows.map(() => 0);
				break;
			}
			case 'row': {
				const i = ids.indexOf(e.item);
				rows[i] = (rows[i] ?? 0) + 1;
				break;
			}
			case 'remove': {
				const i = ids.indexOf(e.item);
				ids.splice(i, 1);
				if (listKeyed) {
					cache.set(`row|${e.item}`, rows[i] ?? 0);
					rows.splice(i, 1);
				} else rows.pop();
				if (r.listChangeResets) rows = rows.map(() => 0);
				break;
			}
			case 'add':
				ids.unshift(e.item);
				if (listKeyed) rows.unshift(r.keyCache ? (cache.get(`row|${e.item}`) ?? 0) : 0);
				else rows.push(0);
				if (r.listChangeResets) rows = rows.map(() => 0);
				break;
		}
		if (recomposes) for (const [name, v] of plainActual) plainShown.set(name, v);
		lines.push(screen());
	}
	return lines;
}

const PYTHON_REFERENCE = `import json

sc = json.loads(input())
vm = {"key": sc["key"], "items": list(sc["list"]["items"]) if sc["list"] else []}


def compose(old, restored):
    # One recomposition: walk the tree, keep a slot whose identity and key are still there, take a restored one, or
    # create it; whatever is not reached leaves the composition.
    new = {}

    def slot(ident, kind, init, key):
        if ident in old and old[ident]["key"] == key:
            new[ident] = old[ident]
        elif kind == "saveable" and ident in restored:
            new[ident] = restored[ident]
        else:
            new[ident] = {"v": init, "key": key, "kind": kind}
        return new[ident]["v"]

    shown = True
    if sc["flag"] is not None:
        shown = slot("flag", sc["flag"]["kind"], sc["flag"]["init"], None)
    parts = [vm["key"]] if sc["showKey"] else []
    for c in sc["counters"]:
        if c["inBranch"] and not shown:
            parts.append("-")
        elif c["kind"] == "plain":
            parts.append(str(c["init"]))
        else:
            parts.append(str(slot("c:" + c["name"], c["kind"], c["init"], vm["key"] if c["keyed"] else None)))
    if sc["list"] is not None:
        for i, item in enumerate(vm["items"]):
            ident = "row:" + item if sc["list"]["keyed"] else "row#" + str(i)
            parts.append(item + ":" + str(slot(ident, "remember", 0, None)))
    return new, " ".join(parts)


def row_ident(item):
    if sc["list"]["keyed"]:
        return "row:" + item
    return "row#" + str(vm["items"].index(item))


table, _ = compose({}, {})
for ev in sc["events"]:
    restored = {}
    op = ev["op"]
    if op == "click":
        ident = "c:" + ev["target"]
        if ident in table:
            table[ident]["v"] += 1
    elif op == "toggle":
        table["flag"]["v"] = not table["flag"]["v"]
    elif op == "row":
        table[row_ident(ev["item"])]["v"] += 1
    elif op == "key":
        vm["key"] = ev["value"]
    elif op == "remove":
        vm["items"].remove(ev["item"])
    elif op == "add":
        vm["items"].insert(0, ev["item"])
    elif op == "rotate":
        restored = {k: dict(v) for k, v in table.items() if v["kind"] == "saveable"}
        table = {}
    table, line = compose(table, restored)
    print(line)
`;

// --- Scenes -----------------------------------------------------------------------------------------------------

const SCREENS = ['PostCard', 'ProfileHeader', 'OrderScreen', 'FeedItem', 'CartBadge'];
const PAIRS: readonly (readonly [string, string])[] = [
	['likes', 'views'],
	['added', 'opened'],
	['taps', 'scrolls'],
	['saved', 'shared'],
	['sent', 'read']
];
const KEY_PLOTS = [
	{ fn: 'ChatDraft', param: 'chatId', counter: 'symbols', ids: ['anna', 'oleg', 'mila', 'ivan', 'yana', 'petr'] },
	{ fn: 'OrderNote', param: 'orderId', counter: 'edits', ids: ['A12', 'B07', 'C33', 'D41', 'E50', 'F18'] },
	{ fn: 'UserTabs', param: 'userId', counter: 'taps', ids: ['u14', 'u27', 'u31', 'u45', 'u58', 'u63'] }
] as const;
const ROW_NAMES = ['anna', 'oleg', 'mila', 'ivan', 'yana', 'petr', 'kira', 'lev'];

/** Events drawn by a step function until the count is reached. */
function events(count: number, step: (i: number) => Event): Event[] {
	return Array.from({ length: count }, (_, i) => step(i));
}

interface Shown {
	scene: Scene;
	code: string;
	intro: string;
	/** Event texts, one per event. */
	texts: string[];
	lineFormat: string;
}

function plainVar(rng: Rng): Shown {
	const [a, b] = rng.pick(PAIRS);
	const plainFirst = rng.bool();
	const counters: Counter[] = [
		{ name: a, kind: plainFirst ? 'plain' : 'remember', init: rng.int(0, 4), keyed: false, inBranch: false },
		{ name: b, kind: plainFirst ? 'remember' : 'plain', init: rng.int(0, 4), keyed: false, inBranch: false }
	];
	const scene: Scene = {
		counters,
		flag: null,
		key: '',
		showKey: false,
		list: null,
		events: events(rng.int(5, 7), () => ({ op: 'click', target: rng.pick([a, b]) }))
	};
	const fn = rng.pick(SCREENS);
	const decl = (c: Counter): string =>
		c.kind === 'plain'
			? `    var ${c.name} = ${c.init}`
			: `    var ${c.name} by remember { mutableStateOf(${c.init}) }`;
	const code = [
		'@Composable',
		`fun ${fn}() {`,
		...counters.map(decl),
		'    Column {',
		`        Text("$${a} $${b}")`,
		`        Button(onClick = { ${a}++ }) { Text("${a}") }`,
		`        Button(onClick = { ${b}++ }) { Text("${b}") }`,
		'    }',
		'}'
	];
	return {
		scene,
		code: code.join('\n'),
		intro: `Экран \`${fn}\` показан один раз и дальше только перекомпоновывается.`,
		texts: scene.events.map((e) => (e.op === 'click' ? `нажатие на кнопку «${e.target}»` : '')),
		lineFormat: `два числа через пробел, как их выводит \`Text\``
	};
}

function rememberKey(rng: Rng): Shown {
	const plot = rng.pick(KEY_PLOTS);
	const pool = rng.sample(plot.ids, 3);
	const first = pool[0] ?? '';
	const init = rng.int(0, 2);
	const counters: Counter[] = [{ name: plot.counter, kind: 'remember', init, keyed: true, inBranch: false }];
	let current = first;
	const list = events(rng.int(6, 7), (i) => {
		if (i === 0 || rng.bool(0.55)) return { op: 'click', target: plot.counter };
		const value = rng.bool(0.2) ? current : rng.pick(pool);
		current = value;
		return { op: 'key', value };
	});
	const scene: Scene = { counters, flag: null, key: first, showKey: true, list: null, events: list };
	const code = [
		'@Composable',
		`fun ${plot.fn}(${plot.param}: String) {`,
		`    var ${plot.counter} by remember(${plot.param}) { mutableStateOf(${init}) }`,
		'    Column {',
		`        Text("$${plot.param} $${plot.counter}")`,
		`        Button(onClick = { ${plot.counter}++ }) { Text("+") }`,
		'    }',
		'}'
	];
	return {
		scene,
		code: code.join('\n'),
		intro: `Родитель показывает \`${plot.fn}("${first}")\` и в какие-то моменты передаёт другой \`${plot.param}\`; сама функция \`${plot.fn}\` из композиции не уходит.`,
		texts: list.map((e) =>
			e.op === 'click'
				? 'нажатие на кнопку «+»'
				: e.op === 'key'
					? `родитель передаёт ${plot.param} = "${e.value}"`
					: ''
		),
		lineFormat: `\`${plot.param}\` и число через пробел, как их выводит \`Text\``
	};
}

const ROTATE_TEXT = 'поворот экрана: Activity пересоздаётся, композиция строится заново';

function saveableRotation(rng: Rng): Shown {
	const [a, b] = rng.pick(PAIRS);
	const saveableFirst = rng.bool();
	const counters: Counter[] = [
		{ name: a, kind: saveableFirst ? 'saveable' : 'remember', init: rng.int(0, 3), keyed: false, inBranch: false },
		{ name: b, kind: saveableFirst ? 'remember' : 'saveable', init: rng.int(0, 3), keyed: false, inBranch: false }
	];
	const count = rng.int(6, 7);
	const list = events(count, (i) =>
		i >= 2 && rng.bool(0.3) ? { op: 'rotate' } : { op: 'click', target: rng.pick([a, b]) }
	);
	const scene: Scene = { counters, flag: null, key: '', showKey: false, list: null, events: list };
	const fn = rng.pick(SCREENS);
	const decl = (c: Counter): string =>
		`    var ${c.name} by ${c.kind === 'saveable' ? 'rememberSaveable' : 'remember'} { mutableStateOf(${c.init}) }`;
	const code = [
		'@Composable',
		`fun ${fn}() {`,
		...counters.map(decl),
		'    Column {',
		`        Text("$${a} $${b}")`,
		`        Button(onClick = { ${a}++ }) { Text("${a}") }`,
		`        Button(onClick = { ${b}++ }) { Text("${b}") }`,
		'    }',
		'}'
	];
	return {
		scene,
		code: code.join('\n'),
		intro: `Экран \`${fn}\` — содержимое Activity; процесс приложения не завершается.`,
		texts: list.map((e) => (e.op === 'click' ? `нажатие на кнопку «${e.target}»` : ROTATE_TEXT)),
		lineFormat: 'два числа через пробел, как их выводит `Text`'
	};
}

function ifBranch(rng: Rng): Shown {
	const [outer, inner] = rng.pick(PAIRS);
	const flagInit = rng.bool();
	const outerInit = rng.int(0, 3);
	const counters: Counter[] = [
		{ name: outer, kind: 'remember', init: outerInit, keyed: false, inBranch: false },
		{ name: inner, kind: 'remember', init: 0, keyed: false, inBranch: true }
	];
	let on = flagInit;
	const list = events(rng.int(6, 7), () => {
		const pick = rng.int(0, 9);
		if (pick < 3) {
			on = !on;
			return { op: 'toggle' };
		}
		if (on && pick < 8) return { op: 'click', target: inner };
		return { op: 'click', target: outer };
	});
	const scene: Scene = {
		counters,
		flag: { kind: 'remember', init: flagInit },
		key: '',
		showKey: false,
		list: null,
		events: list
	};
	const fn = rng.pick(SCREENS);
	const code = [
		'@Composable',
		`fun ${fn}() {`,
		`    var ${outer} by remember { mutableStateOf(${outerInit}) }`,
		`    var expanded by remember { mutableStateOf(${flagInit}) }`,
		'    Column {',
		`        Button(onClick = { ${outer}++ }) { Text("${outer}") }`,
		'        Button(onClick = { expanded = !expanded }) { Text("details") }',
		'        if (expanded) {',
		`            var ${inner} by remember { mutableStateOf(0) }`,
		`            Button(onClick = { ${inner}++ }) { Text("${inner}") }`,
		`            Text("$${outer} $${inner}")`,
		'        } else {',
		`            Text("$${outer} -")`,
		'        }',
		'    }',
		'}'
	];
	return {
		scene,
		code: code.join('\n'),
		intro: `Экран \`${fn}\` показан один раз и дальше только перекомпоновывается. Кнопку «${inner}» нажимают, только когда она видна.`,
		texts: list.map((e) =>
			e.op === 'toggle' ? 'нажатие на кнопку «details»' : e.op === 'click' ? `нажатие на кнопку «${e.target}»` : ''
		),
		lineFormat: 'то, что выводит `Text`: два значения через пробел'
	};
}

function rowCode(fn: string, keyed: boolean): string {
	return [
		'@Composable',
		`fun ${fn}(chats: List<String>) {`,
		'    Column {',
		'        for (chat in chats) {',
		keyed ? '            key(chat) { ChatRow(chat) }' : '            ChatRow(chat)',
		'        }',
		'    }',
		'}',
		'',
		'@Composable',
		'fun ChatRow(chat: String) {',
		'    var unread by remember { mutableStateOf(0) }',
		'    Text("$chat:$unread", Modifier.clickable { unread++ })',
		'}'
	].join('\n');
}

function listNoKey(rng: Rng): Shown {
	const names = rng.sample(ROW_NAMES, 6);
	const items = names.slice(0, rng.int(3, 4));
	const spare = names.slice(items.length);
	const current = [...items];
	const count = rng.int(6, 7);
	const removeAt = rng.int(2, count - 2);
	let addAt = rng.int(2, count - 1);
	if (addAt === removeAt) addAt = count - 1;
	const list = events(count, (i) => {
		if (i === removeAt) {
			// Not the last row: removing the last one changes nothing for the rows before it.
			const item = rng.pick(current.slice(0, -1));
			current.splice(current.indexOf(item), 1);
			return { op: 'remove', item };
		}
		if (i === addAt) {
			const item = spare.shift() ?? '';
			current.unshift(item);
			return { op: 'add', item };
		}
		return { op: 'row', item: rng.pick(current) };
	});
	const fn = rng.pick(['Inbox', 'ChatList', 'Contacts']);
	return {
		scene: { counters: [], flag: null, key: '', showKey: false, list: { keyed: false, items }, events: list },
		code: rowCode(fn, false),
		intro: `Родитель показывает \`${fn}(listOf(${items.map((x) => `"${x}"`).join(', ')}))\` и меняет список; новый список он передаёт той же \`${fn}\`.`,
		texts: list.map(listText),
		lineFormat: 'строки списка сверху вниз в виде `имя:число` через пробел'
	};
}

function listText(e: Event): string {
	switch (e.op) {
		case 'row':
			return `нажатие на строку ${e.item}`;
		case 'remove':
			return `родитель убирает ${e.item} из списка`;
		case 'add':
			return `родитель добавляет ${e.item} в начало списка`;
		case 'rotate':
			return ROTATE_TEXT;
		default:
			return '';
	}
}

function listKey(rng: Rng): Shown {
	const names = rng.sample(ROW_NAMES, 8);
	const items = names.slice(0, rng.int(3, 4));
	const spare = names.slice(items.length);
	const current = [...items];
	const removed: string[] = [];
	const count = rng.int(7, 8);
	const list = events(count, (i) => {
		const pick = rng.int(0, 9);
		if (i >= 1 && pick < 2 && current.length > 2) {
			const item = rng.pick(current);
			current.splice(current.indexOf(item), 1);
			removed.push(item);
			return { op: 'remove', item };
		}
		if (i >= 2 && pick < 4) {
			const from = removed.length > 0 && rng.bool(0.7) ? removed : spare;
			const item = from.shift();
			if (item !== undefined) {
				current.unshift(item);
				return { op: 'add', item };
			}
		}
		if (i >= 3 && pick < 5) return { op: 'rotate' };
		return { op: 'row', item: rng.pick(current) };
	});
	const fn = rng.pick(['Inbox', 'ChatList', 'Contacts']);
	return {
		scene: { counters: [], flag: null, key: '', showKey: false, list: { keyed: true, items }, events: list },
		code: rowCode(fn, true),
		intro: `Родитель показывает \`${fn}(listOf(${items.map((x) => `"${x}"`).join(', ')}))\` и меняет список; список хранится во ViewModel и переживает поворот.`,
		texts: list.map(listText),
		lineFormat: 'строки списка сверху вниз в виде `имя:число` через пробел'
	};
}

function saveableKey(rng: Rng): Shown {
	const plot = rng.pick(KEY_PLOTS);
	const pool = rng.sample(plot.ids, 3);
	const first = pool[0] ?? '';
	const other = rng.pick(['scroll', 'zoom', 'page']);
	const a: Counter = { name: plot.counter, kind: 'saveable', init: rng.int(0, 2), keyed: true, inBranch: false };
	const b: Counter = { name: other, kind: 'remember', init: rng.int(0, 2), keyed: false, inBranch: false };
	const counters = [a, b];
	let current = first;
	const list = events(rng.int(7, 8), (i) => {
		const pick = rng.int(0, 9);
		if (i >= 2 && pick < 2) return { op: 'rotate' };
		if (i >= 1 && pick < 4) {
			const value = rng.pick(pool.filter((x) => x !== current));
			current = value;
			return { op: 'key', value };
		}
		return { op: 'click', target: rng.pick([plot.counter, other]) };
	});
	const code = [
		'@Composable',
		`fun ${plot.fn}(${plot.param}: String) {`,
		`    var ${a.name} by rememberSaveable(${plot.param}) { mutableStateOf(${a.init}) }`,
		`    var ${b.name} by remember { mutableStateOf(${b.init}) }`,
		'    Column {',
		`        Text("$${plot.param} $${a.name} $${b.name}")`,
		`        Button(onClick = { ${a.name}++ }) { Text("${a.name}") }`,
		`        Button(onClick = { ${b.name}++ }) { Text("${b.name}") }`,
		'    }',
		'}'
	];
	return {
		scene: { counters, flag: null, key: first, showKey: true, list: null, events: list },
		code: code.join('\n'),
		intro: `Родитель показывает \`${plot.fn}("${first}")\`; \`${plot.param}\` он берёт из ViewModel, поэтому после поворота передаёт тот же. Сама \`${plot.fn}\` из композиции не уходит.`,
		texts: list.map((e) =>
			e.op === 'click'
				? `нажатие на кнопку «${e.target}»`
				: e.op === 'key'
					? `родитель передаёт ${plot.param} = "${e.value}"`
					: ROTATE_TEXT
		),
		lineFormat: `\`${plot.param}\` и два числа через пробел, как их выводит \`Text\``
	};
}

function branchSaveable(rng: Rng): Shown {
	const [outer, inner] = rng.pick(PAIRS);
	const flag = { kind: rng.pick(['remember', 'saveable'] as const), init: rng.bool() };
	const outerInit = rng.int(0, 3);
	const counters: Counter[] = [
		{ name: outer, kind: 'remember', init: outerInit, keyed: false, inBranch: false },
		{ name: inner, kind: 'saveable', init: 0, keyed: false, inBranch: true }
	];
	let on = flag.init;
	const list = events(rng.int(7, 8), (i) => {
		const pick = rng.int(0, 9);
		// A rotation that hides a shown branch would leave a restored value pending: the scene never makes one.
		const rotationHides = flag.kind === 'remember' && on && !flag.init;
		if (i >= 2 && pick < 2 && !rotationHides) {
			if (flag.kind === 'remember') on = flag.init;
			return { op: 'rotate' };
		}
		if (pick < 5) {
			on = !on;
			return { op: 'toggle' };
		}
		if (on && pick < 8) return { op: 'click', target: inner };
		return { op: 'click', target: outer };
	});
	const fn = rng.pick(SCREENS);
	const holder = flag.kind === 'saveable' ? 'rememberSaveable' : 'remember';
	const code = [
		'@Composable',
		`fun ${fn}() {`,
		`    var ${outer} by remember { mutableStateOf(${outerInit}) }`,
		`    var expanded by ${holder} { mutableStateOf(${flag.init}) }`,
		'    Column {',
		`        Button(onClick = { ${outer}++ }) { Text("${outer}") }`,
		'        Button(onClick = { expanded = !expanded }) { Text("details") }',
		'        if (expanded) {',
		`            var ${inner} by rememberSaveable { mutableStateOf(0) }`,
		`            Button(onClick = { ${inner}++ }) { Text("${inner}") }`,
		`            Text("$${outer} $${inner}")`,
		'        } else {',
		`            Text("$${outer} -")`,
		'        }',
		'    }',
		'}'
	];
	return {
		scene: { counters, flag, key: '', showKey: false, list: null, events: list },
		code: code.join('\n'),
		intro: `Экран \`${fn}\` — содержимое Activity; процесс приложения не завершается. Кнопку «${inner}» нажимают, только когда она видна.`,
		texts: list.map((e) =>
			e.op === 'toggle'
				? 'нажатие на кнопку «details»'
				: e.op === 'click'
					? `нажатие на кнопку «${e.target}»`
					: ROTATE_TEXT
		),
		lineFormat: 'то, что выводит `Text`: два значения через пробел'
	};
}

const SCENES: Record<string, (rng: Rng) => Shown> = {
	'intern/plain-var': plainVar,
	'intern/remember-key': rememberKey,
	'intern/saveable-rotation': saveableRotation,
	'intern/if-branch': ifBranch,
	'junior/list-no-key': listNoKey,
	'junior/saveable-key': saveableKey,
	'junior/branch-saveable': branchSaveable,
	'junior/list-key': listKey
};

function statement(shown: Shown, first: string): string {
	return [
		'По модели Jetpack Compose (не на устройстве): состояние, перекомпоновка и жизненный цикл composable-функций по документации Android.',
		'',
		shown.intro,
		`До первого события экран показывает: \`${first}\`.`,
		'',
		'События по порядку:',
		'',
		...shown.texts.map((t, i) => `${i + 1}. ${t}`),
		'',
		`Что покажет экран после каждого события? Введите по строке на событие: ${shown.lineFormat}.`
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = SCENES[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no scene for ${input.grade}/${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Scenes are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const shown = make(rng);
		const [first = '', ...answer] = simulate(shown.scene, RIGHT);
		const same = (lines: string[]): boolean => lines.join('\n') === answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const lines = simulate(shown.scene, { ...RIGHT, ...change }).slice(1);
				return [id, same(lines) ? null : lines];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(shown, first), code: { language: 'kotlin', source: shown.code } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(shown.scene) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, lines]) => [
						id,
						lines === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: lines } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scene for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
