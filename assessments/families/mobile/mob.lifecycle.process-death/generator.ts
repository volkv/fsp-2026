// What a screen keeps across a configuration change, the death of its process in the background and finish(): each
// value lives in its own storage (a field of the activity, the instance-state Bundle, a ViewModel, SavedStateHandle,
// a process-wide object, Room, Compose remember / rememberSaveable, fragment arguments, intent extras). The model
// follows the Android documentation (Saving UI states, Saved State module for ViewModel, API 28+ order of
// onSaveInstanceState after onStop); it is a model, not a device run.
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

type Kind =
	| 'activityField'
	| 'bundle'
	| 'vmField'
	| 'ssh'
	| 'singleton'
	| 'room'
	| 'remember'
	| 'saveable'
	| 'fragmentArg'
	| 'intentExtra';

interface Item {
	name: string;
	kind: Kind;
	/** The value after a fresh start; for arguments and extras — the value the screen was opened with. */
	initial: number;
}

type Event =
	| { t: number; kind: 'write'; item: string; value: number; background: boolean }
	| { t: number; kind: 'home' | 'return' | 'death' | 'rotate' | 'finish' | 'launch' };

interface Loading {
	item: string;
	seconds: number;
	value: number;
}

interface Scenario {
	screen: string;
	items: Item[];
	events: Event[];
	loading: Loading | null;
	/** Senior: the moment the screen is read, in seconds; middle: after the last event. */
	askAt: number | null;
}

interface Rules {
	vmSurvivesDeath: boolean;
	sshLikeVm: boolean;
	singletonSurvivesDeath: boolean;
	savedSurvivesFinish: boolean;
	vmLostOnRotation: boolean;
	rememberSurvivesRotation: boolean;
	singletonLostOnFinish: boolean;
	argsLostOnDeath: boolean;
	saveAtDeath: boolean;
	loadingResumes: boolean;
}

const RIGHT: Rules = {
	vmSurvivesDeath: false,
	sshLikeVm: false,
	singletonSurvivesDeath: false,
	savedSurvivesFinish: false,
	vmLostOnRotation: false,
	rememberSurvivesRotation: false,
	singletonLostOnFinish: false,
	argsLostOnDeath: false,
	saveAtDeath: false,
	loadingResumes: false
};

const SAVED: readonly Kind[] = ['bundle', 'saveable', 'ssh'];

/** The value of every item at the end, or `null` when the loading finishes exactly at an event (no such scenario). */
function simulate(s: Scenario, rules: Rules): Map<string, number> | null {
	const values = new Map(s.items.map((i) => [i.name, i.initial]));
	let snapshot: Map<string, number> | null = null;
	const takeSnapshot = (): Map<string, number> =>
		new Map(s.items.filter((i) => SAVED.includes(i.kind)).map((i) => [i.name, values.get(i.name) ?? 0]));
	const reset = (item: Item): void => {
		values.set(item.name, item.initial);
	};
	let loadingAt = s.loading ? s.loading.seconds : null;
	let remaining: number | null = null;
	const complete = (until: number): boolean => {
		if (loadingAt === null || !s.loading) return true;
		if (loadingAt === until) return false;
		if (loadingAt < until) {
			values.set(s.loading.item, s.loading.value);
			loadingAt = null;
		}
		return true;
	};
	let dead = false;
	for (const ev of s.events) {
		if (!complete(ev.t)) return null;
		switch (ev.kind) {
			case 'write':
				values.set(ev.item, ev.value);
				break;
			case 'home':
				if (!rules.saveAtDeath) snapshot = takeSnapshot();
				break;
			case 'death':
				if (rules.saveAtDeath) snapshot = takeSnapshot();
				dead = true;
				for (const item of s.items) {
					const k = item.kind;
					if (k === 'activityField' || k === 'remember') reset(item);
					else if (k === 'vmField' && !rules.vmSurvivesDeath) reset(item);
					else if (k === 'singleton' && !rules.singletonSurvivesDeath) reset(item);
					else if (k === 'ssh' && rules.sshLikeVm) reset(item);
					else if (SAVED.includes(k)) values.set(item.name, snapshot?.get(item.name) ?? item.initial);
					else if ((k === 'fragmentArg' || k === 'intentExtra') && rules.argsLostOnDeath) values.set(item.name, 0);
				}
				remaining = loadingAt === null ? null : loadingAt - ev.t;
				loadingAt = null;
				break;
			case 'return':
				if (dead && s.loading)
					loadingAt = ev.t + (rules.loadingResumes && remaining !== null ? remaining : s.loading.seconds);
				dead = false;
				break;
			case 'rotate':
				snapshot = takeSnapshot();
				for (const item of s.items) {
					if (item.kind === 'activityField') reset(item);
					if (item.kind === 'remember' && !rules.rememberSurvivesRotation) reset(item);
					if (item.kind === 'vmField' && rules.vmLostOnRotation) reset(item);
				}
				if (rules.vmLostOnRotation && s.loading) loadingAt = ev.t + s.loading.seconds;
				break;
			case 'finish':
				for (const item of s.items) {
					const k = item.kind;
					if (k === 'activityField' || k === 'remember' || k === 'vmField') reset(item);
					else if (SAVED.includes(k) && !rules.savedSurvivesFinish) reset(item);
					else if (k === 'singleton' && rules.singletonLostOnFinish) reset(item);
				}
				snapshot = null;
				loadingAt = null;
				break;
			case 'launch':
				if (s.loading) loadingAt = ev.t + s.loading.seconds;
				break;
		}
	}
	if (s.askAt !== null && !complete(s.askAt)) return null;
	return values;
}

const NAMES = [
	'query',
	'page',
	'badge',
	'draft',
	'scroll',
	'tab',
	'filter',
	'cartCount',
	'selectedId',
	'sortMode',
	'zoom',
	'step',
	'unread',
	'promo',
	'rating',
	'quantity',
	'offset',
	'colorId'
] as const;

const SCREENS = ['Cart', 'Catalog', 'Profile', 'Chat', 'Orders', 'Search', 'Checkout', 'Feed', 'Wallet'] as const;

const MEMORY: readonly Kind[] = [
	'activityField',
	'bundle',
	'vmField',
	'ssh',
	'singleton',
	'room',
	'remember',
	'saveable'
];
/** Storages a ViewModel coroutine can write to while the app is in the background. */
const BACKGROUND: readonly Kind[] = ['vmField', 'ssh', 'singleton', 'room'];

function freshValue(rng: Rng, avoid: readonly number[]): number {
	for (;;) {
		const v = rng.int(1, 99);
		if (!avoid.includes(v)) return v;
	}
}

function makeItems(rng: Rng, kinds: readonly Kind[]): Item[] {
	const names = rng.sample(NAMES, kinds.length);
	return kinds.map((kind, i) => ({
		name: names[i] ?? '',
		kind,
		initial: kind === 'fragmentArg' || kind === 'intentExtra' ? rng.int(2, 99) : rng.pick([0, 0, 1])
	}));
}

/** The kinds of a level: the required ones plus distinct others, shuffled. */
function pickKinds(rng: Rng, required: readonly Kind[], pool: readonly Kind[], count: number): Kind[] {
	const rest = rng.sample(
		pool.filter((k) => !required.includes(k)),
		Math.max(0, count - required.length)
	);
	return rng.shuffle([...required, ...rest]);
}

function middleScenario(rng: Rng, classId: string): Scenario {
	const screen = rng.pick(SCREENS);
	const count = rng.int(6, 7);
	const required: Kind[] =
		classId === 'death'
			? ['vmField', 'ssh', 'singleton']
			: classId === 'finish'
				? ['singleton', rng.pick(SAVED)]
				: classId === 'rotate-and-back'
					? ['remember', 'vmField']
					: [rng.pick(['fragmentArg', 'intentExtra'] as const)];
	const pool: Kind[] = classId === 'death-args' ? [...MEMORY, 'fragmentArg', 'intentExtra'] : [...MEMORY];
	const items = makeItems(rng, pickKinds(rng, required, pool, count));
	const events: Event[] = [];
	let t = 0;
	const write = (item: Item): void => {
		t += 1;
		events.push({ t, kind: 'write', item: item.name, value: freshValue(rng, [item.initial]), background: false });
	};
	const at = (kind: Exclude<Event['kind'], 'write'>): void => {
		t += 1;
		events.push({ t, kind });
	};
	for (const item of rng.shuffle(items)) if (item.kind !== 'fragmentArg' && item.kind !== 'intentExtra') write(item);
	if (classId === 'finish') {
		at('finish');
		at('launch');
	} else if (classId === 'rotate-and-back') {
		at('rotate');
		at('home');
		at('return');
	} else {
		at('home');
		at('death');
		at('return');
	}
	return { screen, items, events, loading: null, askAt: null };
}

function seniorScenario(rng: Rng, classId: string): Scenario {
	const screen = rng.pick(SCREENS);
	const count = rng.int(5, 6);
	const events: Event[] = [];
	let t = 0;
	const step = (lo = 1, hi = 3): number => {
		t += rng.int(lo, hi);
		return t;
	};
	const at = (kind: Exclude<Event['kind'], 'write'>, lo = 1, hi = 3): void => {
		events.push({ t: step(lo, hi), kind });
	};
	const write = (item: Item, background = false): void => {
		const previous = events
			.filter((e): e is Extract<Event, { kind: 'write' }> => e.kind === 'write' && e.item === item.name)
			.map((e) => e.value);
		events.push({
			t: step(),
			kind: 'write',
			item: item.name,
			value: freshValue(rng, [item.initial, ...previous]),
			background
		});
	};
	let loading: Loading | null = null;
	let items: Item[];
	if (classId === 'write-after-save') {
		items = makeItems(rng, pickKinds(rng, ['ssh', rng.pick(['vmField', 'room', 'singleton'] as const)], MEMORY, count));
		for (const item of rng.sample(items, rng.int(2, items.length))) write(item);
		at('home');
		const bg = items.filter((i) => BACKGROUND.includes(i.kind));
		for (const item of rng.sample(bg, rng.int(1, bg.length))) write(item, true);
		if (rng.bool(0.4)) {
			at('return');
			at('home');
			for (const item of rng.sample(bg, rng.int(1, bg.length))) write(item, true);
		}
		at('death', 2, 5);
		at('return', 2, 5);
	} else if (classId === 'loading') {
		const target = rng.pick(['vmField', 'ssh', 'room', 'singleton'] as const);
		items = makeItems(rng, pickKinds(rng, [target], MEMORY, count));
		const loadItem = items.find((i) => i.kind === target) ?? items[0];
		loading = { item: loadItem?.name ?? '', seconds: rng.int(5, 9), value: freshValue(rng, [loadItem?.initial ?? 0]) };
		for (const item of rng.sample(items, rng.int(2, 3))) if (item !== loadItem) write(item);
		at('home', 1, 2);
		at('death', 1, 2);
		at('return', 1, 3);
	} else if (classId === 'rotate-chain') {
		items = makeItems(
			rng,
			pickKinds(rng, ['vmField', 'ssh', rng.pick(['remember', 'activityField'] as const)], MEMORY, count)
		);
		for (const item of rng.sample(items, rng.int(2, 4))) write(item);
		at('rotate');
		for (const item of rng.sample(items, rng.int(2, 4))) write(item);
		at('home');
		at('death', 2, 5);
		at('return', 2, 5);
	} else {
		items = makeItems(rng, pickKinds(rng, ['singleton', rng.pick(SAVED)], MEMORY, count));
		for (const item of rng.sample(items, rng.int(2, 4))) write(item);
		at('home');
		at('death', 2, 5);
		at('return', 2, 5);
		const singleton = items.find((i) => i.kind === 'singleton');
		const saved = items.find((i) => SAVED.includes(i.kind));
		for (const item of rng.shuffle([singleton, saved, ...rng.sample(items, rng.int(0, 2))])) if (item) write(item);
		at('finish');
		at('launch', 2, 4);
	}
	const askAt = t + rng.int(1, 8);
	return { screen, items, events, loading, askAt };
}

// ---- statement ----

function renderCode(s: Scenario): string {
	const of = (k: Kind): Item[] => s.items.filter((i) => i.kind === k);
	const vm = `${s.screen}ViewModel`;
	const lines: string[] = [];
	const singletons = of('singleton');
	if (singletons.length) {
		lines.push('object AppSession {', ...singletons.map((i) => `    var ${i.name} = ${i.initial}`), '}', '');
	}
	const rooms = of('room');
	const ssh = of('ssh');
	const params = [
		...(ssh.length ? ['    private val state: SavedStateHandle,'] : []),
		...(rooms.length ? [`    private val dao: ${s.screen}Dao,`] : []),
		...(s.loading ? [`    private val api: ${s.screen}Api,`] : [])
	];
	lines.push(...(params.length ? [`class ${vm}(`, ...params, ') : ViewModel() {'] : [`class ${vm} : ViewModel() {`]));
	for (const i of of('vmField')) lines.push(`    var ${i.name} = ${i.initial}`);
	for (const i of ssh) {
		lines.push(
			`    var ${i.name}: Int`,
			`        get() = state["${i.name}"] ?: ${i.initial}`,
			`        set(value) { state["${i.name}"] = value }`
		);
	}
	for (const i of rooms) {
		lines.push(
			`    var ${i.name}: Int`,
			`        get() = dao.read("${i.name}") ?: ${i.initial}`,
			`        set(value) = dao.write("${i.name}", value)`
		);
	}
	if (s.loading) {
		const target = s.items.find((i) => i.name === s.loading?.item);
		const owner = target?.kind === 'singleton' ? 'AppSession.' : '';
		lines.push(
			'',
			'    init {',
			'        viewModelScope.launch {',
			`            val loaded = api.load${capitalize(s.loading.item)}()   // ответ сервера приходит через ${s.loading.seconds} с`,
			`            ${owner}${s.loading.item} = loaded`,
			'        }',
			'    }'
		);
	}
	lines.push('}', '');
	const bundles = of('bundle');
	const extras = of('intentExtra');
	lines.push(`class ${s.screen}Activity : ComponentActivity() {`, `    private val vm: ${vm} by viewModels()`);
	for (const i of of('activityField')) lines.push(`    private var ${i.name} = ${i.initial}`);
	for (const i of bundles) lines.push(`    private var ${i.name} = ${i.initial}`);
	for (const i of extras) lines.push(`    private val ${i.name} get() = intent.getIntExtra("${i.name}", 0)`);
	lines.push(
		'',
		'    override fun onCreate(savedInstanceState: Bundle?) {',
		'        super.onCreate(savedInstanceState)'
	);
	for (const i of bundles) lines.push(`        ${i.name} = savedInstanceState?.getInt("${i.name}") ?: ${i.initial}`);
	const remembers = of('remember');
	const saveables = of('saveable');
	const args = of('fragmentArg');
	if (remembers.length || saveables.length || args.length === 0) {
		lines.push('        setContent {');
		for (const i of remembers) lines.push(`            var ${i.name} by remember { mutableIntStateOf(${i.initial}) }`);
		for (const i of saveables)
			lines.push(`            var ${i.name} by rememberSaveable { mutableIntStateOf(${i.initial}) }`);
		lines.push(`            ${s.screen}Screen(vm /* и состояние выше */)`, '        }');
	}
	lines.push('    }');
	if (bundles.length) {
		lines.push(
			'',
			'    override fun onSaveInstanceState(outState: Bundle) {',
			'        super.onSaveInstanceState(outState)',
			...bundles.map((i) => `        outState.putInt("${i.name}", ${i.name})`),
			'    }'
		);
	}
	lines.push('}');
	if (args.length) {
		lines.push(
			'',
			`// Фрагмент в контейнере ${s.screen}Activity`,
			`class ${s.screen}Fragment : Fragment() {`,
			...args.map((i) => `    private val ${i.name} get() = requireArguments().getInt("${i.name}")`),
			'}'
		);
	}
	return lines.join('\n');
}

function capitalize(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function owner(s: Scenario, name: string): string {
	return s.items.find((i) => i.name === name)?.kind === 'singleton' ? `AppSession.${name}` : `\`${name}\``;
}

function eventText(s: Scenario, ev: Event, timed: boolean): string {
	const when = timed ? `**${ev.t} с.** ` : '';
	switch (ev.kind) {
		case 'write': {
			const target = owner(s, ev.item).replaceAll('`', '');
			return ev.background
				? `${when}Приложение в фоне; корутина в \`viewModelScope\` записывает \`${target} = ${ev.value}\`.`
				: `${when}На экране меняется \`${target} = ${ev.value}\`.`;
		}
		case 'home':
			return `${when}Пользователь сворачивает приложение кнопкой Home.`;
		case 'death':
			return `${when}Система завершает процесс приложения, чтобы освободить память.`;
		case 'return':
			return `${when}Пользователь возвращается в приложение из списка недавних.`;
		case 'rotate':
			return `${when}Пользователь поворачивает экран (активность пересоздаётся, \`configChanges\` не задан).`;
		case 'finish':
			return `${when}Пользователь нажимает «Выйти»: активность вызывает \`finish()\`; процесс остаётся жив.`;
		case 'launch':
			return `${when}Пользователь снова запускает приложение значком в лаунчере.`;
	}
}

function describe(s: Scenario, grade: string): string {
	const timed = grade === 'senior';
	const opened = s.items.filter((i) => i.kind === 'fragmentArg' || i.kind === 'intentExtra');
	const intro = [
		`По модели жизненного цикла Android из документации (Saving UI states, Saved State module for ViewModel; API 34; не на устройстве). Приложение — одна активность \`${s.screen}Activity\`, показанный ниже код — иллюстрация: \`dao.read\`/\`dao.write\` — синхронный доступ к таблице Room, сеть и диск не сбоят. Процесс приложения жив, пока в сценарии явно не сказано, что система его завершила.`
	];
	if (opened.length) {
		intro.push(
			'',
			`Экран открыт так: ${opened.map((i) => (i.kind === 'intentExtra' ? `extra \`${i.name}\` = ${i.initial} в интенте активности` : `аргумент \`${i.name}\` = ${i.initial} у фрагмента`)).join('; ')}.`
		);
	}
	const steps = s.events.map((ev, i) => `${i + 1}. ${eventText(s, ev, timed)}`);
	const ask = timed
		? [
				`В момент **${s.askAt} с** (отсчёт от первого открытия экрана в 0 с) экран читает все переменные из кода. Введите по строке на переменную: \`имя=значение\` (например, \`page=3\`), порядок не важен.`
			]
		: [
				'Какие переменные после последнего шага хранят последнее записанное в них значение (аргументы и extras — значение, с которым экран открыт)? Введите имена по одному в строке, порядок не важен; если таких нет — `-`.'
			];
	return [...intro, '', timed ? 'Сценарий:' : 'Сценарий по шагам:', '', ...steps, '', ...ask].join('\n');
}

// ---- reference ----

const PYTHON_REFERENCE = `import json

s = json.loads(input())
SCOPE = {
    "activityField": "instance", "remember": "instance",
    "bundle": "saved", "saveable": "saved", "ssh": "saved",
    "vmField": "vm", "singleton": "process", "room": "disk",
    "fragmentArg": "opened", "intentExtra": "opened",
}
# which scopes an event wipes; "saved" ones come back from the last saved state after a death
WIPES = {
    "rotate": {"instance"},
    "death": {"instance", "vm", "process"},
    "finish": {"instance", "vm", "saved"},
}
items = s["items"]
init = {i["name"]: i["initial"] for i in items}
scope = {i["name"]: SCOPE[i["kind"]] for i in items}
cur = dict(init)
last_saved = {}
load = s["loading"]
due = load["seconds"] if load else None
vm_gone = False


def tick(now):
    global due
    if due is not None and due < now:
        cur[load["item"]] = load["value"]
        due = None


for e in s["events"]:
    tick(e["t"])
    k = e["kind"]
    if k == "write":
        cur[e["item"]] = e["value"]
    elif k in ("home", "rotate"):
        last_saved = {n: v for n, v in cur.items() if scope[n] == "saved"}
    if k in WIPES:
        for n in cur:
            if scope[n] in WIPES[k]:
                cur[n] = init[n]
        if k == "death":
            for n in cur:
                if scope[n] == "saved":
                    cur[n] = last_saved.get(n, init[n])
        if k in ("death", "finish"):
            due = None
            if k == "finish":
                last_saved = {}
    if k in ("death", "finish"):
        vm_gone = True
    elif k in ("return", "launch") and vm_gone:
        vm_gone = False
        if load:
            due = e["t"] + load["seconds"]
if s["askAt"] is None:
    last = dict(init)
    for e in s["events"]:
        if e["kind"] == "write":
            last[e["item"]] = e["value"]
    keep = sorted(n for n in cur if cur[n] == last[n])
    print("\\n".join(keep) if keep else "-")
else:
    tick(s["askAt"])
    print("\\n".join(f"{n}={cur[n]}" for n in sorted(cur)))
`;

function answerOf(s: Scenario, values: Map<string, number>): string[] {
	if (s.askAt !== null) return s.items.map((i) => `${i.name}=${values.get(i.name)}`).sort();
	const last = new Map(s.items.map((i) => [i.name, i.initial]));
	for (const e of s.events) if (e.kind === 'write') last.set(e.item, e.value);
	const keep = s.items.filter((i) => values.get(i.name) === last.get(i.name)).map((i) => i.name);
	return keep.length ? keep.sort() : ['-'];
}

const WRONG: Record<string, Partial<Rules>> = {
	'vm-survives-death': { vmSurvivesDeath: true },
	'ssh-like-vm': { sshLikeVm: true },
	'singleton-survives-death': { singletonSurvivesDeath: true },
	'saved-survives-finish': { savedSurvivesFinish: true },
	'vm-lost-on-rotation': { vmLostOnRotation: true },
	'remember-survives-rotation': { rememberSurvivesRotation: true },
	'singleton-lost-on-finish': { singletonLostOnFinish: true },
	'args-lost-on-death': { argsLostOnDeath: true },
	'save-at-death': { saveAtDeath: true },
	'loading-resumes': { loadingResumes: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/death': ['vm-survives-death', 'ssh-like-vm', 'singleton-survives-death'],
	'middle/finish': ['saved-survives-finish', 'singleton-lost-on-finish'],
	'middle/rotate-and-back': ['remember-survives-rotation', 'vm-lost-on-rotation'],
	'middle/death-args': ['args-lost-on-death'],
	'senior/write-after-save': ['save-at-death'],
	'senior/loading': ['loading-resumes'],
	'senior/rotate-chain': ['vm-survives-death', 'ssh-like-vm'],
	'senior/death-then-finish': ['singleton-lost-on-finish', 'saved-survives-finish']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = input.grade === 'senior' ? seniorScenario(rng, input.classId) : middleScenario(rng, input.classId);
		const values = simulate(s, RIGHT);
		if (!values) continue;
		const answer = answerOf(s, values);
		if (s.askAt === null && answer.length === s.items.length) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const v = simulate(s, { ...RIGHT, ...change });
				const value = v ? answerOf(s, v) : null;
				return [id, value === null || same(value, answer) ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.grade), code: { language: 'kotlin', source: renderCode(s) } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
