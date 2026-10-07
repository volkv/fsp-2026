// `when` and sealed hierarchies in Kotlin: a screen state as a sealed type, `when` as an expression with smart casts,
// equality branches against data objects, the first matching branch wins (no fall-through, no "most specific" choice),
// ranges with `..` and `until` in branches, `else`. The mechanism that decides the output is the essential class;
// names, values and the order of the elements are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { type TraceProgram, traceBuild } from '../../_lib/mob-kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const main = (body: string[]): string[] => ['fun main() {', ...body.map((l) => `    ${l}`), '}'];

/** States of a screen: `when` with smart casts and one equality branch against a data class instance. */
function equalityBranch(rng: Rng): TraceProgram {
	type State = { kind: 'loading' } | { kind: 'content'; items: number } | { kind: 'failure'; code: number };
	const onContent = rng.bool();
	const special = onContent ? 0 : rng.pick([401, 403, 404]);
	const specialText = onContent
		? rng.pick(['empty', 'nothing', 'no items'])
		: rng.pick(['sign in', 'denied', 'missing']);
	const items = rng.int(1, 30);
	const code = rng.pick([500, 502, 503]);
	const states = rng.shuffle<State>([
		{ kind: 'loading' },
		{ kind: 'content', items: onContent ? 0 : items },
		{ kind: 'content', items: onContent ? items : rng.int(31, 60) },
		{ kind: 'failure', code: onContent ? code : special },
		{ kind: 'failure', code: onContent ? rng.pick([400, 404, 408]) : code }
	]);
	const literal = (s: State): string =>
		s.kind === 'loading' ? 'Loading' : s.kind === 'content' ? `Content(${s.items})` : `Failure(${s.code})`;
	const loadingText = rng.pick(['loading', 'wait', 'spinner']);
	const text = (s: State, identity: boolean): string => {
		if (s.kind === 'loading') return loadingText;
		if (!identity && onContent && s.kind === 'content' && s.items === special) return specialText;
		if (!identity && !onContent && s.kind === 'failure' && s.code === special) return specialText;
		return s.kind === 'content' ? `${s.items} items` : `error ${s.code}`;
	};
	return {
		lines: [
			'sealed interface UiState',
			'data object Loading : UiState',
			'data class Content(val items: Int) : UiState',
			'data class Failure(val code: Int) : UiState',
			...main([
				`val states = listOf(${states.map(literal).join(', ')})`,
				'for (s in states) {',
				'    println(when (s) {',
				`        Loading -> "${loadingText}"`,
				`        ${onContent ? 'Content(0)' : `Failure(${special})`} -> "${specialText}"`,
				'        is Content -> "${s.items} items"',
				'        is Failure -> "error ${s.code}"',
				'    })',
				'}'
			])
		],
		answer: states.map((s) => text(s, false)),
		wrong: { 'branch-identity': states.map((s) => text(s, true)) }
	};
}

/** A `when` without a subject with overlapping conditions: only the first true branch runs. */
function firstMatch(rng: Rng): TraceProgram {
	const t1 = rng.pick([5, 9, 10, 20]);
	const t2 = rng.pick([50, 99, 100]);
	const [l1, l2] = rng.sample(['many', 'lots', 'busy', 'full', 'hot'], 2) as [string, string];
	const zero = rng.pick(['none', 'empty', 'clear']);
	// Values: above both thresholds, between them, zero and a small one, in random order.
	const values = rng.shuffle([rng.int(t2 + 1, 300), rng.int(t1 + 1, t2), 0, rng.int(1, t1), rng.int(t2 + 1, 300)]);
	type Branch = { test: (n: number) => boolean; out: (n: number) => string; tight: number };
	const branches: Branch[] = [
		{ test: (n) => n > t1, out: () => l1, tight: 1 },
		{ test: (n) => n > t2, out: () => l2, tight: 2 },
		{ test: (n) => n === 0, out: () => zero, tight: 3 }
	];
	const elseOut = (n: number): string => `count ${n}`;
	const first = (n: number): string[] => [branches.find((b) => b.test(n))?.out(n) ?? elseOut(n)];
	const tightest = (n: number): string[] => {
		const matching = branches.filter((b) => b.test(n)).sort((a, b) => b.tight - a.tight);
		return [matching[0]?.out(n) ?? elseOut(n)];
	};
	const all = (n: number): string[] => {
		const matching = branches.filter((b) => b.test(n)).map((b) => b.out(n));
		return matching.length > 0 ? matching : [elseOut(n)];
	};
	return {
		lines: main([
			`val unread = listOf(${values.join(', ')})`,
			'for (n in unread) {',
			'    when {',
			`        n > ${t1} -> println("${l1}")`,
			`        n > ${t2} -> println("${l2}")`,
			`        n == 0 -> println("${zero}")`,
			'        else -> println("count $n")',
			'    }',
			'}'
		]),
		answer: values.flatMap(first),
		wrong: { 'most-specific-wins': values.flatMap(tightest), 'all-matching-run': values.flatMap(all) }
	};
}

/** Ranges in branches: `a..b` includes the end, `a until b` does not; a constant after a covering range never wins. */
function ranges(rng: Rng): TraceProgram {
	const specific = rng.pick([401, 403, 404, 429]);
	const [okText, redirectText, clientText, specificText, serverText] = [
		rng.pick(['ok', 'done', 'success']),
		rng.pick(['redirect', 'moved']),
		rng.pick(['client', 'bad request']),
		rng.pick(['not found', 'denied', 'too many']),
		rng.pick(['server', 'retry later'])
	];
	const codes = rng.shuffle([
		rng.pick([200, 201, 204, 299]),
		rng.pick([301, 302, 304]),
		400,
		specific,
		rng.pick([500, 502, 503])
	]);
	const classify = (code: number, untilInclusive: boolean, specificFirst: boolean): string => {
		if (code >= 200 && code <= 299) return okText;
		if (code >= 300 && (untilInclusive ? code <= 400 : code < 400)) return redirectText;
		if (specificFirst && code === specific) return specificText;
		if (code >= 400 && code <= 499) return clientText;
		if (code === specific) return specificText;
		return serverText;
	};
	return {
		lines: main([
			`val codes = listOf(${codes.join(', ')})`,
			'for (code in codes) {',
			'    val text = when (code) {',
			`        in 200..299 -> "${okText}"`,
			`        in 300 until 400 -> "${redirectText}"`,
			`        in 400..499 -> "${clientText}"`,
			`        ${specific} -> "${specificText}"`,
			`        else -> "${serverText}"`,
			'    }',
			'    println(text)',
			'}'
		]),
		answer: codes.map((c) => classify(c, false, false)),
		wrong: {
			'until-inclusive': codes.map((c) => classify(c, true, false)),
			'most-specific-wins': codes.map((c) => classify(c, false, true))
		}
	};
}

/** `is` against a class and its subclass: the branch for the parent comes first and takes the subclass too. */
function typeOrder(rng: Rng): TraceProgram {
	type Screen = { kind: 'content'; items: number } | { kind: 'failure'; code: number } | { kind: 'offline' };
	const offlineCode = rng.pick([0, 503, 599]);
	const offlineText = rng.pick(['offline', 'no network', 'airplane']);
	const screens = rng.shuffle<Screen>([
		{ kind: 'content', items: rng.int(1, 40) },
		{ kind: 'offline' },
		{ kind: 'failure', code: rng.pick([400, 404, 500]) },
		{ kind: 'content', items: rng.int(41, 90) },
		...(rng.bool() ? [{ kind: 'offline' } as Screen] : [])
	]);
	const literal = (s: Screen): string =>
		s.kind === 'content' ? `Content(${s.items})` : s.kind === 'failure' ? `Failure(${s.code})` : 'Offline()';
	const content = (items: number): string => `items ${items}`;
	const failure = (code: number): string => `error ${code}`;
	const run = (mode: 'first' | 'specific' | 'all'): string[] =>
		screens.flatMap((s) => {
			if (s.kind === 'content') return [content(s.items)];
			if (s.kind === 'failure') return [failure(s.code)];
			if (mode === 'first') return [failure(offlineCode)];
			if (mode === 'specific') return [offlineText];
			return [failure(offlineCode), offlineText];
		});
	return {
		lines: [
			'sealed class Screen',
			'class Content(val items: Int) : Screen()',
			'open class Failure(val code: Int) : Screen()',
			`class Offline : Failure(${offlineCode})`,
			'',
			...main([
				`val screens = listOf(${screens.map(literal).join(', ')})`,
				'for (s in screens) {',
				'    when (s) {',
				'        is Content -> println("items ${s.items}")',
				'        is Failure -> println("error ${s.code}")',
				`        is Offline -> println("${offlineText}")`,
				'    }',
				'}'
			])
		],
		answer: run('first'),
		wrong: { 'most-specific-wins': run('specific'), 'all-matching-run': run('all') }
	};
}

function program(rng: Rng, _grade: string, classId: string): TraceProgram {
	if (classId === 'equality-branch') return equalityBranch(rng);
	if (classId === 'first-match') return firstMatch(rng);
	if (classId === 'ranges') return ranges(rng);
	return typeOrder(rng);
}

export function build(input: GenerateInput): Built {
	return traceBuild(descriptor, input, program);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
