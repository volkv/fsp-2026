// Side effects in Jetpack Compose: the events of `LaunchedEffect`, `DisposableEffect`, `SideEffect` and timers with and
// without `rememberUpdatedState` over a timeline of recompositions, leaving and re-entering the composition.
// A keyed effect restarts when its key changes (the old one ends first), a `Unit` key starts once per stay in the
// composition, a skipped recomposition runs no `SideEffect`, a finished coroutine has nothing to cancel, a timer calls
// the callback it captured unless it reads it through `rememberUpdatedState`. The answer is computed by the model
// below and proved by an independent Python program (an event queue over the same timeline).
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

interface Theme {
	screen: string;
	id: string;
	show: string;
	titles: readonly string[];
	code: Readonly<Record<string, readonly string[]>>;
}

const THEMES: readonly Theme[] = [
	{
		screen: 'OrderScreen',
		id: 'orderId',
		show: 'showMap',
		titles: ['Заказ', 'Ваш заказ', 'Доставка', 'Курьер в пути'],
		code: {
			load: ['repository.observe(orderId).collect { order.value = it }'],
			watch: ['tracker.watch(orderId)', 'onDispose { tracker.unwatch(orderId) }'],
			sync: ['syncer.keepFresh()'],
			focus: ['keyboard.lock()', 'onDispose { keyboard.unlock() }'],
			map: ['map.attach()', 'onDispose { map.detach() }'],
			follow: ['map.followCourier()']
		}
	},
	{
		screen: 'ChatScreen',
		id: 'chatId',
		show: 'showMembers',
		titles: ['Чат', 'Команда', 'Поддержка', 'Друзья'],
		code: {
			load: ['messages.stream(chatId).collect { list.value = it }'],
			watch: ['presence.join(chatId)', 'onDispose { presence.leave(chatId) }'],
			sync: ['typing.listen()'],
			focus: ['notifications.mute()', 'onDispose { notifications.unmute() }'],
			map: ['members.subscribe()', 'onDispose { members.unsubscribe() }'],
			follow: ['members.pollOnline()']
		}
	},
	{
		screen: 'PlayerScreen',
		id: 'trackId',
		show: 'showLyrics',
		titles: ['Плеер', 'Сейчас играет', 'Альбом', 'Радио'],
		code: {
			load: ['player.progress(trackId).collect { position.value = it }'],
			watch: ['session.bind(trackId)', 'onDispose { session.unbind(trackId) }'],
			sync: ['equalizer.observe()'],
			focus: ['audioFocus.request()', 'onDispose { audioFocus.abandon() }'],
			map: ['lyrics.open()', 'onDispose { lyrics.close() }'],
			follow: ['lyrics.scrollWithTrack()']
		}
	}
];

const HANDLERS = ['retry', 'close', 'report', 'refresh'];

interface Effect {
	label: string;
	kind: 'launched' | 'disposable';
	key: 'id' | 'unit';
	inIf: boolean;
	timer: { ms: number; via: 'direct' | 'updated' } | null;
}

interface Args {
	id: number;
	title: string;
	show: boolean;
	handler: string;
}
type Step =
	{ t: number; kind: 'args'; args: Args } | { t: number; kind: 'leave' } | { t: number; kind: 'enter'; args: Args };

interface Scenario {
	theme: Theme;
	effects: Effect[];
	hasIf: boolean;
	hasHandler: boolean;
	steps: Step[];
}

interface Rules {
	unitRestarts: boolean;
	keysIgnored: boolean;
	sideAlways: boolean;
	sideOnce: boolean;
	updatedIgnored: boolean;
	directFresh: boolean;
	noLeaveCleanup: boolean;
	cancelCompleted: boolean;
	unitOnceForever: boolean;
}
const RIGHT: Rules = {
	unitRestarts: false,
	keysIgnored: false,
	sideAlways: false,
	sideOnce: false,
	updatedIgnored: false,
	directFresh: false,
	noLeaveCleanup: false,
	cancelCompleted: false,
	unitOnceForever: false
};

interface Running {
	key: number | null;
	firesAt: number | null;
	captured: string;
	done: boolean;
	ghost: boolean;
}

const sameArgs = (a: Args, b: Args): boolean =>
	a.id === b.id && a.title === b.title && a.show === b.show && a.handler === b.handler;

function simulate(sc: Scenario, r: Rules): string[] {
	const out: string[] = [];
	const running = new Map<string, Running>();
	const startedOnce = new Set<string>();
	let current: Args | null = null;
	let composedOnce = false;
	const name = (e: Effect, key: number | null): string => (key === null ? e.label : `${e.label} ${key}`);
	const present = (e: Effect, args: Args): boolean => !e.inIf || args.show;

	const fireUntil = (t: number): void => {
		for (;;) {
			let next: [Effect, Running] | null = null;
			for (const e of sc.effects) {
				const run = running.get(e.label);
				if (!run || run.done || run.firesAt === null || run.firesAt >= t) continue;
				if (!next || run.firesAt < (next[1].firesAt ?? 0)) next = [e, run];
			}
			if (!next) return;
			const [e, run] = next;
			run.done = true;
			const latest = current?.handler ?? run.captured;
			const fresh = e.timer?.via === 'updated' ? !r.updatedIgnored : r.directFresh;
			out.push(`call ${fresh ? latest : run.captured}`);
		}
	};
	const forget = (e: Effect): void => {
		const run = running.get(e.label);
		running.delete(e.label);
		if (!run || run.ghost) return;
		if (e.kind === 'disposable') out.push(`dispose ${name(e, run.key)}`);
		else if (!run.done || r.cancelCompleted) out.push(`cancel ${name(e, run.key)}`);
	};
	const remember = (e: Effect, args: Args, t: number): void => {
		const key = e.key === 'id' ? args.id : null;
		const ghost = r.unitOnceForever && e.key === 'unit' && startedOnce.has(e.label);
		startedOnce.add(e.label);
		running.set(e.label, {
			key,
			firesAt: e.timer && !ghost ? t + e.timer.ms / 1000 : null,
			captured: args.handler,
			done: ghost,
			ghost
		});
		if (ghost) return;
		out.push(`${e.kind === 'disposable' ? 'enter' : 'start'} ${name(e, key)}`);
	};
	const side = (): void => {
		if (!r.sideOnce || !composedOnce) out.push('side');
		composedOnce = true;
	};

	for (const step of sc.steps) {
		fireUntil(step.t);
		if (step.kind === 'leave') {
			const leaving = sc.effects.filter((e) => running.has(e.label)).reverse();
			for (const e of leaving) {
				if (r.noLeaveCleanup) running.delete(e.label);
				else forget(e);
			}
			current = null;
			continue;
		}
		if (step.kind === 'enter') {
			current = step.args;
			for (const e of sc.effects) if (present(e, step.args)) remember(e, step.args, step.t);
			side();
			continue;
		}
		const before = current as Args;
		if (sameArgs(before, step.args)) {
			if (r.sideAlways) out.push('side');
			continue;
		}
		current = step.args;
		const forgets: Effect[] = [];
		const remembers: Effect[] = [];
		for (const e of sc.effects) {
			const was = running.has(e.label);
			const is = present(e, step.args);
			if (was && !is) forgets.push(e);
			else if (!was && is) remembers.push(e);
			else if (was && is) {
				const restart = e.key === 'unit' ? r.unitRestarts : r.keysIgnored || running.get(e.label)?.key !== step.args.id;
				if (restart) {
					forgets.push(e);
					remembers.push(e);
				}
			}
		}
		for (const e of [...forgets].reverse()) {
			if (r.noLeaveCleanup && !present(e, step.args)) running.delete(e.label);
			else forget(e);
		}
		for (const e of remembers) remember(e, step.args, step.t);
		side();
	}
	fireUntil(Number.POSITIVE_INFINITY);
	return out;
}

// Scenarios.

function scenario(rng: Rng, classId: string): Scenario {
	const theme = rng.pick(THEMES);
	const titles = rng.shuffle(theme.titles);
	const handlers = rng.shuffle(HANDLERS);
	const ids = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15], 4);
	let args: Args = {
		id: ids[0] as number,
		title: titles[0] as string,
		show: classId === 'conditional' ? rng.bool() : false,
		handler: handlers[0] as string
	};
	const steps: Step[] = [{ t: 0, kind: 'enter', args }];
	let t = 0;
	const push = (change: Partial<Args> | 'leave' | 'enter'): void => {
		t += 1;
		if (change === 'leave') steps.push({ t, kind: 'leave' });
		else if (change === 'enter') steps.push({ t, kind: 'enter', args });
		else {
			args = { ...args, ...change };
			steps.push({ t, kind: 'args', args });
		}
	};
	const otherTitle = (): string => titles.find((x) => x !== args.title) as string;
	const otherId = (): number => ids.find((x) => x !== args.id) as number;
	const otherHandler = (): string => handlers.find((x) => x !== args.handler) as string;
	const effects: Effect[] = [];
	const launched = (label: string, key: 'id' | 'unit', inIf = false): Effect => ({
		label,
		kind: 'launched',
		key,
		inIf,
		timer: null
	});
	const disposable = (label: string, key: 'id' | 'unit', inIf = false): Effect => ({
		label,
		kind: 'disposable',
		key,
		inIf,
		timer: null
	});

	if (classId === 'key-restart') {
		effects.push(launched('load', 'id'), disposable('watch', rng.pick(['id', 'unit'] as const)));
		effects.push(rng.bool() ? launched('sync', 'unit') : disposable('focus', 'unit'));
		const kinds = rng.shuffle(['title', 'id', 'same', rng.pick(['id', 'title', 'same'])]);
		for (const k of kinds) {
			if (k === 'title') push({ title: otherTitle() });
			else if (k === 'id') push({ id: otherId() });
			else push({});
		}
		if (rng.bool()) push({ id: ids[0] as number });
	} else if (classId === 'conditional') {
		if (rng.bool()) effects.push(launched('load', 'id'));
		effects.push(disposable('map', 'unit', true), launched('follow', 'unit', true));
		if (rng.bool()) effects.push(disposable('watch', 'id'));
		const toggles = rng.shuffle(['show', 'show', rng.pick(['title', 'same', 'id'])]);
		for (const k of toggles) {
			if (k === 'show') push({ show: !args.show });
			else if (k === 'title') push({ title: otherTitle() });
			else if (k === 'id') push({ id: otherId() });
			else push({});
		}
		if (!args.show) push({ show: true });
		push('leave');
		push('enter');
		if (rng.bool()) push({ show: false });
	} else if (classId === 'updated-state') {
		const direct = rng.int(2, 4) * 1000 + 500;
		const updated = rng.int(2, 4) * 1000 + 250;
		const [first, second] = rng.shuffle([
			{ label: 'timer', ms: direct, via: 'direct' as const },
			{ label: 'remind', ms: updated, via: 'updated' as const }
		]);
		for (const x of [first, second]) {
			if (x)
				effects.push({ label: x.label, kind: 'launched', key: 'unit', inIf: false, timer: { ms: x.ms, via: x.via } });
		}
		if (rng.bool()) effects.push(disposable('watch', 'id'));
		push({ handler: otherHandler() });
		push(rng.pick([{ title: otherTitle() }, { id: otherId() }, {}]));
		if (rng.bool()) push({ handler: otherHandler() });
	} else {
		// completed: a timer keyed by the id finishes before one change of the id and is cut by another.
		const ms = rng.pick([1500, 2500]);
		effects.push({ label: 'timer', kind: 'launched', key: 'id', inIf: false, timer: { ms, via: 'direct' } });
		effects.push(launched('load', 'id'));
		if (rng.bool()) effects.push(disposable('watch', 'unit'));
		const wait = Math.ceil(ms / 1000) - 1;
		if (rng.bool()) {
			// Cut first: the change comes before the timer fires; the next one comes after the new timer fired.
			push({ id: otherId() });
			t += wait;
			push({ id: otherId() });
		} else {
			// Finished first: the timer has fired before the change; the next change cuts the new timer.
			t += wait;
			push({ id: otherId() });
			push({ id: otherId() });
		}
		if (rng.bool()) push({ handler: otherHandler() });
		push(rng.bool() ? 'leave' : {});
	}
	const hasIf = effects.some((e) => e.inIf);
	const hasHandler = effects.some((e) => e.timer);
	return { theme, effects: rng.bool() ? effects : orderedShuffle(rng, effects), hasIf, hasHandler, steps };
}

/** Shuffles effects outside the `if` block; the block stays one contiguous group. */
function orderedShuffle(rng: Rng, effects: Effect[]): Effect[] {
	const outside = rng.shuffle(effects.filter((e) => !e.inIf));
	const inside = effects.filter((e) => e.inIf);
	if (!inside.length) return outside;
	const at = rng.int(0, outside.length);
	return [...outside.slice(0, at), ...inside, ...outside.slice(at)];
}

// Rendering.

function render(sc: Scenario): string {
	const th = sc.theme;
	const params = [`${th.id}: Int`, 'title: String'];
	if (sc.hasIf) params.push(`${th.show}: Boolean`);
	if (sc.hasHandler) params.push('onTimeout: () -> Unit');
	const lines = ['@Composable', `fun ${th.screen}(${params.join(', ')}) {`];
	if (sc.effects.some((e) => e.timer?.via === 'updated'))
		lines.push('    val currentOnTimeout by rememberUpdatedState(onTimeout)');
	lines.push('    Text(title)');
	const block = (e: Effect, indent: string): string[] => {
		const key = e.key === 'id' ? th.id : 'Unit';
		const head = `${indent}${e.kind === 'launched' ? 'LaunchedEffect' : 'DisposableEffect'}(${key}) { // ${e.label}`;
		const body = e.timer
			? [`delay(${e.timer.ms})`, e.timer.via === 'updated' ? 'currentOnTimeout()' : 'onTimeout()']
			: (th.code[e.label] ?? []);
		return [head, ...body.map((l) => `${indent}    ${l}`), `${indent}}`];
	};
	let inIf = false;
	for (const e of sc.effects) {
		if (e.inIf && !inIf) {
			lines.push(`    if (${th.show}) {`);
			inIf = true;
		}
		if (!e.inIf && inIf) {
			lines.push('    }');
			inIf = false;
		}
		lines.push(...block(e, e.inIf ? '        ' : '    '));
	}
	if (inIf) lines.push('    }');
	lines.push(`    SideEffect { analytics.screen(${th.id}) } // side`, '}');
	return lines.join('\n');
}

function callText(sc: Scenario, a: Args): string {
	const th = sc.theme;
	const parts = [`${th.id} = ${a.id}`, `title = ${JSON.stringify(a.title)}`];
	if (sc.hasIf) parts.push(`${th.show} = ${String(a.show)}`);
	if (sc.hasHandler) parts.push(`onTimeout = handlers.${a.handler}`);
	return `\`${th.screen}(${parts.join(', ')})\``;
}

function describe(sc: Scenario): string {
	const th = sc.theme;
	const stepLines = sc.steps.map((s) => {
		const at = `${s.t} с`;
		if (s.kind === 'leave') return `- ${at}: экран уходит из композиции;`;
		if (s.kind === 'enter')
			return s.t === 0
				? `- ${at}: экран впервые входит в композицию: ${callText(sc, s.args)};`
				: `- ${at}: экран снова входит в композицию: ${callText(sc, s.args)};`;
		return `- ${at}: родитель перекомпонуется и вызывает ${callText(sc, s.args)};`;
	});
	const hasTimer = sc.hasHandler;
	return [
		`Функция \`${th.screen}\` (код ниже) проходит такую последовательность:`,
		'',
		...stepLines,
		'- дальше ничего не меняется, пока не сработают все оставшиеся таймеры.',
		'',
		'Ответ — по модели Compose, а не по запуску на устройстве. Условия модели:',
		'',
		`- все параметры стабильны; если при вызове родителем все аргументы равны прежним (\`equals\`), \`${th.screen}\` пропускается${hasTimer ? '; `handlers.<имя>` — заранее созданные объекты, одно имя — тот же объект' : ''};`,
		'- на каждом шаге среда сначала завершает уходящие эффекты — в порядке, обратном порядку в коде, затем запускает новые — в порядке кода, затем выполняет `SideEffect`, если тело функции выполнялось;',
		hasTimer
			? '- корутины стартуют без задержки: таймер с `delay(d)`, запущенный на шаге в момент t, вызывает обработчик в момент t + d, если до этого его не отменили.'
			: '- корутины стартуют без задержки.',
		'',
		'Запишите события по одному в строке в порядке их наступления:',
		'',
		'- `start <метка>` и `cancel <метка>` — запуск корутины `LaunchedEffect` и отмена ещё не завершившейся корутины;',
		'- `enter <метка>` и `dispose <метка>` — выполнение блока `DisposableEffect` и его `onDispose`;',
		`- у эффекта с ключом \`${th.id}\` после метки через пробел — значение ключа этого эффекта, например \`start load 7\`; у ключа \`Unit\` — только метка;`,
		...(hasTimer ? ['- `call <имя>` — таймер вызвал обработчик `handlers.<имя>`;'] : []),
		'- `side` — выполнился блок `SideEffect`.',
		'',
		'Метка эффекта — комментарий в его первой строке.'
	].join('\n');
}

const PYTHON_REFERENCE = `import heapq
import json

sc = json.loads(input())
effects = sc["effects"]
order = {e["label"]: i for i, e in enumerate(effects)}
log = []
live = {}  # label -> dict(key, handler, finished)
queue = []  # (time, seq, kind, payload)
seq = 0
args = None


def push(time, kind, payload):
    global seq
    heapq.heappush(queue, (time, seq, kind, payload))
    seq += 1


for st in sc["steps"]:
    push(st["t"], "step", st)


def tag(e, key):
    return e["label"] if key is None else e["label"] + " " + str(key)


def stop(e):
    run = live.pop(e["label"])
    if e["kind"] == "disposable":
        log.append("dispose " + tag(e, run["key"]))
    elif not run["finished"]:
        log.append("cancel " + tag(e, run["key"]))


def launch(e, a, now):
    key = a["id"] if e["key"] == "id" else None
    run = {"key": key, "handler": a["handler"], "finished": False, "token": seq}
    live[e["label"]] = run
    log.append(("enter " if e["kind"] == "disposable" else "start ") + tag(e, key))
    if e["timer"]:
        push(now + e["timer"]["ms"] / 1000, "fire", (e["label"], run["token"]))


def wanted(a):
    return [e for e in effects if not e["inIf"] or a["show"]]


while queue:
    now, _, kind, payload = heapq.heappop(queue)
    if kind == "fire":
        label, ident = payload
        run = live.get(label)
        if run is None or run["token"] != ident:
            continue
        run["finished"] = True
        e = effects[order[label]]
        log.append("call " + (args["handler"] if e["timer"]["via"] == "updated" else run["handler"]))
        continue
    st = payload
    if st["kind"] == "leave":
        for e in sorted((effects[order[l]] for l in live), key=lambda e: -order[e["label"]]):
            stop(e)
        args = None
        continue
    new = st["args"]
    if st["kind"] == "args" and new == args:
        continue
    old_set = {e["label"] for e in wanted(args)} if st["kind"] == "args" else set()
    new_set = {e["label"] for e in wanted(new)}
    ending, starting = [], []
    for e in effects:
        l = e["label"]
        if l in old_set and l not in new_set:
            ending.append(e)
        elif l in new_set and l not in old_set:
            starting.append(e)
        elif l in old_set and e["key"] == "id" and live[l]["key"] != new["id"]:
            ending.append(e)
            starting.append(e)
    for e in sorted(ending, key=lambda e: -order[e["label"]]):
        stop(e)
    args = new
    for e in starting:
        launch(e, new, now)
    log.append("side")

print("\\n".join(log))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'unit-restarts': { unitRestarts: true },
	'keys-ignored': { keysIgnored: true },
	'side-always': { sideAlways: true },
	'side-once': { sideOnce: true },
	'updated-ignored': { updatedIgnored: true },
	'direct-fresh': { directFresh: true },
	'no-cleanup-on-leave': { noLeaveCleanup: true },
	'cancel-completed': { cancelCompleted: true },
	'unit-once-forever': { unitOnceForever: true }
};

const REQUIRED: Record<string, string[]> = {
	'middle/key-restart': ['keys-ignored', 'side-always', 'unit-restarts'],
	'middle/conditional': ['no-cleanup-on-leave', 'unit-once-forever'],
	'middle/updated-state': ['updated-ignored', 'direct-fresh'],
	'middle/completed': ['cancel-completed']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const sc = scenario(rng, input.classId);
		const answer = simulate(sc, RIGHT);
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(sc, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc), code: { language: 'kotlin', source: render(sc) } },
			answer: { kind: 'sequence', value: answer }
		});
		const stdin = JSON.stringify({ effects: sc.effects, steps: sc.steps });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
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
