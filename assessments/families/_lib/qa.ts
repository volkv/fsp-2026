// QA practice (`qa_mutation`): the Python programs a family builds around its reference and its mutants — the harness
// the engine runs on the candidate's cases and the differential run that proves which mutants are equivalent — and the
// greedy cover by which a generator shows that an instance is solvable within the budget.
//
// A family describes its programs in Python: `parse(text)` turns the input line of a case into the tuple of arguments
// (or `None` when the line is outside the input domain of the specification), `expect(text)` turns the expected output
// into the value the programs return (or `None` when it cannot be one), `reference(*args)` and `mutant_<id>(*args)`
// compute the output, and `DOMAIN` is an iterable of every tuple of arguments of the input domain. A program that raises
// on an input gives the outcome «error»: a case expecting a value tells it apart from the reference.
import type { Built, GenerateInput, HarnessMode, HarnessPart, ItemInstance, QaCase, QaProof } from './family.ts';
import type { HarnessProgram } from '../../../src/lib/server/assessments/contract/bank.ts';

export const QA_BUDGET = { min: 5, max: 8 } as const;

/** How many first picks the cover tries. */
const COVER_STARTS = 16;

/** The candidate's task statement, the same for every QA family; the specification is the instance's own. */
export const QA_TASK_TEXT = [
	'Ниже — спецификация программы. Составьте от 5 до 8 тест-кейсов: строку входа и ожидаемый вывод. Кейсы сначала',
	'запускаются на правильной программе — если хоть один не совпадёт с ней, набор не засчитывается. Затем — на',
	'изменённых версиях программы (мутантах): мутант пойман, если хотя бы на одном кейсе его вывод отличается от',
	'ожидаемого. Балл — доля пойманных мутантов. Код программы и мутантов не показывается. Вход кейса — только в',
	'пределах, которые называет спецификация: кейс вне них не проходит на правильной программе.'
].join(' ');

export interface QaPrograms {
	/** Python defining `parse(text)` and `expect(text)` (and any helpers they share with the programs). */
	io: string;
	/** Python defining `reference(*args)`. */
	reference: string;
	/** Python of every mutant, in the instance's order, each defining `mutant_<id>(*args)`. */
	mutants: readonly { id: string; source: string }[];
	/** Python defining `DOMAIN`: every tuple of arguments of the input domain. */
	domain: string;
}

const OUTCOME = [
	'def outcome(fn, args):',
	'    try:',
	'        return ("ok", fn(*args))',
	'    except Exception as exc:',
	'        return ("error", type(exc).__name__)'
].join('\n');

function programs(p: QaPrograms): string[] {
	return [
		p.io,
		'',
		p.reference,
		'',
		...p.mutants.flatMap((m) => [m.source, '']),
		`MUTANTS = [${p.mutants.map((m) => `("${m.id}", mutant_${m.id})`).join(', ')}]`,
		'',
		OUTCOME
	];
}

/**
 * The harness of one mode (contract `FamilyModule.harness`): the candidate's cases as JSON `[{input, expected}]` on
 * standard input, one line out — a character per case on the reference (`1` passes), or a character per mutant in the
 * instance's order (`1` some valid case tells it apart). A malformed case or one outside the domain passes nothing.
 */
export function qaHarness(p: QaPrograms, mode: HarnessMode): string {
	return [
		'import json',
		'import sys',
		'',
		...programs(p),
		'',
		'def read_case(case):',
		'    if not isinstance(case, dict):',
		'        return None',
		'    text, wanted = case.get("input"), case.get("expected")',
		'    if not isinstance(text, str) or not isinstance(wanted, str):',
		'        return None',
		'    args, value = parse(text), expect(wanted)',
		'    if args is None or value is None:',
		'        return None',
		'    return args, ("ok", value)',
		'',
		'data = json.load(sys.stdin)',
		'cases = [read_case(c) for c in data] if isinstance(data, list) else []',
		...(mode === 'reference'
			? ['print("".join("1" if c is not None and outcome(reference, c[0]) == c[1] else "0" for c in cases))']
			: [
					'print("".join("1" if any(c is not None and outcome(fn, c[0]) != c[1] for c in cases) else "0" for _, fn in MUTANTS))'
				])
	].join('\n');
}

/** The whole input domain against the reference: prints `{mutant id: equivalent}` as JSON. */
export function qaDifferential(p: QaPrograms): string {
	return [
		'import json',
		'',
		...programs(p),
		'',
		p.domain,
		'',
		'points = list(DOMAIN)',
		'expected = [outcome(reference, a) for a in points]',
		'print(json.dumps({mid: all(outcome(fn, a) == e for a, e in zip(points, expected)) for mid, fn in MUTANTS}))'
	].join('\n');
}

/** The proof of one part for the gate script: both harness programs, the author's cases and the differential run. */
export function qaProof(p: QaPrograms, cases: readonly QaCase[]): QaProof {
	return {
		harness: { reference: qaHarness(p, 'reference'), mutants: qaHarness(p, 'mutants') },
		cases,
		differential: qaDifferential(p)
	};
}

/** One part of a QA cluster as the gates need it: what its programs are made of and the author's cases. */
export interface QaPart<S> {
	source: S;
	cases: readonly QaCase[];
}

/**
 * The built instance of a QA family: the proof of the task (and of the change step, if any) made lazily from the
 * parts by `programs`, and the weak case sets of the wrong solutions by id. Called at module level, so the closures
 * hold only the parts and the cases, never the kill matrix of the whole domain the generator searched.
 */
export function qaBuilt<S>(
	instance: ItemInstance,
	programs: (source: S) => QaPrograms,
	task: QaPart<S>,
	step: QaPart<S> | null,
	wrong: Readonly<Record<string, readonly QaCase[]>>
): Built {
	return {
		instance,
		reference: () => ({
			kind: 'qa',
			...qaProof(programs(task.source), task.cases),
			...(step ? { changeStep: qaProof(programs(step.source), step.cases) } : {})
		}),
		wrong: () => Object.fromEntries(Object.entries(wrong).map(([id, cases]) => [id, { kind: 'cases' as const, cases }]))
	};
}

/**
 * A small set of inputs that tells every listed mutant apart from the reference: greedy cover over the candidates,
 * the input killing most of the remaining mutants first (ties — the earlier candidate). `null` when some mutant
 * survives every candidate.
 */
export function greedyCover<P>(
	candidates: readonly P[],
	reference: (point: P) => string,
	mutants: readonly { id: string; run: (point: P) => string }[]
): P[] | null {
	const kills = candidates.map((point) => {
		const expected = reference(point);
		return new Set(mutants.filter((m) => m.run(point) !== expected).map((m) => m.id));
	});
	const chosen = coverIndices(
		kills,
		mutants.map((m) => m.id)
	);
	return chosen && chosen.map((i) => candidates[i] as P);
}

/**
 * A small cover of a kill matrix: `kills[i]` — the mutants candidate `i` tells apart. Candidates with the same mutants
 * are one candidate (the earliest); a greedy cover — the candidate killing most of the remaining mutants next, ties to
 * the earlier — is run from each of the strongest candidates as the first pick, redundant picks are dropped, and the
 * smallest cover wins
 * (ties — the earlier start). Indices of the chosen candidates, or `null` when some of `ids` is killed by no candidate.
 */
export function coverIndices(kills: readonly ReadonlySet<string>[], ids: readonly string[]): number[] | null {
	const wanted = new Set(ids);
	const unique: { index: number; kills: string[] }[] = [];
	const seen = new Set<string>();
	kills.forEach((set, index) => {
		const own = [...set].filter((id) => wanted.has(id)).sort();
		const key = own.join(' ');
		if (own.length === 0 || seen.has(key)) return;
		seen.add(key);
		unique.push({ index, kills: own });
	});
	const greedy = (first: number): number[] | null => {
		const remaining = new Set(ids);
		const chosen: number[] = [];
		const take = (u: number): void => {
			for (const id of unique[u]?.kills ?? []) remaining.delete(id);
			chosen.push(u);
		};
		take(first);
		while (remaining.size > 0) {
			let best = -1;
			let bestKills = 0;
			unique.forEach((u, i) => {
				let n = 0;
				for (const id of u.kills) if (remaining.has(id)) n += 1;
				if (n > bestKills) [best, bestKills] = [i, n];
			});
			if (best < 0) return null;
			take(best);
		}
		// A pick whose mutants the others kill as well is dropped, the earliest pick first.
		for (const u of [...chosen]) {
			const hit = new Set(chosen.filter((v) => v !== u).flatMap((v) => unique[v]?.kills ?? []));
			if (ids.every((id) => hit.has(id))) chosen.splice(chosen.indexOf(u), 1);
		}
		return chosen;
	};
	if (ids.length === 0) return [];
	// Starts: the candidates killing most mutants (ties — the earlier), enough to find small covers cheaply.
	const starts = [...unique.keys()]
		.sort((a, b) => (unique[b]?.kills.length ?? 0) - (unique[a]?.kills.length ?? 0) || a - b)
		.slice(0, COVER_STARTS);
	let best: number[] | null = null;
	for (const first of starts) {
		const cover = greedy(first);
		if (cover === null) return null;
		if (best === null || cover.length < best.length) best = cover;
	}
	return best && best.map((u) => unique[u]?.index ?? 0);
}

/** How many proofs `qaHarnessOf` keeps: an instance's two modes and two parts, for a few instances at a time. */
const HARNESS_CACHE = 16;

/**
 * `harness(instance, mode, part)` of a QA family (contract `FamilyModule.harness`): the proof is rebuilt from the
 * instance's seed, grade and class. The build is a pure function of them, so the last proofs are kept and the
 * reference and mutant modes of one instance, and its change step, build it once.
 */
export function qaHarnessOf(
	key: string,
	build: (input: GenerateInput) => Built
): (instance: ItemInstance, mode: HarnessMode, part?: HarnessPart) => HarnessProgram {
	const kept = new Map<string, QaProof & { changeStep?: QaProof }>();
	return (instance, mode, part = 'task') => {
		const id = `${instance.familyVersion}|${instance.grade}|${instance.classId}|${instance.seed}`;
		let proof = kept.get(id);
		if (!proof) {
			const probe = build({ seed: instance.seed, grade: instance.grade, classId: instance.classId }).reference();
			if (probe.kind !== 'qa') throw new Error(`${key}: the reference of a QA instance is not a harness`);
			proof = probe;
			kept.set(id, proof);
			if (kept.size > HARNESS_CACHE) kept.delete(kept.keys().next().value as string);
		}
		const target = part === 'task' ? proof : proof.changeStep;
		if (!target) throw new Error(`${key}: no change step at ${instance.grade}`);
		return { language: 'python3', source: target.harness[mode] };
	};
}
