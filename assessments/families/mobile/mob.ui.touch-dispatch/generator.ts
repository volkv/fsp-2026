// Touch dispatch in the Android View system: which callbacks a gesture (DOWN, MOVE…, UP) reaches through a chain of
// ViewGroups down to a View — onInterceptTouchEvent top-down, onTouchEvent bottom-up while unhandled, the touch target
// for the rest of the gesture, ACTION_CANCEL on interception, requestDisallowInterceptTouchEvent, OnTouchListener and
// the click. The model follows the documented dispatch (Manage touch events in a ViewGroup); here it routes each event
// along the chain, while the Python reference re-implements ViewGroup.dispatchTouchEvent with its touch target.
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

type Action = 'DOWN' | 'MOVE' | 'UP' | 'CANCEL';
type Returns = Record<Action, boolean>;

/** One view of the chain, from the root ViewGroup down to the touched View. */
interface Node {
	name: string;
	group: boolean;
	/** Whether the shown class overrides onInterceptTouchEvent (and logs it). */
	logsIntercept: boolean;
	/** The MOVE (counted from 1 by onInterceptTouchEvent) on which it returns true; `null` — never. */
	interceptAt: number | null;
	/** What onTouchEvent returns; `null` — a button's own onTouchEvent (true, and a click on UP after DOWN). */
	touch: Returns | null;
	/** What the OnTouchListener returns; `null` — no listener. */
	listener: Returns | null;
	click: boolean;
	/** On which event onTouchEvent asks the parent not to intercept: 0 — DOWN, k — the k-th MOVE it gets. */
	disallowAt: number | null;
}

interface Scene {
	chain: Node[];
	events: Action[];
}

interface Rules {
	everyEventLikeDown: boolean;
	interceptEveryEvent: boolean;
	interceptedToParent: boolean;
	noCancel: boolean;
	listenerThenTouch: boolean;
	disallowIgnored: boolean;
	disallowDirectParentOnly: boolean;
	falseMoveBubbles: boolean;
}

const RIGHT: Rules = {
	everyEventLikeDown: false,
	interceptEveryEvent: false,
	interceptedToParent: false,
	noCancel: false,
	listenerThenTouch: false,
	disallowIgnored: false,
	disallowDirectParentOnly: false,
	falseMoveBubbles: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'child-keeps-getting': { everyEventLikeDown: true },
	'intercept-every-event': { interceptEveryEvent: true },
	'intercepted-to-parent': { interceptedToParent: true },
	'no-cancel': { noCancel: true },
	'listener-then-touch': { listenerThenTouch: true },
	'disallow-ignored': { disallowIgnored: true },
	'disallow-direct-parent-only': { disallowDirectParentOnly: true },
	'false-move-bubbles': { falseMoveBubbles: true }
};

/** The log of a gesture: the route of every event along the chain. */
function simulate(s: Scene, r: Rules): string[] {
	const n = s.chain.length;
	const leafIndex = n - 1;
	const log: string[] = [];
	const disallow = s.chain.map(() => false);
	const interceptMoves = s.chain.map(() => 0);
	let leafMoves = 0;
	let pressed = false;
	let owner: number | null = null;
	const node = (i: number): Node => {
		const x = s.chain[i];
		if (!x) throw new Error(`no view ${i}`);
		return x;
	};

	const intercept = (g: number, ev: Action): boolean => {
		const v = node(g);
		if (!v.logsIntercept) return false;
		log.push(`${v.name}.intercept ${ev}`);
		if (ev === 'DOWN') interceptMoves[g] = 0;
		if (ev === 'MOVE') interceptMoves[g] = (interceptMoves[g] ?? 0) + 1;
		return ev === 'MOVE' && v.interceptAt !== null && interceptMoves[g] === v.interceptAt;
	};

	const touch = (i: number, ev: Action): boolean => {
		const v = node(i);
		log.push(`${v.name}.touch ${ev}`);
		if (!v.group) {
			if (ev === 'DOWN') leafMoves = 0;
			if (ev === 'MOVE') leafMoves += 1;
			const at = ev === 'DOWN' ? 0 : ev === 'MOVE' ? leafMoves : -1;
			if (v.disallowAt !== null && at === v.disallowAt && !r.disallowIgnored) {
				for (let g = r.disallowDirectParentOnly ? leafIndex - 1 : 0; g < leafIndex; g += 1) disallow[g] = true;
			}
		}
		if (v.touch !== null) return v.touch[ev];
		// A button: pressed on DOWN, the click on UP only after a DOWN its onTouchEvent saw.
		if (ev === 'DOWN') pressed = true;
		if (ev === 'CANCEL') pressed = false;
		if (ev === 'UP') {
			if (pressed && v.click) log.push(`${v.name}.click`);
			pressed = false;
		}
		return true;
	};

	/** View.dispatchTouchEvent of the leaf, or onTouchEvent of a group that handles the gesture itself. */
	const deliver = (i: number, ev: Action): boolean => {
		const v = node(i);
		if (v.listener !== null) {
			log.push(`${v.name}.listener ${ev}`);
			if (v.listener[ev] && !r.listenerThenTouch) return true;
			if (v.listener[ev]) {
				touch(i, ev);
				return true;
			}
		}
		return touch(i, ev);
	};

	/** Delivers to `from` and on upwards while unhandled; the index that handled it, or null. */
	const bubble = (from: number, ev: Action): number | null => {
		for (let i = from; i >= 0; i -= 1) if (deliver(i, ev)) return i;
		return null;
	};

	for (const ev of s.events) {
		if (ev === 'DOWN') disallow.fill(false);
		if (ev === 'DOWN' || r.everyEventLikeDown) {
			let start = leafIndex;
			for (let g = 0; g < leafIndex; g += 1) {
				if (!disallow[g] && intercept(g, ev)) {
					start = g;
					break;
				}
			}
			owner = bubble(start, ev);
		} else if (owner !== null) {
			let interceptor: number | null = null;
			for (let g = 0; g < owner; g += 1) {
				if (!disallow[g] && intercept(g, ev)) {
					interceptor = g;
					break;
				}
			}
			if (interceptor !== null) {
				if (!r.noCancel) {
					for (let g = interceptor + 1; g < owner; g += 1) if (!disallow[g]) intercept(g, 'CANCEL');
					deliver(owner, 'CANCEL');
				}
				if (r.interceptedToParent) touch(interceptor, ev);
				owner = interceptor;
			} else {
				if (r.interceptEveryEvent && node(owner).group) intercept(owner, ev);
				const handled = deliver(owner, ev);
				if (!handled && r.falseMoveBubbles) bubble(owner - 1, ev);
			}
		}
		if (ev === 'UP') disallow.fill(false);
	}
	return log;
}

const PYTHON_REFERENCE = `import json

sc = json.loads(input())
out = []


class View:
    def __init__(self, spec, parent):
        self.spec = spec
        self.name = spec["name"]
        self.parent = parent
        self.pressed = False
        self.moves = 0

    def dispatch(self, ev):
        # View.dispatchTouchEvent: the listener first; onTouchEvent only when it did not consume the event.
        listener = self.spec["listener"]
        if listener is not None:
            out.append(self.name + ".listener " + ev)
            if listener[ev]:
                return True
        return self.on_touch(ev)

    def on_touch(self, ev):
        out.append(self.name + ".touch " + ev)
        if ev == "DOWN":
            self.moves = 0
            step = 0
        elif ev == "MOVE":
            self.moves += 1
            step = self.moves
        else:
            step = -1
        if self.spec["disallowAt"] == step:
            self.parent.request_disallow()
        if self.spec["touch"] is not None:
            return self.spec["touch"][ev]
        if ev == "DOWN":
            self.pressed = True
        elif ev == "CANCEL":
            self.pressed = False
        elif ev == "UP":
            if self.pressed and self.spec["click"]:
                out.append(self.name + ".click")
            self.pressed = False
        return True


class Group(View):
    def __init__(self, spec, parent):
        super().__init__(spec, parent)
        self.child = None
        self.target = None
        self.disallow = False
        self.seen_moves = 0

    def request_disallow(self):
        if self.disallow:
            return
        self.disallow = True
        if self.parent is not None:
            self.parent.request_disallow()

    def on_intercept(self, ev):
        if not self.spec["logsIntercept"]:
            return False
        out.append(self.name + ".intercept " + ev)
        if ev == "DOWN":
            self.seen_moves = 0
        if ev == "MOVE":
            self.seen_moves += 1
        return ev == "MOVE" and self.spec["interceptAt"] == self.seen_moves

    def dispatch(self, ev):
        # ViewGroup.dispatchTouchEvent with one touch target.
        if ev == "DOWN":
            self.target = None
            self.disallow = False
        canceled = ev == "CANCEL"
        if ev == "DOWN" or self.target is not None:
            intercepted = False if self.disallow else self.on_intercept(ev)
        else:
            intercepted = True
        delivered = False
        if not canceled and not intercepted and ev == "DOWN":
            if self.child.dispatch(ev):
                self.target = self.child
                delivered = True
        if self.target is None:
            handled = View.dispatch(self, ev)
        elif delivered:
            handled = True
        else:
            handled = self.target.dispatch("CANCEL" if intercepted or canceled else ev)
            if intercepted:
                self.target = None
        if canceled or ev == "UP":
            self.target = None
            self.disallow = False
        return handled


views = []
for spec in sc["chain"]:
    parent = views[-1] if views else None
    v = Group(spec, parent) if spec["group"] else View(spec, parent)
    if parent is not None:
        parent.child = v
    views.append(v)
for ev in sc["events"]:
    views[0].dispatch(ev)
print("\\n".join(out))
`;

// --- Scenes -----------------------------------------------------------------------------------------------------

const ROOTS = ['pager', 'feed', 'sheet', 'gallery', 'carousel'];
const MIDS = ['card', 'row', 'tile', 'panel'];
const LEAVES = ['like', 'avatar', 'slider', 'chip', 'badge'];

const all = (value: boolean): Returns => ({ DOWN: value, MOVE: value, UP: value, CANCEL: value });
const only = (action: Action): Returns => ({ ...all(false), [action]: true });

const cap = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

function rootNode(name: string, interceptAt: number | null): Node {
	return {
		name,
		group: true,
		logsIntercept: true,
		interceptAt,
		touch: all(true),
		listener: null,
		click: false,
		disallowAt: null
	};
}

function midNode(name: string): Node {
	return {
		name,
		group: true,
		logsIntercept: false,
		interceptAt: null,
		touch: all(true),
		listener: null,
		click: false,
		disallowAt: null
	};
}

type LeafReturn = 'true' | 'false' | 'down';

function viewLeaf(name: string, returns: LeafReturn, disallowAt: number | null = null): Node {
	return {
		name,
		group: false,
		logsIntercept: false,
		interceptAt: null,
		touch: returns === 'true' ? all(true) : returns === 'false' ? all(false) : only('DOWN'),
		listener: null,
		click: false,
		disallowAt
	};
}

type ListenerReturn = 'all' | 'move' | 'up' | 'none';

function buttonLeaf(name: string, listener: ListenerReturn): Node {
	return {
		name,
		group: false,
		logsIntercept: false,
		interceptAt: null,
		touch: null,
		listener:
			listener === 'all' ? all(true) : listener === 'move' ? only('MOVE') : listener === 'up' ? only('UP') : all(false),
		click: true,
		disallowAt: null
	};
}

const MOVE_IS = 'ev.actionMasked == MotionEvent.ACTION_MOVE';
const DOWN_IS = 'ev.actionMasked == MotionEvent.ACTION_DOWN';

function groupCode(v: Node): string[] {
	const lines = [`class ${cap(v.name)}Layout(context: Context) : FrameLayout(context) {`];
	if (v.logsIntercept) {
		if (v.interceptAt === null) {
			lines.push(
				'    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {',
				`        log("${v.name}.intercept", ev)`,
				'        return false',
				'    }'
			);
		} else {
			lines.push(
				'    private var moves = 0',
				'',
				'    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {',
				`        log("${v.name}.intercept", ev)`,
				`        if (${DOWN_IS}) moves = 0`,
				`        if (${MOVE_IS}) moves++`,
				`        return ${MOVE_IS} && moves == ${v.interceptAt}`,
				'    }'
			);
		}
		lines.push('');
	}
	lines.push(
		'    override fun onTouchEvent(ev: MotionEvent): Boolean {',
		`        log("${v.name}.touch", ev)`,
		'        return true',
		'    }',
		'}'
	);
	return lines;
}

function leafCode(v: Node): string[] {
	if (v.touch === null) {
		const listener = v.listener;
		const expr =
			listener === null
				? 'false'
				: listener.DOWN
					? 'true'
					: listener.MOVE
						? MOVE_IS
						: listener.UP
							? 'ev.actionMasked == MotionEvent.ACTION_UP'
							: 'false';
		return [
			`class ${cap(v.name)}Button(context: Context) : AppCompatButton(context) {`,
			'    override fun onTouchEvent(ev: MotionEvent): Boolean {',
			`        log("${v.name}.touch", ev)`,
			'        return super.onTouchEvent(ev)',
			'    }',
			'}',
			'',
			`// При создании экрана, ${v.name} — экземпляр ${cap(v.name)}Button:`,
			`${v.name}.setOnTouchListener { _, ev ->`,
			`    log("${v.name}.listener", ev)`,
			`    ${expr}`,
			'}',
			`${v.name}.setOnClickListener { println("${v.name}.click") }`
		];
	}
	const returns = v.touch.MOVE ? 'true' : v.touch.DOWN ? DOWN_IS : 'false';
	const lines = [`class ${cap(v.name)}View(context: Context) : View(context) {`];
	if (v.disallowAt !== null) {
		if (v.disallowAt === 0) {
			lines.push(
				'    override fun onTouchEvent(ev: MotionEvent): Boolean {',
				`        log("${v.name}.touch", ev)`,
				`        if (${DOWN_IS}) parent.requestDisallowInterceptTouchEvent(true)`,
				`        return ${returns}`,
				'    }',
				'}'
			);
		} else {
			lines.push(
				'    private var moves = 0',
				'',
				'    override fun onTouchEvent(ev: MotionEvent): Boolean {',
				`        log("${v.name}.touch", ev)`,
				`        if (${DOWN_IS}) moves = 0`,
				`        if (${MOVE_IS}) moves++`,
				`        if (${MOVE_IS} && moves == ${v.disallowAt}) parent.requestDisallowInterceptTouchEvent(true)`,
				`        return ${returns}`,
				'    }',
				'}'
			);
		}
		return lines;
	}
	lines.push(
		'    override fun onTouchEvent(ev: MotionEvent): Boolean {',
		`        log("${v.name}.touch", ev)`,
		`        return ${returns}`,
		'    }',
		'}'
	);
	return lines;
}

function sceneCode(s: Scene): string {
	const parts: string[][] = [
		[
			'fun log(tag: String, ev: MotionEvent) {',
			'    val action = when (ev.actionMasked) {',
			'        MotionEvent.ACTION_DOWN -> "DOWN"',
			'        MotionEvent.ACTION_MOVE -> "MOVE"',
			'        MotionEvent.ACTION_UP -> "UP"',
			'        else -> "CANCEL"',
			'    }',
			'    println("$tag $action")',
			'}'
		]
	];
	for (const v of s.chain) parts.push(v.group ? groupCode(v) : leafCode(v));
	return parts.map((p) => p.join('\n')).join('\n\n');
}

function gesture(moves: number): Action[] {
	return ['DOWN', ...Array.from({ length: moves }, () => 'MOVE' as const), 'UP'];
}

interface Made {
	scene: Scene;
	/** Misconceptions this instance must expose. */
	required: string[];
}

function internScene(rng: Rng, classId: string): Made {
	const root = rng.pick(ROOTS);
	const leaf = rng.pick(LEAVES);
	if (classId === 'child-ignores-down') {
		return {
			scene: { chain: [rootNode(root, null), viewLeaf(leaf, 'false')], events: gesture(rng.int(1, 4)) },
			required: ['child-keeps-getting', 'intercept-every-event']
		};
	}
	if (classId === 'intercept-on-move') {
		const moves = rng.int(2, 4);
		return {
			scene: { chain: [rootNode(root, rng.int(1, moves)), viewLeaf(leaf, 'true')], events: gesture(moves) },
			required: ['intercepted-to-parent', 'no-cancel', 'intercept-every-event']
		};
	}
	if (classId === 'touch-listener') {
		const listener = rng.pick(['all', 'move', 'up'] as const);
		return {
			scene: { chain: [rootNode(root, null), buttonLeaf(leaf, listener)], events: gesture(rng.int(1, 3)) },
			required: ['listener-then-touch']
		};
	}
	// disallow: the child forbids interception before the root would take the gesture.
	const moves = rng.int(2, 4);
	const at = rng.int(2, moves);
	const disallowAt = rng.int(0, at - 1);
	return {
		scene: { chain: [rootNode(root, at), viewLeaf(leaf, 'true', disallowAt)], events: gesture(moves) },
		required: ['disallow-ignored']
	};
}

function juniorScene(rng: Rng, classId: string): Made {
	const root = rng.pick(ROOTS);
	const mid = rng.pick(MIDS);
	const leaf = rng.pick(LEAVES);
	if (classId === 'bubble-up') {
		const moves = rng.int(2, 4);
		return {
			scene: {
				chain: [rootNode(root, rng.int(1, moves)), midNode(mid), viewLeaf(leaf, 'false')],
				events: gesture(moves)
			},
			required: ['child-keeps-getting', 'no-cancel', 'intercepted-to-parent']
		};
	}
	if (classId === 'disallow-late') {
		const moves = rng.int(2, 4);
		const disallowAt = rng.int(1, moves - 1);
		const at = rng.int(1, moves);
		return {
			scene: {
				chain: [rootNode(root, at), midNode(mid), viewLeaf(leaf, 'true', disallowAt)],
				events: gesture(moves)
			},
			// Interception before the request: the child is cancelled and never asks.
			required: at > disallowAt ? ['disallow-direct-parent-only', 'disallow-ignored'] : ['no-cancel']
		};
	}
	if (classId === 'listener-and-intercept') {
		const moves = rng.int(2, 4);
		const listener = rng.pick(['all', 'move', 'none'] as const);
		return {
			scene: {
				chain: [rootNode(root, rng.int(1, moves)), midNode(mid), buttonLeaf(leaf, listener)],
				events: gesture(moves)
			},
			required: listener === 'none' ? ['no-cancel'] : ['listener-then-touch', 'no-cancel']
		};
	}
	// move-false: the child keeps the gesture although it returns false after DOWN.
	const moves = rng.int(2, 4);
	const at = rng.bool(0.3) ? null : rng.int(2, moves);
	return {
		scene: { chain: [rootNode(root, at), midNode(mid), viewLeaf(leaf, 'down')], events: gesture(moves) },
		required: ['false-move-bubbles']
	};
}

function statement(s: Scene): string {
	const names = s.chain.map((v) => `\`${v.name}\``);
	const leaf = s.chain[s.chain.length - 1];
	const moves = s.events.filter((e) => e === 'MOVE').length;
	return [
		'По модели обработки касаний View-системы Android (не на устройстве), как её описывает документация.',
		'',
		`Иерархия: ${names.join(' → ')} (каждый следующий — единственный ребёнок предыдущего, ${names[0]} — верхний контейнер разметки Activity). ` +
			`Палец касается \`${leaf?.name}\` и не выходит за его границы. Жест: DOWN, ${moves} × MOVE, UP; он короткий — долгого нажатия нет. ` +
			'Других обработчиков касаний нет; Activity обработку касаний не переопределяет.',
		'',
		'Что напечатает жест? Введите строки журнала по порядку, по одной в строке поля, ровно как их печатает `log` (и `println` у щелчка); в строке `log` имя и действие — через один пробел, например `feed.touch DOWN`.'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenes are drawn until every misconception the instance must expose changes the answer.
	for (let tries = 0; tries < 200; tries += 1) {
		const made = input.grade === 'intern' ? internScene(rng, input.classId) : juniorScene(rng, input.classId);
		const answer = simulate(made.scene, RIGHT);
		const same = (lines: string[]): boolean => lines.join('\n') === answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const lines = simulate(made.scene, { ...RIGHT, ...change });
				return [id, same(lines) ? null : lines];
			})
		);
		if (made.required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(made.scene), code: { language: 'kotlin', source: sceneCode(made.scene) } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(made.scene) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, lines]) => [
						id,
						lines === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: lines } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scene for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
