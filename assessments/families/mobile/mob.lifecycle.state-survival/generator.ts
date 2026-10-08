// Which values of a screen survive what happens to it: an Activity field, the saved instance state, a ViewModel and
// its SavedStateHandle, Compose `remember` and `rememberSaveable`, a process-wide singleton and SharedPreferences,
// against a recreation by a change of the configuration, the background with or without the process killed, closing
// the screen and swiping the app out of the recents. The answer is the set of the values the screen still shows.
// The generator reads the documented table (guide «Save UI states»); the Python reference derives it from where each
// value lives and what each event tears down.
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

type Kind = 'field' | 'bundle' | 'viewModel' | 'handle' | 'remember' | 'saveable' | 'singleton' | 'prefs' | 'file';
type EventKind = 'rotate' | 'theme' | 'rotateHandled' | 'home' | 'death' | 'close' | 'finish' | 'swipe';

/** The documented outcome: whether a value kept in `kind` is still there after `event`. */
const SURVIVES: Record<Kind, Record<EventKind, boolean>> = {
	field: {
		rotate: false,
		theme: false,
		rotateHandled: true,
		home: true,
		death: false,
		close: false,
		finish: false,
		swipe: false
	},
	bundle: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: true,
		close: false,
		finish: false,
		swipe: false
	},
	viewModel: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: false,
		close: false,
		finish: false,
		swipe: false
	},
	handle: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: true,
		close: false,
		finish: false,
		swipe: false
	},
	remember: {
		rotate: false,
		theme: false,
		rotateHandled: true,
		home: true,
		death: false,
		close: false,
		finish: false,
		swipe: false
	},
	saveable: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: true,
		close: false,
		finish: false,
		swipe: false
	},
	singleton: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: false,
		close: true,
		finish: true,
		swipe: false
	},
	prefs: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: true,
		close: true,
		finish: true,
		swipe: true
	},
	file: {
		rotate: true,
		theme: true,
		rotateHandled: true,
		home: true,
		death: true,
		close: true,
		finish: true,
		swipe: true
	}
};

const RECREATING: readonly EventKind[] = ['rotate', 'theme'];
const CLOSING: readonly EventKind[] = ['close', 'finish'];

/** A misconception: the outcome it believes for a kind and an event, `undefined` where it agrees with the table. */
type Belief = (kind: Kind, event: EventKind) => boolean | undefined;

const WRONG: Record<string, Belief> = {
	'viewmodel-survives-death': (k, e) => (k === 'viewModel' && e === 'death' ? true : undefined),
	'bundle-survives-close': (k, e) =>
		(k === 'bundle' || k === 'handle' || k === 'saveable') && (CLOSING.includes(e) || e === 'swipe') ? true : undefined,
	'field-survives-rotation': (k, e) => (k === 'field' && RECREATING.includes(e) ? true : undefined),
	'remember-survives-rotation': (k, e) => (k === 'remember' && RECREATING.includes(e) ? true : undefined),
	'viewmodel-lost-on-rotation': (k, e) => (k === 'viewModel' && RECREATING.includes(e) ? false : undefined),
	'singleton-survives-death': (k, e) => (k === 'singleton' && (e === 'death' || e === 'swipe') ? true : undefined),
	'handled-recreates': (k, e) => (e === 'rotateHandled' ? SURVIVES[k].rotate : undefined),
	// The dark theme is a change only the class with `android:configChanges` has.
	'all-changes-handled': (k, e) => (e === 'theme' ? SURVIVES[k].rotateHandled : undefined),
	'swipe-keeps-state': (k, e) => (e === 'swipe' ? SURVIVES[k].death : undefined)
};

interface Value {
	name: string;
	kind: Kind;
}

/** What happens to the screen, or the user typing some of its values again. */
type Step = { event: EventKind } | { enter: string[] };

interface Scenario {
	screen: string;
	values: Value[];
	steps: Step[];
	/** `android:configChanges` of the screen, when it declares one. */
	declared: string | null;
}

/** The values the screen shows as the user last typed them: typing a value puts it back, an event may lose it. */
function survivors(s: Scenario, belief?: Belief, steps: readonly Step[] = s.steps): string[] {
	return s.values
		.filter((v) =>
			steps.reduce(
				(kept, step) =>
					'enter' in step
						? kept || step.enter.includes(v.name)
						: kept && (belief?.(v.kind, step.event) ?? SURVIVES[v.kind][step.event]),
				true
			)
		)
		.map((v) => v.name)
		.sort();
}

const NAMES = [
	'draft',
	'query',
	'scrollPosition',
	'selectedTab',
	'cartCount',
	'filter',
	'pageIndex',
	'note',
	'zoomLevel',
	'sortOrder',
	'city',
	'promoCode',
	'rating',
	'volume'
];
const SCREENS = ['Editor', 'Search', 'Checkout', 'Player', 'Map', 'Feed', 'Profile'];

interface Plan {
	kinds: readonly Kind[];
	/** Kinds every instance has. */
	mandatory: readonly Kind[];
	count: [number, number];
	steps: (rng: Rng, values: readonly Value[]) => Step[];
	declared: string | null;
	required: readonly string[];
	/** Events whose removal from the scenario must change the answer. */
	essential?: readonly EventKind[];
	/** At least one of these misconceptions shows on every instance. */
	requiredAny?: readonly string[];
}

const CLASSIC: readonly Kind[] = ['field', 'bundle', 'viewModel', 'handle', 'singleton', 'prefs'];
const ALL: readonly Kind[] = [...CLASSIC, 'remember', 'saveable', 'file'];
const HANDLED = 'orientation|screenSize|screenLayout|smallestScreenSize';

const PLANS: Record<string, Plan> = {
	'intern/rotation': {
		kinds: CLASSIC,
		mandatory: ['field', 'viewModel'],
		count: [4, 5],
		steps: () => [{ event: 'rotate' }],
		declared: null,
		required: ['field-survives-rotation', 'viewmodel-lost-on-rotation']
	},
	'intern/process-death': {
		kinds: CLASSIC,
		mandatory: ['viewModel', 'singleton'],
		count: [4, 5],
		steps: () => [{ event: 'death' }],
		declared: null,
		required: ['viewmodel-survives-death', 'singleton-survives-death']
	},
	'intern/close-reopen': {
		kinds: CLASSIC,
		mandatory: ['bundle'],
		count: [4, 5],
		steps: (rng) => [{ event: rng.pick<EventKind>(['close', 'finish']) }],
		declared: null,
		required: ['bundle-survives-close']
	},
	'intern/compose-rotation': {
		kinds: ['remember', 'saveable', 'viewModel', 'handle', 'field', 'prefs'],
		mandatory: ['remember', 'saveable'],
		count: [4, 5],
		steps: () => [{ event: 'rotate' }],
		declared: null,
		required: ['remember-survives-rotation']
	},
	'junior/rotate-then-death': {
		kinds: ALL,
		mandatory: ['viewModel'],
		count: [5, 6],
		// The process dies first, the user types some values again, then the phone turns: each event loses its own.
		steps: (rng, values) => withHome(rng, [{ event: 'death' }, { enter: retyped(rng, values) }, { event: 'rotate' }]),
		declared: null,
		required: ['viewmodel-survives-death'],
		requiredAny: ['field-survives-rotation', 'remember-survives-rotation'],
		essential: ['death', 'rotate']
	},
	'junior/handled-config': {
		kinds: ALL,
		mandatory: [],
		count: [5, 6],
		// The undeclared theme change recreates the screen, the user types some values again, then the declared
		// rotation keeps them.
		steps: (rng, values) =>
			withHome(rng, [{ event: 'theme' }, { enter: retyped(rng, values) }, { event: 'rotateHandled' }]),
		declared: HANDLED,
		required: ['handled-recreates', 'all-changes-handled'],
		essential: ['theme']
	},
	'junior/swipe-vs-death': {
		kinds: ALL,
		mandatory: ['bundle', 'singleton', 'prefs'],
		count: [5, 6],
		steps: (rng) =>
			rng
				.shuffle<EventKind>([rng.bool(0.6) ? 'swipe' : 'death', rng.pick<EventKind>(['rotate', 'home'])])
				.map((event) => ({ event })),
		declared: null,
		required: [],
		requiredAny: ['swipe-keeps-state', 'singleton-survives-death']
	},
	'junior/close-and-death': {
		kinds: ALL,
		mandatory: ['singleton', 'file'],
		count: [5, 6],
		steps: (rng) =>
			rng.shuffle<EventKind>([rng.pick<EventKind>(['close', 'finish']), 'death']).map((event) => ({ event })),
		declared: null,
		required: ['singleton-survives-death', 'bundle-survives-close']
	}
};

/** One or two values the user types again, among them a value kept in the Activity or in `remember`. */
function retyped(rng: Rng, values: readonly Value[]): string[] {
	const screenBound = values.filter((v) => v.kind === 'field' || v.kind === 'remember');
	const first = rng.pick(screenBound.length ? screenBound : values);
	const others = values.filter((v) => v !== first);
	return [first, ...(rng.bool(0.4) ? rng.sample(others, 1) : [])].map((v) => v.name);
}

/** Inserts «Домой» with the way back at a random place, half of the time; it loses nothing. */
function withHome(rng: Rng, steps: Step[]): Step[] {
	if (!rng.bool()) return steps;
	const at = rng.int(0, steps.length);
	return [...steps.slice(0, at), { event: 'home' }, ...steps.slice(at)];
}

function scenario(rng: Rng, plan: Plan): Scenario {
	const count = rng.int(plan.count[0], plan.count[1]);
	const rest = rng.shuffle(plan.kinds.filter((k) => !plan.mandatory.includes(k)));
	const kinds = rng.shuffle([...plan.mandatory, ...rest.slice(0, count - plan.mandatory.length)]);
	const names = rng.sample(NAMES, kinds.length);
	const values = kinds.map((kind, i) => ({ kind, name: names[i] ?? '' }));
	return { screen: rng.pick(SCREENS), values, steps: plan.steps(rng, values), declared: plan.declared };
}

function storage(v: Value, screen: string): string {
	const n = `\`${v.name}\``;
	switch (v.kind) {
		case 'field':
			return `${n} — обычное поле класса \`${screen}Activity\`;`;
		case 'bundle':
			return `${n} — поле \`${screen}Activity\`, которое экран кладёт в \`outState\` в \`onSaveInstanceState\` и читает из \`savedInstanceState\` в \`onCreate\`;`;
		case 'viewModel':
			return `${n} — поле \`${screen}ViewModel\` экрана (\`by viewModels()\`);`;
		case 'handle':
			return `${n} — значение в \`SavedStateHandle\` той же \`${screen}ViewModel\` (\`savedStateHandle["${v.name}"]\`);`;
		case 'remember':
			return `${n} — состояние в \`setContent\` экрана: \`var ${v.name} by remember { mutableStateOf(…) }\`;`;
		case 'saveable':
			return `${n} — состояние в \`setContent\` экрана: \`var ${v.name} by rememberSaveable { mutableStateOf(…) }\`;`;
		case 'singleton':
			return `${n} — поле объекта-одиночки \`object SessionCache\`;`;
		case 'prefs':
			return `${n} — в \`SharedPreferences\`: экран записывает его через \`edit().put…(…).commit()\` и читает в \`onCreate\`;`;
		case 'file':
			return `${n} — в файле \`filesDir/${v.name}.json\`: экран записывает его сразу после ввода и читает в \`onCreate\`;`;
	}
}

function eventText(e: EventKind, screen: string): string {
	switch (e) {
		case 'rotate':
			return 'Пользователь поворачивает телефон (меняются `orientation` и `screenSize`).';
		case 'rotateHandled':
			return 'Пользователь поворачивает телефон (меняются `orientation` и `screenSize`).';
		case 'theme':
			return 'Пользователь включает тёмную тему в шторке быстрых настроек (меняется `uiMode`).';
		case 'home':
			return 'Пользователь нажимает «Домой» и через минуту возвращается в приложение из списка недавних; процесс всё это время жив.';
		case 'death':
			return 'Пользователь нажимает «Домой»; пока приложение в фоне, система завершает его процесс, чтобы освободить память; пользователь возвращается в приложение из списка недавних.';
		case 'close':
			return `Пользователь нажимает «Назад» — \`${screen}\` закрывается; затем он снова открывает \`${screen}\` с главного экрана.`;
		case 'finish':
			return `Пользователь нажимает «Готово» — экран вызывает \`finish()\`; затем пользователь снова открывает \`${screen}\` с главного экрана.`;
		case 'swipe':
			return `Пользователь смахивает приложение из списка недавних (задача удаляется, процесс завершается), затем запускает приложение значком и открывает \`${screen}\` с главного экрана.`;
	}
}

function enterText(names: readonly string[]): string {
	const list = names.map((n) => `\`${n}\``).join(' и ');
	return `Пользователь заново вводит на экране ${names.length > 1 ? 'значения' : 'значение'} ${list}; экран хранит ${names.length > 1 ? 'их' : 'его'} там же, где описано выше.`;
}

function describe(s: Scenario): string {
	const manifest = s.declared
		? `В манифесте у \`${s.screen}Activity\` объявлено \`android:configChanges="${s.declared}"\`.`
		: `В манифесте у \`${s.screen}Activity\` атрибута \`android:configChanges\` нет.`;
	const compose = s.values.some((v) => v.kind === 'remember' || v.kind === 'saveable');
	return [
		'Ответ — по документации Android (жизненный цикл Activity, ViewModel, сохранение состояния интерфейса; API 34), а не по поведению конкретного устройства.',
		'',
		`Экран \`${s.screen}\` — Activity${compose ? ' с интерфейсом на Compose' : ''}, которую открывают с главного экрана приложения; «Назад» закрывает её. ${manifest} Пользователь ввёл на экране значения, и экран хранит их так:`,
		'',
		...s.values
			.map((v) => `- ${storage(v, s.screen)}`)
			.map((line, i, all) => (i === all.length - 1 ? `${line.slice(0, -1)}.` : line)),
		'',
		'Затем по порядку:',
		'',
		...s.steps.map(
			(step, i) => `${i + 1}. ${'enter' in step ? enterText(step.enter) : eventText(step.event, s.screen)}`
		),
		'',
		`Какие значения \`${s.screen}\` после этого показывает такими, какими их последний раз ввёл пользователь (а не начальными)? Введите их имена по одному в строке, порядок не важен; если таких нет — одну строку \`-\`.`
	].join('\n');
}

/**
 * The independent reference: a value lives in one layer — the Activity object, the ViewModel store, the saved state
 * of the task, the process, the disk — and an event tears down some of the layers; a value survives when no event
 * tore its layer down.
 */
const PYTHON_REFERENCE = `import json

d = json.loads(input())
LAYER = {
    "field": "activity", "remember": "activity",
    "viewModel": "store",
    "bundle": "saved", "handle": "saved", "saveable": "saved",
    "singleton": "process",
    "prefs": "disk", "file": "disk",
}
TEARS = {
    "home": set(),
    "rotateHandled": set(),
    "rotate": {"activity"},
    "theme": {"activity"},
    "death": {"activity", "store", "process"},
    "close": {"activity", "store", "saved"},
    "finish": {"activity", "store", "saved"},
    "swipe": {"activity", "store", "saved", "process"},
}
alive = {v["name"] for v in d["values"]}
for step in d["steps"]:
    if "enter" in step:
        alive |= set(step["enter"])
    else:
        torn = TEARS[step["event"]]
        alive -= {v["name"] for v in d["values"] if LAYER[v["kind"]] in torn}
alive = sorted(alive)
print("\\n".join(alive) if alive else "-")
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const plan = PLANS[`${input.grade}/${input.classId}`];
	if (!plan) throw new Error(`${descriptor.key}: no plan for ${input.grade}/${input.classId}`);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until some value survives, some is lost, and every misconception of the class shows.
	for (let tries = 0; tries < 200; tries += 1) {
		const s = scenario(rng, plan);
		const answer = survivors(s);
		if (answer.length === 0 || answer.length === s.values.length) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, belief]) => {
				const value = survivors(s, belief);
				const same = value.length === answer.length && value.every((v, i) => v === answer[i]);
				return [id, same ? null : value];
			})
		);
		if (plan.required.some((id) => wrong[id] === null)) continue;
		if (plan.requiredAny && plan.requiredAny.every((id) => wrong[id] === null)) continue;
		const matters = (event: EventKind): boolean => {
			const without = survivors(
				s,
				undefined,
				s.steps.filter((step) => !('event' in step) || step.event !== event)
			);
			return without.length !== answer.length || without.some((v, i) => v !== answer[i]);
		};
		if (plan.essential && !plan.essential.every(matters)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: null },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ values: s.values, steps: s.steps })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null
							? null
							: { kind: 'answer' as const, answer: { kind: 'set' as const, value: value.length ? value : ['-'] } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
