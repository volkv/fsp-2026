// Resilience of a released bank to the spread of answers and the separation of grades (docs/submission/04-testing.md,
// «Устойчивость к распространению заданий»). Everything runs through the engine of the test: the choice of family-levels
// and classes, the generators, the checks of answers (`answerMatches`, the share of hidden test groups, the change step)
// and the procedure, along `runAttempt` of the trajectory report. What differs from the report is only who answers:
//
// - an honest candidate of the report's model (`simulatedScore`: a shift from the cut of the item);
// - a candidate who pastes the answer or the program of another instance — of another candidate's attempt, or of an
//   instance of the same class with another seed; the pasted answer is checked against the candidate's own instance;
// - a profile of competence: a shift per grade of the items and per block (`Profile`), an explicit model;
// - an outside solver whose answers come asynchronously (programs run on the hidden tests, a remote assistant).
//
// `playAttempt` makes `runAttempt` serve asynchronous answers by replaying it: the path of an attempt is a function of
// its seed and of the scores already given, so a replay with the scores known so far reaches the next unscored cluster.
//
// Plain erasable TypeScript run by Node itself.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type {
	ComputedAnswer,
	FamilyDescriptor,
	HiddenTestGroup,
	ItemInstance
} from '../../src/lib/server/assessments/contract/bank.ts';
import type { GradeKey, SpecializationKey } from '../../src/lib/server/assessments/contract/catalog.ts';
import {
	PROCEDURE,
	type DecisionOutcome,
	type ProcedureParams
} from '../../src/lib/server/assessments/contract/procedure.ts';
import { sha256Hex, type LoadedFamily } from '../../src/lib/server/assessments/families.ts';
import {
	answerMatches,
	shareDown,
	withChangeStep,
	type CandidateAnswer
} from '../../src/lib/server/assessments/score.ts';
import {
	labelRandom,
	runAttempt,
	simulatedScore,
	type SimulatedAttempt
} from '../../src/lib/server/assessments/simulate.ts';
import type { AttemptForm } from '../../src/lib/server/assessments/select.ts';
import { outputMatches } from '../../src/lib/server/sandbox/checker.ts';

/** A cluster as the engine served it, with the score it got. */
export interface ServedCluster {
	seq: number;
	instance: ItemInstance;
	family: FamilyDescriptor;
	angoff: number;
	score: number;
}

export type ClusterRequest = Omit<ServedCluster, 'score'>;

/** Scores a served cluster; may wait for a program run or a remote answer. */
export type AsyncScorer = (cluster: ClusterRequest) => number | Promise<number>;

class Pending extends Error {
	readonly cluster: ClusterRequest;
	readonly result: Promise<number>;
	constructor(cluster: ClusterRequest, result: Promise<number>) {
		super(`cluster ${cluster.seq} waits for its score`);
		this.name = 'Pending';
		this.cluster = cluster;
		this.result = result;
	}
}

export interface AttemptSpec {
	families: readonly Pick<LoadedFamily, 'descriptor' | 'module'>[];
	specialization: SpecializationKey;
	grade: GradeKey;
	form: AttemptForm;
	seen: ReadonlySet<string>;
	attemptSeed: string;
	params?: ProcedureParams;
}

export interface PlayedAttempt extends SimulatedAttempt {
	clusters: ServedCluster[];
}

/**
 * One attempt along the engine's path (`runAttempt`) with scores that may come asynchronously. A score given at once is
 * used at once; a score that has to be waited for stops the run at its cluster, and once it comes the attempt is
 * replayed with the scores known so far. A replay that serves another instance at a known slot is a defect of
 * determinism.
 */
export async function playAttempt(spec: AttemptSpec, score: AsyncScorer): Promise<PlayedAttempt> {
	const scored = new Map<number, ServedCluster>();
	for (;;) {
		try {
			const attempt = runAttempt({
				...spec,
				score: (instance, family, angoff, seq) => {
					const known = scored.get(seq);
					if (known) {
						if (known.instance.family !== instance.family || known.instance.seed !== instance.seed)
							throw new Error(`the replay served ${instance.family}/${instance.seed} at slot ${seq}`);
						return known.score;
					}
					const cluster = { seq, instance, family, angoff };
					const result = score(cluster);
					if (typeof result !== 'number') throw new Pending(cluster, result);
					scored.set(seq, { ...cluster, score: result });
					return result;
				}
			});
			return { ...attempt, clusters: [...scored.values()].sort((a, b) => a.seq - b.seq) };
		} catch (error) {
			if (!(error instanceof Pending)) throw error;
			scored.set(error.cluster.seq, { ...error.cluster, score: await error.result });
		}
	}
}

/**
 * The honest candidate of the trajectory report's model (`simulatedScore`) with a shift from the cut that may depend on
 * the block and the grade of the item. Each slot draws from its own stream, so replays and pasted answers elsewhere in
 * the attempt never move the draws of a slot.
 */
export function honestScorer(
	label: string,
	shiftOf: (block: string, grade: GradeKey) => number,
	rho: number = PROCEDURE.trajectoryAcceptance.model.rho
): AsyncScorer {
	return ({ instance, family, angoff, seq }) =>
		simulatedScore(
			instance,
			family,
			angoff,
			shiftOf(family.block, instance.grade),
			rho,
			labelRandom(`${label}:${seq}`)
		);
}

/** A profile of competence: the shift of the true chance from the cut of an item, by the grade of the item and by block. */
export interface Profile {
	key: string;
	title: string;
	/** Shift from the Angoff estimate of an item of this grade. */
	byGrade: Readonly<Record<GradeKey, number>>;
	/** Added to the shift on the items of a block. */
	byBlock: Readonly<Record<string, number>>;
}

export const profileShift =
	(profile: Profile) =>
	(block: string, grade: GradeKey): number =>
		profile.byGrade[grade] + (profile.byBlock[block] ?? 0);

/** What a candidate types for a computed answer: the value, a list one item per line. */
export function typedAnswer(answer: ComputedAnswer): CandidateAnswer {
	switch (answer.kind) {
		case 'exact':
		case 'tokens':
			return answer.value;
		case 'float_eps':
		case 'line_no':
			return String(answer.value);
		case 'set':
		case 'sequence':
			return [...answer.value];
	}
}

/** The score of a computed cluster when the answer of `donor` is pasted into `own`: the engine's check of the answer. */
export function pastedScore(own: ItemInstance, donor: ItemInstance): 0 | 1 {
	if (!own.answer || !donor.answer) throw new Error(`${own.family}: a pasted answer needs computed instances`);
	return answerMatches(own.answer, typedAnswer(donor.answer)) ? 1 : 0;
}

/** The seed of another candidate's instance of the same class: a different seed, derived from the own one. */
export const otherSeed = (seed: string, label: string): string => sha256Hex(`other:${label}:${seed}`);

/** An instance of the same family, grade and class with another seed. */
export function otherInstance(
	family: Pick<LoadedFamily, 'module'>,
	instance: ItemInstance,
	label: string
): ItemInstance {
	return family.module.generate({
		seed: otherSeed(instance.seed, label),
		grade: instance.grade,
		classId: instance.classId
	});
}

export interface Tally {
	runs: number;
	confirmed: number;
	undetermined: number;
	notConfirmed: number;
}

export function tally(outcomes: readonly DecisionOutcome[]): Tally {
	const share = (o: DecisionOutcome) => outcomes.filter((x) => x === o).length / outcomes.length;
	return {
		runs: outcomes.length,
		confirmed: share('confirmed'),
		undetermined: share('undetermined'),
		notConfirmed: share('not_confirmed')
	};
}

/** The Wilson 95 % interval of a share. */
export function wilson(share: number, n: number): [number, number] {
	if (n === 0) throw new Error('an interval of nothing');
	const z = 1.959964;
	const centre = (share + (z * z) / (2 * n)) / (1 + (z * z) / n);
	const half = (z * Math.sqrt((share * (1 - share)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// ---------------------------------------------------------------------------------------------------------------
// Programs on hidden tests: the Python runtime of the gates (`harness.py`), in the sandbox image or on this machine.

const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SANDBOX_IMAGE = 'fsp-sandbox:test';

const outputSchema = z.object({ stdout: z.string(), error: z.string().nullable() });
const runResponse = z.object({ outputs: z.array(outputSchema) });

/** One long-lived `harness.py serve`: one JSON request per line, one JSON answer per line. */
export class PythonRunner {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #lines: AsyncIterator<string>;
	readonly runtime: string;

	constructor(localPython: boolean) {
		this.runtime = localPython ? 'python3 этой машины' : `образ песочницы \`${SANDBOX_IMAGE}\``;
		this.#child = localPython
			? spawn('python3', ['-I', join(HARNESS_DIR, 'harness.py'), 'serve'])
			: spawn('docker', [
					'run',
					'--rm',
					'-i',
					'--network',
					'none',
					'--cpus',
					'2',
					'--memory',
					'2g',
					'--entrypoint',
					'python3',
					'-v',
					`${HARNESS_DIR}:/h:ro`,
					SANDBOX_IMAGE,
					'-I',
					'/h/harness.py',
					'serve'
				]);
		this.#child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
		this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
	}

	/** Requests go one at a time: the harness answers in the order asked, one line per request. */
	#queue: Promise<unknown> = Promise.resolve();

	/** Which groups a Python program passes in full; a run that fails or prints another output fails its group. */
	passedGroups(
		source: string,
		groups: readonly HiddenTestGroup[],
		checker: NonNullable<ItemInstance['practice']>['checker']
	): Promise<number> {
		const next = this.#queue.then(() => this.#passedGroups(source, groups, checker));
		// A failed request fails its caller; the requests after it still go.
		this.#queue = next.catch(() => undefined);
		return next;
	}

	async #passedGroups(
		source: string,
		groups: readonly HiddenTestGroup[],
		checker: NonNullable<ItemInstance['practice']>['checker']
	): Promise<number> {
		const runs = groups.flatMap((g) => g.tests.map((t) => ({ program: 0, stdin: t.stdin })));
		this.#child.stdin.write(`${JSON.stringify({ op: 'run', programs: [source], runs, seconds: 2 })}\n`);
		const next = await this.#lines.next();
		if (next.done) throw new Error('the harness exited');
		const { outputs } = runResponse.parse(JSON.parse(next.value));
		if (outputs.length !== runs.length)
			throw new Error(`the harness answered ${outputs.length} of ${runs.length} runs`);
		let i = 0;
		return groups.filter((g) =>
			g.tests
				.map((t) => {
					const out = outputs[i++];
					return out !== undefined && out.error === null && outputMatches(checker, out.stdout, t.expected);
				})
				.every(Boolean)
		).length;
	}

	close(): void {
		this.#child.stdin.end();
	}
}

/** The share of groups of a practice cluster passed by a program and, for the change step, by its changed program. */
export interface PracticeRun {
	score: number;
	taskGroups: { passed: number; total: number };
	stepGroups: { passed: number; total: number } | null;
}

/**
 * The score of a practice cluster for the given programs, as the engine scores it: the share of hidden test groups
 * passed in full, rounded down to 1/20, and with a change step its own share folded in by the step's weight. A step
 * without a program scores 0.
 */
export async function practiceRun(
	runner: PythonRunner,
	instance: ItemInstance,
	source: string,
	changeSource: string | null
): Promise<PracticeRun> {
	const practice = instance.practice;
	if (!practice) throw new Error(`${instance.family}/${instance.seed} is not a practice task`);
	const passed = await runner.passedGroups(source, practice.groups, practice.checker);
	const task = shareDown(passed, practice.groups.length);
	const step = instance.changeStep;
	if (!step) return { score: task, taskGroups: { passed, total: practice.groups.length }, stepGroups: null };
	if (step.groups.length === 0) throw new Error(`${instance.family}: a practice step without test groups`);
	const stepPassed = changeSource === null ? 0 : await runner.passedGroups(changeSource, step.groups, practice.checker);
	return {
		score: withChangeStep(task, shareDown(stepPassed, step.groups.length), step.weight),
		taskGroups: { passed, total: practice.groups.length },
		stepGroups: { passed: stepPassed, total: step.groups.length }
	};
}

// ---------------------------------------------------------------------------------------------------------------
// An outside solver: the statement as the candidate sees it, the answer as the candidate would type it.

/** The label of the answer field on the candidate's screen (`item-answer.svelte`). */
function answerHint(instance: ItemInstance): string {
	switch (instance.answerKind) {
		case 'set':
		case 'sequence':
			return 'Ответ — по одному элементу в строке.';
		case 'line_no':
			return 'Ответ — одно число: номер строки в коде задания (строки пронумерованы с 1).';
		default:
			return 'Ответ — одно значение.';
	}
}

/** The code of a statement as the screen shows it: numbered for a task answered by a line number. */
function shownCode(instance: ItemInstance): string {
	const code = instance.statement.code;
	if (!code) return '';
	const source =
		instance.answerKind === 'line_no'
			? code.source
					.split('\n')
					.map((line, i) => `${String(i + 1).padStart(3)}  ${line}`)
					.join('\n')
			: code.source;
	return `\n\n\`\`\`${code.language}\n${source}\n\`\`\``;
}

const ANSWER_TAGS = 'Итоговый ответ дай в самом конце между тегами <answer> и </answer>, без пояснений внутри тегов.';
const PROGRAM_RULES =
	'Программа читает вход из стандартного ввода и печатает ответ; она запускается на скрытых тестах задания. ' +
	'Напиши решение на Python 3 и дай итоговую программу одним блоком ```python.';

/** The request for a computed cluster or for the program of a practice task. */
export function solverPrompt(instance: ItemInstance): string {
	const body = `${instance.statement.markdown}${shownCode(instance)}`;
	if (instance.practice) return `${body}\n\n${PROGRAM_RULES}`;
	if (instance.qa) throw new Error(`${instance.family}: QA clusters are outside this experiment`);
	return `${body}\n\n${answerHint(instance)} ${ANSWER_TAGS}`;
}

/** The request for the step «измени своё решение» of a practice task, after the program of the task. */
export function stepPrompt(instance: ItemInstance, program: string | null): string {
	const step = instance.changeStep;
	if (!step) throw new Error(`${instance.family}/${instance.seed} has no change step`);
	const previous =
		program === null ? '' : `\n\nМоя программа для исходного условия:\n\n\`\`\`python\n${program}\n\`\`\``;
	return `${instance.statement.markdown}${previous}\n\n${step.markdown}\n\nИзмени программу под новое условие. ${PROGRAM_RULES}`;
}

/** The answer between the last pair of tags; `null` — the reply has none (the cluster stays unanswered and scores 0). */
export function replyAnswer(reply: string): string | null {
	const matches = [...reply.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
	const last = matches.at(-1)?.[1];
	return last === undefined ? null : last.trim();
}

/** The last ```python block of a reply; `null` — no program (the practice scores 0). */
export function replyProgram(reply: string): string | null {
	const matches = [...reply.matchAll(/```(?:python3?|py)\s*\n([\s\S]*?)```/g)];
	const last = matches.at(-1)?.[1];
	return last === undefined ? null : last;
}
