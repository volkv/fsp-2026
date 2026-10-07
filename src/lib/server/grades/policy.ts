// The grade policy over the data of a candidate (docs/domain.md, section 12.3): the automaton of the contract
// (`contract/policy.ts`) is fed with the current declaration of the specialization, its active category and the
// attempts, read at the moment of the question — the state is never stored, so it cannot drift from the history.
//
// `canStartAttempt` is the one answer to «may this candidate start a test of grade G now, and why not»: the test engine
// asks it before it starts an attempt (in the transaction of the start), the cabinet and the API show it for every grade.
//
// Demo mode (domain 12.3, 19.3): for a candidate of a demo session the order of grades, the intervals and the attempt
// limit close nothing — a visitor takes any grade and retakes it at once, to see the tests separate grades and repeat.
// It lifts the answer of the automaton here, not in the contract: the automaton and the decision stay as they are.
import { and, desc, eq } from 'drizzle-orm';
import { specializationOpen, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import {
	GRADE_POLICY,
	gradeOptions,
	type BlockReason,
	type GradeOption,
	type OptionKind,
	type PolicyInput
} from '$lib/server/assessments/contract/policy';
import type { Executor } from '$lib/server/db';
import { gradeDeclarations } from '$lib/server/db/schema';
import { ApiError, policyViolation } from '$lib/server/errors/api-error';
import type { GradeSources, SourceAttempt, SourceCategory } from './sources';
import { blockReasonText } from './texts';

/** The automaton's input with the place of the candidate: inside a demo session or not. */
export interface GradeState extends PolicyInput {
	demoSession: boolean;
}

/** Why a test is open: a kind of the automaton, or `demo_session` — closed outside a demo session, open inside one. */
export type OfferKind = OptionKind | 'demo_session';

/** A grade as the candidate is offered it: the option of the automaton, or a test the demo session opens. */
export type GradeOffer = GradeOption | { grade: GradeKey; available: true; kind: 'demo_session'; failedRetake?: never };

/** Reasons a demo session keeps: one attempt at a time and a declaration before the first test are not the policy's order. */
const DEMO_KEEPS: readonly BlockReason[] = ['attempt_in_progress', 'not_declared'];

/** Every grade of the specialization with whether its test can start now, and why not. */
export function gradeOffers(state: GradeState): GradeOffer[] {
	const options = gradeOptions(state);
	if (!state.demoSession) return options;
	return options.map((option): GradeOffer =>
		option.available || DEMO_KEEPS.includes(option.reason)
			? option
			: { grade: option.grade, available: true, kind: 'demo_session' }
	);
}

export type StartVerdict =
	| { allowed: true; kind: OfferKind }
	/** `availableFrom` — the moment it opens by itself; `null` — it needs another event (a decision, a declaration). */
	| { allowed: false; reason: BlockReason; availableFrom: Date | null };

/** Whether a test of `grade` may start now, and why not. Pure: the same input gives the same answer. */
export function canStartAttempt(state: GradeState, grade: GradeKey): StartVerdict {
	const option = gradeOffers(state).find((candidate) => candidate.grade === grade);
	if (!option) throw new Error(`grade ${grade} is not in the catalog`);
	return option.available
		? { allowed: true, kind: option.kind }
		: { allowed: false, reason: option.reason, availableFrom: option.availableFrom ?? null };
}

/**
 * The input of the automaton for one specialization: the attempts taken in it, and an attempt in progress in any
 * specialization (it closes every test, domain 10.7).
 */
export function policyInputOf(state: {
	now: Date;
	specialization: SpecializationKey;
	declaredGrade: GradeKey | null;
	categories: readonly SourceCategory[];
	attempts: readonly SourceAttempt[];
	demoSession: boolean;
}): GradeState {
	const category = state.categories.find((c) => c.specialization === state.specialization) ?? null;
	return {
		now: state.now,
		policy: GRADE_POLICY,
		declaredGrade: state.declaredGrade,
		category: category && {
			grade: category.grade,
			assignedAt: category.assignedAt,
			confidentUpgradeUntil: category.confidentUpgradeUntil
		},
		attempts: state.attempts
			.filter((a) => a.specialization === state.specialization || a.state === 'in_progress')
			.map(({ grade, startedAt, endedAt, state: attemptState }) => ({
				grade,
				startedAt,
				endedAt,
				state: attemptState
			})),
		demoSession: state.demoSession
	};
}

/** The current declaration of a specialization: the latest one (domain 12.2). */
export async function currentDeclaration(
	executor: Executor,
	candidateId: string,
	specialization: SpecializationKey
): Promise<{ id: string; grade: GradeKey; surveyId: string; declaredAt: Date } | null> {
	const [row] = await executor
		.select({
			id: gradeDeclarations.id,
			grade: gradeDeclarations.grade,
			surveyId: gradeDeclarations.surveyId,
			declaredAt: gradeDeclarations.declaredAt
		})
		.from(gradeDeclarations)
		.where(and(eq(gradeDeclarations.candidateId, candidateId), eq(gradeDeclarations.specialization, specialization)))
		.orderBy(desc(gradeDeclarations.declaredAt), desc(gradeDeclarations.id))
		.limit(1);
	return row ?? null;
}

/** The automaton's input for a specialization of the candidate, read now. */
export async function loadPolicyInput(
	executor: Executor,
	sources: GradeSources,
	query: { candidateId: string; specialization: SpecializationKey; now: Date }
): Promise<GradeState> {
	const [declaration, categories, attempts, demoSession] = await Promise.all([
		currentDeclaration(executor, query.candidateId, query.specialization),
		sources.activeCategories(executor, query.candidateId),
		sources.policyAttempts(executor, query.candidateId),
		sources.inDemoSession(executor, query.candidateId)
	]);
	return policyInputOf({
		now: query.now,
		specialization: query.specialization,
		declaredGrade: declaration?.grade ?? null,
		categories,
		attempts,
		demoSession
	});
}

/** Every grade of a specialization with whether its test can start now (`GET /me/grade-options`). */
export async function loadGradeOptions(
	executor: Executor,
	sources: GradeSources,
	query: { candidateId: string; specialization: SpecializationKey; now: Date }
): Promise<GradeOffer[]> {
	return gradeOffers(await loadPolicyInput(executor, sources, query));
}

/** `409 conflict` with the code of the policy and the day it opens (domain 12.3, contracts 9.1). */
export function blockedTestError(verdict: Extract<StartVerdict, { allowed: false }>): ApiError {
	return new ApiError('conflict', {
		message: blockReasonText(verdict.reason, verdict.availableFrom),
		details: [{ code: verdict.reason, message: blockReasonText(verdict.reason, verdict.availableFrom) }]
	});
}

/**
 * The check of the test engine before it starts an attempt of purpose `grade`: the specialization is open and the
 * policy lets the grade start now. Refuses with `422 policy_violation (specialization_closed)` or `409 conflict` with
 * the reason; otherwise answers what kind of test it is. Called inside the transaction that inserts the attempt, so the
 * attempts it reads are the ones the insertion is checked against.
 */
export async function admitGradeTest(
	executor: Executor,
	sources: GradeSources,
	request: { candidateId: string; specialization: SpecializationKey; grade: GradeKey; now: Date }
): Promise<{ kind: OfferKind }> {
	if (!specializationOpen(request.specialization, await sources.releasedSpecializations(executor))) {
		throw policyViolation('specialization_closed', 'specialization');
	}
	const verdict = canStartAttempt(await loadPolicyInput(executor, sources, request), request.grade);
	if (!verdict.allowed) throw blockedTestError(verdict);
	return { kind: verdict.kind };
}
