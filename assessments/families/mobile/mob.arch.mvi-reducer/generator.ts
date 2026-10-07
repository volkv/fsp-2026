// A unidirectional data flow in Kotlin: a sealed `Intent`, an immutable `data class State`, a pure reducer, one-shot
// effects in their own queue, stale responses dropped by request number, an optimistic update rolled back by its
// inverse, and a `StateFlow` that conflates bursts and skips equal states. What the program prints after each intent
// is the answer; the mechanism that decides it is the essential class, names and values are surface.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { kotlinOutputProbe, kotlinProgram } from '../../_lib/kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Program {
	lines: string[];
	answer: string[];
	/** Outputs of the misconceptions that apply to the class; a missing one does not apply. */
	wrong: Record<string, string[]>;
}

const str = (s: string): string => JSON.stringify(s);

// Stale responses: a search bumps the request number, a retry keeps it, a response with another number is dropped.

type SearchIntent =
	{ kind: 'search'; query: string } | { kind: 'retry' } | { kind: 'loaded'; request: number; found: number };

interface SearchRules {
	staleApplied: boolean;
	retryNewRequest: boolean;
	staleStopsLoading: boolean;
	copyResetsDefaults: boolean;
}

function searchRun(intents: readonly SearchIntent[], resetFound: boolean, r: SearchRules): string[] {
	const initial = { query: '', request: 0, found: -1, loading: false };
	let s = { ...initial };
	const copy = (change: Partial<typeof s>): typeof s => ({ ...(r.copyResetsDefaults ? initial : s), ...change });
	return intents.map((i) => {
		if (i.kind === 'search')
			s = copy({ query: i.query, request: s.request + 1, loading: true, ...(resetFound ? { found: -1 } : {}) });
		else if (i.kind === 'retry') s = copy({ loading: true, ...(r.retryNewRequest ? { request: s.request + 1 } : {}) });
		else if (i.request !== s.request && !r.staleApplied) s = r.staleStopsLoading ? copy({ loading: false }) : s;
		else s = copy({ found: i.found, loading: false });
		return `${s.query}#${s.request} found=${s.found}${s.loading ? ' loading' : ''}`;
	});
}

const SEARCH_RIGHT: SearchRules = {
	staleApplied: false,
	retryNewRequest: false,
	staleStopsLoading: false,
	copyResetsDefaults: false
};

function staleResponse(rng: Rng): Program {
	const queries = rng.sample(['phone', 'case', 'cable', 'lamp', 'desk', 'chair', 'mug', 'bag'], 3);
	const resetFound = rng.bool();
	const intents: SearchIntent[] = [{ kind: 'search', query: queries[0] as string }];
	// Every search and retry sends a request; responses arrive in any order, an old one possibly after a newer search.
	const inFlight = [1];
	let request = 1;
	let q = 1;
	const count = rng.int(6, 7);
	while (intents.length < count) {
		const roll = rng.next();
		if ((roll < 0.3 || inFlight.length === 0) && q < queries.length) {
			intents.push({ kind: 'search', query: queries[q] as string });
			q += 1;
			request += 1;
			inFlight.push(request);
		} else if (roll < 0.45 || inFlight.length === 0) {
			intents.push({ kind: 'retry' });
			inFlight.push(request);
		} else {
			const at = rng.int(0, inFlight.length - 1);
			const [answered] = inFlight.splice(at, 1);
			intents.push({ kind: 'loaded', request: answered as number, found: rng.int(0, 40) });
		}
	}
	const run = (change: Partial<SearchRules>): string[] =>
		searchRun(intents, resetFound, { ...SEARCH_RIGHT, ...change });
	const render = (i: SearchIntent): string =>
		i.kind === 'search'
			? `Intent.Search(${str(i.query)})`
			: i.kind === 'retry'
				? 'Intent.Retry'
				: `Intent.Loaded(request = ${i.request}, found = ${i.found})`;
	return {
		lines: [
			'sealed interface Intent {',
			'    data class Search(val query: String) : Intent',
			'    data object Retry : Intent',
			'    data class Loaded(val request: Int, val found: Int) : Intent',
			'}',
			'',
			'data class State(val query: String = "", val request: Int = 0, val found: Int = -1, val loading: Boolean = false)',
			'',
			'fun reduce(s: State, i: Intent): State = when (i) {',
			`    is Intent.Search -> s.copy(query = i.query, request = s.request + 1, ${resetFound ? 'found = -1, ' : ''}loading = true)`,
			'    Intent.Retry -> s.copy(loading = true)',
			'    is Intent.Loaded -> if (i.request != s.request) s else s.copy(found = i.found, loading = false)',
			'}',
			'',
			'fun render(s: State) = "${s.query}#${s.request} found=${s.found}" + if (s.loading) " loading" else ""',
			'',
			'fun main() {',
			'    var state = State()',
			'    val intents = listOf<Intent>(',
			...intents.map((i, k) => `        ${render(i)}${k < intents.length - 1 ? ',' : ''}`),
			'    )',
			'    for (i in intents) {',
			'        state = reduce(state, i)',
			'        println(render(state))',
			'    }',
			'}'
		],
		answer: run({}),
		wrong: {
			'stale-applied': run({ staleApplied: true }),
			'retry-new-request': run({ retryNewRequest: true }),
			'stale-stops-loading': run({ staleStopsLoading: true }),
			'copy-resets-defaults': run({ copyResetsDefaults: true })
		}
	};
}

// Optimistic likes: a like counts at once, a failure rolls back by the inverse change and posts an effect.

type LikeIntent = { kind: 'like' | 'saved' | 'failed'; post: number };

interface LikeRules {
	rollbackSnapshot: boolean;
	doubleLikeCounts: boolean;
}

function likeRun(posts: readonly [number, number][], intents: readonly LikeIntent[], r: LikeRules): string[] {
	let liked = new Set<number>();
	let likes = new Map(posts);
	/** The state before the like that a failure rolls back to, under the misconception. */
	const before = new Map<number, { liked: Set<number>; likes: Map<number, number> }>();
	return intents.map((i) => {
		let effect: string | null = null;
		if (i.kind === 'like') {
			if (!liked.has(i.post) || r.doubleLikeCounts) {
				before.set(i.post, { liked: new Set(liked), likes: new Map(likes) });
				liked = new Set([...liked, i.post]);
				likes = new Map(likes).set(i.post, (likes.get(i.post) ?? 0) + 1);
			}
		} else if (i.kind === 'saved') effect = `saved:${i.post}`;
		else {
			const snapshot = before.get(i.post);
			if (r.rollbackSnapshot && snapshot) {
				liked = snapshot.liked;
				likes = snapshot.likes;
			} else {
				liked = new Set([...liked].filter((p) => p !== i.post));
				likes = new Map(likes).set(i.post, (likes.get(i.post) ?? 0) - 1);
			}
			effect = `error:${i.post}`;
		}
		const text = [...likes].map(([p, n]) => (liked.has(p) ? `${p}:${n}+` : `${p}:${n}`)).join(' ');
		return effect === null ? text : `${text} | ${effect}`;
	});
}

function optimisticRollback(rng: Rng): Program {
	const ids = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
	const posts = ids.map((id) => [id, rng.int(0, 30)] as [number, number]);
	const intents: LikeIntent[] = [];
	const pending = new Set<number>();
	const liked = new Set<number>();
	const count = rng.int(6, 8);
	// A failure comes after a later like of another post, and one post is liked twice before its answer.
	while (intents.length < count) {
		const roll = rng.next();
		const open = [...pending];
		if (roll < 0.45 || open.length === 0) {
			const post = rng.pick(ids);
			intents.push({ kind: 'like', post });
			if (!liked.has(post)) {
				liked.add(post);
				pending.add(post);
			}
		} else {
			const post = rng.pick(open);
			const failed = rng.bool(0.6);
			intents.push({ kind: failed ? 'failed' : 'saved', post });
			pending.delete(post);
			if (failed) liked.delete(post);
		}
	}
	const run = (change: Partial<LikeRules>): string[] =>
		likeRun(posts, intents, { rollbackSnapshot: false, doubleLikeCounts: false, ...change });
	const name = { like: 'Like', saved: 'Saved', failed: 'Failed' } as const;
	return {
		lines: [
			'sealed interface Intent {',
			'    data class Like(val post: Int) : Intent',
			'    data class Saved(val post: Int) : Intent',
			'    data class Failed(val post: Int) : Intent',
			'}',
			'',
			`data class State(val liked: Set<Int> = emptySet(), val likes: Map<Int, Int> = mapOf(${posts.map(([p, n]) => `${p} to ${n}`).join(', ')}))`,
			'',
			'fun reduce(s: State, i: Intent): Pair<State, String?> = when (i) {',
			'    is Intent.Like ->',
			'        if (i.post in s.liked) s to null',
			'        else s.copy(liked = s.liked + i.post, likes = s.likes + (i.post to s.likes.getValue(i.post) + 1)) to null',
			'    is Intent.Saved -> s to "saved:${i.post}"',
			'    is Intent.Failed ->',
			'        s.copy(liked = s.liked - i.post, likes = s.likes + (i.post to s.likes.getValue(i.post) - 1)) to "error:${i.post}"',
			'}',
			'',
			'fun render(s: State) = s.likes.map { (post, n) -> if (post in s.liked) "$post:$n+" else "$post:$n" }.joinToString(" ")',
			'',
			'fun main() {',
			'    var state = State()',
			`    val intents = listOf<Intent>(${intents.map((i) => `Intent.${name[i.kind]}(${i.post})`).join(', ')})`,
			'    for (i in intents) {',
			'        val (next, effect) = reduce(state, i)',
			'        state = next',
			'        println(render(state) + (effect?.let { " | $it" } ?: ""))',
			'    }',
			'}'
		],
		answer: run({}),
		wrong: {
			'rollback-snapshot': run({ rollbackSnapshot: true }),
			'double-like-counts': run({ doubleLikeCounts: true })
		}
	};
}

// One-shot effects: the screen gets the current state on attach, effects wait in a queue and are shown once.

type StoreOp =
	{ kind: 'attach'; screen: string } | { kind: 'detach' } | { kind: 'add'; item: string } | { kind: 'checkout' };

interface StoreRules {
	effectsReplayed: boolean;
	stateHistoryReplayed: boolean;
	effectsLostDetached: boolean;
	effectAfterReset: boolean;
}

function storeRun(ops: readonly StoreOp[], r: StoreRules): string[] {
	const out: string[] = [];
	let cart: string[] = [];
	let screen: string | null = null;
	let queue: string[] = [];
	const all: string[] = [];
	let missed: string[][] = [];
	const show = (): void => {
		if (screen === null) return;
		out.push(`${screen} [${cart.join(', ')}]`);
		for (const e of queue) out.push(`${screen} effect ${e}`);
		queue = [];
	};
	for (const op of ops) {
		if (op.kind === 'attach') {
			screen = op.screen;
			if (r.stateHistoryReplayed) for (const c of missed.slice(0, -1)) out.push(`${screen} [${c.join(', ')}]`);
			missed = [];
			if (r.effectsReplayed) queue = [...all];
			show();
		} else if (op.kind === 'detach') screen = null;
		else {
			if (op.kind === 'add') cart = [...cart, op.item];
			else {
				const effect = `pay:${r.effectAfterReset ? 0 : cart.length}`;
				all.push(effect);
				if (screen !== null || !r.effectsLostDetached) queue.push(effect);
				cart = [];
			}
			if (screen === null) missed.push(cart);
			show();
		}
	}
	return out;
}

function effectsReplay(rng: Rng): Program {
	const items = rng.sample(['tea', 'cup', 'jam', 'milk', 'bread', 'salt', 'rice', 'soap'], 5);
	const screens = rng.sample(['cart', 'menu', 'home'], 2);
	const ops: StoreOp[] = [{ kind: 'attach', screen: screens[0] as string }];
	let next = 0;
	const add = (): void => {
		ops.push({ kind: 'add', item: items[next % items.length] as string });
		next += 1;
	};
	add();
	// A rotation while the order goes out: the effect is posted to a detached screen.
	ops.push({ kind: 'detach' });
	for (let i = rng.int(0, 1); i > 0; i -= 1) add();
	ops.push({ kind: 'checkout' });
	if (rng.bool()) add();
	// Back on screen: the latest state and the waiting effect; attached again: the state only.
	ops.push({ kind: 'attach', screen: rng.pick(screens) });
	if (rng.bool(0.3)) {
		add();
		ops.push({ kind: 'checkout' });
	}
	ops.push({ kind: 'detach' }, { kind: 'attach', screen: rng.pick(screens) });
	const run = (change: Partial<StoreRules>): string[] =>
		storeRun(ops, {
			effectsReplayed: false,
			stateHistoryReplayed: false,
			effectsLostDetached: false,
			effectAfterReset: false,
			...change
		});
	const call = (op: StoreOp): string =>
		op.kind === 'attach'
			? `attach(${str(op.screen)})`
			: op.kind === 'detach'
				? 'detach()'
				: op.kind === 'add'
					? `dispatch(Add(${str(op.item)}))`
					: 'dispatch(Checkout)';
	return {
		lines: [
			'sealed interface Intent',
			'data class Add(val item: String) : Intent',
			'data object Checkout : Intent',
			'data class State(val cart: List<String> = emptyList())',
			'class Store {',
			'    private var state = State()',
			'    private val effects = ArrayDeque<String>()',
			'    private var screen: String? = null',
			'    fun attach(name: String) { screen = name; show() }',
			'    fun detach() { screen = null }',
			'    fun dispatch(i: Intent) {',
			'        state = when (i) {',
			'            is Add -> state.copy(cart = state.cart + i.item)',
			'            Checkout -> State().also { effects.addLast("pay:${state.cart.size}") }',
			'        }',
			'        show()',
			'    }',
			'    private fun show() {',
			'        val name = screen ?: return',
			'        println("$name ${state.cart}")',
			'        while (effects.isNotEmpty()) println("$name effect ${effects.removeFirst()}")',
			'    }',
			'}',
			'fun main() = with(Store()) {',
			...ops.map((op) => `    ${call(op)}`),
			'}'
		],
		answer: run({}),
		wrong: {
			'effects-replayed': run({ effectsReplayed: true }),
			'state-history-replayed': run({ stateHistoryReplayed: true }),
			'effects-lost-detached': run({ effectsLostDetached: true }),
			'effect-after-reset': run({ effectAfterReset: true })
		}
	};
}

// StateFlow: a collector sees the latest value when it runs, never an equal one twice.

type TabIntent = { kind: 'select'; tab: string } | { kind: 'badge'; count: number };

interface FlowRules {
	noConflation: boolean;
	equalRendered: boolean;
	initialSkipped: boolean;
	copyResetsDefaults: boolean;
}

function flowRun(groups: readonly (readonly TabIntent[])[], r: FlowRules): string[] {
	const initial = { tab: 'home', badge: 0 };
	let s = { ...initial };
	const out: string[] = [];
	let last: string | null = null;
	const emit = (): void => {
		const text = `${s.tab} ${s.badge}`;
		if (text !== last || r.equalRendered) out.push(text);
		last = text;
	};
	if (!r.initialSkipped) emit();
	else last = `${s.tab} ${s.badge}`;
	for (const group of groups) {
		let changed = false;
		for (const i of group) {
			const base = r.copyResetsDefaults ? initial : s;
			const next = i.kind === 'select' ? { ...base, tab: i.tab } : { ...base, badge: i.count };
			// An equal value does not even wake the collector up.
			const equal = next.tab === s.tab && next.badge === s.badge;
			s = next;
			if (!equal || r.equalRendered) {
				changed = true;
				if (r.noConflation) emit();
			}
		}
		if (changed && !r.noConflation) emit();
	}
	return out;
}

function stateFlowConflation(rng: Rng): Program {
	const tabs = rng.sample(['cart', 'feed', 'chat', 'profile', 'search'], 3);
	const groups: TabIntent[][] = [];
	let tab = 'home';
	let badge = 0;
	const intent = (): TabIntent => {
		const roll = rng.next();
		if (roll < 0.2) return rng.bool() ? { kind: 'select', tab } : { kind: 'badge', count: badge };
		if (roll < 0.55) {
			tab = rng.pick(tabs.filter((t) => t !== tab));
			return { kind: 'select', tab };
		}
		badge = rng.pick([1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => n !== badge));
		return { kind: 'badge', count: badge };
	};
	const sizes = rng.shuffle([1, 2, rng.int(1, 3), 3]).slice(0, rng.int(3, 4));
	for (const size of sizes) groups.push(Array.from({ length: size }, intent));
	const run = (change: Partial<FlowRules>): string[] =>
		flowRun(groups, {
			noConflation: false,
			equalRendered: false,
			initialSkipped: false,
			copyResetsDefaults: false,
			...change
		});
	const send = (i: TabIntent): string =>
		`    state.value = reduce(state.value, ${i.kind === 'select' ? `Intent.Select(${str(i.tab)})` : `Intent.Badge(${i.count})`})`;
	return {
		lines: [
			'import kotlinx.coroutines.*',
			'import kotlinx.coroutines.flow.*',
			'',
			'sealed interface Intent {',
			'    data class Select(val tab: String) : Intent',
			'    data class Badge(val count: Int) : Intent',
			'}',
			'data class State(val tab: String = "home", val badge: Int = 0)',
			'',
			'fun reduce(s: State, i: Intent): State = when (i) {',
			'    is Intent.Select -> s.copy(tab = i.tab)',
			'    is Intent.Badge -> s.copy(badge = i.count)',
			'}',
			'',
			'fun main() = runBlocking {',
			'    val state = MutableStateFlow(State())',
			'    val job = launch { state.collect { println("${it.tab} ${it.badge}") } }',
			'    yield()',
			...groups.flatMap((g) => [...g.map(send), '    yield()']),
			'    job.cancel()',
			'}'
		],
		answer: run({}),
		wrong: {
			'no-conflation': run({ noConflation: true }),
			'equal-rendered': run({ equalRendered: true }),
			'initial-skipped': run({ initialSkipped: true }),
			'copy-resets-defaults': run({ copyResetsDefaults: true })
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'stale-response': staleResponse,
	'optimistic-rollback': optimisticRollback,
	'effects-replay': effectsReplay,
	'stateflow-conflation': stateFlowConflation
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'stale-response': ['stale-applied', 'copy-resets-defaults'],
	'optimistic-rollback': ['rollback-snapshot', 'double-like-counts'],
	'effects-replay': ['effects-replayed', 'effect-after-reset'],
	'stateflow-conflation': ['no-conflation', 'equal-rendered']
};

/** Senior programs: 20–35 lines. */
const LINES = { min: 20, max: 35 };

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = PROGRAMS[input.classId] as (rng: Rng) => Program;
	const required = REQUIRED[input.classId] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const program = make(rng);
		if (program.lines.length < LINES.min || program.lines.length > LINES.max) continue;
		const key = program.answer.join('\n');
		const differs = (id: string): boolean => (program.wrong[id] ?? program.answer).join('\n') !== key;
		if (!required.every(differs)) continue;
		const source = program.lines.join('\n');
		const run = kotlinProgram(source);
		const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: 'Что напечатает программа на Kotlin? Введите вывод построчно, как он появится на экране.',
				code: { language: 'kotlin', source }
			},
			answer: toAnswer(program.answer)
		});
		return {
			instance,
			reference: () => kotlinOutputProbe(run),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						// A misconception that gives the right output on this instance does not apply to it.
						const lines = program.wrong[id];
						return [
							id,
							lines === undefined || !differs(id) ? null : { kind: 'answer' as const, answer: toAnswer(lines) }
						];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
