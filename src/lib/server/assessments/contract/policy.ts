// The grade policy (docs/domain.md, section 23.4): which test of a specialization a candidate may take now and what a
// decision does to the category. The declared grade and the confirmed grade are apart; a failure never lowers a
// confirmed grade; a confident result offers the next grade; the confirmed grade changes at most once per interval; the
// same grade is retaken after an interval on the other form, at most twice per window of forms.
//
// The parameters are data (`GRADE_POLICY`): an answer of the experts changes a number, not the code. Pure functions,
// plain erasable TypeScript without `$lib`.
import { GRADE_KEYS, gradeOrdinal, type GradeKey } from './catalog.ts';
import type { DecisionOutcome } from './procedure.ts';

export interface GradePolicy {
	version: number;
	/** The confirmed grade changes at most once per this many days (an upgrade by a confident token counts). */
	gradeChangeIntervalDays: number;
	/** A grade not confirmed is retaken after this many days, on the other form. */
	retakeIntervalDays: number;
	/** A confident result lets the next grade be taken at once within this many days. */
	confidentUpgradeValidDays: number;
	/** Attempts at one grade of one specialization within `formWindowDays`; a family-level class seen by a candidate is
	 * not served to them again within the same window. Two attempts — forms A and B. */
	maxAttemptsPerGrade: number;
	formWindowDays: number;
	/** Annulment reasons that do not count as an attempt: the retake is free and immediate. */
	freeRetakeAnnulReasons: readonly string[];
}

export const GRADE_POLICY: GradePolicy = {
	version: 1,
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
		| { decided: DecisionOutcome }
		/** Started and not finished in time: counts as an attempt without a decision. */
		| 'expired'
		/** Annulled for a reason that counts as an attempt (plagiarism, the candidate's request). */
		| 'annulled_counted'
		/** Annulled for a reason of `freeRetakeAnnulReasons`: as if never taken. */
		| 'annulled_free';
}

export interface PolicyCategory {
	grade: GradeKey;
	/** When this grade was assigned: the start of the interval of the next change. */
	assignedAt: Date;
	/** The right to take the next grade at once, given by a confident decision; `null` — none or used. */
	confidentUpgradeUntil: Date | null;
}

export interface PolicyInput {
	now: Date;
	policy: GradePolicy;
	/** The grade of the current declaration in this specialization; `null` — not declared. */
	declaredGrade: GradeKey | null;
	/** The active category in this specialization; `null` — none. */
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

export type OptionKind = 'declared' | 'lower_after_failure' | 'upgrade_confident' | 'upgrade_interval';

export type GradeOption =
	| { grade: GradeKey; available: true; kind: OptionKind }
	/** `availableFrom` — when the option opens by itself; absent — it needs another event (a decision, a declaration). */
	| { grade: GradeKey; available: false; reason: BlockReason; availableFrom?: Date };

const DAY_MS = 86_400_000;
const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS);
const later = (a: Date | undefined, b: Date): Date => (a && a > b ? a : b);

const counts = (attempt: PolicyAttempt): boolean =>
	attempt.state !== 'annulled_free' && attempt.state !== 'in_progress';

const failed = (attempt: PolicyAttempt): boolean =>
	attempt.state === 'expired' || (typeof attempt.state === 'object' && attempt.state.decided !== 'confirmed');

/** Every grade of the catalog with whether its test can start now, and why not. */
export function gradeOptions(input: PolicyInput): GradeOption[] {
	const { now, policy, declaredGrade, category, attempts } = input;
	const running = attempts.some((a) => a.state === 'in_progress');
	return GRADE_KEYS.map((grade): GradeOption => {
		if (running) return { grade, available: false, reason: 'attempt_in_progress' };
		const ordinal = gradeOrdinal(grade);
		let kind: OptionKind;
		let notBefore: Date | undefined;
		if (category) {
			const confirmed = gradeOrdinal(category.grade);
			if (ordinal < confirmed) return { grade, available: false, reason: 'below_confirmed' };
			if (ordinal === confirmed) return { grade, available: false, reason: 'already_confirmed' };
			if (ordinal > confirmed + 1) return { grade, available: false, reason: 'above_next_grade' };
			if (category.confidentUpgradeUntil && now <= category.confidentUpgradeUntil) kind = 'upgrade_confident';
			else {
				kind = 'upgrade_interval';
				const opens = addDays(category.assignedAt, policy.gradeChangeIntervalDays);
				if (now < opens) return { grade, available: false, reason: 'grade_change_interval', availableFrom: opens };
			}
		} else {
			if (declaredGrade === null) return { grade, available: false, reason: 'not_declared' };
			const declared = gradeOrdinal(declaredGrade);
			if (ordinal > declared) return { grade, available: false, reason: 'above_declared' };
			if (ordinal === declared) kind = 'declared';
			else {
				const above = GRADE_KEYS[ordinal + 1];
				const failedAbove = attempts.some((a) => a.grade === above && counts(a) && failed(a));
				if (!failedAbove) return { grade, available: false, reason: 'lower_requires_failure' };
				kind = 'lower_after_failure';
			}
		}
		const atGrade = attempts.filter((a) => a.grade === grade && counts(a));
		const lastFailure = atGrade
			.filter(failed)
			.map((a) => a.endedAt ?? a.startedAt)
			.sort((a, b) => b.getTime() - a.getTime())[0];
		if (lastFailure) {
			const opens = addDays(lastFailure, policy.retakeIntervalDays);
			if (now < opens) notBefore = later(notBefore, opens);
		}
		const windowStart = addDays(now, -policy.formWindowDays);
		const inWindow = atGrade
			.filter((a) => a.startedAt > windowStart)
			.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
		if (inWindow.length >= policy.maxAttemptsPerGrade) {
			const oldest = inWindow[inWindow.length - policy.maxAttemptsPerGrade];
			if (oldest) {
				const opens = addDays(oldest.startedAt, policy.formWindowDays);
				return { grade, available: false, reason: 'attempt_limit', availableFrom: later(notBefore, opens) };
			}
		}
		if (notBefore) return { grade, available: false, reason: 'retake_interval', availableFrom: notBefore };
		return { grade, available: true, kind };
	});
}

export type CategoryChange =
	/** No category before: the decided grade becomes the category. */
	| { action: 'assign'; grade: GradeKey; confidentUpgradeUntil: Date | null }
	/** The next grade confirmed: the previous category is superseded. */
	| { action: 'supersede'; from: GradeKey; grade: GradeKey; confidentUpgradeUntil: Date | null }
	/** Not confirmed or undetermined: the category, if any, stays as it is. */
	| { action: 'keep' };

export class PolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PolicyError';
	}
}

/**
 * What a grade decision does to the category of its specialization. A failure keeps everything; a confirmation assigns
 * the grade or replaces the confirmed one by the next. A confirmation the policy would not have let start is a defect
 * of the caller and throws.
 */
export function categoryAfterDecision(
	category: PolicyCategory | null,
	decision: { grade: GradeKey; outcome: DecisionOutcome; confident: boolean },
	now: Date,
	policy: GradePolicy
): CategoryChange {
	if (decision.outcome !== 'confirmed') return { action: 'keep' };
	const isTop = gradeOrdinal(decision.grade) === GRADE_KEYS.length - 1;
	const confidentUpgradeUntil = decision.confident && !isTop ? addDays(now, policy.confidentUpgradeValidDays) : null;
	if (!category) return { action: 'assign', grade: decision.grade, confidentUpgradeUntil };
	if (gradeOrdinal(decision.grade) !== gradeOrdinal(category.grade) + 1) {
		throw new PolicyError(`a confirmed ${decision.grade} cannot replace the confirmed ${category.grade}`);
	}
	return { action: 'supersede', from: category.grade, grade: decision.grade, confidentUpgradeUntil };
}
