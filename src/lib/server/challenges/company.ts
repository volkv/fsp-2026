// Calls of a company (docs/domain.md, 13.12; contracts 10.2): a short task with the range and the goal in view. The
// company writes it, publishes it for a period, sees the solutions or approaches by pseudonym and invites from a
// solution — the offer then names the solution in «why you». Only members of a company the admission policy lets act
// see and change its calls; publishing needs the profile of the company filled in, as an offer does.
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import {
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { activeCategories } from '$lib/server/categories/read';
import { admissionRefusal, loadCompanyAdmission } from '$lib/server/companies/gate';
import { loadCompanyProfile } from '$lib/server/companies/public-profile';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { challengeDeliveries, challengeSolutions, companyChallenges } from '$lib/server/db/schema';
import { policyViolation } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { memberSide, type MemberSide } from '$lib/server/invitations/records';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { checkVacancyText, textCheckSchema, type TextCheck } from '$lib/server/vacancies/text-check';
import { canShow } from '$lib/server/visibility/can-show';
import { companyNow } from './clock';

export interface ChallengeDeps {
	db: Database;
	crypto: Pick<FieldCrypto, 'pseudonym'>;
	now: () => Date;
}

export const CHALLENGE_LIMITS = {
	titleMax: 120,
	statementMin: 50,
	statementMax: 5000,
	goalMax: 500,
	timeLimitMin: 5,
	timeLimitMax: 30,
	/** The longest period a call runs. */
	periodDaysMax: 60
} as const;

type ChallengeRow = typeof companyChallenges.$inferSelect;

export interface ChallengeInput {
	title: string;
	statement: string;
	answerKind: string;
	specialization: string;
	grades: readonly string[];
	salaryMin: number;
	salaryMax: number;
	salaryCurrency: string;
	salaryTaxBase: string;
	goal: string;
	timeLimitMinutes: number;
	/** The end of the period; the start is the moment of publishing. */
	endsAt: Date;
}

export interface ChallengeView {
	id: string;
	title: string;
	statement: string;
	answerKind: 'solution' | 'approach';
	specialization: SpecializationKey;
	grades: GradeKey[];
	salary: { min: number; max: number; currency: 'RUB'; period: 'month'; taxBase: 'gross' | 'net' };
	goal: string;
	timeLimitMinutes: number;
	status: ChallengeRow['status'];
	startsAt: Date | null;
	endsAt: Date;
	textCheck: TextCheck;
	createdAt: Date;
	counts: { delivered: number; opened: number; solutions: number };
}

const trimmed = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/** The input after the checks that need no database; the range only in roubles (`422 salary_not_rub`). */
function validInput(
	input: ChallengeInput,
	now: Date
): Omit<typeof companyChallenges.$inferInsert, 'companyId' | 'createdByMemberId' | 'status' | 'textCheck'> {
	const title = trimmed(input.title);
	if (title === null || title.length > CHALLENGE_LIMITS.titleMax) {
		throw invalid('title', `Название — от 1 до ${CHALLENGE_LIMITS.titleMax} символов`);
	}
	const statement = trimmed(input.statement);
	if (
		statement === null ||
		statement.length < CHALLENGE_LIMITS.statementMin ||
		statement.length > CHALLENGE_LIMITS.statementMax
	) {
		throw invalid(
			'statement',
			`Условие — от ${CHALLENGE_LIMITS.statementMin} до ${CHALLENGE_LIMITS.statementMax} символов`
		);
	}
	const goal = trimmed(input.goal);
	if (goal === null || goal.length > CHALLENGE_LIMITS.goalMax) {
		throw invalid('goal', `Цель — от 1 до ${CHALLENGE_LIMITS.goalMax} символов`);
	}
	const answerKind = input.answerKind === 'solution' || input.answerKind === 'approach' ? input.answerKind : null;
	if (answerKind === null) throw invalid('answer_kind', 'Ответ: решение или подход');
	const specialization = SPECIALIZATION_KEYS.find((key) => key === input.specialization);
	if (!specialization) throw invalid('specialization', 'Неизвестная специализация');
	const grades = GRADE_KEYS.filter((grade) => input.grades.includes(grade));
	if (grades.length === 0 || grades.length !== new Set(input.grades).size) {
		throw invalid('grades', 'Грейды — один или несколько из справочника');
	}
	if (!Number.isSafeInteger(input.salaryMin) || input.salaryMin <= 0) {
		throw invalid('salary_min', 'Нижняя граница — целое положительное число');
	}
	if (!Number.isSafeInteger(input.salaryMax) || input.salaryMax < input.salaryMin) {
		throw invalid('salary_max', 'Верхняя граница — целое число не меньше нижней');
	}
	if (input.salaryCurrency !== 'RUB') throw policyViolation('salary_not_rub', 'salary_currency');
	const taxBase = input.salaryTaxBase === 'gross' || input.salaryTaxBase === 'net' ? input.salaryTaxBase : null;
	if (taxBase === null) throw invalid('salary_tax_base', 'Налоговая база: до вычета НДФЛ или на руки');
	if (
		!Number.isInteger(input.timeLimitMinutes) ||
		input.timeLimitMinutes < CHALLENGE_LIMITS.timeLimitMin ||
		input.timeLimitMinutes > CHALLENGE_LIMITS.timeLimitMax
	) {
		throw invalid(
			'time_limit_minutes',
			`Время на задачу — от ${CHALLENGE_LIMITS.timeLimitMin} до ${CHALLENGE_LIMITS.timeLimitMax} минут`
		);
	}
	if (Number.isNaN(input.endsAt.getTime()) || input.endsAt <= now) throw invalid('ends_at', 'Окончание — в будущем');
	if (input.endsAt.getTime() - now.getTime() > CHALLENGE_LIMITS.periodDaysMax * 86_400_000) {
		throw invalid('ends_at', `Вызов идёт не дольше ${CHALLENGE_LIMITS.periodDaysMax} дней`);
	}
	return {
		title,
		statement,
		goal,
		answerKind,
		specialization,
		grades,
		salaryMin: input.salaryMin,
		salaryMax: input.salaryMax,
		salaryCurrency: 'RUB',
		salaryPeriod: 'month',
		salaryTaxBase: taxBase,
		timeLimitMinutes: input.timeLimitMinutes,
		endsAt: input.endsAt
	};
}

/** The text check of the call: a blocked requirement is not stored (`422 text_blocked`). */
function checkText(fields: { title: string; statement: string; goal: string }): TextCheck {
	const check = checkVacancyText(fields);
	if (check.result === 'blocked') throw policyViolation('text_blocked', 'statement');
	return check;
}

/** The member acting for the company: admitted by the policy (`403` with its code) and holding `challenge.manage`. */
async function managingMember(executor: Executor, subject: AccessSubject): Promise<MemberSide> {
	const member = memberSide(subject);
	const admission = await loadCompanyAdmission(executor, member.companyId);
	if (!admission.admitted) throw admissionRefusal(admission.reason);
	if (!can(subject, 'challenge.manage', { companyId: member.companyId }).allowed)
		throw refuse('forbidden', 'permission');
	return member;
}

async function counts(executor: Executor, ids: readonly string[]) {
	const result = new Map<string, ChallengeView['counts']>(
		ids.map((id) => [id, { delivered: 0, opened: 0, solutions: 0 }])
	);
	if (ids.length === 0) return result;
	const rows = await executor
		.select({
			challengeId: challengeDeliveries.challengeId,
			delivered: count(),
			opened: sql<number>`count(*) filter (where ${challengeDeliveries.openedAt} is not null)::int`,
			solutions: sql<number>`count(${challengeSolutions.id}) filter (where ${challengeSolutions.status} = 'submitted')::int`
		})
		.from(challengeDeliveries)
		.leftJoin(challengeSolutions, eq(challengeSolutions.deliveryId, challengeDeliveries.id))
		.where(inArray(challengeDeliveries.challengeId, [...ids]))
		.groupBy(challengeDeliveries.challengeId);
	for (const row of rows) {
		result.set(row.challengeId, { delivered: row.delivered, opened: row.opened, solutions: row.solutions });
	}
	return result;
}

function viewOf(row: ChallengeRow, counted: ChallengeView['counts']): ChallengeView {
	if (
		row.salaryMin === null ||
		row.salaryMax === null ||
		(row.salaryTaxBase !== 'gross' && row.salaryTaxBase !== 'net')
	) {
		throw new Error(`call ${row.id} has no full range in roubles`);
	}
	return {
		id: row.id,
		title: row.title,
		statement: row.statement,
		answerKind: row.answerKind,
		specialization: row.specialization,
		grades: row.grades.filter((grade): grade is GradeKey => (GRADE_KEYS as readonly string[]).includes(grade)),
		salary: { min: row.salaryMin, max: row.salaryMax, currency: 'RUB', period: 'month', taxBase: row.salaryTaxBase },
		goal: row.goal,
		timeLimitMinutes: row.timeLimitMinutes,
		status: row.status,
		startsAt: row.startsAt,
		endsAt: row.endsAt,
		textCheck: textCheckSchema.parse(row.textCheck),
		createdAt: row.createdAt,
		counts: counted
	};
}

async function viewsOf(executor: Executor, rows: readonly ChallengeRow[]): Promise<ChallengeView[]> {
	const counted = await counts(
		executor,
		rows.map((row) => row.id)
	);
	return rows.map((row) => viewOf(row, counted.get(row.id) ?? { delivered: 0, opened: 0, solutions: 0 }));
}

async function journal(
	tx: Transaction,
	actor: AuditActor,
	meta: RequestMeta,
	action: 'challenge.published' | 'challenge.updated' | 'challenge.closed',
	challengeId: string,
	details: Record<string, string | number | boolean | null>,
	at: Date
): Promise<void> {
	await recordAuditEvent(tx, {
		action,
		outcome: 'success',
		actor,
		object: { type: 'company_challenge', id: challengeId },
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details,
		occurredAt: at
	});
}

/** Publishing needs an open specialization and a filled-in profile of the company (domain 13.5, 13.12). */
async function requirePublishable(executor: Executor, companyId: string, specialization: SpecializationKey) {
	if (!(await openSpecializations(executor)).has(specialization))
		throw policyViolation('specialization_closed', 'specialization');
	if (!(await loadCompanyProfile(executor, companyId)).complete) throw policyViolation('company_profile_incomplete');
}

/** A new call of the subject's company (`POST /api/v1/challenges`): a draft, or published at once with `publish`. */
export async function createChallenge(
	deps: ChallengeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: ChallengeInput & { publish: boolean }
): Promise<ChallengeView> {
	return deps.db.transaction(async (tx) => {
		const member = await managingMember(tx, subject);
		const now = await companyNow(tx, member.companyId, deps.now());
		const values = validInput(input, now);
		const textCheck = checkText({ title: values.title, statement: values.statement, goal: values.goal });
		if (input.publish) await requirePublishable(tx, member.companyId, values.specialization);
		const [row] = await tx
			.insert(companyChallenges)
			.values({
				...values,
				companyId: member.companyId,
				createdByMemberId: member.memberId,
				status: input.publish ? 'active' : 'draft',
				startsAt: input.publish ? now : null,
				textCheck
			})
			.returning();
		if (!row) throw new Error('call was not inserted');
		if (input.publish) {
			await journal(tx, auditActor(subject, meta, 'company'), meta, 'challenge.published', row.id, {}, now);
		}
		const [view] = await viewsOf(tx, [row]);
		if (!view) throw new Error('view of a new call was not built');
		return view;
	});
}

export interface ChallengePatch extends Partial<ChallengeInput> {
	status?: 'active' | 'closed';
}

/**
 * Changes a call (`PATCH /api/v1/challenges/{id}`): the content of a draft, the publishing of a draft (`active`), the
 * end of an active call and its closing (`closed`). A published call keeps its terms: the candidates saw them.
 */
export async function updateChallenge(
	deps: ChallengeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	challengeId: string,
	patch: ChallengePatch
): Promise<ChallengeView> {
	return deps.db.transaction(async (tx) => {
		const member = await managingMember(tx, subject);
		const [row] = await tx
			.select()
			.from(companyChallenges)
			.where(and(eq(companyChallenges.id, challengeId), eq(companyChallenges.companyId, member.companyId)))
			.for('update');
		if (!row) throw refuse('not_found', 'foreign_challenge');
		const now = await companyNow(tx, member.companyId, deps.now());
		const actor = auditActor(subject, meta, 'company');
		if (row.status === 'closed')
			throw refuse('conflict', 'challenge_closed', [{ code: 'challenge_closed', message: 'Вызов закрыт' }]);
		const { status, ...content } = patch;
		const changesContent = Object.keys(content).length > 0;
		let next: ChallengeRow = row;
		if (changesContent) {
			if (row.status !== 'draft') {
				const onlyEnd = Object.keys(content).every((key) => key === 'endsAt');
				if (!onlyEnd) {
					throw refuse('conflict', 'challenge_published', [
						{ code: 'challenge_published', message: 'У опубликованного вызова меняется только окончание' }
					]);
				}
			}
			const values = validInput(
				{
					title: content.title ?? row.title,
					statement: content.statement ?? row.statement,
					answerKind: content.answerKind ?? row.answerKind,
					specialization: content.specialization ?? row.specialization,
					grades: content.grades ?? row.grades,
					salaryMin: content.salaryMin ?? row.salaryMin ?? 0,
					salaryMax: content.salaryMax ?? row.salaryMax ?? 0,
					salaryCurrency: content.salaryCurrency ?? row.salaryCurrency ?? '',
					salaryTaxBase: content.salaryTaxBase ?? row.salaryTaxBase ?? '',
					goal: content.goal ?? row.goal,
					timeLimitMinutes: content.timeLimitMinutes ?? row.timeLimitMinutes,
					endsAt: content.endsAt ?? row.endsAt
				},
				now
			);
			const textCheck = checkText({ title: values.title, statement: values.statement, goal: values.goal });
			const [updated] = await tx
				.update(companyChallenges)
				.set({ ...values, textCheck })
				.where(eq(companyChallenges.id, row.id))
				.returning();
			if (!updated) throw new Error(`call ${row.id} disappeared`);
			next = updated;
			await journal(tx, actor, meta, 'challenge.updated', row.id, {}, now);
		}
		if (status === 'active' && next.status === 'draft') {
			await requirePublishable(tx, member.companyId, next.specialization);
			if (next.endsAt <= now) throw invalid('ends_at', 'Окончание — в будущем');
			const [published] = await tx
				.update(companyChallenges)
				.set({ status: 'active', startsAt: now })
				.where(eq(companyChallenges.id, row.id))
				.returning();
			if (!published) throw new Error(`call ${row.id} disappeared`);
			next = published;
			await journal(tx, actor, meta, 'challenge.published', row.id, {}, now);
		} else if (status === 'closed') {
			const [closed] = await tx
				.update(companyChallenges)
				.set({ status: 'closed' })
				.where(eq(companyChallenges.id, row.id))
				.returning();
			if (!closed) throw new Error(`call ${row.id} disappeared`);
			next = closed;
			await journal(tx, actor, meta, 'challenge.closed', row.id, { reason: 'company' }, now);
		} else if (status === 'active' && next.status !== 'active') {
			throw refuse('conflict', 'challenge_not_draft');
		}
		const [view] = await viewsOf(tx, [next]);
		if (!view) throw new Error('view of a call was not built');
		return view;
	});
}

/** The calls of the subject's company, newest first. */
export async function listChallenges(deps: ChallengeDeps, subject: AccessSubject): Promise<ChallengeView[]> {
	const member = await managingMember(deps.db, subject);
	const rows = await deps.db
		.select()
		.from(companyChallenges)
		.where(eq(companyChallenges.companyId, member.companyId))
		.orderBy(desc(companyChallenges.createdAt));
	return viewsOf(deps.db, rows);
}

export async function getChallenge(
	deps: ChallengeDeps,
	subject: AccessSubject,
	challengeId: string
): Promise<ChallengeView> {
	const member = await managingMember(deps.db, subject);
	const [row] = await deps.db
		.select()
		.from(companyChallenges)
		.where(and(eq(companyChallenges.id, challengeId), eq(companyChallenges.companyId, member.companyId)));
	if (!row) throw refuse('not_found', 'foreign_challenge');
	const [view] = await viewsOf(deps.db, [row]);
	if (!view) throw new Error('view of a call was not built');
	return view;
}

export interface SolutionView {
	id: string;
	/** The candidate for the company: the pseudonym, never the name (domain 14). */
	pseudonym: string;
	/** The category of the candidate in the specialization of the call, if any. */
	category: { specialization: SpecializationKey; grade: GradeKey } | null;
	content: string;
	submittedAt: Date;
	decision: 'invited' | 'dismissed' | null;
	decidedAt: Date | null;
}

/**
 * The solutions of a call (`GET /api/v1/challenges/{id}/solutions`) by pseudonym: withdrawn ones are not shown, nor the
 * solutions of candidates the company no longer sees (hidden, blocked the company, deleted).
 */
export async function challengeSolutionsOf(
	deps: ChallengeDeps,
	subject: AccessSubject,
	challengeId: string
): Promise<{ challenge: ChallengeView; solutions: SolutionView[] }> {
	const challenge = await getChallenge(deps, subject, challengeId);
	const member = memberSide(subject);
	const rows = await deps.db
		.select({
			id: challengeSolutions.id,
			candidateId: challengeDeliveries.candidateId,
			content: challengeSolutions.content,
			submittedAt: challengeSolutions.submittedAt,
			decision: challengeSolutions.companyDecision,
			decidedAt: challengeSolutions.decidedAt
		})
		.from(challengeSolutions)
		.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
		.where(and(eq(challengeDeliveries.challengeId, challengeId), eq(challengeSolutions.status, 'submitted')))
		.orderBy(desc(challengeSolutions.submittedAt));
	const now = deps.now();
	const viewer = await loadCatalogViewer(deps.db, subject, now);
	if (!viewer) throw refuse('forbidden', 'not_member');
	const facts = await loadVisibilityFacts(
		deps.db,
		rows.map((row) => row.candidateId),
		{
			now,
			policy: await loadVisibilityPolicy(deps.db, now),
			viewerCompanyId: member.companyId,
			viewerCompany: viewer.company
		}
	);
	const categories = await activeCategories(
		deps.db,
		rows.map((row) => row.candidateId)
	);
	const solutions: SolutionView[] = [];
	for (const row of rows) {
		const candidate = facts.get(row.candidateId);
		if (!candidate || !canShow(candidate, viewer.viewer, { kind: 'catalog' }).allowed) continue;
		if (row.content === null) throw new Error(`submitted solution ${row.id} has no content`);
		const category = (categories.get(row.candidateId) ?? []).find((c) => c.specialization === challenge.specialization);
		solutions.push({
			id: row.id,
			pseudonym: deps.crypto.pseudonym(row.candidateId, member.companyId),
			category: category ? { specialization: category.specialization, grade: category.grade } : null,
			content: row.content,
			submittedAt: row.submittedAt,
			decision: row.decision,
			decidedAt: row.decidedAt
		});
	}
	return { challenge, solutions };
}

/** The company sets a solution aside (`POST /api/v1/challenges/{id}/solutions/{solution_id}/dismissal`). */
export async function dismissSolution(
	deps: ChallengeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	challengeId: string,
	solutionId: string
): Promise<void> {
	await deps.db.transaction(async (tx) => {
		const member = await managingMember(tx, subject);
		const [row] = await tx
			.select({
				id: challengeSolutions.id,
				decision: challengeSolutions.companyDecision,
				candidateId: challengeDeliveries.candidateId
			})
			.from(challengeSolutions)
			.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
			.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
			.where(
				and(
					eq(challengeSolutions.id, solutionId),
					eq(challengeSolutions.status, 'submitted'),
					eq(companyChallenges.id, challengeId),
					eq(companyChallenges.companyId, member.companyId)
				)
			)
			.for('update', { of: challengeSolutions });
		if (!row) throw refuse('not_found', 'foreign_solution');
		if (row.decision !== null) throw refuse('conflict', 'already_decided');
		const now = deps.now();
		await tx
			.update(challengeSolutions)
			.set({ companyDecision: 'dismissed', decidedAt: now, decidedByMemberId: member.memberId })
			.where(eq(challengeSolutions.id, row.id));
		await recordAuditEvent(tx, {
			action: 'challenge.solution_dismissed',
			outcome: 'success',
			actor: auditActor(subject, meta, 'company'),
			object: { type: 'challenge_solution', id: row.id },
			subjectCandidateId: row.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		});
	});
}

/** The solutions the candidate keeps to the calls of the company, newest first: points «why you» may name. */
export async function solutionsOfCandidate(
	executor: Executor,
	pair: { candidateId: string; companyId: string }
): Promise<{ id: string; challengeTitle: string; submittedAt: Date; decision: 'invited' | 'dismissed' | null }[]> {
	return executor
		.select({
			id: challengeSolutions.id,
			challengeTitle: companyChallenges.title,
			submittedAt: challengeSolutions.submittedAt,
			decision: challengeSolutions.companyDecision
		})
		.from(challengeSolutions)
		.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
		.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
		.where(
			and(
				eq(challengeSolutions.status, 'submitted'),
				eq(challengeDeliveries.candidateId, pair.candidateId),
				eq(companyChallenges.companyId, pair.companyId)
			)
		)
		.orderBy(desc(challengeSolutions.submittedAt));
}

/** A solution the candidate keeps, to a call of the company, by this candidate: what «why you» may name. */
export async function solutionOfPair(
	executor: Executor,
	solutionId: string,
	pair: { candidateId: string; companyId: string }
): Promise<boolean> {
	if (!/^[0-9a-f-]{36}$/u.test(solutionId)) return false;
	const [row] = await executor
		.select({ id: challengeSolutions.id })
		.from(challengeSolutions)
		.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
		.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
		.where(
			and(
				eq(challengeSolutions.id, solutionId),
				eq(challengeSolutions.status, 'submitted'),
				eq(challengeDeliveries.candidateId, pair.candidateId),
				eq(companyChallenges.companyId, pair.companyId)
			)
		);
	return row !== undefined;
}

/**
 * The offer names these solutions in «why you»: the company invited from them (domain 13.12). A solution already marked
 * keeps its first decision; the journal records the invitation from each.
 */
export async function markSolutionsInvited(
	tx: Transaction,
	solutionIds: readonly string[],
	context: {
		candidateId: string;
		companyId: string;
		memberId: string;
		invitationId: string;
		actor: AuditActor;
		requestId: string;
		now: Date;
	}
): Promise<void> {
	if (solutionIds.length === 0) return;
	const marked = await tx
		.update(challengeSolutions)
		.set({ companyDecision: 'invited', decidedAt: context.now, decidedByMemberId: context.memberId })
		.where(
			and(
				inArray(challengeSolutions.id, [...solutionIds]),
				sql`${challengeSolutions.companyDecision} is distinct from 'invited'`
			)
		)
		.returning({ id: challengeSolutions.id });
	for (const solution of marked) {
		await recordAuditEvent(tx, {
			action: 'challenge.invited_from_solution',
			outcome: 'success',
			actor: context.actor,
			object: { type: 'challenge_solution', id: solution.id },
			subjectCandidateId: context.candidateId,
			requestId: context.requestId,
			details: { invitation_id: context.invitationId },
			occurredAt: context.now
		});
	}
}
