// What the candidate reads about their tests (docs/domain.md, 10.6–10.7; contracts 10.1): the tests the grade policy
// lets them take, their attempts and decisions, an attempt with the statements of its served clusters — never a key, a
// hidden test or a mutant — and a decision with its explanation by blocks. Every read is the candidate's own.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { gradeDecisions, testArtifacts, testAttempts, testItems } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { openSpecializations, releaseById } from './bank-store';
import { judgementProvenance, type ItemInstance, type JudgementProvenance } from './contract/bank';
import { blockDefinition, type GradeKey, type SpecializationKey } from './contract/catalog';
import type { GradeOption } from './contract/policy';
import type { BlockSummary } from './contract/procedure';
import { expireOverdue, ownCandidateId } from './engine';
import { explainDecision, type Explanation } from './explain';
import { parseSignalLog, type SignalLog } from './signals';
import { testTitle } from './titles';
import { loadGradeOptions } from '$lib/server/grades/policy';
import { gradeSources } from '$lib/server/grades/sources';

export interface AttemptSummary {
	id: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	title: string;
	/** `null` — a block test or a recheck (reserve classes). */
	form: 'A' | 'B' | null;
	status: (typeof testAttempts.$inferSelect)['status'];
	startedAt: Date;
	endedAt: Date | null;
	seeded: boolean;
	annulReason: (typeof testAttempts.$inferSelect)['annulReason'];
	decision: { id: string; outcome: string; status: string; confident: boolean } | null;
}

export interface TestsOverview {
	specializations: { key: SpecializationKey; options: GradeOption[] }[];
	activeAttemptId: string | null;
	attempts: AttemptSummary[];
}

async function attemptSummaries(executor: Executor, candidateId: string): Promise<AttemptSummary[]> {
	const rows = await executor
		.select({ attempt: testAttempts, decision: gradeDecisions })
		.from(testAttempts)
		.leftJoin(gradeDecisions, eq(gradeDecisions.attemptId, testAttempts.id))
		.where(eq(testAttempts.candidateId, candidateId))
		.orderBy(desc(testAttempts.startedAt), desc(gradeDecisions.decidedAt));
	const seen = new Set<string>();
	const summaries: AttemptSummary[] = [];
	for (const { attempt, decision } of rows) {
		if (seen.has(attempt.id)) continue;
		seen.add(attempt.id);
		summaries.push({
			id: attempt.id,
			specialization: attempt.specialization as SpecializationKey,
			grade: attempt.grade as GradeKey,
			title: testTitle(attempt.specialization, attempt.grade),
			form: attempt.form,
			status: attempt.status,
			startedAt: attempt.startedAt,
			endedAt: attempt.endedAt,
			seeded: attempt.seeded,
			annulReason: attempt.annulReason,
			decision: decision
				? { id: decision.id, outcome: decision.outcome, status: decision.status, confident: decision.confident }
				: null
		});
	}
	return summaries;
}

/** The open specializations with the grades the policy lets the candidate take, and the history of attempts. */
export async function testsOverview(db: Executor, subject: AccessSubject, now: Date): Promise<TestsOverview> {
	const candidateId = ownCandidateId(subject, 'read');
	await expireOverdue(db, candidateId, now);
	const open = [...(await openSpecializations(db))];
	const specializations = [];
	for (const key of open) {
		specializations.push({
			key,
			options: await loadGradeOptions(db, gradeSources, { candidateId, specialization: key, now })
		});
	}
	const attempts = await attemptSummaries(db, candidateId);
	return {
		specializations,
		activeAttemptId: attempts.find((a) => a.status === 'in_progress')?.id ?? null,
		attempts
	};
}

export interface ItemView {
	seq: number;
	block: string;
	blockTitle: string;
	format: string;
	practice: boolean;
	status: (typeof testItems.$inferSelect)['status'];
	statement: ItemInstance['statement'];
	answerKind: ItemInstance['answerKind'];
	languages: readonly string[];
	qa: { budget: { min: number; max: number }; specification: string } | null;
	/** The step «измени своё решение»: shown once the task is scored. */
	changeStep: { markdown: string; kind: 'code' | 'cases'; specification: string | null } | null;
	timeNormSec: number;
	/** The candidate's own answers and submissions, newest last. */
	answers: { kind: string; stage: string; content: Record<string, unknown> | null; createdAt: Date }[];
	/** What the candidate may see of a program's run: groups passed, never their inputs. */
	practiceResult: { stage: string; passedGroups: number; totalGroups: number }[];
}

export interface AttemptState extends AttemptSummary {
	deadlineAt: Date;
	items: ItemView[];
	/** The item the candidate answers now; `null` — waiting for the sandbox, or the attempt ended. */
	current: number | null;
	waitingSandbox: boolean;
	signals: SignalLog;
}

function itemView(item: typeof testItems.$inferSelect, artifacts: (typeof testArtifacts.$inferSelect)[]): ItemView {
	const instance = item.instance as ItemInstance;
	const detail = (item.scoreDetail ?? {}) as Record<
		string,
		{ passed_groups?: number; total_groups?: number } | undefined
	>;
	const practiceResult = (['task', 'step'] as const).flatMap((stage) => {
		const part = detail[stage];
		return instance.practice && part?.passed_groups !== undefined && part.total_groups !== undefined
			? [{ stage, passedGroups: part.passed_groups, totalGroups: part.total_groups }]
			: [];
	});
	const step = instance.changeStep;
	// The step opens once its task is scored.
	const stepOpen = detail.task !== undefined;
	return {
		seq: item.seq,
		block: item.block,
		blockTitle: blockDefinition(item.block).title,
		format: item.format,
		practice: item.practice,
		status: item.status,
		statement: instance.statement,
		answerKind: instance.answerKind,
		languages: instance.practice?.languages ?? [],
		qa: instance.qa ? { budget: instance.qa.budget, specification: instance.qa.specification } : null,
		changeStep:
			step && stepOpen
				? { markdown: step.markdown, kind: step.qa ? 'cases' : 'code', specification: step.qa?.specification ?? null }
				: null,
		timeNormSec: instance.timeNormSec,
		answers: artifacts
			.filter((a) => a.kind !== 'run_result')
			.map((a) => {
				const content = a.content as Record<string, unknown> | null;
				return {
					kind: a.kind,
					stage: typeof content?.stage === 'string' ? content.stage : 'task',
					content: content && { ...content, request_id: undefined },
					createdAt: a.createdAt
				};
			}),
		practiceResult
	};
}

/** The candidate's attempt with the statements of its served clusters. */
export async function attemptState(
	db: Executor,
	subject: AccessSubject,
	attemptId: string,
	now: Date
): Promise<AttemptState> {
	const candidateId = ownCandidateId(subject, 'read');
	await expireOverdue(db, candidateId, now);
	const summary = (await attemptSummaries(db, candidateId)).find((a) => a.id === attemptId);
	if (!summary) throw new ApiError('not_found');
	const [attempt] = await db.select().from(testAttempts).where(eq(testAttempts.id, attemptId));
	if (!attempt) throw new ApiError('not_found');
	const items = await db.select().from(testItems).where(eq(testItems.attemptId, attemptId)).orderBy(asc(testItems.seq));
	const artifacts =
		items.length === 0
			? []
			: await db
					.select()
					.from(testArtifacts)
					.where(
						and(
							eq(testArtifacts.attemptId, attemptId),
							inArray(
								testArtifacts.itemId,
								items.map((i) => i.id)
							)
						)
					)
					.orderBy(asc(testArtifacts.seq));
	const open = items.find((i) => i.status === 'served' || i.status === 'answered');
	const inProgress = attempt.status === 'in_progress';
	return {
		...summary,
		deadlineAt: attempt.deadlineAt,
		items: items.map((item) =>
			itemView(
				item,
				artifacts.filter((a) => a.itemId === item.id)
			)
		),
		current: inProgress && open ? open.seq : null,
		waitingSandbox: inProgress && items.some((i) => i.status === 'awaiting_sandbox'),
		signals: parseSignalLog(attempt.integritySignals)
	};
}

export interface DecisionView {
	id: string;
	attemptId: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	title: string;
	status: 'valid' | 'annulled' | 'superseded';
	outcome: 'confirmed' | 'not_confirmed' | 'undetermined';
	decidedAt: Date;
	bankReleaseId: string;
	procedureVersion: string;
	seeded: boolean;
	explanation: Explanation;
	/** How the clusters of the attempt were judged (domain 10.8): any by models only, any on a provisional cut. */
	judgement: JudgementProvenance;
	/** What the policy offers next in the specialization. */
	next: GradeOption[];
}

/**
 * `judgementProvenance` over the clusters served in an attempt: the rubric of any of them approved by models only, the
 * cut of any of them on model ratings only. A family the release does not record is a broken release, not a cluster
 * to skip.
 */
async function attemptJudgement(
	db: Executor,
	attemptId: string,
	releaseId: string,
	grade: GradeKey
): Promise<JudgementProvenance> {
	const keys = await db
		.selectDistinct({ familyKey: testItems.familyKey })
		.from(testItems)
		.where(eq(testItems.attemptId, attemptId));
	const judgement: JudgementProvenance = { rubricByModelsOnly: false, angoffProvisional: false };
	if (keys.length === 0) return judgement;
	const release = await releaseById(db, releaseId);
	for (const { familyKey } of keys) {
		const family = release.families.find((f) => f.descriptor.key === familyKey);
		if (!family) throw new Error(`release ${releaseId} has no family ${familyKey} of attempt ${attemptId}`);
		const provenance = judgementProvenance(family.descriptor, grade);
		judgement.rubricByModelsOnly ||= provenance.rubricByModelsOnly;
		judgement.angoffProvisional ||= provenance.angoffProvisional;
	}
	return judgement;
}

/** The candidate's decision with its explanation, from the stored decision without recomputing. */
export async function decisionView(
	db: Executor,
	subject: AccessSubject,
	decisionId: string,
	now: Date
): Promise<DecisionView> {
	const candidateId = ownCandidateId(subject, 'read');
	const [row] = await db
		.select({ decision: gradeDecisions, seeded: testAttempts.seeded })
		.from(gradeDecisions)
		.innerJoin(testAttempts, eq(testAttempts.id, gradeDecisions.attemptId))
		.where(and(eq(gradeDecisions.id, decisionId), eq(gradeDecisions.candidateId, candidateId)));
	if (!row) throw new ApiError('not_found');
	const { decision } = row;
	const specialization = decision.specialization as SpecializationKey;
	const grade = decision.grade as GradeKey;
	return {
		id: decision.id,
		attemptId: decision.attemptId,
		specialization,
		grade,
		title: testTitle(specialization, grade),
		status: decision.status,
		outcome: decision.outcome,
		decidedAt: decision.decidedAt,
		bankReleaseId: decision.bankReleaseId,
		procedureVersion: decision.procedureVersion,
		seeded: row.seeded,
		explanation: explainDecision({
			specialization,
			grade,
			outcome: decision.outcome,
			reason: decision.reason,
			confident: decision.confident,
			scoreSum: decision.scoreSum,
			cutSum: decision.cutSum,
			items: decision.items,
			extensionUsed: decision.extensionUsed,
			practice: decision.practice as { score: number; gateMinScore: number; passed: boolean } | null,
			blocks: decision.blocks as BlockSummary[]
		}),
		judgement: await attemptJudgement(db, decision.attemptId, decision.bankReleaseId, grade),
		next: await loadGradeOptions(db, gradeSources, { candidateId, specialization, now })
	};
}
