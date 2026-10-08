// Context leaks after a rotation: which statements of `onCreate` keep the destroyed Activity reachable from a GC root
// at the moment of a heap dump — a singleton initialised once with the Activity against `applicationContext` or a
// field that the new Activity overwrites, a ViewModel that outlives the rotation, listeners left registered, coroutines
// in `GlobalScope`, `viewModelScope` and `lifecycleScope` with their delays, delayed messages, `WeakReference`. The mix
// of mechanisms is the essential class; names, delays and the order of statements are surface.
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

/**
 * One statement of `onCreate` with what it needs around it. The kinds:
 * - `init-once` — a singleton keeps the first context it gets (`this` or `applicationContext`);
 * - `overwrite` — a singleton or the ViewModel field gets `this` on every `onCreate`;
 * - `bus` — a listener added to a singleton list: a lambda using a view, a lambda using nothing of the Activity, an
 *   inner class, a class holding a `WeakReference`; maybe removed in `onDestroy`;
 * - `observers` — a lambda using a view added to a list of the ViewModel; maybe cleared in `onDestroy`;
 * - `coroutine` — `GlobalScope`, `lifecycleScope` or the ViewModel's `viewModelScope` (through a callback) with a
 *   delay, its body using a view or not;
 * - `handler` — a delayed message using a view on the main looper; maybe removed in `onDestroy`.
 */
type Fragment =
	| { kind: 'init-once'; holder: string; app: boolean }
	| { kind: 'overwrite'; holder: string; owner: 'singleton' | 'viewmodel' }
	| { kind: 'bus'; holder: string; listener: 'member' | 'none' | 'inner' | 'weak'; removed: boolean }
	| { kind: 'observers'; cleared: boolean }
	| { kind: 'coroutine'; scope: 'global' | 'lifecycle' | 'viewmodel'; capture: boolean; delaySec: number }
	| { kind: 'handler'; removed: boolean; delaySec: number };

interface Scenario {
	rotateSec: number;
	dumpSec: number;
	fragments: Fragment[];
}

interface Rules {
	appContextLeaks: boolean;
	overwriteStillLeaks: boolean;
	vmScopeCancelled: boolean;
	lifecycleScopeLeaks: boolean;
	weakRefLeaks: boolean;
	finishedStillLeaks: boolean;
	nonCapturingLeaks: boolean;
}

const RIGHT: Rules = {
	appContextLeaks: false,
	overwriteStillLeaks: false,
	vmScopeCancelled: false,
	lifecycleScopeLeaks: false,
	weakRefLeaks: false,
	finishedStillLeaks: false,
	nonCapturingLeaks: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'app-context-leaks': { appContextLeaks: true },
	'overwrite-still-leaks': { overwriteStillLeaks: true },
	'viewmodelscope-cancelled': { vmScopeCancelled: true },
	'lifecyclescope-leaks': { lifecycleScopeLeaks: true },
	'weakref-leaks': { weakRefLeaks: true },
	'finished-still-leaks': { finishedStillLeaks: true },
	'non-capturing-leaks': { nonCapturingLeaks: true }
};

/** Whether the statement keeps the old Activity reachable at the dump. */
function leaks(f: Fragment, s: Scenario, r: Rules): boolean {
	/** A job or a message started in the old `onCreate` (at 0) is still pending at the dump. */
	const pending = (delaySec: number): boolean => delaySec > s.dumpSec || r.finishedStillLeaks;
	switch (f.kind) {
		case 'init-once':
			return !f.app || r.appContextLeaks;
		case 'overwrite':
			return r.overwriteStillLeaks;
		case 'bus': {
			if (f.removed) return false;
			if (f.listener === 'none') return r.nonCapturingLeaks;
			if (f.listener === 'weak') return r.weakRefLeaks;
			return true;
		}
		case 'observers':
			return !f.cleared;
		case 'coroutine': {
			if (!f.capture && !r.nonCapturingLeaks) return false;
			if (f.scope === 'lifecycle') return r.lifecycleScopeLeaks && pending(f.delaySec);
			if (f.scope === 'viewmodel') return !r.vmScopeCancelled && pending(f.delaySec);
			return pending(f.delaySec);
		}
		case 'handler':
			return !f.removed && pending(f.delaySec);
	}
}

const SINGLETONS = ['Analytics', 'Prefs', 'Session', 'Billing', 'Remote', 'Metrics', 'Router', 'Updates', 'Media'];

interface Rendered {
	code: string;
	/** The line of each fragment's statement in `onCreate`, in fragment order. */
	lines: number[];
}

const ms = (sec: number): string => `${sec}_000`;

function render(s: Scenario): Rendered {
	const objects: string[] = [];
	const vm: string[] = [];
	const fields: string[] = [];
	const create: { text: string; fragment: number | null }[] = [];
	const destroy: string[] = [];
	const needs = new Set<string>();
	let methods = 0;
	s.fragments.forEach((f, i) => {
		const stmt = (text: string): void => {
			create.push({ text, fragment: i });
		};
		switch (f.kind) {
			case 'init-once':
				objects.push(
					`object ${f.holder} {`,
					'    private var context: Context? = null',
					'    fun init(context: Context) { if (this.context == null) this.context = context }',
					'}'
				);
				stmt(`${f.holder}.init(${f.app ? 'applicationContext' : 'this'})`);
				break;
			case 'overwrite':
				if (f.owner === 'singleton') {
					objects.push(`object ${f.holder} { var context: Context? = null }`);
					stmt(`${f.holder}.context = this`);
				} else {
					vm.push('    var host: Activity? = null');
					stmt('viewModel.host = this');
				}
				break;
			case 'bus': {
				objects.push(`object ${f.holder} { val listeners = mutableListOf<(String) -> Unit>() }`);
				const name = `on${f.holder}`;
				if (f.listener === 'member') fields.push(`    private val ${name}: (String) -> Unit = { header.text = it }`);
				else if (f.listener === 'none')
					fields.push(`    private val ${name}: (String) -> Unit = { Log.d("${f.holder.toLowerCase()}", it) }`);
				else if (f.listener === 'inner') {
					needs.add('inner');
					fields.push(`    private val ${name}: (String) -> Unit = HeaderUpdater()`);
				} else {
					needs.add('weak');
					fields.push(`    private val ${name}: (String) -> Unit = WeakHeader(this)`);
				}
				stmt(`${f.holder}.listeners += ${name}`);
				if (f.removed) destroy.push(`${f.holder}.listeners -= ${name}`);
				break;
			}
			case 'observers':
				vm.push('    val observers = mutableListOf<() -> Unit>()');
				stmt('viewModel.observers += { header.text = "updated" }');
				if (f.cleared) destroy.push('viewModel.observers.clear()');
				break;
			case 'coroutine': {
				const body = f.capture ? 'header.text = "synced"' : 'Log.d("sync", "done")';
				if (f.scope === 'viewmodel') {
					const method = (['refresh', 'reload', 'sync'] as const)[methods++] as string;
					vm.push(
						`    fun ${method}(onDone: () -> Unit) { viewModelScope.launch { delay(${ms(f.delaySec)}); onDone() } }`
					);
					stmt(`viewModel.${method} { ${body} }`);
				} else
					stmt(
						`${f.scope === 'global' ? 'GlobalScope' : 'lifecycleScope'}.launch { delay(${ms(f.delaySec)}); ${body} }`
					);
				break;
			}
			case 'handler':
				fields.push('    private val handler = Handler(Looper.getMainLooper())');
				stmt(`handler.postDelayed({ header.text = "tick" }, ${ms(f.delaySec)})`);
				if (f.removed) destroy.push('handler.removeCallbacksAndMessages(null)');
				break;
		}
	});
	const support: string[] = [];
	if (needs.has('weak'))
		support.push(
			'class WeakHeader(activity: MainActivity) : (String) -> Unit {',
			'    private val ref = WeakReference(activity)',
			'    override fun invoke(text: String) { ref.get()?.header?.text = text }',
			'}'
		);
	const lines: string[] = [...objects, ...support];
	if (vm.length > 0) lines.push('class MainViewModel : ViewModel() {', ...vm, '}');
	lines.push(
		'class MainActivity : AppCompatActivity() {',
		'    val header: TextView by lazy { findViewById(R.id.header) }',
		...(vm.length > 0 ? ['    private val viewModel: MainViewModel by viewModels()'] : []),
		...fields
	);
	if (needs.has('inner'))
		lines.push(
			'    inner class HeaderUpdater : (String) -> Unit {',
			'        override fun invoke(text: String) { header.text = text }',
			'    }'
		);
	lines.push('    override fun onCreate(savedInstanceState: Bundle?) {', '        super.onCreate(savedInstanceState)');
	const at: number[] = [];
	for (const c of create) {
		lines.push(`        ${c.text}`);
		if (c.fragment !== null) at[c.fragment] = lines.length;
	}
	lines.push('    }');
	if (destroy.length > 0)
		lines.push(
			'    override fun onDestroy() {',
			...destroy.map((d) => `        ${d}`),
			'        super.onDestroy()',
			'    }'
		);
	lines.push('}');
	return { code: lines.join('\n'), lines: at };
}

/** A delay that is still running at the dump, or one that ended between the rotation and the dump. */
function delay(rng: Rng, s: Pick<Scenario, 'rotateSec' | 'dumpSec'>, running: boolean): number {
	return running ? s.dumpSec + rng.int(2, 25) : rng.int(s.rotateSec + 1, s.dumpSec - 1);
}

function fragment(rng: Rng, kind: string, s: Pick<Scenario, 'rotateSec' | 'dumpSec'>, holders: string[]): Fragment {
	const holder = (): string => holders.shift() as string;
	switch (kind) {
		case 'init-once':
			return { kind, holder: holder(), app: rng.bool(0.5) };
		case 'overwrite':
			return { kind, holder: holder(), owner: rng.bool(0.5) ? 'singleton' : 'viewmodel' };
		case 'bus':
			return {
				kind,
				holder: holder(),
				listener: rng.pick(['member', 'none', 'inner', 'weak'] as const),
				removed: rng.bool(0.3)
			};
		case 'observers':
			return { kind, cleared: rng.bool(0.4) };
		case 'handler':
			return { kind, removed: rng.bool(0.35), delaySec: delay(rng, s, rng.bool(0.6)) };
		default: {
			const scope = kind === 'global' ? 'global' : kind === 'lifecycle' ? 'lifecycle' : 'viewmodel';
			return { kind: 'coroutine', scope, capture: rng.bool(0.8), delaySec: delay(rng, s, rng.bool(0.6)) };
		}
	}
}

const KINDS: Record<string, string[]> = {
	singletons: ['init-once', 'init-once', 'overwrite', 'bus', 'bus', 'global'],
	coroutines: ['global', 'global', 'lifecycle', 'viewmodel', 'handler', 'init-once'],
	viewmodel: ['overwrite', 'observers', 'viewmodel', 'viewmodel', 'lifecycle', 'bus'],
	mixed: ['init-once', 'overwrite', 'bus', 'observers', 'global', 'lifecycle', 'viewmodel', 'handler']
};

function scenario(rng: Rng, classId: string): Scenario {
	const rotateSec = rng.int(2, 5);
	const times = { rotateSec, dumpSec: rotateSec + rng.int(4, 9) };
	const holders = rng.sample(SINGLETONS, 6);
	const kinds = classId === 'mixed' ? rng.sample(KINDS.mixed as string[], 6) : rng.shuffle(KINDS[classId] as string[]);
	let fragments = kinds.map((k) => fragment(rng, k, times, holders));
	// One overwrite of the ViewModel's host at most: two statements cannot share the field.
	const hosts = fragments.filter((f) => f.kind === 'overwrite' && f.owner === 'viewmodel');
	if (hosts.length > 1) fragments = fragments.filter((f) => f !== hosts[1]);
	const handlers = fragments.filter((f) => f.kind === 'handler');
	if (handlers.length > 1) fragments = fragments.filter((f) => f !== handlers[1]);
	const observers = fragments.filter((f) => f.kind === 'observers');
	if (observers.length > 1) fragments = fragments.filter((f) => f !== observers[1]);
	return { ...times, fragments };
}

function describe(s: Scenario): string {
	return [
		'Экран на Kotlin (код под условием, импорты опущены). Модель — по семантике Kotlin/JVM и документации Android (не на устройстве):',
		'',
		`- \`MainActivity\` создана в момент 0 с; в момент ${s.rotateSec} с пользователь поворачивает устройство: старая Activity проходит \`onDestroy\`, затем новая — \`onCreate\` с тем же кодом; ViewModel экрана одна и та же;`,
		`- в момент ${s.dumpSec} с снимают дамп кучи. Корни GC: \`object\`-синглтоны, ViewModel экрана (её держит ViewModelStore), очередь сообщений главного потока, ещё не завершённые и не отменённые корутины; все ссылки сильные, кроме \`WeakReference\`;`,
		'- время идеальное: до момента 0 поля синглтонов пусты; `onCreate` и `onDestroy` выполняются мгновенно, корутина и отложенное сообщение запускаются в момент вызова, задержка истекает ровно через указанное время, после чего тело выполняется мгновенно и корутина завершается; корутина `lifecycleScope` отменяется в `onDestroy` своей Activity.',
		'',
		'Какие строки `onCreate` приводят к тому, что **старая** (уничтоженная) Activity в момент дампа достижима от корня?',
		'',
		'Введите номера строк кода (нумерация с 1), по одному в строке, в любом порядке; если таких нет — одна строка `-`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
R, C = p["rotateSec"], p["dumpSec"]

# Event simulation of one statement at a time: the strong edges it creates, the roots that hold them, then
# reachability of the old Activity ("old") from the roots at the dump.
def retains(f):
    edges = {}          # node -> set of nodes
    roots = set()
    def link(a, b):
        edges.setdefault(a, set()).add(b)
    def unlink(a, b):
        edges.get(a, set()).discard(b)
    state = {}
    jobs = []           # (node, end, cancelled_on_destroy_of)
    def on_create(act, t):
        k = f["kind"]
        if k == "init-once":
            roots.add("obj")
            if "ctx" not in state:
                state["ctx"] = "app" if f["app"] else act
                link("obj", state["ctx"])
        elif k == "overwrite":
            roots.add("holder")
            if "ctx" in state:
                unlink("holder", state["ctx"])
            state["ctx"] = act
            link("holder", act)
        elif k == "bus":
            roots.add("bus")
            node = "listener-" + act
            link("bus", node)
            if f["listener"] in ("member", "inner"):
                link(node, act)
        elif k == "observers":
            roots.add("vm")
            node = "observer-" + act
            link("vm", node)
            link(node, act)
        elif k == "coroutine":
            node = "job-" + act
            if f["capture"]:
                link(node, act)
            jobs.append((node, t + f["delaySec"], act if f["scope"] == "lifecycle" else None))
        elif k == "handler":
            node = "msg-" + act
            link(node, act)
            jobs.append((node, t + f["delaySec"], None))
    def on_destroy(act):
        k = f["kind"]
        if k == "bus" and f["removed"]:
            unlink("bus", "listener-" + act)
        if k == "observers" and f["cleared"]:
            edges["vm"] = set()
        if k == "handler" and f["removed"]:
            jobs[:] = [j for j in jobs if j[0] != "msg-" + act]
        jobs[:] = [j for j in jobs if j[2] != act]
    on_create("old", 0)
    on_destroy("old")
    on_create("new", R)
    for node, end, _ in jobs:
        if end > C:
            roots.add(node)
    seen = set()
    stack = list(roots)
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        stack.extend(edges.get(n, ()))
    return "old" in seen

out = [str(line) for f, line in zip(p["fragments"], p["lines"]) if retains(f)]
print("\\n".join(sorted(out)) or "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	singletons: ['overwrite-still-leaks', 'app-context-leaks'],
	coroutines: ['finished-still-leaks', 'lifecyclescope-leaks', 'viewmodelscope-cancelled'],
	viewmodel: ['viewmodelscope-cancelled', 'overwrite-still-leaks'],
	mixed: []
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	for (let tries = 0; tries < 1000; tries += 1) {
		const s = scenario(rng, input.classId);
		const { code, lines } = render(s);
		const solve = (rules: Rules): string[] => {
			const set = s.fragments.flatMap((f, i) => (leaks(f, s, rules) ? [String(lines[i])] : [])).sort();
			return set.length === 0 ? ['-'] : set;
		};
		const answer = solve(RIGHT);
		if (answer[0] === '-' || answer.length === s.fragments.length) continue;
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve({ ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// Every instance exposes at least three misconceptions: a single trap would let a half-right model pass.
		if (Object.values(wrong).filter((v) => v !== null).length < 3) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s), code: { language: 'kotlin', source: code } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ ...s, lines }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
