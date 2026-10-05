// Grade decisions as the owner of categories reads them (docs/domain.md, 12.3–12.4): every decision of a candidate in a
// specialization from `grade_decisions`, with the attempt that gave it — whether it was started on a confident result,
// the catalog version, the language the candidate wrote the practice program in — and, for a decision that stopped counting, why: an
// annulment upheld by an objection (`objection_annulled`), any other annulment (`decision_annulled`), a review that
// replaced it (`objection_rescored`).
import { and, eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { gradeDecisions, testAttempts, testItems } from '$lib/server/db/schema';
import {
	GRADE_KEYS,
	PRACTICE_LANGUAGE_KEYS,
	type GradeKey,
	type PracticeLanguageKey,
	type SpecializationKey
} from './contract/catalog';
import type { DecisionRecord } from '../categories/decisions';

function gradeOf(decision: { id: string; grade: string }): GradeKey {
	const grade = GRADE_KEYS.find((g) => g === decision.grade);
	if (!grade) throw new Error(`decision ${decision.id} of unknown grade ${decision.grade}`);
	return grade;
}

const isPracticeLanguage = (value: unknown): value is PracticeLanguageKey =>
	typeof value === 'string' && (PRACTICE_LANGUAGE_KEYS as readonly string[]).includes(value);

/**
 * The language of a confirmed practice: the language the candidate wrote the program in (`practice_code`). A QA practice
 * (`qa_mutation`) is test cases the harness runs in a language the candidate never wrote, and a decision without a
 * served practice (a synthetic one of the quality evaluation) shows no program: no language is confirmed. A practice
 * program without its language is a data error, not a language to guess.
 */
function languageOf(
	decisionId: string,
	practice: { format: string; detail: unknown } | null
): PracticeLanguageKey | null {
	if (!practice || practice.format !== 'practice_code') return null;
	const language = (practice.detail as { language?: unknown } | null)?.language;
	if (!isPracticeLanguage(language)) throw new Error(`the practice of decision ${decisionId} has no language`);
	return language;
}

/** Every decision of the candidate in the specialization, valid or not. */
export async function decisionRecords(
	executor: Executor,
	candidateId: string,
	specialization: SpecializationKey
): Promise<DecisionRecord[]> {
	const rows = await executor
		.select({
			decision: gradeDecisions,
			attempt: testAttempts,
			practice: { format: testItems.format, detail: testItems.scoreDetail }
		})
		.from(gradeDecisions)
		.innerJoin(testAttempts, eq(testAttempts.id, gradeDecisions.attemptId))
		.leftJoin(testItems, and(eq(testItems.attemptId, testAttempts.id), eq(testItems.practice, true)))
		.where(and(eq(gradeDecisions.candidateId, candidateId), eq(gradeDecisions.specialization, specialization)));
	return rows.map(({ decision, attempt, practice }): DecisionRecord => {
		const invalidReason =
			decision.status === 'valid'
				? null
				: decision.status === 'superseded'
					? 'objection_rescored'
					: attempt.annulReason === 'objection_upheld'
						? 'objection_annulled'
						: 'decision_annulled';
		return {
			id: decision.id,
			grade: gradeOf(decision),
			outcome: decision.outcome,
			confident: decision.confident,
			viaConfidentUpgrade: attempt.viaConfidentUpgrade,
			decidedAt: decision.decidedAt,
			valid: decision.status === 'valid',
			specialization,
			bankReleaseId: decision.bankReleaseId,
			catalogVersion: attempt.catalogVersion,
			practiceLanguage: decision.outcome === 'confirmed' ? languageOf(decision.id, practice) : null,
			invalidReason
		};
	});
}
