// The grade policy (docs/domain.md, section 12.3): which test of a specialization a candidate may take now, when a
// closed one opens, and which grade is confirmed. The declared grade and the confirmed grade are apart; a failure never
// lowers a confirmed grade; a confident result offers the next grade once; the confirmed grade changes at most once per
// interval, except that one step; the same grade is retaken after an interval on the other form, at most twice per
// window of forms.
//
// The parameters are data (`GRADE_POLICY`): an answer of the experts changes a number, not the code. Pure functions,
// plain erasable TypeScript without `$lib`.
import { GRADE_KEYS, gradeOrdinal, type GradeKey } from './catalog.ts';
import { SYSTEM_DECISION_REASONS, type DecisionOutcome, type DecisionReason } from './procedure.ts';

export interface GradePolicy {
	version: number;
	/** The confirmed grade changes at most once per this many days, counted from its assignment. */
	gradeChangeIntervalDays: number;
	/** A grade not confirmed is retaken after this many days from the end of the failed attempt, on the other form. */
	retakeIntervalDays: number;
	/** A confident result lets the next grade be taken at once within this many days — one step, never a chain. */
	confidentUpgradeValidDays: number;
	/**
	 * Counted attempts at one grade of one specialization within `formWindowDays`, counted from their start; a class an
	 * attempt served is seen by the candidate for the same window from the same start. Two attempts — forms A and B.
	 */
	maxAttemptsPerGrade: number;
	formWindowDays: number;
	/** Annulment reasons that do not count as an attempt: the retake is free and immediate. */
	freeRetakeAnnulReasons: readonly string[];
}

export const GRADE_POLICY: GradePolicy = {
	version: 2,
	gradeChangeIntervalDays: 90,
	retakeIntervalDays: 14,
	confidentUpgradeValidDays: 30,
	maxAttemptsPerGrade: 2,
	formWindowDays: 180,
	freeRetakeAnnulReasons: ['technical_failure', 'version_defect', 'objection_upheld']
};

/** An attempt of the candidate at a grade of the specialization, as the policy sees it. */
export interface PolicyAttempt {
	grade: GradeKey;
	startedAt: Date;
	/** When it ended: decided, expired or annulled; `null` while in progress. */
	endedAt: Date | null;
	state:
		| 'in_progress'
		/** A decision; a system end (`SYSTEM_DECISION_REASONS`: the bank ran out, a review could not decide) is not counted. */
		| { decided: DecisionOutcome; reason: DecisionReason }
		/** Started and not finished in time: a counted failure. */
		| 'expired'
		/** Annulled for a reason that counts (plagiarism, the candidate's request): a counted failure with its own end. */
		| 'annulled_counted'
		/** Annulled for a reason of `freeRetakeAnnulReasons`: as if never taken. */
		| 'annulled_free';
}

export interface PolicyCategory {
	grade: GradeKey;
	/** When this grade was assigned: the start of the interval of the next change. */
	assignedAt: Date;
	/**
	 * The one-step right to take the next grade at once; `null` — none (not confident, used, or itself a step sooner than
	 * the interval: on a token or as the retake of a failed upgrade).
	 */
	confidentUpgradeUntil: Date | null;
}

export interface PolicyInput {
	now: Date;
	policy: GradePolicy;
	/** The grade of the current declaration in this specialization; `null` — not declared. */
	declaredGrade: GradeKey | null;
	/** The active category in this specialization (`resolveCategory`); `null` — none. */
	category: PolicyCategory | null;
	attempts: readonly PolicyAttempt[];
}

export type BlockReason =
	/** Another attempt of the candidate is running. */
	| 'attempt_in_progress'
	| 'not_declared'
	/** Without a category only the declared grade and the grades under a failed one are tested. */
	| 'above_declared'
	| 'lower_requires_failure'
	| 'below_confirmed'
	| 'already_confirmed'
	/** Only the grade next to the confirmed one is tested. */
	| 'above_next_grade'
	| 'grade_change_interval'
	| 'retake_interval'
	| 'attempt_limit';

export type OptionKind =
	| 'declared'
	| 'lower_after_failure'
	| 'upgrade_confident'
	| 'upgrade_interval'
	/** The next grade was already attempted and failed: its retake follows the retake interval, not the 90 days. */
	| 'upgrade_retake';

export type GradeOption =
	| {
			grade: GradeKey;
			available: true;
			kind: OptionKind;
			/** For a lower test after a failure: when the failed grade can be retaken — the same date whatever this test gives. */
			failedRetake?: { grade: GradeKey; availableFrom: Date };
	  }
	/**
	 * `availableFrom` — when the option opens by itself, the latest of all the dated reasons that close it (`reason` is
	 * the one with that date); absent — it needs another event (a decision, a declaration).
	 */
	| { grade: GradeKey; available: false; reason: BlockReason; availableFrom?: Date };

const DAY_MS = 86_400_000;
const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS);

/** Counted: every attempt except one in progress, a free annulment and a system end. */
export function attemptCounts(attempt: PolicyAttempt): boolean {
	if (attempt.state === 'in_progress' || attempt.state === 'annulled_free') return false;
	if (typeof attempt.state === 'object') return !SYSTEM_DECISION_REASONS.includes(attempt.state.reason);
	return true;
}

/** A counted attempt that did not confirm. */
function failed(attempt: PolicyAttempt): boolean {
	if (!attemptCounts(attempt)) return false;
	return typeof attempt.state !== 'object' || attempt.state.decided !== 'confirmed';
}

const endOf = (attempt: PolicyAttempt): Date => attempt.endedAt ?? attempt.startedAt;

/** When the retake of `grade` opens after its last counted failure; `null` — no failure. */
function retakeOpens(attempts: readonly PolicyAttempt[], grade: GradeKey, policy: GradePolicy): Date | null {
	const last = attempts
		.filter((a) => a.grade === grade && failed(a))
		.map(endOf)
		.sort((a, b) => b.getTime() - a.getTime())[0];
	return last ? addDays(last, policy.retakeIntervalDays) : null;
}

/** When the attempt limit of `grade` lets one more start; `null` — under the limit now. */
function limitOpens(attempts: readonly PolicyAttempt[], grade: GradeKey, now: Date, policy: GradePolicy): Date | null {
	const windowStart = addDays(now, -policy.formWindowDays);
	const inWindow = attempts
		.filter((a) => a.grade === grade && attemptCounts(a) && a.startedAt > windowStart)
		.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
	if (inWindow.length < policy.maxAttemptsPerGrade) return null;
	const oldest = inWindow[inWindow.length - policy.maxAttemptsPerGrade];
	return oldest ? addDays(oldest.startedAt, policy.formWindowDays) : null;
}

/** Every grade of the catalog with whether its test can start now, and why not. */
export function gradeOptions(input: PolicyInput): GradeOption[] {
	const { now, policy, declaredGrade, category, attempts } = input;
	const running = attempts.some((a) => a.state === 'in_progress');
	return GRADE_KEYS.map((grade): GradeOption => {
		if (running) return { grade, available: false, reason: 'attempt_in_progress' };
		const ordinal = gradeOrdinal(grade);
		const dated: { reason: BlockReason; from: Date }[] = [];
		let kind: OptionKind;
		if (category) {
			const confirmed = gradeOrdinal(category.grade);
			if (ordinal < confirmed) return { grade, available: false, reason: 'below_confirmed' };
			if (ordinal === confirmed) return { grade, available: false, reason: 'already_confirmed' };
			if (ordinal > confirmed + 1) return { grade, available: false, reason: 'above_next_grade' };
			if (attempts.some((a) => a.grade === grade && failed(a))) kind = 'upgrade_retake';
			else if (category.confidentUpgradeUntil && now <= category.confidentUpgradeUntil) kind = 'upgrade_confident';
			else {
				kind = 'upgrade_interval';
				const opens = addDays(category.assignedAt, policy.gradeChangeIntervalDays);
				if (now < opens) dated.push({ reason: 'grade_change_interval', from: opens });
			}
		} else {
			if (declaredGrade === null) return { grade, available: false, reason: 'not_declared' };
			const declared = gradeOrdinal(declaredGrade);
			if (ordinal > declared) return { grade, available: false, reason: 'above_declared' };
			if (ordinal === declared) kind = 'declared';
			else {
				const above = GRADE_KEYS[ordinal + 1];
				if (!attempts.some((a) => a.grade === above && failed(a))) {
					return { grade, available: false, reason: 'lower_requires_failure' };
				}
				kind = 'lower_after_failure';
			}
		}
		const retake = retakeOpens(attempts, grade, policy);
		if (retake && now < retake) dated.push({ reason: 'retake_interval', from: retake });
		const limit = limitOpens(attempts, grade, now, policy);
		if (limit && now < limit) dated.push({ reason: 'attempt_limit', from: limit });
		if (dated.length) {
			const latest = dated.reduce((a, b) => (b.from > a.from ? b : a));
			return { grade, available: false, reason: latest.reason, availableFrom: latest.from };
		}
		if (kind === 'lower_after_failure') {
			const above = GRADE_KEYS[ordinal + 1];
			if (above) {
				const opens = [retakeOpens(attempts, above, policy), limitOpens(attempts, above, now, policy)]
					.filter((d): d is Date => d !== null)
					.reduce<Date>((a, b) => (b > a ? b : a), now);
				return { grade, available: true, kind, failedRetake: { grade: above, availableFrom: opens } };
			}
		}
		return { grade, available: true, kind };
	});
}

/** A grade decision as the category sees it. */
export interface CategoryDecision {
	id: string;
	grade: GradeKey;
	outcome: DecisionOutcome;
	confident: boolean;
	/** The attempt started on a confident token (`upgrade_confident`): its own confidence gives no further token. */
	viaConfidentUpgrade: boolean;
	decidedAt: Date;
	/** `false` — annulled or replaced by a review. */
	valid: boolean;
}

export interface ResolvedCategory extends PolicyCategory {
	decisionId: string;
}

/**
 * The active category of a specialization from all its decisions: the valid confirmed decision of the highest grade
 * (the latest among equals). Closed over any chain of annulments: after any revocation the category is whatever the
 * remaining valid decisions support, with the `assignedAt` of the decision that gives it; the same function answers
 * after a new decision, an annulment, a review or a restoration, so they never disagree.
 */
export function resolveCategory(decisions: readonly CategoryDecision[], policy: GradePolicy): ResolvedCategory | null {
	const best = decisions
		.filter((d) => d.valid && d.outcome === 'confirmed')
		.sort((a, b) => gradeOrdinal(b.grade) - gradeOrdinal(a.grade) || b.decidedAt.getTime() - a.decidedAt.getTime())[0];
	if (!best) return null;
	const isTop = gradeOrdinal(best.grade) === GRADE_KEYS.length - 1;
	// A step that came sooner than the interval after the grade it replaced — on a token or as the retake of a failed
	// upgrade — was itself the exception: it gives no token, so fast steps never chain.
	const replaced = decisions
		.filter(
			(d) =>
				d.valid &&
				d.outcome === 'confirmed' &&
				gradeOrdinal(d.grade) < gradeOrdinal(best.grade) &&
				d.decidedAt < best.decidedAt
		)
		.sort((a, b) => gradeOrdinal(b.grade) - gradeOrdinal(a.grade) || b.decidedAt.getTime() - a.decidedAt.getTime())[0];
	const fast = replaced !== undefined && best.decidedAt < addDays(replaced.decidedAt, policy.gradeChangeIntervalDays);
	const token =
		best.confident && !best.viaConfidentUpgrade && !fast && !isTop
			? addDays(best.decidedAt, policy.confidentUpgradeValidDays)
			: null;
	const used = token !== null && decisions.some((d) => d.viaConfidentUpgrade && d.decidedAt > best.decidedAt);
	return {
		decisionId: best.id,
		grade: best.grade,
		assignedAt: best.decidedAt,
		confidentUpgradeUntil: used ? null : token
	};
}

export type CategoryChange =
	| { action: 'assign'; grade: GradeKey }
	| { action: 'supersede'; from: GradeKey; grade: GradeKey }
	| { action: 'restore'; from: GradeKey; grade: GradeKey }
	| { action: 'revoke'; from: GradeKey }
	/** Nothing changes: the decision does not confirm, or the active category is already that grade or higher. */
	| { action: 'keep' };

/**
 * What a change of the decisions (a new one, an annulment, a review) does to the category: the difference of
 * `resolveCategory` before and after. Never throws — a decision that arrives after a parallel annulment or review is
 * applied to whatever the decisions support at that moment.
 */
export function categoryChange(
	before: readonly CategoryDecision[],
	after: readonly CategoryDecision[],
	policy: GradePolicy
): CategoryChange {
	const was = resolveCategory(before, policy);
	const now = resolveCategory(after, policy);
	if (was?.decisionId === now?.decisionId) return { action: 'keep' };
	if (!was && now) return { action: 'assign', grade: now.grade };
	if (was && !now) return { action: 'revoke', from: was.grade };
	if (was && now) {
		return gradeOrdinal(now.grade) > gradeOrdinal(was.grade) ||
			(now.grade === was.grade && now.assignedAt > was.assignedAt)
			? { action: 'supersede', from: was.grade, grade: now.grade }
			: { action: 'restore', from: was.grade, grade: now.grade };
	}
	return { action: 'keep' };
}
