// Scopes of Hilt: how many instances of each class a scenario of screens creates (open, rotate, open a second screen,
// go back), and which dependency breaks the graph when a binding reaches a scope its component cannot see. The shape
// of the scenario and of the graph is the essential class; names and the exact edges are surface.
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

type Scope = 'singleton' | 'retained' | 'activity' | 'viewmodel' | 'none';

interface Binding {
	name: string;
	scope: Scope;
	deps: string[];
}

interface Screen {
	activity: string;
	viewModel: string;
	fields: string[];
	ctor: string[];
}

type Step = { kind: 'open'; screen: number } | { kind: 'rotate' } | { kind: 'back' };

interface Scenario {
	bindings: Binding[];
	screens: Screen[];
	steps: Step[];
}

interface Rules {
	retainedRecreated: boolean;
	activitySurvivesRotation: boolean;
	unscopedPerComponent: boolean;
	viewModelRecreated: boolean;
	retainedShared: boolean;
	vmUnderActivity: boolean;
	blameIntermediate: boolean;
}

const RIGHT: Rules = {
	retainedRecreated: false,
	activitySurvivesRotation: false,
	unscopedPerComponent: false,
	viewModelRecreated: false,
	retainedShared: false,
	vmUnderActivity: false,
	blameIntermediate: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'retained-recreated': { retainedRecreated: true },
	'activity-survives-rotation': { activitySurvivesRotation: true },
	'unscoped-per-component': { unscopedPerComponent: true },
	'viewmodel-recreated': { viewModelRecreated: true },
	'retained-shared': { retainedShared: true },
	'vm-under-activity': { vmUnderActivity: true },
	'blame-intermediate': { blameIntermediate: true }
};

const NAMES: Record<Scope, readonly string[]> = {
	singleton: ['ApiClient', 'AppDatabase', 'TokenStore', 'AnalyticsTracker', 'ImageCache'],
	retained: ['SessionCache', 'CheckoutDraft', 'FlowCoordinator', 'SearchHistory'],
	activity: ['Navigator', 'PermissionRequester', 'ScreenTracker', 'DialogController'],
	viewmodel: ['FormValidator', 'OrderEditor', 'SearchPager', 'FilterState'],
	none: ['PriceFormatter', 'DateMapper', 'EventLogger', 'ErrorMapper', 'ItemMapper', 'UrlBuilder']
};

const ANNOTATION: Record<Scope, string> = {
	singleton: '@Singleton ',
	retained: '@ActivityRetainedScoped ',
	activity: '@ActivityScoped ',
	viewmodel: '@ViewModelScoped ',
	none: ''
};

/** The scopes a component of a kind sees: its own and those of its ancestors. */
function sees(kind: Scope, rules: Rules): readonly Scope[] {
	switch (kind) {
		case 'singleton':
			return ['singleton'];
		case 'retained':
			return ['retained', 'singleton'];
		case 'activity':
			return ['activity', 'retained', 'singleton'];
		case 'viewmodel':
			return rules.vmUnderActivity
				? ['viewmodel', 'activity', 'retained', 'singleton']
				: ['viewmodel', 'retained', 'singleton'];
		case 'none':
			throw new Error('an unscoped binding has no component');
	}
}

/** Every dependency the graph cannot satisfy, as `owner dep`; the owner is the nearest scoped class or the root. */
function graphErrors(s: Scenario, rules: Rules): string[] {
	const byName = new Map(s.bindings.map((b) => [b.name, b]));
	const errors = new Set<string>();
	const visit = (name: string, kind: Scope, owner: string, direct: string): void => {
		const b = byName.get(name) as Binding;
		if (b.scope === 'none') {
			for (const d of b.deps) visit(d, kind, owner, b.name);
			return;
		}
		if (!sees(kind, rules).includes(b.scope)) {
			errors.add(`${rules.blameIntermediate ? direct : owner} ${b.name}`);
			return;
		}
		for (const d of b.deps) visit(d, b.scope, b.name, b.name);
	};
	for (const screen of s.screens) {
		for (const f of screen.fields) visit(f, 'activity', screen.activity, screen.activity);
		for (const c of screen.ctor) visit(c, 'viewmodel', screen.viewModel, screen.viewModel);
	}
	return [...errors].sort();
}

interface Component {
	kind: Scope;
	parent: Component | null;
	held: Map<string, true>;
}

const component = (kind: Scope, parent: Component | null): Component => ({ kind, parent, held: new Map() });

/** Instances created by the scenario, by class, in the order of the bindings. */
function countInstances(s: Scenario, rules: Rules): number[] {
	const byName = new Map(s.bindings.map((b) => [b.name, b]));
	const counts = new Map(s.bindings.map((b) => [b.name, 0]));
	const resolve = (name: string, from: Component): void => {
		const b = byName.get(name) as Binding;
		let holder: Component | null = null;
		if (b.scope === 'none') holder = rules.unscopedPerComponent ? from : null;
		else {
			for (let c: Component | null = from; c; c = c.parent) if (c.kind === b.scope) holder = c;
			if (!holder) throw new Error(`${name} is not visible from ${from.kind}`);
		}
		if (holder?.held.has(name)) return;
		holder?.held.set(name, true);
		counts.set(name, (counts.get(name) ?? 0) + 1);
		for (const d of b.deps) resolve(d, holder ?? from);
	};
	const app = component('singleton', null);
	const sharedRetained = component('retained', app);
	interface Entry {
		screen: Screen;
		retained: Component;
		activity: Component;
		viewModel: Component;
	}
	const stack: Entry[] = [];
	const createViewModel = (e: Entry): void => {
		e.viewModel = component('viewmodel', rules.vmUnderActivity ? e.activity : e.retained);
		for (const c of e.screen.ctor) resolve(c, e.viewModel);
	};
	const createActivity = (e: Entry): void => {
		for (const f of e.screen.fields) resolve(f, e.activity);
	};
	for (const step of s.steps) {
		if (step.kind === 'open') {
			const screen = s.screens[step.screen] as Screen;
			const retained = rules.retainedShared ? sharedRetained : component('retained', app);
			const e: Entry = { screen, retained, activity: component('activity', retained), viewModel: app };
			stack.push(e);
			createActivity(e);
			createViewModel(e);
		} else if (step.kind === 'rotate') {
			const e = stack.at(-1) as Entry;
			if (rules.retainedRecreated) e.retained = component('retained', app);
			if (!rules.activitySurvivesRotation) e.activity = component('activity', e.retained);
			createActivity(e);
			if (rules.viewModelRecreated) createViewModel(e);
		} else stack.pop();
	}
	return s.bindings.map((b) => counts.get(b.name) ?? 0);
}

function solve(s: Scenario, rules: Rules): string {
	const errors = graphErrors(s, rules);
	if (errors.length > 0) return `error ${errors.join(' ')}`;
	return countInstances(s, rules).join(' ');
}

/** Bindings: one per scope plus one or two unscoped, dependencies drawn freely (the class checks the result). */
function bindings(rng: Rng): Binding[] {
	const scopes: Scope[] = [
		'singleton',
		'retained',
		'activity',
		'viewmodel',
		'none',
		...(rng.bool() ? ['none' as const] : [])
	];
	const names = new Map<Scope, string[]>(
		(Object.keys(NAMES) as Scope[]).map((k) => [k, rng.sample(NAMES[k], k === 'none' ? 2 : 1)])
	);
	const list: Binding[] = scopes.map((scope) => ({
		name: (names.get(scope) as string[]).shift() as string,
		scope,
		deps: []
	}));
	// Dependencies go only to bindings later in a random order: the graph is acyclic.
	const order = rng.shuffle(list);
	for (const [i, b] of order.entries()) {
		const later = order.slice(i + 1);
		if (later.length === 0) continue;
		b.deps = rng.sample(later, Math.min(later.length, rng.int(0, 2))).map((d) => d.name);
	}
	return list;
}

const SCREENS = [
	['MainActivity', 'MainViewModel'],
	['CatalogActivity', 'CatalogViewModel'],
	['DetailsActivity', 'DetailsViewModel'],
	['CartActivity', 'CartViewModel'],
	['ProfileActivity', 'ProfileViewModel']
] as const;

function screens(rng: Rng, list: Binding[], count: number): Screen[] {
	const forActivity = list.filter((b) => b.scope !== 'viewmodel').map((b) => b.name);
	const forViewModel = list.filter((b) => b.scope !== 'activity').map((b) => b.name);
	const [first, second] = rng.sample(SCREENS, 2) as [readonly [string, string], readonly [string, string]];
	return [first, second].slice(0, count).map(([activity, viewModel]) => ({
		activity,
		viewModel,
		fields: rng.sample(forActivity, rng.int(1, 3)),
		ctor: rng.sample(forViewModel, rng.int(1, 3))
	}));
}

function steps(rng: Rng, classId: string): Step[] {
	const rotations = (n: number): Step[] => Array.from({ length: n }, () => ({ kind: 'rotate' as const }));
	if (classId === 'rotation') {
		return [
			{ kind: 'open', screen: 0 },
			...rotations(rng.int(1, 3)),
			{ kind: 'open', screen: 1 },
			...rotations(rng.int(0, 1))
		];
	}
	if (classId === 'two-screens') {
		const s: Step[] = [
			{ kind: 'open', screen: 0 },
			{ kind: 'open', screen: 1 },
			{ kind: 'back' },
			{ kind: 'open', screen: 1 }
		];
		if (rng.bool()) s.push({ kind: 'back' }, { kind: 'open', screen: 1 });
		return s;
	}
	return [
		{ kind: 'open', screen: 0 },
		...rotations(rng.int(1, 2)),
		{ kind: 'open', screen: 1 },
		{ kind: 'back' },
		{ kind: 'open', screen: 1 },
		...rotations(1)
	];
}

/** A dependency added to a valid graph that no component can satisfy. */
function breakGraph(rng: Rng, s: Scenario): void {
	const of = (scope: Scope): Binding[] => s.bindings.filter((b) => b.scope === scope);
	const activity = of('activity')[0] as Binding;
	const kind = rng.int(0, 2);
	if (kind === 0) {
		// A ViewModel (or a ViewModel-scoped class) asks for an Activity-scoped one: a sibling component.
		const vmScoped = of('viewmodel')[0] as Binding;
		if (rng.bool()) vmScoped.deps.push(activity.name);
		else (s.screens[0] as Screen).ctor.push(activity.name);
		return;
	}
	// A wide binding reaches a narrow one through an unscoped class.
	const via = rng.pick(of('none'));
	const wide = rng.pick([...of('singleton'), ...of('retained')]);
	const narrow = rng.pick([activity, ...of('viewmodel')]);
	if (!via.deps.includes(narrow.name)) via.deps.push(narrow.name);
	if (!wide.deps.includes(via.name)) wide.deps.push(via.name);
	if (kind === 2 && !(s.screens[0] as Screen).fields.includes(wide.name))
		(s.screens[0] as Screen).fields.push(wide.name);
}

function acyclic(list: Binding[]): boolean {
	const byName = new Map(list.map((b) => [b.name, b]));
	const state = new Map<string, number>();
	const visit = (name: string): boolean => {
		if (state.get(name) === 2) return true;
		if (state.get(name) === 1) return false;
		state.set(name, 1);
		const ok = (byName.get(name) as Binding).deps.every(visit);
		state.set(name, 2);
		return ok;
	};
	return list.every((b) => visit(b.name));
}

function scenario(rng: Rng, classId: string): Scenario {
	const list = bindings(rng);
	const s: Scenario = { bindings: list, screens: screens(rng, list, 2), steps: steps(rng, classId) };
	if (classId === 'scope-error') breakGraph(rng, s);
	return s;
}

function renderCode(s: Scenario): string {
	const param = (d: string): string => `private val ${d.charAt(0).toLowerCase()}${d.slice(1)}: ${d}`;
	// One parameter stays on the line of the class; two or more go one per line.
	const ctor = (deps: readonly string[]): string =>
		deps.length === 0
			? '()'
			: deps.length === 1
				? `(${param(deps[0] as string)})`
				: `(\n${deps.map((d) => `    ${param(d)},`).join('\n')}\n)`;
	const lines: string[] = [];
	for (const b of s.bindings) lines.push(`${ANNOTATION[b.scope]}class ${b.name} @Inject constructor${ctor(b.deps)}`);
	for (const screen of s.screens) {
		lines.push(
			'',
			'@HiltViewModel',
			`class ${screen.viewModel} @Inject constructor${ctor(screen.ctor)} : ViewModel()`,
			'',
			'@AndroidEntryPoint',
			`class ${screen.activity} : AppCompatActivity() {`,
			...screen.fields.map((f) => `    @Inject lateinit var ${f.charAt(0).toLowerCase()}${f.slice(1)}: ${f}`),
			`    private val viewModel: ${screen.viewModel} by viewModels()`,
			'',
			'    override fun onCreate(savedInstanceState: Bundle?) {',
			'        super.onCreate(savedInstanceState)',
			'        viewModel.hashCode() // ViewModel запрашивается в onCreate',
			'    }',
			'}'
		);
	}
	return lines.join('\n');
}

function describe(s: Scenario): string {
	const steps = s.steps.map((step, i) => {
		const n = `${i + 1}. `;
		if (step.kind === 'open')
			return i === 0
				? `${n}Приложение запускается, открывается \`${(s.screens[step.screen] as Screen).activity}\`.`
				: `${n}Поверх текущего экрана открывается \`${(s.screens[step.screen] as Screen).activity}\`.`;
		if (step.kind === 'rotate')
			return `${n}Пользователь поворачивает устройство на верхнем экране (смена конфигурации обрабатывается по умолчанию).`;
		return `${n}Пользователь нажимает «Назад»: верхний экран завершается.`;
	});
	return [
		'Приложение на Hilt; код классов — под условием. Считайте по документированной модели компонентов и скоупов Hilt (не на устройстве): классы с `@Inject`-конструктором создаются лениво, при первом запросе; поля Activity внедряются при каждом `onCreate`; `Lazy` и `Provider` не используются.',
		'',
		'Сценарий (процесс приложения не убивается):',
		'',
		...steps,
		'',
		`Сколько экземпляров каждого из классов ${s.bindings.map((b) => `\`${b.name}\``).join(', ')} будет создано за весь сценарий?`,
		'',
		'Введите числа через пробел в этом порядке классов. Если Hilt не соберёт граф зависимостей, введите вместо чисел `error`, затем через пробел класс, для которого зависимость недоступна (ближайший класс с аннотацией скоупа, `ViewModel` или `Activity`, куда она внедряется, если между ними только классы без скоупа), и саму недоступную зависимость. Например: `2 1 0 3 1` или `error CartViewModel Navigator`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
B = {b["name"]: b for b in p["bindings"]}
PARENT = {"singleton": None, "retained": "singleton", "activity": "retained", "viewmodel": "retained"}

def ancestors(kind):
    out = []
    while kind is not None:
        out.append(kind)
        kind = PARENT[kind]
    return out

# Compile-time check: walk every injection root, unscoped classes are resolved in the component that asks.
errors = set()
def walk(name, kind, owner):
    b = B[name]
    if b["scope"] == "none":
        for d in b["deps"]:
            walk(d, kind, owner)
    elif b["scope"] not in ancestors(kind):
        errors.add(owner + " " + name)
    else:
        for d in b["deps"]:
            walk(d, b["scope"], name)

for sc in p["screens"]:
    for f in sc["fields"]:
        walk(f, "activity", sc["activity"])
    for c in sc["ctor"]:
        walk(c, "viewmodel", sc["viewModel"])

if errors:
    print("error " + " ".join(sorted(errors)))
else:
    created = {name: 0 for name in B}
    # A component is a dict of the instances it holds plus its kind and parent.
    def new(kind, parent):
        return {"kind": kind, "parent": parent, "held": set()}
    def get(name, comp):
        b = B[name]
        if b["scope"] == "none":
            created[name] += 1
            for d in b["deps"]:
                get(d, comp)
            return
        c = comp
        while c["kind"] != b["scope"]:
            c = c["parent"]
        if name in c["held"]:
            return
        c["held"].add(name)
        created[name] += 1
        for d in b["deps"]:
            get(d, c)
    app = new("singleton", None)
    stack = []
    for st in p["steps"]:
        if st["kind"] == "open":
            sc = p["screens"][st["screen"]]
            retained = new("retained", app)
            act = new("activity", retained)
            for f in sc["fields"]:
                get(f, act)
            vm = new("viewmodel", retained)
            for c in sc["ctor"]:
                get(c, vm)
            stack.append([sc, retained])
        elif st["kind"] == "rotate":
            sc, retained = stack[-1]
            act = new("activity", retained)
            for f in sc["fields"]:
                get(f, act)
        else:
            stack.pop()
    print(" ".join(str(created[b["name"]]) for b in p["bindings"]))
`;

/** The misconceptions every instance of a class must expose; `scope-error` needs one of its two. */
const REQUIRED: Record<string, string[]> = {
	rotation: ['retained-recreated', 'activity-survives-rotation', 'viewmodel-recreated'],
	'two-screens': ['retained-shared', 'unscoped-per-component'],
	'mixed-lifetimes': ['unscoped-per-component', 'retained-recreated', 'viewmodel-recreated']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const isError = input.classId === 'scope-error';
	for (let tries = 0; tries < 1000; tries += 1) {
		const s = scenario(rng, input.classId);
		if (!acyclic(s.bindings)) continue;
		const errors = graphErrors(s, RIGHT);
		if (errors.length !== (isError ? 1 : 0)) continue;
		const answer = solve(s, RIGHT);
		// Every class is created at least once in a counting scenario: a class nobody asks for is noise.
		if (!isError && answer.split(' ').includes('0')) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(s, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (
			isError
				? wrong['vm-under-activity'] === null && wrong['blame-intermediate'] === null
				: (REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)
		)
			continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: renderCode(s) } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(s) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
