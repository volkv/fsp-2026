// The admission gates of the bank (docs/domain.md, section 10.2): for every family, on every level and class, the
// reference proves the expected answer of 200 seeds, the wrong solutions are rejected, answers do not collide, the
// essential classes lead to different answers, and for practice the hidden tests kill the template mutants of the
// reference and the reference of one class fails the tests of another. Python programs run in the runtime of the
// sandbox image (`services/sandbox`), the same interpreter and SQLite the candidates' programs get.
//
// A family that passes gets its gate report in `descriptor.json` (`gates`; the rubric review a person wrote stays
// while the family's source is the one it was made for) and its source hash in `gate-sources.json`. Then every family
// is validated (`familyProblems`) and the bank side of the release of every specialization is checked — anchors, the
// families behind every block test (`blockTestPairs`) and every extreme history (`capacityChecks`); the simulation of
// trajectories is the engine's (`pnpm bank:check`). Probes (`_probes/`) are gated but never released. The report of a
// full run goes to `gates-report.md`; a run of some families (`--family`) records their gates and leaves the report:
// it stays the picture of the whole bank.
//
//   node scripts/assessments/gates.ts [--family <key prefix>] [--seeds <n>] [--pending-review-ok] [--local-python]
//                                     [--no-write]
//
// `--local-python` runs the programs with the `python3` of this machine instead of the image (faster to iterate; the
// report names the runtime). `--pending-review-ok` exits with 0 when the only problems left are rubric reviews a
// person has not made yet. `--no-write` checks without touching the descriptors, the records and the report.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { answerFromStdout, answerKey, sameAnswer } from '../../assessments/families/_lib/answers.ts';
import type { Built, HarnessMode, QaCase } from '../../assessments/families/_lib/family.ts';
import {
	blockTestPairs,
	capacityChecks,
	FAMILY_GATES,
	type BankRelease,
	type ComputedAnswer,
	type FamilyDescriptor,
	type FamilyLevel,
	type HiddenTestGroup,
	type ItemInstance
} from '../../src/lib/server/assessments/contract/bank.ts';
import { CATALOG, GRADE_KEYS } from '../../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE } from '../../src/lib/server/assessments/contract/procedure.ts';
import { familyProblems, instanceProblems, levelsByBlock } from '../../src/lib/server/assessments/contract/validate.ts';
import { angoffMean } from './reviews.ts';
import { outputMatches } from '../../src/lib/server/sandbox/checker.ts';
import {
	DESCRIPTOR_FILE,
	FAMILIES_DIR,
	currentSourceSha256,
	gateSourceSha256,
	GATE_SOURCES_FILE,
	loadTree,
	readGateSources,
	sharedSha256,
	type TreeFamily
} from './tree.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SANDBOX_DIR = fileURLToPath(new URL('../../services/sandbox', import.meta.url));
const IMAGE = 'fsp-sandbox:test';
/** The factory's own bar for computed formats: the same seed in two classes gives the same answer this rarely. */
const CLASS_OVERLAP_MAX = 0.05;
const MUTATION_SEEDS = 3;
/** Bug locate: the seeds of every class searched for other one-line repairs. */
const ALTERNATIVE_SEARCH_SEEDS = 10;
const EQUIVALENCE_POOL_SEEDS = 40;
const TRANSFER_SEEDS = 50;
/** QA: the exhaustive differential run of the mutants is slow in Python; it checks the first seeds of every class. */
const QA_DIFFERENTIAL_SEEDS = 10;
/**
 * A generator is a total function: the engine serves any seed. Beyond the gated seeds, this many more per class are only
 * generated, to catch a draw that never settles (practice builds whole test suites, so it gets fewer).
 */
const TOTALITY_SEEDS = { computed: 3000, practice: 300 };
const BATCH_BYTES = 32 * 1024 * 1024;
const BATCH_RUNS = 4000;

const { values: args } = parseArgs({
	options: {
		family: { type: 'string' },
		seeds: { type: 'string' },
		'pending-review-ok': { type: 'boolean', default: false },
		'local-python': { type: 'boolean', default: false },
		'no-write': { type: 'boolean', default: false }
	}
});
const SEEDS = args.seeds === undefined ? FAMILY_GATES.referenceSeedsMin : Number.parseInt(args.seeds, 10);
if (!Number.isInteger(SEEDS) || SEEDS < 2) throw new Error(`--seeds must be an integer ≥ 2, got ${String(args.seeds)}`);

// ---------------------------------------------------------------------------------------------------------------
// The Python harness, one long-lived process: one JSON request per line, one JSON answer per line.

const outputSchema = z.object({ stdout: z.string(), error: z.string().nullable() });
type Output = z.infer<typeof outputSchema>;
const runResponse = z.object({ outputs: z.array(outputSchema) });
const mutateResponse = z.object({
	mutants: z.array(z.object({ id: z.string(), description: z.string(), source: z.string() }))
});
const versionResponse = z.object({ python: z.string(), sqlite: z.string() });

class Harness {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #lines: AsyncIterator<string>;

	constructor(localPython: boolean) {
		this.#child = localPython
			? spawn('python3', ['-I', join(HERE, 'harness.py'), 'serve'])
			: spawn('docker', [
					'run',
					'--rm',
					'-i',
					'--network',
					'none',
					'--cpus',
					'3',
					'--memory',
					'3g',
					'--entrypoint',
					'python3',
					'-v',
					`${HERE}:/h:ro`,
					IMAGE,
					'-I',
					'/h/harness.py',
					'serve'
				]);
		this.#child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
		this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
	}

	async #request(body: object): Promise<unknown> {
		this.#child.stdin.write(`${JSON.stringify(body)}\n`);
		const next = await this.#lines.next();
		if (next.done) throw new Error('the harness exited');
		return JSON.parse(next.value) as unknown;
	}

	/** Runs programs on inputs; `seconds` is the time limit of one run. Large sets go in batches of bounded size. */
	async run(runs: readonly { source: string; stdin: string }[], seconds = 2): Promise<Output[]> {
		const outputs: Output[] = [];
		let batch: { source: string; stdin: string }[] = [];
		let size = 0;
		for (const run of runs) {
			if (batch.length > 0 && (size + run.stdin.length > BATCH_BYTES || batch.length >= BATCH_RUNS)) {
				outputs.push(...(await this.#runBatch(batch, seconds)));
				batch = [];
				size = 0;
			}
			batch.push(run);
			size += run.stdin.length;
		}
		if (batch.length > 0) outputs.push(...(await this.#runBatch(batch, seconds)));
		return outputs;
	}

	async #runBatch(runs: readonly { source: string; stdin: string }[], seconds: number): Promise<Output[]> {
		const programs: string[] = [];
		const index = new Map<string, number>();
		const indexed = runs.map((run) => {
			let i = index.get(run.source);
			if (i === undefined) {
				i = programs.length;
				programs.push(run.source);
				index.set(run.source, i);
			}
			return { program: i, stdin: run.stdin };
		});
		const { outputs } = runResponse.parse(await this.#request({ op: 'run', programs, runs: indexed, seconds }));
		if (outputs.length !== runs.length) throw new Error(`harness answered ${outputs.length} of ${runs.length} runs`);
		return outputs;
	}

	async mutate(source: string): Promise<z.infer<typeof mutateResponse>['mutants']> {
		return mutateResponse.parse(await this.#request({ op: 'mutate', source })).mutants;
	}

	async version(): Promise<z.infer<typeof versionResponse>> {
		return versionResponse.parse(await this.#request({ op: 'version' }));
	}

	close(): void {
		this.#child.stdin.end();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Checking one family.

interface Sample {
	grade: string;
	classId: string;
	seedIndex: number;
	built: Built;
}

interface WrongStat {
	id: string;
	mustBeCaught: boolean;
	/** A wrong revision of the change step: it meets the step's tests. */
	step: boolean;
	applied: number;
	rejected: number;
}

type GateReport = FamilyDescriptor['gates'];

interface FamilyCheck {
	family: TreeFamily;
	/** The gate record's hash: the family's sources and the shared code. */
	sourceSha256: string;
	/** `familySourceSha256` of the sources the run checked. */
	familySource: string;
	/** The descriptor with the gate report of this run. */
	descriptor: FamilyDescriptor;
	problems: string[];
	wrong: WrongStat[];
	classOverlap: number | null;
	mutants: { total: number; killed: number; equivalent: number; survivors: string[] } | null;
	instances: number;
	seconds: number;
}

const gateSeed = (key: string, i: number): string => createHash('sha256').update(`gate|${key}|${i}`).digest('hex');

/** Share of pairs with equal keys. */
function collision(keys: readonly string[]): number {
	const counts = new Map<string, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	const pairs = (keys.length * (keys.length - 1)) / 2;
	let same = 0;
	for (const count of counts.values()) same += (count * (count - 1)) / 2;
	return pairs === 0 ? 0 : same / pairs;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function practiceKey(instance: ItemInstance): string {
	return JSON.stringify(instance.practice?.groups.map((g) => g.tests.map((t) => t.expected)) ?? []);
}

function replaceLine(source: string, line: number, replacement: string): string | null {
	const lines = source.split('\n');
	if (line < 1 || line > lines.length) return null;
	lines[line - 1] = replacement;
	return lines.join('\n');
}

/**
 * Usual one-instruction edits of a line: the line made a no-op, an `await` dropped, a comparison, arithmetic or logic
 * operator swapped, a `not` dropped, an integer moved by one. The search for other repairs of a defect tries them on
 * every line; string literals are left alone.
 */
function lineVariants(text: string): string[] {
	const indent = /^\s*/.exec(text)?.[0] ?? '';
	const body = text.slice(indent.length);
	if (body === '' || body.startsWith('#') || body.startsWith('"'.repeat(3)) || body.startsWith("'".repeat(3)))
		return [];
	const variants = new Set<string>();
	if (!/^(def|class|async def|@|else|elif|try|except|finally|with|async with|for|async for|while|if)\b/.test(body))
		variants.add(`${indent}pass`);
	// Edits outside string literals only: the body split into code and quoted parts (quoted parts at odd indexes).
	const parts = body.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
	const swaps: [RegExp, (m: string) => string][] = [
		[/==/g, () => '!='],
		[/!=/g, () => '=='],
		[/<=/g, () => '<'],
		[/>=/g, () => '>'],
		[/(?<![<>=!])<(?![<=])/g, () => '<='],
		[/(?<![<>=!-])>(?![>=])/g, () => '>='],
		[/\band\b/g, () => 'or'],
		[/\bor\b/g, () => 'and'],
		[/\bnot\s+/g, () => ''],
		[/\bis not\b/g, () => 'is'],
		[/\bawait\s+/g, () => ''],
		[/(?<![\w.])\d+(?![\w.])/g, (m) => String(Number(m) + 1)],
		[/(?<![\w.])\d+(?![\w.])/g, (m) => String(Number(m) - 1)],
		[/ \+ /g, () => ' - '],
		[/ - /g, () => ' + ']
	];
	parts.forEach((part, index) => {
		if (index % 2 === 1) return;
		for (const [pattern, swap] of swaps) {
			for (const match of part.matchAll(pattern)) {
				const edited = part.slice(0, match.index) + swap(match[0]) + part.slice(match.index + match[0].length);
				variants.add(indent + parts.map((p, j) => (j === index ? edited : p)).join(''));
			}
		}
	});
	variants.delete(text);
	return [...variants];
}

/** The runs of a program over groups of tests, and a reader of their outputs: which groups passed in full. */
function groupRuns(source: string, groups: readonly HiddenTestGroup[]) {
	const runs = groups.flatMap((g) => g.tests.map((t) => ({ source, stdin: t.stdin })));
	return {
		runs,
		passedGroups(instance: ItemInstance, outputs: readonly Output[]): boolean[] {
			const checker = instance.practice?.checker ?? { kind: 'exact' as const };
			let i = 0;
			return groups.map((g) =>
				g.tests
					.map((t) => {
						const out = outputs[i++];
						return out !== undefined && out.error === null && outputMatches(checker, out.stdout, t.expected);
					})
					.every(Boolean)
			);
		}
	};
}

/** The two runs of a QA set: the harness on the reference, then on every mutant; the cases go in as JSON. */
function qaRuns(
	harness: Readonly<Record<HarnessMode, string>>,
	cases: readonly QaCase[]
): { source: string; stdin: string }[] {
	const stdin = JSON.stringify(cases);
	return [
		{ source: harness.reference, stdin },
		{ source: harness.mutants, stdin }
	];
}

/**
 * The score of a QA set (domain 10.3): a set that fails on the reference scores 0; otherwise the share of mutants it
 * kills among those that are not equivalent, mapped to the highest level of the rubric it reaches. Each harness run
 * prints one line, a character per case (reference) or per mutant in the instance's order (mutants).
 */
function qaScore(
	instance: ItemInstance,
	levels: readonly { minKillRatio: number; score: number }[],
	cases: readonly QaCase[],
	onReference: Output | undefined,
	onMutants: Output | undefined
): { valid: boolean; ratio: number; score: number; detail: string } {
	if (!onReference || onReference.error !== null || !onMutants || onMutants.error !== null) {
		return {
			valid: false,
			ratio: 0,
			score: 0,
			detail: `harness error: ${onReference?.error ?? onMutants?.error ?? ''}`
		};
	}
	const verdicts = onReference.stdout.trim();
	if (verdicts.length !== cases.length || /[^1]/.test(verdicts)) {
		return { valid: false, ratio: 0, score: 0, detail: verdicts };
	}
	const mutants = instance.qa?.mutants ?? [];
	const matrix = onMutants.stdout.trim();
	if (matrix.length !== mutants.length || /[^01]/.test(matrix)) {
		return { valid: false, ratio: 0, score: 0, detail: `malformed mutant line ${matrix}` };
	}
	const counted = mutants.filter((m) => !m.equivalent);
	const alive = mutants.filter((m, i) => !m.equivalent && matrix[i] !== '1').map((m) => m.id);
	const ratio = counted.length === 0 ? 0 : (counted.length - alive.length) / counted.length;
	const score = Math.max(0, ...levels.filter((l) => l.minKillRatio <= ratio + 1e-9).map((l) => l.score));
	return { valid: true, ratio, score, detail: alive.length ? `alive ${alive.join(', ')}` : 'all killed' };
}

/**
 * The first `EQUIVALENCE_POOL_SEEDS` instances of the same task as a reference: those its program passes in full. For
 * most families that is every instance of the class; a family that states its own constants per instance (Backend
 * practice) gives the program of one instance no right answer on another, so only the instances with its constants.
 */
async function sameTask(harness: Harness, source: string, candidates: readonly Sample[]): Promise<Sample[]> {
	const found: Sample[] = [];
	for (
		let from = 0;
		from < candidates.length && found.length < EQUIVALENCE_POOL_SEEDS;
		from += EQUIVALENCE_POOL_SEEDS
	) {
		const chunk = candidates
			.slice(from, from + EQUIVALENCE_POOL_SEEDS)
			.map((c) => ({ c, runs: groupRuns(source, c.built.instance.practice?.groups ?? []) }));
		const outputs = await harness.run(chunk.flatMap((x) => x.runs.runs));
		let offset = 0;
		for (const x of chunk) {
			const slice = outputs.slice(offset, offset + x.runs.runs.length);
			offset += x.runs.runs.length;
			if (x.runs.passedGroups(x.c.built.instance, slice).every(Boolean)) found.push(x.c);
		}
	}
	return found.slice(0, EQUIVALENCE_POOL_SEEDS);
}

async function checkFamily(harness: Harness, family: TreeFamily): Promise<FamilyCheck> {
	const started = performance.now();
	const d = family.descriptor;
	const module = await family.module();
	const problems: string[] = [];
	const samples: Sample[] = [];
	for (const level of d.levels) {
		for (const cls of level.classes) {
			for (let s = 0; s < SEEDS; s += 1) {
				const input = { seed: gateSeed(d.key, s), grade: level.grade, classId: cls.id };
				const built = module.build(input);
				if (s < 3 && JSON.stringify(module.build(input).instance) !== JSON.stringify(built.instance)) {
					problems.push(`${d.key}@${level.grade}/${cls.id}: the generator is not deterministic`);
				}
				for (const p of instanceProblems(built.instance, d)) problems.push(p.message);
				// A program's output is compared by its tokens: a correct answer with other separators of the fields
				// (a tab, two spaces, a trailing space) is still correct. `exact` would fail a right solution for its spacing.
				if (s === 0 && built.instance.practice?.checker.kind === 'exact')
					problems.push(
						`${d.key}@${level.grade}/${cls.id}: practice output is checked by \`tokens\` (or \`float_eps\`), not \`exact\``
					);
				samples.push({ grade: level.grade, classId: cls.id, seedIndex: s, built });
			}
		}
	}

	// Totality: generation never fails, whatever the seed.
	const extra =
		d.format === 'practice_code' || d.format === 'qa_mutation' ? TOTALITY_SEEDS.practice : TOTALITY_SEEDS.computed;
	for (const level of d.levels) {
		for (const cls of level.classes) {
			let failures = 0;
			let first = '';
			for (let s = SEEDS; s < SEEDS + extra; s += 1) {
				try {
					module.build({ seed: gateSeed(d.key, s), grade: level.grade, classId: cls.id });
				} catch (error) {
					failures += 1;
					first ||= (error as Error).message;
				}
			}
			if (failures > 0)
				problems.push(
					`${d.key}@${level.grade}/${cls.id}: generation fails on ${failures} of ${extra} more seeds: ${first}`
				);
		}
	}

	// Reference.
	const referenceRuns: { source: string; stdin: string }[] = [];
	const readers: ((outputs: readonly Output[]) => string | null)[] = [];
	const referenceRanges: [number, number][] = [];
	for (const sample of samples) {
		const instance = sample.built.instance;
		const probe = sample.built.reference();
		const from = referenceRuns.length;
		const where = `${d.key}@${sample.grade}/${sample.classId}#${sample.seedIndex}`;
		if (probe.kind === 'output') {
			referenceRuns.push({ source: probe.source, stdin: probe.stdin });
			readers.push(([out]) => {
				if (!out || out.error) return `${where}: reference failed: ${out?.error ?? 'no output'}`;
				const expected = instance.answer;
				if (!expected) return `${where}: no computed answer`;
				const eps = expected.kind === 'float_eps' ? expected.eps : undefined;
				const got = answerFromStdout(expected.kind, out.stdout, eps);
				return sameAnswer(got, expected)
					? null
					: `${where}: reference printed ${JSON.stringify(got.value)}, expected ${JSON.stringify(expected.value)}`;
			});
		} else if (probe.kind === 'bug') {
			const source = instance.statement.code?.source ?? '';
			const line = instance.answer?.kind === 'line_no' ? instance.answer.value : 0;
			const fixed = replaceLine(source, line, probe.fix);
			const alternatives = probe.alternatives ?? [];
			const declared = instance.answer?.kind === 'line_no' ? [...(instance.answer.alternatives ?? [])].sort() : [];
			referenceRuns.push({ source: `${source}\n${probe.check}`, stdin: '' });
			referenceRuns.push({ source: `${fixed ?? ''}\n${probe.check}`, stdin: '' });
			for (const alternative of alternatives) {
				referenceRuns.push({
					source: `${replaceLine(source, alternative.line, alternative.fix) ?? ''}\n${probe.check}`,
					stdin: ''
				});
			}
			readers.push(([buggy, repaired, ...others]) => {
				if (fixed === null) return `${where}: defect line ${line} is outside the program`;
				if (buggy?.error === null && buggy.stdout.trim() === 'ok')
					return `${where}: the program passes its checks with the defect`;
				if (!repaired || repaired.error !== null || repaired.stdout.trim() !== 'ok')
					return `${where}: the fixed program fails its checks: ${repaired?.error ?? repaired?.stdout.slice(0, 200) ?? ''}`;
				const failing = alternatives.filter((_, i) => {
					const out = others[i];
					return !out || out.error !== null || out.stdout.trim() !== 'ok';
				});
				if (failing.length > 0)
					return `${where}: alternative fix at line ${failing.map((a) => a.line).join(', ')} does not restore the contract`;
				const proven = alternatives.map((a) => a.line).sort();
				if (JSON.stringify(proven) !== JSON.stringify(declared))
					return `${where}: the answer lists alternatives ${declared.join(', ') || 'none'}, the factory proves ${proven.join(', ') || 'none'}`;
				return null;
			});
		} else if (probe.kind === 'qa') {
			const rubric = d.rubric;
			const differentialRun = sample.seedIndex < QA_DIFFERENTIAL_SEEDS;
			referenceRuns.push(
				...qaRuns(probe.harness, probe.cases),
				...(differentialRun ? [{ source: probe.differential, stdin: '' }] : [])
			);
			readers.push(([onReference, onMutants, differential]) => {
				if (rubric.kind !== 'mutants') return `${where}: a QA family is scored by mutants`;
				const result = qaScore(instance, rubric.levels, probe.cases, onReference, onMutants);
				if (!result.valid) return `${where}: the author's cases fail on the reference: ${result.detail}`;
				if (result.ratio < 1) return `${where}: the author's cases leave mutants alive: ${result.detail}`;
				if (!differentialRun) return null;
				if (!differential || differential.error !== null)
					return `${where}: the differential run failed: ${differential?.error ?? 'no output'}`;
				const declared = Object.fromEntries((instance.qa?.mutants ?? []).map((m) => [m.id, m.equivalent]));
				const measured = z.record(z.string(), z.boolean()).parse(JSON.parse(differential.stdout));
				return JSON.stringify(Object.entries(measured).sort()) === JSON.stringify(Object.entries(declared).sort())
					? null
					: `${where}: equivalence measured ${JSON.stringify(measured)}, declared ${JSON.stringify(declared)}`;
			});
		} else {
			const main = groupRuns(probe.source, instance.practice?.groups ?? []);
			const step =
				probe.changeSource === null ? null : groupRuns(probe.changeSource, instance.changeStep?.groups ?? []);
			if ((probe.changeSource === null) !== (instance.changeStep === null))
				problems.push(`${where}: the reference of the change step must follow the instance`);
			referenceRuns.push(...main.runs, ...(step?.runs ?? []));
			readers.push((outputs) => {
				const passed = main.passedGroups(instance, outputs.slice(0, main.runs.length));
				const stepPassed = step ? step.passedGroups(instance, outputs.slice(main.runs.length)) : [];
				const failedAt = outputs.find((o) => o.error !== null)?.error;
				return passed.every(Boolean) && stepPassed.every(Boolean)
					? null
					: `${where}: reference fails groups ${passed
							.map((p, i) => (p ? null : i))
							.filter((i) => i !== null)
							.join(
								','
							)}${stepPassed.some((p) => !p) ? ' and the change step' : ''}${failedAt ? ` (${failedAt})` : ''}`;
			});
		}
		referenceRanges.push([from, referenceRuns.length]);
	}
	const referenceOutputs = await harness.run(referenceRuns);
	let referenceFailures = 0;
	samples.forEach((_, i) => {
		const [from, to] = referenceRanges[i] ?? [0, 0];
		const reader = readers[i];
		if (!reader) throw new Error(`no reader for sample ${i}`);
		const failure = reader(referenceOutputs.slice(from, to));
		if (failure !== null) {
			referenceFailures += 1;
			if (referenceFailures <= 5) problems.push(failure);
		}
	});

	// Bug locate: other lines a usual one-instruction edit also repairs must be among the accepted answers.
	if (d.format === 'bug_locate') {
		const searchRuns: { source: string; stdin: string }[] = [];
		const searched: { where: string; line: number; variant: string }[] = [];
		for (const sample of samples.filter((x) => x.seedIndex < ALTERNATIVE_SEARCH_SEEDS)) {
			const probe = sample.built.reference();
			const instance = sample.built.instance;
			if (probe.kind !== 'bug' || instance.answer?.kind !== 'line_no') continue;
			const known = new Set([instance.answer.value, ...(instance.answer.alternatives ?? [])]);
			const source = instance.statement.code?.source ?? '';
			source.split('\n').forEach((text, i) => {
				if (known.has(i + 1)) return;
				for (const variant of lineVariants(text)) {
					searchRuns.push({ source: `${replaceLine(source, i + 1, variant) ?? ''}\n${probe.check}`, stdin: '' });
					searched.push({
						where: `${d.key}@${sample.grade}/${sample.classId}#${sample.seedIndex}`,
						line: i + 1,
						variant
					});
				}
			});
		}
		const searchOutputs = await harness.run(searchRuns, 1);
		const found = searched.filter(
			(_, i) => searchOutputs[i]?.error === null && searchOutputs[i].stdout.trim() === 'ok'
		);
		for (const f of found.slice(0, 12))
			problems.push(
				`${f.where}: line ${f.line} also repairs the program with \`${f.variant.trim()}\` — accept it or rebuild`
			);
		if (found.length > 12) problems.push(`${d.key}: ${found.length - 12} more unlisted one-line repairs`);
	}

	// Wrong solutions.
	const wrong: WrongStat[] = d.wrongSolutions.map((w) => ({
		id: w.id,
		mustBeCaught: w.mustBeCaught,
		step: w.part === 'change_step',
		applied: 0,
		rejected: 0
	}));
	const appliedPerLevel = new Map<string, number>();
	const wrongRuns: { source: string; stdin: string }[] = [];
	const pendingRuns: { stat: WrongStat; from: number; to: number; judge: (outputs: readonly Output[]) => boolean }[] =
		[];
	for (const sample of samples) {
		const instance = sample.built.instance;
		const probes = sample.built.wrong();
		for (const stat of wrong) {
			const probe = probes[stat.id];
			if (probe === undefined) {
				problems.push(`${d.key}: the factory gives no probe for the wrong solution ${stat.id}`);
				continue;
			}
			if (probe === null) continue;
			stat.applied += 1;
			appliedPerLevel.set(sample.grade, (appliedPerLevel.get(sample.grade) ?? 0) + 1);
			if (probe.kind === 'answer') {
				if (!instance.answer || !sameAnswer(probe.answer, instance.answer)) stat.rejected += 1;
			} else if (probe.kind === 'line') {
				const answerLine = instance.answer?.kind === 'line_no' ? instance.answer.value : 0;
				const reference = sample.built.reference();
				const patched = replaceLine(instance.statement.code?.source ?? '', probe.line, probe.replacement);
				if (probe.line === answerLine || reference.kind !== 'bug' || patched === null) continue;
				const from = wrongRuns.length;
				wrongRuns.push({ source: `${patched}\n${reference.check}`, stdin: '' });
				pendingRuns.push({
					stat,
					from,
					to: wrongRuns.length,
					judge: ([out]) => !out || out.error !== null || out.stdout.trim() !== 'ok'
				});
			} else if (probe.kind === 'cases') {
				const budget = instance.qa?.budget ?? FAMILY_GATES.qaBudget;
				const rubric = d.rubric;
				// Outside the budget the set is refused before any run.
				if (probe.cases.length < budget.min || probe.cases.length > budget.max) {
					stat.rejected += 1;
					continue;
				}
				const reference = sample.built.reference();
				if (reference.kind !== 'qa') {
					problems.push(`${d.key}: a QA case set needs the QA reference of the instance`);
					continue;
				}
				const from = wrongRuns.length;
				wrongRuns.push(...qaRuns(reference.harness, probe.cases));
				pendingRuns.push({
					stat,
					from,
					to: wrongRuns.length,
					judge: ([onReference, onMutants]) =>
						rubric.kind !== 'mutants' || qaScore(instance, rubric.levels, probe.cases, onReference, onMutants).score < 1
				});
			} else {
				const runs = groupRuns(
					probe.source,
					(stat.step ? instance.changeStep?.groups : instance.practice?.groups) ?? []
				);
				const from = wrongRuns.length;
				wrongRuns.push(...runs.runs);
				pendingRuns.push({
					stat,
					from,
					to: wrongRuns.length,
					judge: (outputs) => runs.passedGroups(instance, outputs).some((p) => !p)
				});
			}
		}
	}
	const wrongOutputs = await harness.run(wrongRuns);
	for (const run of pendingRuns) if (run.judge(wrongOutputs.slice(run.from, run.to))) run.stat.rejected += 1;
	for (const stat of wrong) {
		if (stat.applied === 0) problems.push(`${d.key}: the wrong solution ${stat.id} applies to no class`);
		else if (stat.rejected < stat.applied)
			problems.push(
				`${d.key}: the wrong solution ${stat.id} passes on ${stat.applied - stat.rejected} of ${stat.applied} instances`
			);
	}
	for (const level of d.levels) {
		if (!appliedPerLevel.get(level.grade))
			problems.push(`${d.key}@${level.grade}: no wrong solution applies to the level`);
	}

	// Collisions within a class and overlap between classes on the same seed.
	const isPractice = d.format === 'practice_code' || d.format === 'qa_mutation';
	const keyOf = (instance: ItemInstance): string =>
		d.format === 'qa_mutation'
			? (instance.qa?.specification ?? '')
			: isPractice
				? practiceKey(instance)
				: answerKey(instance.answer as ComputedAnswer);
	let answerCollision = 0;
	let classOverlap: number | null = isPractice ? null : 0;
	for (const level of d.levels) {
		const byClass = level.classes.map((cls) =>
			samples.filter((s) => s.grade === level.grade && s.classId === cls.id).map((s) => keyOf(s.built.instance))
		);
		for (const keys of byClass) answerCollision = Math.max(answerCollision, collision(keys));
		if (classOverlap !== null) {
			for (let i = 0; i < byClass.length; i += 1) {
				for (let j = i + 1; j < byClass.length; j += 1) {
					const a = byClass[i] ?? [];
					const b = byClass[j] ?? [];
					const same = a.filter((key, s) => key === b[s]).length;
					classOverlap = Math.max(classOverlap, same / Math.max(a.length, 1));
				}
			}
		}
	}
	// A line number shared by two different programs is a coincidence, not a shared path: reported, not gated.
	if (classOverlap !== null && d.answerKind !== 'line_no' && classOverlap > CLASS_OVERLAP_MAX)
		problems.push(`${d.key}: classes give the same answer on ${round4(classOverlap)} of seeds`);

	// Practice: transfer between classes and the template mutants of the reference.
	let transfer: number | null = null;
	let mutants: FamilyCheck['mutants'] = null;
	if (d.format === 'practice_code') {
		const transferRuns: { source: string; stdin: string }[] = [];
		const transferPairs: { from: number; to: number; target: ItemInstance; groups: HiddenTestGroup[] }[] = [];
		for (const level of d.levels) {
			for (const a of level.classes) {
				for (const b of level.classes) {
					if (a.id === b.id) continue;
					for (let s = 0; s < Math.min(TRANSFER_SEEDS, SEEDS); s += 1) {
						const source = samples.find((x) => x.grade === level.grade && x.classId === a.id && x.seedIndex === s);
						const target = samples.find((x) => x.grade === level.grade && x.classId === b.id && x.seedIndex === s);
						const probe = source?.built.reference();
						if (!target || probe?.kind !== 'practice') continue;
						const groups = [...(target.built.instance.practice?.groups ?? [])];
						const from = transferRuns.length;
						transferRuns.push(...groups.flatMap((g) => g.tests.map((t) => ({ source: probe.source, stdin: t.stdin }))));
						transferPairs.push({ from, to: transferRuns.length, target: target.built.instance, groups });
					}
				}
			}
		}
		const transferOutputs = await harness.run(transferRuns);
		let passed = 0;
		for (const pair of transferPairs) {
			const checker = pair.target.practice?.checker ?? { kind: 'exact' as const };
			const tests = pair.groups.flatMap((g) => g.tests);
			tests.forEach((t, i) => {
				const out = transferOutputs[pair.from + i];
				if (out && out.error === null && outputMatches(checker, out.stdout, t.expected)) passed += 1;
			});
		}
		transfer = transferRuns.length === 0 ? 0 : round4(passed / transferRuns.length);

		let total = 0;
		let killed = 0;
		let equivalent = 0;
		const survivors: string[] = [];
		for (const level of d.levels) {
			for (const cls of level.classes) {
				const ofClass = samples.filter((x) => x.grade === level.grade && x.classId === cls.id);
				for (const sample of ofClass.slice(0, MUTATION_SEEDS)) {
					const probe = sample.built.reference();
					if (probe.kind !== 'practice') continue;
					const instance = sample.built.instance;
					const list = await harness.mutate(probe.source);
					const groups = instance.practice?.groups ?? [];
					const runs = list.flatMap((m) => groupRuns(m.source, groups).runs);
					const outputs = await harness.run(runs, 0.5);
					const perMutant = runs.length / Math.max(list.length, 1);
					const alive = list.filter((m, i) =>
						groupRuns(m.source, groups)
							.passedGroups(instance, outputs.slice(i * perMutant, (i + 1) * perMutant))
							.every(Boolean)
					);
					total += list.length;
					killed += list.length - alive.length;
					// A survivor of the instance's tests meets the tests of many other seeds of the same task; one that
					// survives them all is treated as equivalent to the reference and leaves the denominator. Without such
					// seeds nothing proves it equivalent, and it stays a survivor.
					const pool = alive.length === 0 ? [] : await sameTask(harness, probe.source, ofClass.slice(MUTATION_SEEDS));
					for (const m of alive) {
						const poolRuns = pool.map((p) => ({
							p,
							runs: groupRuns(m.source, p.built.instance.practice?.groups ?? [])
						}));
						const poolOutputs = await harness.run(
							poolRuns.flatMap((x) => x.runs.runs),
							0.5
						);
						let offset = 0;
						let dies = false;
						for (const x of poolRuns) {
							const slice = poolOutputs.slice(offset, offset + x.runs.runs.length);
							offset += x.runs.runs.length;
							if (x.runs.passedGroups(x.p.built.instance, slice).some((ok) => !ok)) dies = true;
						}
						if (dies || pool.length === 0)
							survivors.push(`${level.grade}/${cls.id}#${sample.seedIndex}: ${m.description}`);
						else equivalent += 1;
					}
				}
			}
		}
		mutants = { total, killed, equivalent, survivors };
	}

	const mustBeCaught = wrong.filter((w) => w.mustBeCaught);
	const familySource = currentSourceSha256(family);
	const sourceSha256 = gateSourceSha256(family);
	const gates: GateReport = {
		reference: { seeds: SEEDS, failures: referenceFailures },
		wrongSolutions: {
			mustBeCaught: mustBeCaught.length,
			caught: mustBeCaught.filter((w) => w.applied > 0 && w.rejected === w.applied).length
		},
		hiddenTestsMutationScore: mutants ? round4(mutants.killed / Math.max(mutants.total - mutants.equivalent, 1)) : null,
		answerCollision: round4(answerCollision),
		transfer,
		bruteForceInputs: null,
		// A review holds only for the sources it was made on: an edit of the family resets it.
		rubricReviews: d.gates.rubricReviews.filter((review) => review.sourceSha256 === familySource)
	};
	const descriptor: FamilyDescriptor = {
		...d,
		levels: d.levels.map((level) => currentRatings(level, familySource)),
		gates
	};
	// The thresholds of the contract on this run's report; what waits for reviewers and raters is counted apart.
	problems.push(
		...familyProblems(descriptor, familySource)
			.filter((p) => p.code === 'defect')
			.map((p) => p.message)
	);
	return {
		family,
		sourceSha256,
		familySource,
		descriptor,
		problems,
		wrong,
		classOverlap: classOverlap === null ? null : round4(classOverlap),
		mutants,
		instances: samples.length,
		seconds: (performance.now() - started) / 1000
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The run: check, record, validate, report.

/**
 * A level's Angoff ratings on the current sources only: an edit of the family resets the others. Without ratings left,
 * the level keeps its cut as the provisional one.
 */
function currentRatings(level: FamilyLevel, familySource: string): FamilyLevel {
	const ratings = level.angoff.ratings.filter((rating) => rating.sourceSha256 === familySource);
	if (ratings.length === level.angoff.ratings.length) return level;
	return {
		...level,
		angoff: { ...level.angoff, ratings, mean: ratings.length > 0 ? angoffMean(ratings) : level.angoff.mean }
	};
}

/**
 * The bank side of a release (contract `releaseProblems` without the trajectory report, which only the engine's
 * simulation makes): anchors per grade, the families behind every block test, every extreme history served.
 */
function bankSideReleaseProblems(release: BankRelease): string[] {
	const where = `release ${release.id}`;
	const problems: string[] = [];
	for (const grade of GRADE_KEYS) {
		const anchors = release.families.filter((f) =>
			f.levels.some((l) => l.grade === grade && l.classes.some((c) => c.form === 'anchor'))
		).length;
		if (anchors < FAMILY_GATES.anchorsPerGrade)
			problems.push(`${where}: ${grade} has ${anchors} anchor family-levels, ${FAMILY_GATES.anchorsPerGrade} required`);
		for (const { block } of blockTestPairs(release.specialization).filter((p) => p.grade === grade)) {
			const families = release.families.filter((f) => f.block === block && f.levels.some((l) => l.grade === grade));
			if (families.length < FAMILY_GATES.blockTestFamiliesMin)
				problems.push(
					`${where}: ${block}@${grade} has ${families.length} families, a block test needs ${FAMILY_GATES.blockTestFamiliesMin}`
				);
		}
	}
	for (const check of capacityChecks(release, PROCEDURE)) {
		if (check.ok) continue;
		const steps = [...new Set(check.shortages.map((s) => `${s.step} in ${s.block}`))].join(', ');
		problems.push(`${where}: ${check.grade} ${check.scenario.join('→')} runs out: ${steps}`);
	}
	return problems;
}

/** A file in the style of the repository's Prettier, so the written descriptors and the report pass the lint. */
async function writeFormatted(path: string, text: string): Promise<void> {
	const options = (await resolveConfig(path)) ?? {};
	writeFileSync(path, await format(text, { ...options, filepath: path }));
}

async function main(): Promise<number> {
	const started = performance.now();
	const { families: tree, problems: treeProblems } = loadTree();
	const selected = tree.filter((f) => args.family === undefined || f.key.startsWith(args.family));
	if (selected.length === 0) throw new Error(`no family matches ${String(args.family)}`);
	if (!args['local-python']) {
		execFileSync('docker', ['build', '--quiet', '--tag', IMAGE, SANDBOX_DIR], {
			stdio: ['ignore', 'ignore', 'inherit']
		});
	}
	const harness = new Harness(args['local-python']);
	const runtime = await harness.version();
	console.log(
		`runtime: ${args['local-python'] ? 'local python3' : IMAGE} — Python ${runtime.python}, SQLite ${runtime.sqlite}; ${SEEDS} seeds per class`
	);
	const checks: FamilyCheck[] = [];
	try {
		for (const family of selected) {
			const check = await checkFamily(harness, family);
			checks.push(check);
			const g = check.descriptor.gates;
			console.log(
				`${check.problems.length === 0 ? 'ok  ' : 'FAIL'} ${family.key}: ${check.instances} instances, ${check.seconds.toFixed(1)} s; ` +
					`wrong ${g.wrongSolutions.caught}/${g.wrongSolutions.mustBeCaught}, collision ${g.answerCollision}` +
					(g.hiddenTestsMutationScore === null
						? ''
						: `, mutants ${g.hiddenTestsMutationScore}, transfer ${g.transfer ?? '—'}`)
			);
			for (const p of check.problems.slice(0, 12)) console.log(`     ${p}`);
		}
	} finally {
		harness.close();
	}

	const write = !args['no-write'];
	const sources = readGateSources();
	for (const key of Object.keys(sources)) if (!tree.some((f) => f.key === key)) Reflect.deleteProperty(sources, key);
	for (const check of checks) {
		if (check.problems.length > 0) {
			Reflect.deleteProperty(sources, check.family.key);
			continue;
		}
		sources[check.family.key] = check.sourceSha256;
		if (write) {
			// The judgements are re-read from disk at the moment of writing: a review recorded while the gates ran is kept.
			// A family whose sources changed meanwhile is not written — its run checked other sources.
			const path = join(check.family.dir, DESCRIPTOR_FILE);
			const onDisk = JSON.parse(readFileSync(path, 'utf8')) as FamilyDescriptor;
			if (currentSourceSha256(check.family) !== check.familySource) {
				Reflect.deleteProperty(sources, check.family.key);
				console.log(`     ${check.family.key}: changed while the gates ran — not recorded, run again`);
				continue;
			}
			const merged: FamilyDescriptor = {
				...onDisk,
				levels: onDisk.levels.map((level) => currentRatings(level, check.familySource)),
				gates: {
					...check.descriptor.gates,
					rubricReviews: onDisk.gates.rubricReviews.filter((r) => r.sourceSha256 === check.familySource)
				}
			};
			await writeFormatted(path, JSON.stringify(merged));
			check.family.descriptor = merged;
			check.descriptor = merged;
		}
	}
	if (write) {
		const sorted = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
		await writeFormatted(GATE_SOURCES_FILE, JSON.stringify(sorted));
	}

	const familyLines: string[] = [];
	const releaseLines: string[] = [];
	let blocking = 0;
	let pendingReviews = 0;
	const count = (problems: readonly string[]): void => {
		blocking += problems.length;
	};
	for (const check of checks) count(check.problems);
	count(treeProblems);
	familyLines.push(...treeProblems.map((p) => `- ${p}`));
	const specializations = [...new Set(tree.filter((f) => !f.probe).map((f) => f.specialization))];
	const current = (family: TreeFamily): FamilyDescriptor =>
		checks.find((c) => c.family === family)?.descriptor ?? family.descriptor;
	for (const family of tree) {
		const stale = sources[family.key] !== gateSourceSha256(family);
		const validation = familyProblems(current(family), currentSourceSha256(family));
		const defects = [
			...(stale
				? [`family ${family.key}: the gate report is not for the current source (the gates failed or never ran)`]
				: []),
			...validation.filter((p) => p.code === 'defect').map((p) => p.message)
		];
		// A checked family has its defects counted already; what waits for judgements is counted apart.
		if (!checks.some((c) => c.family === family)) count(defects);
		pendingReviews += validation.filter((p) => p.code !== 'defect').length;
		familyLines.push(
			...defects.map((p) => `- ${p}`),
			...validation.filter((p) => p.code !== 'defect').map((p) => `- (${p.code}) ${p.message}`)
		);
	}
	for (const specialization of specializations) {
		const descriptors = tree.filter((f) => !f.probe && f.specialization === specialization).map(current);
		const release: BankRelease = {
			id: `${specialization}@${CATALOG.version}-1`,
			specialization,
			catalogVersion: CATALOG.version,
			procedureVersion: PROCEDURE.version,
			families: descriptors,
			sharedSha256: sharedSha256(tree.filter((f) => !f.probe && f.specialization === specialization)),
			familySources: Object.fromEntries(
				tree.filter((f) => !f.probe && f.specialization === specialization).map((f) => [f.key, currentSourceSha256(f)])
			)
		};
		const capacity = capacityChecks(release, PROCEDURE);
		const releaseOnly = bankSideReleaseProblems(release);
		count(releaseOnly);
		releaseLines.push(`### ${specialization}`, '');
		releaseLines.push(
			'| Грейд | ' +
				[...new Set(CATALOG.blocks.filter((b) => b.specialization === specialization).map((b) => b.code))].join(' | ') +
				' |'
		);
		const blockCodes = CATALOG.blocks.filter((b) => b.specialization === specialization).map((b) => b.code);
		releaseLines.push(`|---|${blockCodes.map(() => '---').join('|')}|`);
		for (const grade of GRADE_KEYS) {
			const definition = CATALOG.definitions.find((x) => x.specialization === specialization && x.grade === grade);
			const have = levelsByBlock(release, grade);
			releaseLines.push(
				`| ${grade} | ${blockCodes
					.map((code) => {
						const quota = definition?.blocks.find((q) => q.block === code)?.items ?? 0;
						const n = have.get(code) ?? 0;
						return quota === 0 && n === 0 ? '—' : `${n} / ${quota}`;
					})
					.join(' | ')} |`
			);
		}
		releaseLines.push('', 'Семейств-уровней в блоке / квота блока на самой длинной траектории.', '');
		releaseLines.push('| Грейд | Сценарий | Итог | Нехватка |', '|---|---|---|---|');
		for (const c of capacity) {
			releaseLines.push(
				`| ${c.grade} | ${c.scenario.join(' → ')} | ${c.ok ? 'ok' : 'нехватка'} | ${[...new Set(c.shortages.map((s) => `${s.step}: ${s.block}`))].join(', ')} |`
			);
		}
		releaseLines.push('', ...(releaseOnly.length ? releaseOnly.map((p) => `- ${p}`) : ['Проблем выпуска нет.']), '');
	}

	const seconds = (performance.now() - started) / 1000;
	const report = [
		'# Отчёт ворот банка',
		'',
		`Среда исполнения: ${args['local-python'] ? 'python3 этой машины' : `образ песочницы \`${IMAGE}\``} — Python ${runtime.python}, SQLite ${runtime.sqlite}. ` +
			`Сидов на класс: ${SEEDS}. Проверено семейств: ${checks.length}, время ${seconds.toFixed(0)} с.`,
		'',
		'## Семейства',
		'',
		'| Семейство | Формат | Уровни | Экз. | Эталон: отказов | Ошибочные: поймано | Коллизия | Пересечение классов | Мутанты (убито / всего − экв.) | Перенос | Проблем |',
		'|---|---|---|---|---|---|---|---|---|---|---|',
		...checks.map((c) => {
			const r = c.descriptor.gates;
			const m = c.mutants;
			return `| \`${c.family.key}\` | ${c.family.descriptor.format} | ${c.family.descriptor.levels.map((l) => l.grade).join(', ')} | ${c.instances} | ${r.reference.failures} | ${r.wrongSolutions.caught} / ${r.wrongSolutions.mustBeCaught} | ${r.answerCollision} | ${c.classOverlap ?? '—'} | ${m ? `${m.killed} / ${m.total} − ${m.equivalent} = ${r.hiddenTestsMutationScore ?? ''}` : '—'} | ${r.transfer ?? '—'} | ${c.problems.length} |`;
		}),
		'',
		'## Ошибочные решения',
		'',
		...checks.flatMap((c) => [
			`- \`${c.family.key}\`: ${c.wrong.map((w) => `${w.id} — отвергнуто ${w.rejected} из ${w.applied}`).join('; ')}`
		]),
		'',
		'## Проблемы ворот',
		'',
		...(checks.some((c) => c.problems.length) ? checks.flatMap((c) => c.problems.map((p) => `- ${p}`)) : ['Нет.']),
		'',
		'## Валидатор контракта',
		'',
		...(familyLines.length ? familyLines : ['Проблем нет.']),
		'',
		'## Выпуск и вместимость',
		'',
		...releaseLines,
		...checks
			.filter((c) => c.mutants && c.mutants.survivors.length)
			.flatMap((c) => [
				`Выжившие мутанты \`${c.family.key}\`:`,
				'',
				...(c.mutants?.survivors ?? []).map((s) => `- ${s}`),
				''
			])
	].join('\n');
	if (write && args.family === undefined) await writeFormatted(join(FAMILIES_DIR, 'gates-report.md'), report);
	else if (write) console.log('a run of some families: gates-report.md is written by a full run only');
	console.log(
		`\n${checks.length} families checked in ${seconds.toFixed(1)} s; blocking problems: ${blocking}; judgements pending (reviews, raters): ${pendingReviews}`
	);
	console.log(releaseLines.filter((l) => l.startsWith('- release')).join('\n'));
	if (blocking > 0) return 1;
	if (pendingReviews > 0 && !args['pending-review-ok']) return 1;
	return 0;
}

process.exitCode = await main();
