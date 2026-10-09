// What the released bank gives a seeded attempt (docs/domain.md, 23.3), foreseen in memory before the attempt is made.
// A seeded attempt is a pure function of its draw — the candidate's true share, the seed of the verdict and the seed
// of the attempt (its form and items) — over the release in force: the engine takes the same choices, generators and
// procedure as the trajectory report of the release (`assessments/simulate.ts`). So the seed does not try attempts in
// the database until one gives the outcome it needs: it looks for a draw that gives it here and makes that attempt once.
//
// An outcome is not reachable at every grade of every bank: «не определено» needs a score over the cut by less than the
// band after the extension, which a level of few families with these cuts may never give (Backend Intern of
// `backend@2026.10.3-1`: none in thousands of attempts at any share). The plan of the seed asks only for outcomes the
// bank gives (`outcomeReach`): an outcome is reachable when the sample finds it often enough for the search of every
// attempt to find it too.
import { createHash } from 'node:crypto';
import { familyModule, releaseInForce, type ServedRelease } from '$lib/server/assessments/bank-store';
import type { FamilyDescriptor, FamilyModule } from '$lib/server/assessments/contract/bank';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { GradeDecision } from '$lib/server/assessments/contract/procedure';
import { seededClusterScore } from '$lib/server/assessments/seeded';
import { attemptForm, type AttemptForm } from '$lib/server/assessments/select';
import { runAttempt } from '$lib/server/assessments/simulate';
import type { Executor } from '$lib/server/db';
import { TEST_OUTCOMES, type TestOutcome } from './data';
import { Random, type CandidatePlan } from './generate';

/** The range of the true share each outcome is drawn from. */
const SHARES: Readonly<Record<TestOutcome, readonly [number, number]>> = {
	confident: [0.92, 1],
	confirmed: [0.6, 0.76],
	not_confirmed: [0.1, 0.4],
	undetermined: [0.35, 0.85]
};

/**
 * The sample of the reach: an outcome is reachable at a grade when `REACH_HITS` of at most `REACH_SAMPLE` draws give it
 * (a chance of about 0.2 % and more). The search of one attempt then misses it in `SEARCH_TRIALS` draws with a chance of
 * e^−(0.002 · 40 000) — never in practice; a miss is still an error, not a skipped test.
 */
const REACH_SAMPLE = 3000;
const REACH_HITS = 5;
export const SEARCH_TRIALS = 40_000;

/**
 * The foresight is pure computation, up to seconds per attempt and a minute per bank: it gives the event loop back every
 * few draws, so the worker that seeds keeps extending the leases of its jobs and serving its other slots.
 */
const DRAWS_PER_TURN = 25;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The release in force of a specialization with the generators of its families, as the engine serves it. */
export interface ReleasedBank {
	release: ServedRelease;
	families: { descriptor: FamilyDescriptor; module: FamilyModule }[];
}

/** The outcomes each grade of a released specialization gives a seeded attempt. */
export type GradeReach = ReadonlyMap<GradeKey, ReadonlySet<TestOutcome>>;

/** The reach of every open specialization; a specialization without a released bank is absent. */
export type OutcomeReach = ReadonlyMap<SpecializationKey, GradeReach>;

/** One draw of a seeded attempt: the seed of the verdict, the true share and the seed of the attempt. */
export interface Draw {
	candidateSeed: string;
	trueShare: number;
	attemptSeed: string;
}

export function outcomeOf(decision: Pick<GradeDecision, 'outcome' | 'confident'>): TestOutcome {
	if (decision.outcome === 'confirmed') return decision.confident ? 'confident' : 'confirmed';
	return decision.outcome;
}

/** The draw of `label` for an attempt that is to give `outcome`. */
export function drawOf(label: string, outcome: TestOutcome): Draw {
	const [low, high] = SHARES[outcome];
	return {
		candidateSeed: label,
		trueShare: low + (high - low) * new Random(label).next(),
		// 128 bits in hex, the format of the seed of an attempt.
		attemptSeed: createHash('sha256').update(`${label}:attempt`).digest('hex').slice(0, 32)
	};
}

/** The banks of the open specializations, loaded once for the whole seed. */
export async function openBanks(
	executor: Executor,
	open: ReadonlySet<SpecializationKey>
): Promise<Map<SpecializationKey, ReleasedBank>> {
	const banks = new Map<SpecializationKey, ReleasedBank>();
	for (const specialization of [...open].sort()) {
		const release = await releaseInForce(executor, specialization);
		if (!release) throw new Error(`specialization ${specialization} is open without a release in force`);
		const families = await Promise.all(
			release.families.map(async (family) => ({
				descriptor: family.descriptor,
				module: await familyModule(family, release)
			}))
		);
		banks.set(specialization, { release, families });
	}
	return banks;
}

/** What the engine reads at the start of an attempt: the classes seen (`seenKey`s) and the form of the previous one. */
export interface AttemptHistory {
	seen: ReadonlySet<string>;
	previous: AttemptForm | null;
}

const NO_HISTORY: AttemptHistory = { seen: new Set(), previous: null };

/** How the seeded attempt of `draw` ends at `grade` for a candidate with the history `history`. */
export function foresee(bank: ReleasedBank, grade: GradeKey, history: AttemptHistory, draw: Draw): TestOutcome {
	const { seen } = history;
	const form = attemptForm(
		bank.families.map((family) => family.descriptor),
		grade,
		seen,
		history.previous,
		draw.attemptSeed
	);
	const { decision } = runAttempt({
		families: bank.families,
		specialization: bank.release.specialization,
		grade,
		form,
		seen,
		attemptSeed: draw.attemptSeed,
		score: (instance, family, _angoff, seq) =>
			seededClusterScore({ candidateSeed: draw.candidateSeed, trueShare: draw.trueShare, seq, instance, family })
	});
	return outcomeOf(decision);
}

/** The first draw of `labelOf(0)`, `labelOf(1)`, … whose attempt gives `outcome`; `null` — none in `SEARCH_TRIALS`. */
export async function findDraw(
	bank: ReleasedBank,
	grade: GradeKey,
	history: AttemptHistory,
	outcome: TestOutcome,
	labelOf: (trial: number) => string
): Promise<{ draw: Draw; trials: number } | null> {
	for (let trial = 0; trial < SEARCH_TRIALS; trial += 1) {
		if (trial % DRAWS_PER_TURN === DRAWS_PER_TURN - 1) await nextTurn();
		const draw = drawOf(labelOf(trial), outcome);
		if (foresee(bank, grade, history, draw) === outcome) return { draw, trials: trial + 1 };
	}
	return null;
}

/** The outcomes every grade of the bank gives a candidate who has seen nothing, sampled with the labels of `batch`. */
export async function gradeReach(bank: ReleasedBank, batch: string): Promise<GradeReach> {
	const reach = new Map<GradeKey, Set<TestOutcome>>();
	for (const grade of GRADE_KEYS) {
		const outcomes = new Set<TestOutcome>();
		for (const outcome of TEST_OUTCOMES) {
			let hits = 0;
			for (let i = 0; i < REACH_SAMPLE && hits < REACH_HITS; i += 1) {
				if (i % DRAWS_PER_TURN === DRAWS_PER_TURN - 1) await nextTurn();
				const label = `${batch}:reach:${bank.release.id}:${grade}:${outcome}:${i}`;
				if (foresee(bank, grade, NO_HISTORY, drawOf(label, outcome)) === outcome) hits += 1;
			}
			if (hits >= REACH_HITS) outcomes.add(outcome);
		}
		reach.set(grade, outcomes);
	}
	return reach;
}

export async function outcomeReach(
	banks: ReadonlyMap<SpecializationKey, ReleasedBank>,
	batch: string
): Promise<OutcomeReach> {
	const reach = new Map<SpecializationKey, GradeReach>();
	for (const [specialization, bank] of banks) reach.set(specialization, await gradeReach(bank, batch));
	return reach;
}

/**
 * The tests of the plans that ask a released bank for an outcome it does not give: a hero of `seeds/demo.json` is
 * written by hand, and the seed refuses to start rather than stop at the hero's test.
 */
export function unreachableTests(plans: readonly CandidatePlan[], reach: OutcomeReach): string[] {
	const problems: string[] = [];
	for (const plan of plans) {
		for (const test of plan.assessments) {
			const grades = reach.get(test.specialization);
			if (grades === undefined) continue;
			for (const attempt of test.attempts) {
				if (grades.get(attempt.grade)?.has(attempt.outcome)) continue;
				problems.push(
					`${plan.key}: «${attempt.outcome}» at ${test.specialization} ${attempt.grade} — the released bank gives ` +
						`it in fewer than ${REACH_HITS} of ${REACH_SAMPLE} seeded attempts`
				);
			}
		}
	}
	return problems;
}
