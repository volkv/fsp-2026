// Fragment callbacks together with the host activity: replace with and without addToBackStack, add on top, Back,
// leaving for the background, rotation with fragments on the back stack, a fragment re-added in onCreate without the
// savedInstanceState check, and a LiveData observer bound to the fragment instead of its view. The callbacks of each
// fragment follow the Android documentation (Fragment lifecycle, Fragment manager); the order between the host and
// the fragments and between several fragments is the model's convention, stated in the item.
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

type Op =
	| { kind: 'replace' | 'add'; fragment: string; backStack: boolean }
	| { kind: 'back' }
	| { kind: 'home'; setWhileAway: number | null }
	| { kind: 'dialog' }
	| { kind: 'rotate' }
	| { kind: 'set'; value: number };

interface Scenario {
	activity: string;
	first: string;
	ops: Op[];
	/** The activity adds the first fragment in onCreate without checking savedInstanceState. */
	addsInOnCreate: boolean;
	/** LiveData observed by the first fragment in onViewCreated: with the fragment or with its view as the owner. */
	observer: 'this' | 'view' | null;
	initialValue: number;
	/** Junior — every callback of the first fragment and of the activity; middle — four callbacks of every fragment. */
	log: 'first' | 'four';
}

interface Rules {
	backstackDestroys: boolean;
	backstackKeepsView: boolean;
	noBackstackKeeps: boolean;
	addStopsBelow: boolean;
	hostFirstDown: boolean;
	ownerIgnored: boolean;
	inactiveReceives: boolean;
	noRedelivery: boolean;
	rotationSkipsBackstack: boolean;
	rotationBackstackView: boolean;
	noDuplicateOnRestore: boolean;
}

const RIGHT: Rules = {
	backstackDestroys: false,
	backstackKeepsView: false,
	noBackstackKeeps: false,
	addStopsBelow: false,
	hostFirstDown: false,
	ownerIgnored: false,
	inactiveReceives: false,
	noRedelivery: false,
	rotationSkipsBackstack: false,
	rotationBackstackView: false,
	noDuplicateOnRestore: false
};

/** Fragment states: 0 — none, 1 — CREATED (no view), 2 — view created, 3 — STARTED, 4 — RESUMED. */
const UP: Record<number, readonly string[]> = {
	1: ['onAttach', 'onCreate'],
	2: ['onCreateView', 'onViewCreated', 'onViewStateRestored'],
	3: ['onStart'],
	4: ['onResume']
};
const DOWN: Record<number, readonly string[]> = {
	4: ['onPause'],
	3: ['onStop'],
	2: ['onDestroyView'],
	1: ['onDestroy', 'onDetach']
};
const FOUR = new Set(['onCreate', 'onCreateView', 'onDestroyView', 'onDestroy']);

interface Frag {
	id: number;
	name: string;
	state: number;
	/** The state the fragment returns to with its host: 4 in the container, 1 on the back stack. */
	target: number;
}

interface Observer {
	owner: 'this' | 'view';
	lastVersion: number;
}

class World {
	readonly log: string[] = [];
	container: Frag[] = [];
	/** Fragments removed with addToBackStack, in the order they got there. */
	held: Frag[] = [];
	entries: { removed: Frag[]; added: Frag[] }[] = [];
	nextId = 1;
	observers: Observer[] = [];
	version = 0;
	value: number;
	firstId = 0;

	readonly s: Scenario;
	readonly rules: Rules;

	constructor(s: Scenario, rules: Rules) {
		this.s = s;
		this.rules = rules;
		this.value = s.initialValue;
	}

	host(callback: string): void {
		if (this.s.log === 'first' && this.s.observer === null) this.log.push(`${this.s.activity}Activity.${callback}`);
	}

	emit(f: Frag, callback: string): void {
		if (this.s.observer !== null) return;
		if (this.s.log === 'first' ? f.id === this.firstId : FOUR.has(callback)) this.log.push(`${f.name}.${callback}`);
	}

	fresh(name: string): Frag {
		const f = { id: this.nextId, name, state: 0, target: 4 };
		this.nextId += 1;
		return f;
	}

	/** Moves a fragment step by step, with the LiveData hooks of the observing fragment. */
	move(f: Frag, to: number): void {
		while (f.state < to) {
			const next = f.state + 1;
			for (const cb of UP[next] ?? []) this.emit(f, cb);
			f.state = next;
			if (f.id === this.firstId && this.s.observer) {
				if (next === 2) this.observers.push({ owner: this.ownerOf(), lastVersion: -1 });
				if (next === 3) this.activate();
			}
		}
		while (f.state > to) {
			for (const cb of DOWN[f.state] ?? []) this.emit(f, cb);
			f.state -= 1;
			if (f.id === this.firstId && this.s.observer) {
				if (f.state === 1) this.observers = this.observers.filter((o) => o.owner !== 'view');
				if (f.state === 0) this.observers = [];
			}
		}
	}

	ownerOf(): 'this' | 'view' {
		return this.rules.ownerIgnored ? 'view' : (this.s.observer ?? 'view');
	}

	firstActive(): boolean {
		return (this.container.find((f) => f.id === this.firstId)?.state ?? 0) >= 3;
	}

	activate(): void {
		for (const o of this.observers) {
			if (o.lastVersion >= this.version) continue;
			if (this.rules.noRedelivery && o.lastVersion >= 0) {
				o.lastVersion = this.version;
				continue;
			}
			o.lastVersion = this.version;
			this.log.push(String(this.value));
		}
	}

	set(value: number): void {
		this.value = value;
		this.version += 1;
		if (!this.firstActive() && !this.rules.inactiveReceives) return;
		for (const o of this.observers) {
			o.lastVersion = this.version;
			this.log.push(String(value));
		}
	}

	/** The host goes down to `rank` (3 — paused, 2 — stopped) or comes back up; fragments follow by the convention. */
	hostDown(callback: string, to: number): void {
		if (this.rules.hostFirstDown) this.host(callback);
		for (const f of this.container) if (f.state > to) this.move(f, to);
		if (!this.rules.hostFirstDown) this.host(callback);
	}

	hostUp(callback: string, to: number): void {
		this.host(callback);
		for (const f of this.container) if (f.state < Math.min(to, f.target)) this.move(f, Math.min(to, f.target));
	}
}

function simulate(s: Scenario, rules: Rules): string[] {
	const w = new World(s, rules);
	const first = w.fresh(s.first);
	w.firstId = first.id;
	first.state = 4;
	w.container = [first];
	if (s.observer)
		w.observers = [{ owner: s.observer === 'this' && !rules.ownerIgnored ? 'this' : 'view', lastVersion: 0 }];
	for (const op of s.ops) {
		switch (op.kind) {
			case 'replace': {
				const removed = w.container;
				for (const f of removed) {
					const to = op.backStack
						? rules.backstackDestroys
							? 0
							: rules.backstackKeepsView
								? 2
								: 1
						: rules.noBackstackKeeps
							? 1
							: 0;
					w.move(f, to);
					f.target = to;
				}
				const added = w.fresh(op.fragment);
				w.container = [added];
				w.move(added, 4);
				if (op.backStack) {
					w.held.push(...removed);
					w.entries.push({ removed, added: [added] });
				}
				break;
			}
			case 'add': {
				const below = [...w.container];
				if (rules.addStopsBelow)
					for (const f of below) {
						w.move(f, 2);
						f.target = 2;
					}
				const added = w.fresh(op.fragment);
				w.container.push(added);
				w.move(added, 4);
				if (op.backStack) w.entries.push({ removed: [], added: [added] });
				break;
			}
			case 'back': {
				const entry = w.entries.pop();
				if (!entry) throw new Error('back with an empty back stack');
				for (const f of entry.added) {
					w.move(f, 0);
					w.container = w.container.filter((c) => c !== f);
				}
				for (const f of entry.removed) {
					w.held = w.held.filter((h) => h !== f);
					f.target = 4;
					w.container.push(f);
					w.move(f, 4);
				}
				if (rules.addStopsBelow && entry.removed.length === 0)
					for (const f of w.container) {
						f.target = 4;
						w.move(f, 4);
					}
				break;
			}
			case 'home':
				w.hostDown('onPause', 3);
				w.hostDown('onStop', 2);
				if (op.setWhileAway !== null) w.set(op.setWhileAway);
				w.hostUp('onStart', 3);
				w.hostUp('onResume', 4);
				break;
			case 'dialog':
				w.hostDown('onPause', 3);
				w.hostUp('onResume', 4);
				break;
			case 'set':
				w.set(op.value);
				break;
			case 'rotate':
				rotate(w, rules);
				break;
		}
	}
	return w.log;
}

function rotate(w: World, rules: Rules): void {
	w.hostDown('onPause', 3);
	w.hostDown('onStop', 2);
	const held = rules.rotationSkipsBackstack ? [] : w.held;
	const down = (callback: string | null, frags: Frag[], to: number): void => {
		if (rules.hostFirstDown && callback) w.host(callback);
		for (const f of frags) if (f.state > to) w.move(f, to);
		if (!rules.hostFirstDown && callback) w.host(callback);
	};
	down(null, [...w.container, ...held], 1);
	down('onDestroy', [...w.container, ...held], 0);
	// The new activity: FragmentManager restores the container and the back stack as new instances.
	w.host('onCreate');
	const renew = new Map<Frag, Frag>();
	for (const f of [...w.container, ...held]) {
		if (f.target === 0) continue;
		const g = w.fresh(f.name);
		g.target = f.target;
		renew.set(f, g);
	}
	const map = (f: Frag): Frag => renew.get(f) ?? f;
	w.container = w.container.filter((f) => renew.has(f)).map(map);
	w.held = w.held.map(map);
	w.entries = w.entries.map((e) => ({ removed: e.removed.map(map), added: e.added.map(map) }));
	if (w.s.addsInOnCreate && !rules.noDuplicateOnRestore) w.container.push(w.fresh(w.s.first));
	const created = [...w.container, ...held.map(map)].filter((f) => f.state === 0);
	for (const f of created) w.move(f, 1);
	for (const f of w.container) w.move(f, 2);
	if (rules.rotationBackstackView) for (const f of held.map(map)) w.move(f, 2);
	w.hostUp('onStart', 3);
	w.hostUp('onResume', 4);
}

// ---- scenarios ----

const FRAGMENTS = [
	'Cart',
	'Catalog',
	'Product',
	'Profile',
	'Settings',
	'Search',
	'Orders',
	'Chat',
	'Feed',
	'Details',
	'Map',
	'Wallet'
] as const;
const ACTIVITIES = ['Main', 'Shop', 'Home', 'Root', 'Host', 'Start', 'Nav', 'Store'] as const;

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const names = rng.sample(FRAGMENTS, 6);
	const [first, ...others] = names as [string, ...string[]];
	const s: Scenario = {
		activity: rng.pick(ACTIVITIES),
		first,
		ops: [],
		addsInOnCreate: false,
		observer: null,
		initialValue: rng.int(1, 9),
		log: grade === 'junior' ? 'first' : 'four'
	};
	let pool = [...others];
	const another = (): string => {
		const name = rng.pick(pool);
		pool = pool.filter((n) => n !== name);
		if (pool.length === 0) pool = [...others];
		return name;
	};
	const home = (): Op => (rng.bool(0.35) ? { kind: 'dialog' } : { kind: 'home', setWhileAway: null });
	const ops = s.ops;
	if (grade === 'junior') {
		if (classId === 'replace-back') {
			if (rng.bool(0.5)) ops.push(home());
			ops.push({ kind: 'replace', fragment: another(), backStack: true });
			if (rng.bool(0.4)) ops.push(home());
			ops.push({ kind: 'back' });
			if (rng.bool(0.5)) ops.push(home());
		} else if (classId === 'replace-no-backstack') {
			// Units that never split an add from its Back: the replace without the back stack needs an empty one.
			const units: Op[][] = [];
			for (let i = rng.int(1, 2); i > 0; i -= 1) units.push([home()]);
			if (rng.bool(0.4)) units.push([{ kind: 'add', fragment: another(), backStack: true }, { kind: 'back' }]);
			units.splice(rng.int(0, units.length), 0, [{ kind: 'replace', fragment: another(), backStack: false }]);
			ops.push(...units.flat());
		} else if (classId === 'add-home') {
			ops.push({ kind: 'add', fragment: another(), backStack: true });
			for (let i = rng.int(1, 2); i > 0; i -= 1) ops.push(home());
			if (rng.bool(0.6)) ops.push({ kind: 'back' });
			if (rng.bool(0.5)) ops.unshift(home());
		} else {
			s.observer = rng.pick(['this', 'view'] as const);
			const value = (): number => rng.int(10, 99);
			if (rng.bool(0.5)) ops.push({ kind: 'set', value: value() });
			ops.push({ kind: 'replace', fragment: another(), backStack: true });
			for (let i = rng.int(0, 2); i > 0; i -= 1) ops.push({ kind: 'set', value: value() });
			ops.push({ kind: 'back' });
			const tail = rng.int(1, 2);
			for (let i = 0; i < tail; i += 1)
				ops.push(rng.bool(0.5) ? { kind: 'set', value: value() } : { kind: 'home', setWhileAway: value() });
		}
		return s;
	}
	if (classId === 'replace-chain') {
		let depth = 0;
		let size = 1;
		const count = rng.int(3, 5);
		for (let i = 0; i < count; i += 1) {
			const r = rng.next();
			if (depth > 0 && r < 0.35) {
				ops.push({ kind: 'back' });
				depth -= 1;
				size = 1;
			} else if (r < 0.75 && size === 1) {
				ops.push({ kind: 'replace', fragment: another(), backStack: true });
				depth += 1;
			} else {
				ops.push({ kind: 'add', fragment: another(), backStack: true });
				depth += 1;
				size += 1;
			}
		}
		return { ...s, ops: fixSizes(ops) };
	}
	if (classId === 'rotation-backstack') {
		for (let i = rng.int(1, 2); i > 0; i -= 1) ops.push({ kind: 'replace', fragment: another(), backStack: true });
		ops.push({ kind: 'rotate' });
		ops.push({ kind: 'back' });
		if (rng.bool(0.5)) ops.push({ kind: 'back' });
		return { ...s, ops: ops.filter((op, i) => op.kind !== 'back' || backs(ops.slice(0, i))) };
	}
	if (classId === 'rotation-duplicate') {
		s.addsInOnCreate = true;
		if (rng.bool(0.5)) ops.push({ kind: 'add', fragment: another(), backStack: true });
		ops.push({ kind: 'rotate' });
		if (rng.bool(0.5)) ops.push({ kind: 'rotate' });
		if (ops[0]?.kind === 'add' && rng.bool(0.6)) ops.push({ kind: 'back' });
		return s;
	}
	ops.push({ kind: 'replace', fragment: another(), backStack: false });
	if (rng.bool(0.5)) ops.push({ kind: 'add', fragment: another(), backStack: true });
	ops.push({ kind: 'rotate' });
	if (ops[1]?.kind === 'add' && rng.bool(0.6)) ops.push({ kind: 'back' });
	return s;
}

/** Back presses the back stack still has an entry for. */
function backs(before: readonly Op[]): boolean {
	let depth = 0;
	for (const op of before) {
		if ((op.kind === 'replace' || op.kind === 'add') && op.backStack) depth += 1;
		if (op.kind === 'back') depth -= 1;
	}
	return depth > 0;
}

/** A replace needs exactly one fragment in the container: an add before it is popped first, or the replace becomes an add. */
function fixSizes(ops: Op[]): Op[] {
	const sizes: number[] = [];
	let size = 1;
	return ops.map((op) => {
		if (op.kind === 'replace' && size !== 1) {
			sizes.push(size);
			size += 1;
			return { ...op, kind: 'add' as const };
		}
		if (op.kind === 'replace') sizes.push(size);
		else if (op.kind === 'add') {
			sizes.push(size);
			size += 1;
		} else if (op.kind === 'back') size = sizes.pop() ?? 1;
		return op;
	});
}

// ---- statement ----

function commit(op: Extract<Op, { kind: 'replace' | 'add' }>): string {
	return `\`supportFragmentManager.commit { setReorderingAllowed(true); ${op.kind}<${op.fragment}Fragment>(R.id.container)${op.backStack ? '; addToBackStack(null)' : ''} }\``;
}

function opText(s: Scenario, op: Op): string {
	switch (op.kind) {
		case 'replace':
		case 'add':
			return `выполняется транзакция ${commit(op)};`;
		case 'back':
			return 'пользователь нажимает «Назад» (снимается верхняя транзакция стека возврата фрагментов);';
		case 'home':
			return op.setWhileAway === null
				? 'пользователь сворачивает приложение кнопкой Home и сразу возвращается;'
				: `пользователь сворачивает приложение; пока оно в фоне, ViewModel присваивает \`count.value = ${op.setWhileAway}\`; пользователь возвращается;`;
		case 'dialog':
			return 'поверх открывается полупрозрачная активность-диалог, затем закрывается;';
		case 'rotate':
			return `пользователь поворачивает экран: \`${s.activity}Activity\` пересоздаётся (\`configChanges\` не задан);`;
		case 'set':
			return `ViewModel присваивает \`count.value = ${op.value}\`;`;
	}
}

function renderCode(s: Scenario): string {
	const lines = [
		`class ${s.activity}Activity : AppCompatActivity(R.layout.activity_${s.activity.toLowerCase()}) {`,
		'    override fun onCreate(savedInstanceState: Bundle?) {',
		'        super.onCreate(savedInstanceState)',
		...(s.addsInOnCreate
			? [
					'        supportFragmentManager.commit {',
					'            setReorderingAllowed(true)',
					`            add<${s.first}Fragment>(R.id.container)`,
					'        }'
				]
			: [
					'        if (savedInstanceState == null) {',
					'            supportFragmentManager.commit {',
					'                setReorderingAllowed(true)',
					`                add<${s.first}Fragment>(R.id.container)`,
					'            }',
					'        }'
				]),
		'    }',
		'}'
	];
	if (s.observer) {
		const owner = s.observer === 'this' ? 'this' : 'viewLifecycleOwner';
		lines.push(
			'',
			`class ${s.first}Fragment : Fragment(R.layout.fragment_${s.first.toLowerCase()}) {`,
			'    private val vm: CounterViewModel by activityViewModels()',
			'',
			'    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {',
			'        super.onViewCreated(view, savedInstanceState)',
			`        vm.count.observe(${owner}) { println(it) }`,
			'    }',
			'}'
		);
	}
	return lines.join('\n');
}

function describe(s: Scenario): string {
	const model = [
		'По модели жизненного цикла из документации Android (Fragment lifecycle, Fragment manager; androidx.fragment 1.8; не на устройстве) с такими соглашениями о порядке:',
		'',
		'- фрагмент поднимается шагами: `onAttach`, `onCreate` → `onCreateView`, `onViewCreated`, `onViewStateRestored` → `onStart` → `onResume`; опускается: `onPause` → `onStop` → `onDestroyView` → `onDestroy`, `onDetach`;',
		'- при подъёме сначала колбэк активности, затем фрагментов; при спуске — сначала фрагментов, затем активности (фрагмент не бывает в состоянии выше хозяина);',
		'- в транзакции и при «Назад» сначала удаляемые фрагменты проходят все свои колбэки, затем добавляемые;',
		'- при пересоздании активности каждый шаг проходят все фрагменты, прежде чем начнётся следующий, в таком порядке: фрагменты контейнера в порядке добавления (фрагмент, добавленный транзакцией в `onCreate` новой активности, — после восстановленных), затем фрагменты стека возврата в порядке попадания туда.'
	];
	const start =
		s.observer === null
			? `Сейчас \`${s.activity}Activity\` на экране (RESUMED), в контейнере — \`${s.first}Fragment\`, стек возврата фрагментов пуст. Код активности ниже. Дальше по очереди:`
			: `Сейчас \`${s.activity}Activity\` на экране, в контейнере — \`${s.first}Fragment\` (код ниже), стек возврата фрагментов пуст; \`count\` — \`MutableLiveData<Int>\` общей ViewModel активности, равен ${s.initialValue}, и наблюдатель уже напечатал это значение. Дальше по очереди:`;
	const steps = s.ops.map((op, i) => `${i + 1}. ${opText(s, op)}`);
	const ask =
		s.observer !== null
			? 'Что напечатает `println` из `observe` после этого момента? Введите числа по одному в строке в порядке печати; если ничего — `-`.'
			: s.log === 'first'
				? `Выпишите по порядку колбэки \`${s.first}Fragment\` (только этого экземпляра) и \`${s.activity}Activity\`, по одному в строке в виде \`${s.first}.onPause\` или \`${s.activity}Activity.onStop\`; если колбэков не было — \`-\`.`
				: 'Выпишите по порядку только колбэки `onCreate`, `onCreateView`, `onDestroyView` и `onDestroy` всех фрагментов, по одному в строке в виде `Cart.onCreateView` (имя класса без суффикса `Fragment`); колбэки активности не выписывайте.';
	return [...model, '', start, '', ...steps, '', ask].join('\n');
}

// ---- reference ----

const PYTHON_REFERENCE = `import json

s = json.loads(input())
CB = ["onAttach", "onCreate", "onCreateView", "onViewCreated", "onViewStateRestored", "onStart", "onResume"]
# callbacks between states: index ranges in CB (going up) or their mirrors (going down)
UP_AT = {1: (0, 2), 2: (2, 5), 3: (5, 6), 4: (6, 7)}
DOWN_NAMES = {4: ["onPause"], 3: ["onStop"], 2: ["onDestroyView"], 1: ["onDestroy", "onDetach"]}
FOUR = {"onCreate", "onCreateView", "onDestroyView", "onDestroy"}
act = s["activity"] + "Activity"
out = []
frags = {}   # id -> [name, state, home_state]
order = []   # container ids in order
held = []    # back stack ids in arrival order
stack = []   # entries: (removed ids, added ids)
nid = [0]
obs = []     # observers: [owner, seen_version]
data = {"v": s["initialValue"], "ver": 0}
FIRST = 0


def new(name):
    i = nid[0]
    nid[0] += 1
    frags[i] = [name, 0, 4]
    return i


def log_frag(i, cb):
    if s["observer"] is not None:
        return
    if s["log"] == "first":
        if i == FIRST:
            out.append(frags[i][0] + "." + cb)
    elif cb in FOUR:
        out.append(frags[i][0] + "." + cb)


def log_act(cb):
    if s["log"] == "first" and s["observer"] is None:
        out.append(act + "." + cb)


def deliver(o):
    o[1] = data["ver"]
    out.append(str(data["v"]))


def go(i, to):
    f = frags[i]
    while f[1] < to:
        nxt = f[1] + 1
        a, b = UP_AT[nxt]
        for cb in CB[a:b]:
            log_frag(i, cb)
        f[1] = nxt
        if i == FIRST and s["observer"] is not None:
            if nxt == 2:
                obs.append([s["observer"], -1])
            if nxt == 3:
                for o in obs:
                    if o[1] < data["ver"]:
                        deliver(o)
    while f[1] > to:
        for cb in DOWN_NAMES[f[1]]:
            log_frag(i, cb)
        f[1] -= 1
        if i == FIRST and s["observer"] is not None:
            if f[1] == 1:
                obs[:] = [o for o in obs if o[0] != "view"]
            if f[1] == 0:
                obs.clear()


def assign(v):
    data["v"] = v
    data["ver"] += 1
    if FIRST in order and frags[FIRST][1] >= 3:
        for o in obs:
            deliver(o)


def host_down(cb, to):
    for i in order:
        if frags[i][1] > to:
            go(i, to)
    log_act(cb)


def host_up(cb, to):
    log_act(cb)
    for i in order:
        go(i, min(to, frags[i][2]))


FIRST = new(s["first"])
frags[FIRST][1] = 4
order.append(FIRST)
if s["observer"] is not None:
    obs.append([s["observer"], 0])

for op in s["ops"]:
    k = op["kind"]
    if k == "replace":
        gone = list(order)
        for i in gone:
            go(i, 1 if op["backStack"] else 0)
            frags[i][2] = 1
        n = new(op["fragment"])
        order[:] = [n]
        go(n, 4)
        if op["backStack"]:
            held.extend(gone)
            stack.append((gone, [n]))
    elif k == "add":
        n = new(op["fragment"])
        order.append(n)
        go(n, 4)
        if op["backStack"]:
            stack.append(([], [n]))
    elif k == "back":
        gone, came = stack.pop()
        for i in came:
            go(i, 0)
            order.remove(i)
        for i in gone:
            held.remove(i)
            frags[i][2] = 4
            order.append(i)
            go(i, 4)
    elif k == "home":
        host_down("onPause", 3)
        host_down("onStop", 2)
        if op["setWhileAway"] is not None:
            assign(op["setWhileAway"])
        host_up("onStart", 3)
        host_up("onResume", 4)
    elif k == "dialog":
        host_down("onPause", 3)
        host_up("onResume", 4)
    elif k == "set":
        assign(op["value"])
    elif k == "rotate":
        host_down("onPause", 3)
        host_down("onStop", 2)
        every = order + held
        for i in every:
            go(i, 1)
        for i in every:
            go(i, 0)
        log_act("onDestroy")
        log_act("onCreate")
        again = {}
        for i in every:
            again[i] = new(frags[i][0])
            frags[again[i]][2] = frags[i][2]
        order[:] = [again[i] for i in order]
        held[:] = [again[i] for i in held]
        stack[:] = [([again[i] for i in g], [again[i] for i in c]) for g, c in stack]
        if s["addsInOnCreate"]:
            order.append(new(s["first"]))
        for i in order + held:
            go(i, 1)
        for i in order:
            go(i, 2)
        host_up("onStart", 3)
        host_up("onResume", 4)
print("\\n".join(out) if out else "-")
`;

// ---- build ----

const WRONG: Record<string, Partial<Rules>> = {
	'backstack-destroys': { backstackDestroys: true },
	'backstack-keeps-view': { backstackKeepsView: true },
	'no-backstack-keeps': { noBackstackKeeps: true },
	'add-stops-below': { addStopsBelow: true },
	'host-first-down': { hostFirstDown: true },
	'owner-ignored': { ownerIgnored: true },
	'inactive-receives': { inactiveReceives: true },
	'no-redelivery': { noRedelivery: true },
	'rotation-skips-backstack': { rotationSkipsBackstack: true },
	'rotation-backstack-view': { rotationBackstackView: true },
	'no-duplicate-on-restore': { noDuplicateOnRestore: true }
};

/** The misconceptions every instance of a class must expose. */
function required(grade: string, classId: string, s: Scenario): string[] {
	switch (`${grade}/${classId}`) {
		case 'junior/replace-back':
			return ['backstack-destroys', 'backstack-keeps-view'];
		case 'junior/replace-no-backstack':
			return ['no-backstack-keeps'];
		case 'junior/add-home':
			return ['add-stops-below', 'host-first-down'];
		case 'junior/observer-owner':
			return s.observer === 'this' ? ['owner-ignored', 'inactive-receives'] : ['inactive-receives'];
		case 'middle/replace-chain':
			return ['backstack-destroys', 'backstack-keeps-view'];
		case 'middle/rotation-backstack':
			return ['rotation-skips-backstack', 'rotation-backstack-view'];
		case 'middle/rotation-duplicate':
			return ['no-duplicate-on-restore'];
		default:
			return ['no-backstack-keeps'];
	}
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const log = simulate(s, RIGHT);
		if (log.length === 0 || log.length > 14) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(s, { ...RIGHT, ...change });
				const shown = value.length ? value : ['-'];
				return [id, same(shown, log) ? null : shown];
			})
		);
		if (required(input.grade, input.classId, s).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: renderCode(s) } },
			answer: { kind: 'sequence', value: log }
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
