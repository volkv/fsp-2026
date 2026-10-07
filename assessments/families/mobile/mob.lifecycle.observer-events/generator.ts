// Lifecycle observers of an androidx `ComponentActivity` (API 34): `DefaultLifecycleObserver`s get the events going up
// (ON_CREATE, ON_START, ON_RESUME) right after the Activity's callback returns and the events going down (ON_PAUSE,
// ON_STOP, ON_DESTROY) right before it is called — `ReportFragment` dispatches them from `onActivityPost*` and
// `onActivityPre*`. Going up the observers are called in the order they were added, going down in the reverse
// order; an observer added late catches up through every event up to the current state, one removed gets nothing
// more. The generator follows the observers one by one; the Python reference runs a copy of `LifecycleRegistry`'s
// synchronisation (`sync`, forward and backward passes over an ordered map).
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

const OBSERVERS = [
	'Analytics',
	'Player',
	'Location',
	'Camera',
	'Sync',
	'Logger',
	'Network',
	'Session',
	'Sensor',
	'Chat'
];
const SCREENS = ['Player', 'Map', 'Camera', 'Chat', 'Feed', 'Tracker'];

type UserEvent = 'launch' | 'home' | 'return' | 'overlay' | 'back' | 'rotate' | 'clickAdd' | 'clickRemove';
type Hook = 'onStart' | 'onResume' | 'onPause' | 'onStop';

interface Scenario {
	screen: string;
	/** Added in `onCreate`, in this order. */
	initial: string[];
	/** Added by a button or once in `addIn`. */
	extra: string | null;
	addIn: Hook | null;
	/** Removed by a button or once in `removeIn`. */
	removeTarget: string | null;
	removeIn: Hook | null;
	events: UserEvent[];
	/** The log asked for starts with the entries of this event (0 — the whole log). */
	logFrom: number;
}

interface Rules {
	sameOrderDown: boolean;
	noCatchUp: boolean;
	catchUpCurrentOnly: boolean;
	removedGetsDown: boolean;
	activityFirstDown: boolean;
	catchUpIncludesCurrent: boolean;
}

const RIGHT: Rules = {
	sameOrderDown: false,
	noCatchUp: false,
	catchUpCurrentOnly: false,
	removedGetsDown: false,
	activityFirstDown: false,
	catchUpIncludesCurrent: false
};

const UP_NAME = ['', 'onCreate', 'onStart', 'onResume'];
const DOWN_NAME = ['', 'onDestroy', 'onStop', 'onPause'];
const UP_TARGET: Record<string, number> = { onCreate: 1, onStart: 2, onResume: 3 };
const DOWN_TARGET: Record<string, number> = { onPause: 2, onStop: 1, onDestroy: 0 };

/** The log of a scenario: the Activity's callbacks and the observers' events in order. */
function simulate(s: Scenario, rules: Rules): string[] {
	const out: string[] = [];
	let observers: { name: string; state: number }[] = [];
	let state = 0;
	let added = false;
	let removed = false;
	/** The state an observer added now catches up to; inside an up callback a misconception takes the coming one. */
	let catchUpTo = (): number => state;

	const up = (o: { name: string; state: number }, target: number): void => {
		while (o.state < target) {
			o.state += 1;
			out.push(`${o.name}.${UP_NAME[o.state]}`);
		}
	};
	const down = (o: { name: string; state: number }, target: number): void => {
		while (o.state > target) {
			out.push(`${o.name}.${DOWN_NAME[o.state]}`);
			o.state -= 1;
		}
	};
	const add = (name: string): void => {
		const o = { name, state: 0 };
		const target = catchUpTo();
		if (rules.noCatchUp) o.state = target;
		else if (rules.catchUpCurrentOnly) {
			o.state = target;
			if (target > 0) out.push(`${name}.${UP_NAME[target]}`);
		} else up(o, target);
		observers.push(o);
	};
	const remove = (name: string): void => {
		const o = observers.find((x) => x.name === name);
		if (!o) throw new Error(`${descriptor.key}: removing ${name} that is not there`);
		if (rules.removedGetsDown) down(o, 0);
		observers = observers.filter((x) => x !== o);
	};
	const hooks = (callback: string): void => {
		if (callback === 'onCreate') for (const name of s.initial) add(name);
		if (s.addIn === callback && !added && s.extra) {
			added = true;
			add(s.extra);
		}
		if (s.removeIn === callback && !removed && s.removeTarget) {
			removed = true;
			remove(s.removeTarget);
		}
	};
	const callback = (name: string): void => {
		const upTarget = UP_TARGET[name];
		const downTarget = DOWN_TARGET[name];
		if (upTarget !== undefined) {
			out.push(`Activity.${name}`);
			if (rules.catchUpIncludesCurrent) catchUpTo = () => upTarget;
			hooks(name);
			catchUpTo = () => state;
			state = upTarget;
			for (const o of observers) up(o, upTarget);
		} else if (downTarget !== undefined) {
			if (rules.activityFirstDown) out.push(`Activity.${name}`);
			state = downTarget;
			for (const o of rules.sameOrderDown ? observers : [...observers].reverse()) down(o, downTarget);
			if (!rules.activityFirstDown) out.push(`Activity.${name}`);
			hooks(name);
		} else out.push(`Activity.${name}`);
	};
	const newInstance = (): void => {
		observers = [];
		state = 0;
		added = false;
		removed = false;
		callback('onCreate');
		callback('onStart');
		callback('onResume');
	};

	let from = 0;
	for (const [i, event] of s.events.entries()) {
		if (i === s.logFrom) from = out.length;
		switch (event) {
			case 'launch':
				newInstance();
				break;
			case 'home':
				callback('onPause');
				callback('onStop');
				break;
			case 'return':
				callback('onRestart');
				callback('onStart');
				callback('onResume');
				break;
			case 'overlay':
				callback('onPause');
				callback('onResume');
				break;
			case 'back':
				callback('onPause');
				callback('onStop');
				callback('onDestroy');
				break;
			case 'rotate':
				callback('onPause');
				callback('onStop');
				callback('onDestroy');
				newInstance();
				break;
			case 'clickAdd':
				if (s.extra) add(s.extra);
				break;
			case 'clickRemove':
				if (s.removeTarget) remove(s.removeTarget);
				break;
		}
	}
	return out.slice(from);
}

interface Plan {
	initial: [number, number];
	extra: 'click' | 'hook' | null;
	addIn: readonly Hook[];
	remove: 'click' | 'hook' | null;
	removeIn: readonly Hook[];
	events: (rng: Rng) => UserEvent[];
	/** Only the log from the rotation on is asked for: what comes before is the setting. */
	logFromRotation?: boolean;
	required: readonly string[];
}

/** `count` middle events («Домой» with the way back), then maybe a last one. */
const walk = (
	rng: Rng,
	middle: readonly UserEvent[],
	count: number,
	last: readonly (UserEvent | null)[]
): UserEvent[] => {
	const events: UserEvent[] = [];
	for (let i = 0; i < count; i += 1) {
		const e = rng.pick(middle);
		events.push(...(e === 'home' ? (['home', 'return'] as const) : [e]));
	}
	const end = rng.pick(last);
	return end ? [...events, end] : events;
};

const PLANS: Record<string, Plan> = {
	'intern/create-observers': {
		initial: [2, 2],
		extra: null,
		addIn: [],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', ...walk(rng, [], 0, ['back', 'home'])],
		required: ['same-order-down']
	},
	'intern/late-click': {
		initial: [1, 2],
		extra: 'click',
		addIn: [],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', 'clickAdd', ...walk(rng, [], 0, ['back', 'home', 'overlay'])],
		required: ['no-catch-up', 'catch-up-current-only']
	},
	'intern/home-return': {
		initial: [1, 2],
		extra: null,
		addIn: [],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', ...walk(rng, ['home'], 1, ['overlay', null])],
		required: ['activity-first-down']
	},
	'intern/overlay': {
		initial: [2, 2],
		extra: null,
		addIn: [],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', 'overlay', ...walk(rng, [], 0, ['back', 'home', null])],
		required: ['activity-first-down', 'same-order-down']
	},
	'junior/remove-mid': {
		initial: [2, 3],
		extra: null,
		addIn: [],
		remove: 'hook',
		removeIn: ['onPause', 'onStop'],
		events: (rng) => ['launch', ...walk(rng, ['home', 'overlay'], rng.int(0, 1), ['back', 'home', null])],
		required: ['removed-gets-down']
	},
	'junior/add-in-stop': {
		initial: [2, 2],
		extra: 'hook',
		addIn: ['onPause', 'onStop'],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', ...walk(rng, ['home', 'overlay'], rng.int(0, 1), ['back', 'home', null])],
		required: ['no-catch-up']
	},
	'junior/add-in-start': {
		initial: [2, 2],
		extra: 'hook',
		addIn: ['onStart', 'onResume'],
		remove: null,
		removeIn: [],
		events: (rng) => ['launch', ...walk(rng, ['home', 'overlay'], rng.int(0, 1), ['back', 'home', null])],
		required: ['catch-up-includes-current']
	},
	'junior/rotation': {
		initial: [2, 2],
		extra: 'click',
		addIn: [],
		remove: 'click',
		removeIn: [],
		events: (rng) => {
			const before = rng.bool() ? (['clickAdd'] as UserEvent[]) : (['clickRemove'] as UserEvent[]);
			return ['launch', ...before, 'rotate', ...walk(rng, [], 0, ['back', 'home', null])];
		},
		logFromRotation: true,
		required: ['same-order-down']
	}
};

function scenario(rng: Rng, plan: Plan): Scenario {
	const names = rng.sample(OBSERVERS, 4);
	const initial = names.slice(0, rng.int(plan.initial[0], plan.initial[1]));
	const extra = plan.extra ? (names[3] ?? null) : null;
	const events = plan.events(rng);
	// The button of the rotation class either adds or removes; only the one used is in the code.
	const removes = plan.remove === 'hook' || events.includes('clickRemove');
	return {
		screen: rng.pick(SCREENS),
		initial,
		extra: plan.extra === 'click' && !events.includes('clickAdd') ? null : extra,
		addIn: plan.extra === 'hook' ? rng.pick(plan.addIn) : null,
		removeTarget: removes ? rng.pick(initial) : null,
		removeIn: plan.remove === 'hook' ? rng.pick(plan.removeIn) : null,
		events,
		logFrom: plan.logFromRotation ? events.indexOf('rotate') : 0
	};
}

const field = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

function program(s: Scenario): string {
	const fields = [...s.initial, ...(s.extra ? [s.extra] : [])].map(
		(n) => `    private val ${field(n)} = Logged("${n}")`
	);
	const flags = [
		...(s.addIn ? ['    private var added = false'] : []),
		...(s.removeIn ? ['    private var removed = false'] : [])
	];
	const body = (cb: Hook): string[] => {
		const lines: string[] = [];
		if (s.addIn === cb && s.extra)
			lines.push(`        if (!added) { added = true; lifecycle.addObserver(${field(s.extra)}) }`);
		if (s.removeIn === cb && s.removeTarget)
			lines.push(`        if (!removed) { removed = true; lifecycle.removeObserver(${field(s.removeTarget)}) }`);
		return lines;
	};
	const method = (cb: string, signature: string, superCall: string, extra: string[]): string[] =>
		extra.length
			? [`    override fun ${signature} {`, `        ${superCall}`, `        log("Activity.${cb}")`, ...extra, '    }']
			: [`    override fun ${signature} { ${superCall}; log("Activity.${cb}") }`];
	const buttons: string[] = [];
	if (s.events.includes('clickAdd') && s.extra)
		buttons.push(`    fun onAddClick() = lifecycle.addObserver(${field(s.extra)})   // кнопка «Подключить»`);
	if (s.events.includes('clickRemove') && s.removeTarget)
		buttons.push(
			`    fun onRemoveClick() = lifecycle.removeObserver(${field(s.removeTarget)})   // кнопка «Отключить»`
		);
	return [
		'class Logged(private val name: String) : DefaultLifecycleObserver {',
		'    override fun onCreate(owner: LifecycleOwner) = log("$name.onCreate")',
		'    override fun onStart(owner: LifecycleOwner) = log("$name.onStart")',
		'    override fun onResume(owner: LifecycleOwner) = log("$name.onResume")',
		'    override fun onPause(owner: LifecycleOwner) = log("$name.onPause")',
		'    override fun onStop(owner: LifecycleOwner) = log("$name.onStop")',
		'    override fun onDestroy(owner: LifecycleOwner) = log("$name.onDestroy")',
		'}',
		'',
		`class ${s.screen}Activity : ComponentActivity() {`,
		...fields,
		...flags,
		'',
		'    override fun onCreate(savedInstanceState: Bundle?) {',
		'        super.onCreate(savedInstanceState)',
		'        log("Activity.onCreate")',
		...s.initial.map((n) => `        lifecycle.addObserver(${field(n)})`),
		'    }',
		...method('onStart', 'onStart()', 'super.onStart()', body('onStart')),
		...method('onRestart', 'onRestart()', 'super.onRestart()', []),
		...method('onResume', 'onResume()', 'super.onResume()', body('onResume')),
		...method('onPause', 'onPause()', 'super.onPause()', body('onPause')),
		...method('onStop', 'onStop()', 'super.onStop()', body('onStop')),
		...method('onDestroy', 'onDestroy()', 'super.onDestroy()', []),
		...(buttons.length ? ['', ...buttons] : []),
		'}'
	].join('\n');
}

function eventText(e: UserEvent, s: Scenario): string {
	switch (e) {
		case 'launch':
			return `Пользователь открывает \`${s.screen}Activity\` с главного экрана приложения.`;
		case 'home':
			return 'Пользователь нажимает «Домой».';
		case 'return':
			return 'Пользователь возвращается в приложение из списка недавних.';
		case 'overlay':
			return 'Поверх экрана открывается полупрозрачная Activity другого приложения, пользователь закрывает её.';
		case 'back':
			return 'Пользователь нажимает «Назад» — экран закрывается.';
		case 'rotate':
			return 'Пользователь поворачивает телефон (у экрана нет `android:configChanges`, он пересоздаётся).';
		case 'clickAdd':
			return 'Пользователь нажимает кнопку «Подключить».';
		case 'clickRemove':
			return 'Пользователь нажимает кнопку «Отключить».';
	}
}

function describe(s: Scenario): string {
	return [
		'Ответ — по модели из документации и исходников androidx (`ComponentActivity`, `LifecycleRegistry`, `ReportFragment`; API 34), а не по поведению конкретного устройства.',
		'',
		'Как доставляются события: события подъёма (`ON_CREATE`, `ON_START`, `ON_RESUME`) наблюдатели получают сразу **после** возврата из соответствующего колбэка Activity, события спуска (`ON_PAUSE`, `ON_STOP`, `ON_DESTROY`) — непосредственно **перед** его вызовом. `onRestart` событий жизненного цикла не порождает. Функция `log` дописывает строку в общий журнал; `onSaveInstanceState` в журнал не пишется. Экран открывают с главного экрана приложения, «Назад» закрывает его.',
		'',
		'Что происходит по порядку:',
		'',
		...s.events.map((e, i) => `${i + 1}. ${eventText(e, s)}`),
		'',
		s.logFrom === 0
			? 'Введите весь журнал по порядку, по одной записи в строке, как их печатает `log` (например, `Activity.onCreate`).'
			: `Введите часть журнала, начиная с первой записи, вызванной событием ${s.logFrom + 1}, и до конца — по порядку, по одной записи в строке, как их печатает \`log\` (например, \`Activity.onPause\`).`
	].join('\n');
}

/**
 * The independent reference: an ordered map of observers with their states and the synchronisation of
 * `LifecycleRegistry` — a backward pass from the newest while the registry is below the eldest observer, a forward
 * pass from the eldest while it is above the newest; `addObserver` brings the newcomer up to the registry's state.
 */
const PYTHON_REFERENCE = `import json

d = json.loads(input())
out = []
UP = {1: "onCreate", 2: "onStart", 3: "onResume"}
DOWN = {3: "onPause", 2: "onStop", 1: "onDestroy"}
EVENT_STATE = {"onCreate": 1, "onStart": 2, "onResume": 3, "onPause": 2, "onStop": 1, "onDestroy": 0}


class Registry:
    def __init__(self):
        self.state = 0
        self.order = []
        self.states = {}

    def synced(self):
        return all(self.states[o] == self.state for o in self.order)

    def sync(self):
        while not self.synced():
            if self.order and self.state < self.states[self.order[0]]:
                for o in reversed(list(self.order)):
                    while o in self.states and self.states[o] > self.state:
                        out.append(o + "." + DOWN[self.states[o]])
                        self.states[o] -= 1
            if self.order and self.state > self.states[self.order[-1]]:
                for o in list(self.order):
                    while o in self.states and self.states[o] < self.state:
                        self.states[o] += 1
                        out.append(o + "." + UP[self.states[o]])

    def handle(self, cb):
        self.state = EVENT_STATE[cb]
        self.sync()

    def add(self, o):
        self.order.append(o)
        self.states[o] = 0
        while self.states[o] < self.state:
            self.states[o] += 1
            out.append(o + "." + UP[self.states[o]])

    def remove(self, o):
        self.order.remove(o)
        del self.states[o]


class Screen:
    def __init__(self):
        self.reg = Registry()
        self.added = False
        self.removed = False

    def body(self, cb):
        if cb == "onCreate":
            for o in d["initial"]:
                self.reg.add(o)
        if d["addIn"] == cb and not self.added:
            self.added = True
            self.reg.add(d["extra"])
        if d["removeIn"] == cb and not self.removed:
            self.removed = True
            self.reg.remove(d["removeTarget"])

    def call(self, cb):
        if cb in ("onCreate", "onStart", "onResume"):
            out.append("Activity." + cb)
            self.body(cb)
            self.reg.handle(cb)
        elif cb in ("onPause", "onStop", "onDestroy"):
            self.reg.handle(cb)
            out.append("Activity." + cb)
            self.body(cb)
        else:
            out.append("Activity." + cb)


SEQ = {
    "home": ["onPause", "onStop"],
    "return": ["onRestart", "onStart", "onResume"],
    "overlay": ["onPause", "onResume"],
    "back": ["onPause", "onStop", "onDestroy"],
}
screen = None
start = 0
for i, ev in enumerate(d["events"]):
    if i == d["logFrom"]:
        start = len(out)
    if ev in ("launch", "rotate"):
        if ev == "rotate":
            for cb in SEQ["back"]:
                screen.call(cb)
        screen = Screen()
        for cb in ("onCreate", "onStart", "onResume"):
            screen.call(cb)
    elif ev == "clickAdd":
        screen.reg.add(d["extra"])
    elif ev == "clickRemove":
        screen.reg.remove(d["removeTarget"])
    else:
        for cb in SEQ[ev]:
            screen.call(cb)
print("\\n".join(out[start:]))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'same-order-down': { sameOrderDown: true },
	'no-catch-up': { noCatchUp: true },
	'catch-up-current-only': { catchUpCurrentOnly: true },
	'removed-gets-down': { removedGetsDown: true },
	'activity-first-down': { activityFirstDown: true },
	'catch-up-includes-current': { catchUpIncludesCurrent: true }
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const plan = PLANS[`${input.grade}/${input.classId}`];
	if (!plan) throw new Error(`${descriptor.key}: no plan for ${input.grade}/${input.classId}`);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class is about changes the log.
	for (let tries = 0; tries < 200; tries += 1) {
		const s = scenario(rng, plan);
		const answer = simulate(s, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(s, { ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (plan.required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: program(s) } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
