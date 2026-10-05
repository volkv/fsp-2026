// Where the candidate stands on the way to a category (docs/domain.md, sections 12.2, 12.3, 12.7): the survey in force,
// the current declaration of its specialization, the active categories, what the policy opens now, and the history of
// surveys and declarations. «Шаг до категории» is what is done of the survey, the declaration and the test, and the
// nearest action available.
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import {
	gradeOptions,
	type BlockReason,
	type GradeOption,
	type OptionKind
} from '$lib/server/assessments/contract/policy';
import type { Executor } from '$lib/server/db';
import { declarationHistory, type Declaration } from './declarations';
import { policyInputOf } from './policy';
import type { GradeSources, SourceCategory } from './sources';
import { surveyHistory, type Survey } from './surveys';

export type NextStep =
	| { kind: 'survey' }
	| { kind: 'declare'; specialization: SpecializationKey }
	/** A test can start now. */
	| { kind: 'test'; grade: GradeKey; option: OptionKind }
	/** Every test of the specialization is closed for now; `availableFrom` — the earliest day one opens by itself. */
	| { kind: 'wait'; grade: GradeKey; reason: BlockReason; availableFrom: Date | null }
	/** The top grade is confirmed. */
	| { kind: 'done' };

export interface GradeStanding {
	survey: Survey | null;
	surveys: Survey[];
	declarations: Declaration[];
	/** The current declaration of the survey's specialization. */
	declaration: Declaration | null;
	/** Active categories in every specialization. */
	categories: SourceCategory[];
	/** The category of the survey's specialization. */
	category: SourceCategory | null;
	/** Every grade of the survey's specialization with whether its test can start now; empty without a survey. */
	options: GradeOption[];
	steps: { survey: boolean; declaration: boolean; test: boolean };
	next: NextStep;
}

/** The step the candidate can take next, from the options of the policy. */
export function nextStep(state: {
	specialization: SpecializationKey | null;
	declaredGrade: GradeKey | null;
	category: { grade: GradeKey } | null;
	options: readonly GradeOption[];
}): NextStep {
	if (state.specialization === null) return { kind: 'survey' };
	if (state.declaredGrade === null && state.category === null) {
		return { kind: 'declare', specialization: state.specialization };
	}
	// The highest open test: an upgrade above a category, the declared grade, or the next one down after a failure.
	const open = [...state.options].reverse().find((o) => o.available);
	if (open?.available) return { kind: 'test', grade: open.grade, option: open.kind };
	// What the candidate is aiming at: the next grade above a category, else the declared grade.
	const target = state.category
		? state.options[state.options.findIndex((o) => o.grade === state.category?.grade) + 1]
		: state.options.find((o) => o.grade === state.declaredGrade);
	if (!target) return { kind: 'done' };
	if (target.available) throw new Error('an open option was not found among the options');
	// Of the closed options, the one that opens by itself first; without a date — the target's own reason.
	const dated = state.options
		.flatMap((o) =>
			!o.available && o.availableFrom
				? [{ kind: 'wait' as const, grade: o.grade, reason: o.reason, availableFrom: o.availableFrom }]
				: []
		)
		.sort((a, b) => a.availableFrom.getTime() - b.availableFrom.getTime())[0];
	if (dated) return dated;
	return { kind: 'wait', grade: target.grade, reason: target.reason, availableFrom: null };
}

export async function loadGradeStanding(
	executor: Executor,
	sources: GradeSources,
	candidateId: string,
	now: Date
): Promise<GradeStanding> {
	const [surveys, declarations, categories, attempts] = await Promise.all([
		surveyHistory(executor, candidateId),
		declarationHistory(executor, candidateId),
		sources.activeCategories(executor, candidateId),
		sources.policyAttempts(executor, candidateId)
	]);
	const survey = surveys.at(-1) ?? null;
	const specialization = survey?.specialization ?? null;
	const declaration =
		specialization === null ? null : (declarations.findLast((d) => d.specialization === specialization) ?? null);
	const category = categories.find((c) => c.specialization === specialization) ?? null;
	const options =
		specialization === null
			? []
			: gradeOptions(
					policyInputOf({
						now,
						specialization,
						declaredGrade: declaration?.grade ?? null,
						categories,
						attempts
					})
				);
	return {
		survey,
		surveys,
		declarations,
		declaration,
		categories,
		category,
		options,
		steps: { survey: survey !== null, declaration: declaration !== null, test: category !== null },
		next: nextStep({ specialization, declaredGrade: declaration?.grade ?? null, category, options })
	};
}
