// DOM event dispatch (DOM Standard, «dispatching events»): the capturing pass from the root down to the target, the
// target itself (its capturing listeners first, then the others, each in the order of registration), the bubbling
// pass back up for events that bubble; `stopPropagation`, `stopImmediatePropagation`, `preventDefault`, `once`, and a
// listener added twice. The answer is the log the listeners print; the reference simulates the dispatch on its own.
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

type Action = 'none' | 'stop' | 'immediate' | 'prevent';

/** One `addEventListener` call in the order of the program. */
interface Registration {
	node: string;
	type: string;
	capture: boolean;
	once: boolean;
	/** The callback object: anonymous callbacks are unique, a named function is shared by its registrations. */
	fn: string;
	/** The name of a shared function, or `null` for an arrow function written in place. */
	named: string | null;
	action: Action;
	/** What the callback prints when it runs on this node. */
	log: string;
}

interface Dispatch {
	target: string;
	type: string;
	bubbles: boolean;
	/** `click` — a user's click; otherwise `dispatchEvent(new Event(type, …))`. */
	how: 'click' | 'dispatch';
}

interface Params {
	/** Ids from the root down; each element is the parent of the next. */
	chain: string[];
	tags: string[];
	registrations: Registration[];
	dispatches: Dispatch[];
}

interface Rules {
	captureIgnored: boolean;
	registrationOrder: boolean;
	bubbleTopDown: boolean;
	stop: 'right' | 'skips-node' | 'ignored';
	preventStops: boolean;
	onceIgnored: boolean;
	immediateAsStop: boolean;
	targetRegistrationOrder: boolean;
	nonBubblingNoCapture: boolean;
	bubblesByDefault: boolean;
	dedupe: 'right' | 'none' | 'ignores-capture';
}

const RIGHT: Rules = {
	captureIgnored: false,
	registrationOrder: false,
	bubbleTopDown: false,
	stop: 'right',
	preventStops: false,
	onceIgnored: false,
	immediateAsStop: false,
	targetRegistrationOrder: false,
	nonBubblingNoCapture: false,
	bubblesByDefault: false,
	dedupe: 'right'
};

const WRONG: Record<string, Partial<Rules>> = {
	'capture-ignored': { captureIgnored: true },
	'registration-order': { registrationOrder: true },
	'bubble-top-down': { bubbleTopDown: true },
	'stop-skips-node': { stop: 'skips-node' },
	'stop-ignored': { stop: 'ignored' },
	'prevent-stops': { preventStops: true },
	'once-ignored': { onceIgnored: true },
	'immediate-as-stop': { immediateAsStop: true },
	'target-registration-order': { targetRegistrationOrder: true },
	'non-bubbling-no-capture': { nonBubblingNoCapture: true },
	'bubbles-by-default': { bubblesByDefault: true },
	'no-dedupe': { dedupe: 'none' },
	'dedupe-ignores-capture': { dedupe: 'ignores-capture' }
};

interface Live extends Registration {
	removed: boolean;
}

/**
 * The log of all dispatches under the rules, and whether the scenario touches an edge the item avoids: a capturing
 * listener of the target stopping propagation while the target also has listeners of the bubbling pass.
 */
function simulate(p: Params, rules: Rules): { log: string[]; edge: boolean } {
	const live: Live[] = [];
	for (const r of p.registrations) {
		const capture = rules.captureIgnored ? false : r.capture;
		const duplicate = live.some(
			(l) =>
				l.node === r.node &&
				l.type === r.type &&
				l.fn === r.fn &&
				(rules.dedupe === 'ignores-capture' || l.capture === capture)
		);
		if (duplicate && rules.dedupe !== 'none') continue;
		live.push({ ...r, capture, removed: false });
	}
	const log: string[] = [];
	let edge = false;
	for (const d of p.dispatches) {
		const bubbles = d.bubbles || (d.how === 'dispatch' && rules.bubblesByDefault);
		const path = p.chain.slice(0, p.chain.indexOf(d.target) + 1);
		// Whether propagation is stopped for the rest of the path.
		const state = { stopped: false };
		/** Runs a listener; tells whether it stopped propagation and whether it also stopped its own node at once. */
		const run = (l: Live): { stops: boolean; now: boolean } => {
			if (l.once && !rules.onceIgnored) l.removed = true;
			log.push(l.log);
			const action = l.action === 'prevent' && rules.preventStops ? 'stop' : l.action;
			if (action === 'stop' && rules.stop === 'ignored') return { stops: false, now: false };
			return {
				stops: action === 'stop' || action === 'immediate',
				now: (action === 'immediate' && !rules.immediateAsStop) || (action === 'stop' && rules.stop === 'skips-node')
			};
		};
		if (rules.registrationOrder) {
			for (const l of live) {
				if (l.removed || l.type !== d.type || !path.includes(l.node)) continue;
				if (!bubbles && !l.capture && l.node !== d.target) continue;
				if (run(l).stops) break;
			}
			continue;
		}
		/** Listeners of a node for one pass: `capturing`, `bubbling` or, under a misconception, both at once. */
		const invoke = (node: string, pass: 'capturing' | 'bubbling' | 'both'): void => {
			if (state.stopped) return;
			const listeners = live.filter((l) => l.node === node && l.type === d.type);
			for (const l of listeners) {
				if (l.removed) continue;
				if (pass === 'capturing' && !l.capture) continue;
				if (pass === 'bubbling' && l.capture) continue;
				const effect = run(l);
				const targetHasOthers = listeners.some((x) => !x.capture && !x.removed);
				if (effect.stops && pass === 'capturing' && node === d.target && targetHasOthers) edge = true;
				if (effect.stops) state.stopped = true;
				if (effect.now) break;
			}
		};
		const ancestors = path.slice(0, -1);
		const capturePath = !bubbles && rules.nonBubblingNoCapture ? [] : ancestors;
		for (const node of capturePath) invoke(node, 'capturing');
		if (rules.targetRegistrationOrder) invoke(d.target, 'both');
		else {
			invoke(d.target, 'capturing');
			invoke(d.target, 'bubbling');
		}
		if (bubbles) {
			const up = [...ancestors].reverse();
			for (const node of rules.bubbleTopDown ? ancestors : up) invoke(node, 'bubbling');
		}
	}
	return { log, edge };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const OUTER = ['page', 'app', 'layout', 'root'];
const SECOND = ['panel', 'toolbar', 'sidebar', 'card', 'dialog'];
const THIRD = ['group', 'row', 'actions', 'footer'];
const TARGETS = ['save', 'send', 'like', 'buy', 'apply', 'share'];
const SHARED_FNS = ['trace', 'track', 'report', 'audit'];

interface Shape {
	depth: number;
	listeners: [number, number];
	captureShare: number;
}

function chainOf(rng: Rng, depth: number): { chain: string[]; tags: string[] } {
	const chain =
		depth === 3
			? [rng.pick(OUTER), rng.pick(SECOND), rng.pick(TARGETS)]
			: [rng.pick(OUTER), rng.pick(SECOND), rng.pick(THIRD), rng.pick(TARGETS)];
	const tags = depth === 3 ? ['div', 'div', 'button'] : ['div', 'section', 'div', 'button'];
	return { chain, tags };
}

/** Anonymous listeners on the chain with labels `<id> <n>`, n counting the registrations of that element. */
function anonymous(
	rng: Rng,
	chain: readonly string[],
	count: number,
	captureShare: number,
	type = 'click'
): Registration[] {
	const counters = new Map<string, number>();
	return Array.from({ length: count }, (_, i) => {
		const node = rng.pick(chain);
		const n = (counters.get(node) ?? 0) + 1;
		counters.set(node, n);
		const isTarget = node === chain[chain.length - 1];
		return {
			node,
			type,
			capture: !isTarget && rng.bool(captureShare),
			once: false,
			fn: `anon${i}`,
			named: null,
			action: 'none',
			log: `${node} ${n}`
		};
	});
}

function relabel(registrations: Registration[]): Registration[] {
	const counters = new Map<string, number>();
	return registrations.map((r) => {
		if (r.named !== null) return r;
		const n = (counters.get(r.node) ?? 0) + 1;
		counters.set(r.node, n);
		return { ...r, log: `${r.node} ${n}` };
	});
}

const SHAPES: { intern: Shape; junior: Shape } = {
	intern: { depth: 3, listeners: [6, 8], captureShare: 0.45 },
	junior: { depth: 4, listeners: [7, 9], captureShare: 0.4 }
};

function scenario(rng: Rng, grade: string, classId: string): Params {
	const shape = grade === 'intern' ? SHAPES.intern : SHAPES.junior;
	const { chain, tags } = chainOf(rng, shape.depth);
	const target = chain[chain.length - 1] as string;
	const count = rng.int(...shape.listeners);
	let registrations = anonymous(rng, chain, count, shape.captureShare);
	const click = (t: string): Dispatch => ({ target: t, type: 'click', bubbles: true, how: 'click' });
	let dispatches: Dispatch[] = [click(target)];
	const pickIndex = (pred: (r: Registration) => boolean): number => {
		const idx = registrations.map((r, i) => (pred(r) ? i : -1)).filter((i) => i >= 0);
		return idx.length ? rng.pick(idx) : -1;
	};
	const setAction = (i: number, action: Action): void => {
		const r = registrations[i];
		if (r) registrations[i] = { ...r, action };
	};
	const notTargetCapture = (r: Registration): boolean => !(r.capture && r.node === target);
	if (grade === 'intern') {
		if (classId === 'stop-propagation') setAction(pickIndex(notTargetCapture), 'stop');
		else if (classId === 'prevent-default') {
			const prevent = pickIndex(() => true);
			setAction(prevent, 'prevent');
			const preventReg = registrations[prevent];
			setAction(
				pickIndex((r) => notTargetCapture(r) && r !== preventReg),
				'stop'
			);
		} else if (classId === 'once') {
			for (let k = rng.int(2, 3); k > 0; k -= 1) {
				const i = pickIndex((r) => !r.once);
				const r = registrations[i];
				if (r) registrations[i] = { ...r, once: true };
			}
			dispatches = [click(target), click(target)];
		}
		return { chain, tags, registrations, dispatches };
	}
	const middle = chain[rng.int(1, chain.length - 2)] as string;
	if (classId === 'immediate') {
		const imm = pickIndex(notTargetCapture);
		setAction(imm, 'immediate');
		const immReg = registrations[imm];
		setAction(
			pickIndex((r) => notTargetCapture(r) && r !== immReg),
			'stop'
		);
		dispatches = [click(target), click(middle)];
	} else if (classId === 'target-phase') {
		// The target's own listeners: ordinary ones first, then capturing ones.
		const plain = rng.int(1, 2);
		const capturing = rng.int(1, 2);
		const own: Registration[] = [
			...Array.from({ length: plain }, () => ({ capture: false })),
			...Array.from({ length: capturing }, () => ({ capture: true }))
		].map((x, i) => ({
			node: target,
			type: 'click',
			capture: x.capture,
			once: false,
			fn: `own${i}`,
			named: null,
			action: 'none',
			log: ''
		}));
		const others = registrations.filter((r) => r.node !== target);
		const merged: Registration[] = [];
		let k = 0;
		for (const r of others) {
			if (k < own.length && rng.bool(0.4)) merged.push(own[k++] as Registration);
			merged.push(r);
		}
		while (k < own.length) merged.push(own[k++] as Registration);
		registrations = merged;
		if (rng.bool(0.5)) {
			const i = pickIndex((r) => r.node !== target && !r.capture);
			setAction(i, 'prevent');
		}
		dispatches = [click(target), click(middle)];
	} else if (classId === 'non-bubbling') {
		const type = rng.pick(['ping', 'refresh', 'sync', 'check']);
		const pings = anonymous(rng, chain, rng.int(5, 7), 0.45, type).map((r, i) => ({ ...r, fn: `ping${i}` }));
		const clicks = registrations.slice(0, 2);
		registrations = rng.shuffle([...pings, ...clicks]);
		dispatches = [
			{ target, type, bubbles: false, how: 'dispatch' },
			{ target: middle, type, bubbles: true, how: 'dispatch' }
		];
	} else {
		// dedupe: a shared named function registered on several elements, twice on one of them, once with capture.
		const name = rng.pick(SHARED_FNS);
		const named = (node: string, capture: boolean, once = false): Registration => ({
			node,
			type: 'click',
			capture,
			once,
			fn: name,
			named: name,
			action: 'none',
			log: `${name} ${node}`
		});
		const twice = rng.pick(chain.slice(0, -1));
		const shared: Registration[] = [
			named(twice, false),
			named(twice, false),
			named(rng.pick(chain.filter((c) => c !== twice)), rng.bool(0.5)),
			named(twice, true, rng.bool(0.5))
		];
		const base = registrations.slice(0, rng.int(4, 5));
		const merged = rng.shuffle([...base, ...shared]);
		// The first registration of the shared function on `twice` stays before the second one.
		registrations = merged;
		if (rng.bool(0.5))
			setAction(
				pickIndex((r) => r.named === null && notTargetCapture(r)),
				'stop'
			);
		dispatches = [click(target), click(rng.bool(0.5) ? target : middle)];
	}
	return { chain, tags, registrations: relabel(registrations), dispatches };
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/bubble-capture': ['capture-ignored', 'bubble-top-down', 'registration-order'],
	'intern/stop-propagation': ['stop-skips-node', 'stop-ignored'],
	'intern/prevent-default': ['prevent-stops', 'stop-ignored'],
	'intern/once': ['once-ignored', 'capture-ignored'],
	'junior/immediate': ['immediate-as-stop', 'stop-skips-node'],
	'junior/target-phase': ['target-registration-order', 'capture-ignored'],
	'junior/non-bubbling': ['non-bubbling-no-capture', 'bubbles-by-default'],
	'junior/dedupe': ['no-dedupe', 'dedupe-ignores-capture']
};

function answers(p: Params): { answer: string[]; edge: boolean; wrong: Record<string, string[] | null> } {
	const right = simulate(p, RIGHT);
	const key = right.log.join('\n');
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change }).log;
			return [id, value.join('\n') === key ? null : value];
		})
	);
	return { answer: right.log, edge: right.edge, wrong };
}

function acceptable(p: Params, answer: readonly string[], edge: boolean): boolean {
	if (edge) return false;
	if (answer.length < 5 || answer.length > 14) return false;
	// Every element of the chain has a listener, so the whole path is in play.
	return p.chain.every((id) => p.registrations.some((r) => r.node === id));
}

/** A deterministic scenario for the rare seed whose random draws keep failing; it exposes the required misconceptions. */
function fallback(rng: Rng, grade: string, classId: string): Params {
	const depth = grade === 'intern' ? 3 : 4;
	const { chain, tags } = chainOf(rng, depth);
	const [a, b, c, d] = chain as [string, string, string, string | undefined];
	const target = d ?? c;
	const mid = b;
	const reg = (
		node: string,
		capture: boolean,
		action: Action = 'none',
		once = false,
		type = 'click'
	): Registration => ({
		node,
		type,
		capture,
		once,
		fn: '',
		named: null,
		action,
		log: ''
	});
	const unique = (rs: Registration[]): Registration[] => relabel(rs.map((r, i) => ({ ...r, fn: `fallback${i}` })));
	const click = (t: string): Dispatch => ({ target: t, type: 'click', bubbles: true, how: 'click' });
	if (grade === 'intern') {
		const base = [reg(a, false), reg(a, true), reg(target, false), reg(mid, true), reg(mid, false), reg(target, false)];
		if (classId === 'stop-propagation') base[4] = reg(mid, false, 'stop');
		if (classId === 'stop-propagation') base.push(reg(mid, false));
		if (classId === 'prevent-default') {
			base[1] = reg(a, true, 'prevent');
			base[4] = reg(mid, false, 'stop');
			base.push(reg(mid, false));
		}
		if (classId === 'once') {
			base[1] = reg(a, true, 'none', true);
			base[2] = reg(target, false, 'none', true);
		}
		return {
			chain,
			tags,
			registrations: unique(base),
			dispatches: classId === 'once' ? [click(target), click(target)] : [click(target)]
		};
	}
	if (classId === 'immediate') {
		const base = [
			reg(a, true),
			reg(mid, false, 'immediate'),
			reg(mid, false),
			reg(c, true, 'stop'),
			reg(c, true),
			reg(target, false),
			reg(a, false)
		];
		return { chain, tags, registrations: unique(base), dispatches: [click(target), click(mid)] };
	}
	if (classId === 'target-phase') {
		const base = [reg(target, false), reg(a, true), reg(mid, false), reg(target, true), reg(c, true), reg(a, false)];
		return { chain, tags, registrations: unique(base), dispatches: [click(target), click(mid)] };
	}
	if (classId === 'non-bubbling') {
		const t = 'ping';
		const base = [
			reg(a, true, 'none', false, t),
			reg(mid, false, 'none', false, t),
			reg(target, false, 'none', false, t),
			reg(c, true, 'none', false, t),
			reg(a, false, 'none', false, t),
			reg(target, false)
		];
		return {
			chain,
			tags,
			registrations: unique(base),
			dispatches: [
				{ target, type: t, bubbles: false, how: 'dispatch' },
				{ target: mid, type: t, bubbles: true, how: 'dispatch' }
			]
		};
	}
	const name = rng.pick(SHARED_FNS);
	const named = (node: string, capture: boolean): Registration => ({
		node,
		type: 'click',
		capture,
		once: false,
		fn: name,
		named: name,
		action: 'none',
		log: `${name} ${node}`
	});
	const rs = relabel([
		{ ...reg(a, true), fn: 'x1' },
		named(mid, false),
		{ ...reg(target, false), fn: 'x2' },
		named(mid, false),
		named(mid, true),
		{ ...reg(c, false), fn: 'x3' },
		named(a, false)
	]);
	return { chain, tags, registrations: rs, dispatches: [click(target), click(target)] };
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

function optionsText(r: Registration): string {
	if (r.once) return r.capture ? ', { capture: true, once: true }' : ', { once: true }';
	return r.capture ? ', true' : '';
}

const ACTION_CALL: Record<Action, string> = {
	none: '',
	stop: 'e.stopPropagation();',
	immediate: 'e.stopImmediatePropagation();',
	prevent: 'e.preventDefault();'
};

function program(p: Params): string {
	const lines: string[] = [];
	for (const id of p.chain) lines.push(`const ${camel(id)} = document.getElementById('${id}');`);
	const shared = [...new Set(p.registrations.filter((r) => r.named !== null).map((r) => r.named as string))];
	for (const name of shared) {
		const r = p.registrations.find((x) => x.named === name) as Registration;
		lines.push('', `function ${name}(e) {`, `  console.log('${name} ' + e.currentTarget.id);`);
		if (r.action !== 'none') lines.push(`  ${ACTION_CALL[r.action]}`);
		lines.push('}');
	}
	lines.push('');
	for (const r of p.registrations) {
		const el = camel(r.node);
		if (r.named !== null) {
			lines.push(`${el}.addEventListener('${r.type}', ${r.named}${optionsText(r)});`);
		} else if (r.action === 'none') {
			lines.push(`${el}.addEventListener('${r.type}', () => console.log('${r.log}')${optionsText(r)});`);
		} else {
			lines.push(
				`${el}.addEventListener('${r.type}', (e) => {`,
				`  console.log('${r.log}');`,
				`  ${ACTION_CALL[r.action]}`,
				`}${optionsText(r)});`
			);
		}
	}
	const dispatched = p.dispatches.filter((d) => d.how === 'dispatch');
	if (dispatched.length) {
		lines.push('');
		for (const d of dispatched) {
			const init = d.bubbles ? `, { bubbles: true }` : '';
			lines.push(`${camel(d.target)}.dispatchEvent(new Event('${d.type}'${init}));`);
		}
	}
	return lines.join('\n');
}

const camel = (id: string): string => `${id}El`;

function markup(p: Params): string {
	const lines: string[] = [];
	p.chain.forEach((id, i) => {
		const tag = p.tags[i] ?? 'div';
		const pad = '  '.repeat(i);
		lines.push(i === p.chain.length - 1 ? `${pad}<${tag} id="${id}">OK</${tag}>` : `${pad}<${tag} id="${id}">`);
	});
	for (let i = p.chain.length - 2; i >= 0; i -= 1) lines.push(`${'  '.repeat(i)}</${p.tags[i] ?? 'div'}>`);
	return lines.join('\n');
}

function describe(p: Params): string {
	const clicks = p.dispatches.filter((d) => d.how === 'click');
	const after = clicks.length
		? `После того как код выполнился, пользователь ${clicks
				.map((d, i) => `${i === 0 ? '' : 'затем '}кликает по элементу \`#${d.target}\``)
				.join(', ')}.`
		: 'Код выполняется целиком, вызовы `dispatchEvent` идут последними строками.';
	return [
		'Разметка страницы:',
		'',
		'```html',
		markup(p),
		'```',
		'',
		'Скрипт страницы:',
		'',
		'```js',
		program(p),
		'```',
		'',
		after,
		'',
		'Считаем: других обработчиков на странице нет, кнопка не в форме, у клика нет других последствий; браузер современный и следует стандарту DOM.',
		'',
		'Введите, что будет выведено в консоль, — по строке на вызов `console.log`, в порядке вывода, без кавычек.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Reference.

const PYTHON_REFERENCE = `import json
import sys

data = json.loads(sys.stdin.read())
parent = {}
for i, node in enumerate(data["chain"]):
    parent[node] = data["chain"][i - 1] if i else None

# Event listener lists per node, as addEventListener builds them: a callback already registered on the node for the
# same type with the same capture flag is not added again.
lists = {node: [] for node in data["chain"]}
for r in data["registrations"]:
    entries = lists[r["node"]]
    if any(e["type"] == r["type"] and e["fn"] == r["fn"] and e["capture"] == r["capture"] for e in entries):
        continue
    entries.append(dict(r, removed=False))

out = []
for ev in data["events"]:
    path = []
    node = ev["target"]
    while node is not None:
        path.append(node)
        node = parent[node]
    flags = {"stop": False, "immediate": False}

    def inner(node, phase):
        if flags["stop"]:
            return
        for e in list(lists[node]):
            if e["removed"] or e["type"] != ev["type"]:
                continue
            if phase == "capturing" and not e["capture"]:
                continue
            if phase == "bubbling" and e["capture"]:
                continue
            if e["once"]:
                e["removed"] = True
            out.append(e["log"])
            if e["action"] == "stop":
                flags["stop"] = True
            elif e["action"] == "immediate":
                flags["stop"] = True
                flags["immediate"] = True
            if flags["immediate"]:
                return

    for node in reversed(path):
        inner(node, "capturing")
    for node in path:
        if node != ev["target"] and not ev["bubbles"]:
            continue
        inner(node, "bubbling")

print("\\n".join(out))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let chosen: { p: Params; answer: string[]; wrong: Record<string, string[] | null> } | null = null;
	for (let tries = 0; tries < 400 && chosen === null; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const { answer, edge, wrong } = answers(p);
		if (!acceptable(p, answer, edge)) continue;
		if (required.some((id) => wrong[id] === null)) continue;
		chosen = { p, answer, wrong };
	}
	if (chosen === null) {
		const p = fallback(rng, input.grade, input.classId);
		const { answer, wrong } = answers(p);
		chosen = { p, answer, wrong };
	}
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p), code: null },
		answer: { kind: 'sequence', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({
				chain: p.chain,
				registrations: p.registrations.map((r) => ({
					node: r.node,
					type: r.type,
					capture: r.capture,
					once: r.once,
					fn: r.fn,
					action: r.action,
					log: r.log
				})),
				events: p.dispatches.map((d) => ({ target: d.target, type: d.type, bubbles: d.bubbles }))
			})
		}),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
