// Own vacancies of companies (docs/domain.md, section 13.1): draft → published (or → pending moderation when the text
// check blocks it) ⇄ paused → closed. A vacancy is stored complete — role, grade, work terms and a full salary range
// with a known tax base — because the employer reaches a candidate «with the vacancy and the salary»; the draft from
// pasted text is filled in by the employer before it is saved (`from-text.ts`). Every change of fields raises
// `revision` and enqueues the vector and the matches in the same transaction; so does publication.
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditActor } from '$lib/server/audit/record';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Transaction } from '$lib/server/db';
import { companyMembers, mlResults, vacancies } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { withdrawOpenInvitations } from '$lib/server/invitations/send';
import { conflict } from '$lib/server/companies/context';
import { requireAdmission } from '$lib/server/companies/gate';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import type { JobCreator } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { companyAdmitted, enqueueMatchRefresh, enqueueRevisionDerivations } from './derivations';
import { invalid, refuse, violation } from './errors';
import { VACANCY_SCHEMA_VERSION } from './text-extract';
import {
	checkVacancyText,
	sameBlockingFindings,
	sameFindings,
	textCheckSchema,
	type TextCheck,
	type TextCheckModeration
} from './text-check';
import { loadVacancyTaxonomy, type VacancyTaxonomy } from './taxonomy';

export interface VacancyDeps {
	db: Database;
	now: () => Date;
}

/** A member acting for its company; the route has checked `can(subject, 'vacancy.write', …)`. */
export interface VacancyAuthor {
	memberId: string;
	companyId: string;
	audit: AuditActor;
	requestId: string;
}

const key = z.string().regex(/^[a-z0-9_]+$/u);

export const ownVacancyInputSchema = z
	.strictObject({
		title: z.string().trim().min(3).max(200),
		description: z.string().trim().min(20).max(20_000),
		roleKey: key,
		gradeMin: key,
		gradeMax: key,
		requiredSkillKeys: z.array(key).max(30),
		niceSkillKeys: z.array(key).max(30),
		workFormat: key,
		employmentForm: key,
		contractTypes: z.array(key).min(1).max(4),
		cityId: z.string().trim().min(1).max(100).nullable(),
		timezoneOverlapHours: z.int().min(0).max(24).nullable(),
		/** A vacancy for minors from this age (domain 7.3, 13.1); `null` — only adults. */
		minAge: z.int().min(14).max(16).nullable().default(null),
		salary: z.strictObject({
			min: z.int().positive(),
			max: z.int().positive(),
			currency: z.string().regex(/^[A-Z]{3}$/u),
			period: z.enum(['month', 'year', 'hour', 'project']),
			taxBase: z.enum(['gross', 'net'])
		})
	})
	.refine((v) => v.salary.min <= v.salary.max, { path: ['salary', 'max'], message: 'max below min' });

export type OwnVacancyInput = z.infer<typeof ownVacancyInputSchema>;

/** Keys of the input exist in the taxonomy version; each failure names its field. */
function checkAgainstTaxonomy(input: OwnVacancyInput, taxonomy: VacancyTaxonomy): void {
	if (!taxonomy.roles.has(input.roleKey)) throw invalid('roleKey', 'unknown role');
	const min = taxonomy.grades.indexOf(input.gradeMin);
	const max = taxonomy.grades.indexOf(input.gradeMax);
	if (min < 0) throw invalid('gradeMin', 'unknown grade');
	if (max < 0) throw invalid('gradeMax', 'unknown grade');
	if (min > max) throw invalid('gradeMax', 'grade range is reversed');
	for (const [field, list] of [
		['requiredSkillKeys', input.requiredSkillKeys],
		['niceSkillKeys', input.niceSkillKeys]
	] as const) {
		for (const skill of list) if (!taxonomy.aliasesBySkill.has(skill)) throw invalid(field, `unknown skill ${skill}`);
	}
	if (input.requiredSkillKeys.some((s) => input.niceSkillKeys.includes(s))) {
		throw invalid('niceSkillKeys', 'a skill is both required and nice to have');
	}
	if (!taxonomy.terms.work_format.includes(input.workFormat)) throw invalid('workFormat', 'unknown work format');
	if (!taxonomy.terms.employment_form.includes(input.employmentForm)) {
		throw invalid('employmentForm', 'unknown employment form');
	}
	for (const contract of input.contractTypes) {
		if (!taxonomy.terms.contract_type.includes(contract))
			throw invalid('contractTypes', `unknown contract ${contract}`);
	}
}

/** The range of an own vacancy is in roubles only (domain 13.1): another currency is a policy, not a typo. */
function parseInput(raw: unknown): OwnVacancyInput {
	const parsed = ownVacancyInputSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw invalid(issue?.path.join('.') ?? '', issue?.message ?? 'invalid vacancy');
	}
	if (parsed.data.salary.currency !== 'RUB') throw violation('salary_not_rub', 'salary.currency');
	return parsed.data;
}

/**
 * `min_age` and the acceptance it stands on: a vacancy for minors needs the company's acceptance of the offer on the
 * work of minors in effect at the moment of the change (domain 6.2, 13.1).
 */
async function minorTerms(
	tx: Transaction,
	input: OwnVacancyInput,
	companyId: string,
	now: Date
): Promise<{ minAge: number | null; minorTermsAcceptanceId: string | null }> {
	if (input.minAge === null) return { minAge: null, minorTermsAcceptanceId: null };
	const acceptance = await minorTermsAcceptance(tx, companyId, now);
	if (!acceptance) throw violation('minor_terms_not_accepted', 'minAge');
	return { minAge: input.minAge, minorTermsAcceptanceId: acceptance.id };
}

function columnsOf(input: OwnVacancyInput, taxonomy: VacancyTaxonomy) {
	return {
		title: input.title,
		description: input.description,
		taxonomyVersionId: taxonomy.id,
		roleKey: input.roleKey,
		gradeMin: input.gradeMin,
		gradeMax: input.gradeMax,
		requiredSkillKeys: [...new Set(input.requiredSkillKeys)],
		niceSkillKeys: [...new Set(input.niceSkillKeys)],
		workFormat: input.workFormat,
		employmentForm: input.employmentForm,
		contractTypes: [...new Set(input.contractTypes)],
		cityId: input.cityId,
		timezoneOverlapHours: input.timezoneOverlapHours,
		salaryMin: input.salary.min,
		salaryMax: input.salary.max,
		salaryCurrency: input.salary.currency,
		salaryPeriod: input.salary.period,
		salaryTaxBase: input.salary.taxBase
	};
}

type VacancyRow = typeof vacancies.$inferSelect;

async function lockOwnVacancy(tx: Transaction, vacancyId: string, companyId: string): Promise<VacancyRow> {
	const [row] = await tx.select().from(vacancies).where(eq(vacancies.id, vacancyId)).for('update');
	// Another company's vacancy is indistinguishable from a missing one.
	if (!row || row.companyId !== companyId) throw refuse('not_found', 'vacancy_not_found');
	return row;
}

/** The pasted-text parse the draft was built from: extracted for this company, not yet used by another vacancy. */
async function draftParse(tx: Transaction, mlResultId: string, companyId: string): Promise<{ vacancyId: string }> {
	const [row] = await tx
		.select({ inputRef: mlResults.inputRef, schemaVersion: mlResults.schemaVersion })
		.from(mlResults)
		.where(eq(mlResults.id, mlResultId));
	const ref = z.object({ type: z.literal('vacancy'), id: z.uuid(), company_id: z.uuid() }).safeParse(row?.inputRef);
	if (!row || row.schemaVersion !== VACANCY_SCHEMA_VERSION || !ref.success || ref.data.company_id !== companyId) {
		throw invalid('fromText.mlResultId', 'unknown vacancy text parse');
	}
	const [used] = await tx.select({ id: vacancies.id }).from(vacancies).where(eq(vacancies.id, ref.data.id));
	if (used) throw invalid('fromText.mlResultId', 'the parse is already used by a vacancy');
	return { vacancyId: ref.data.id };
}

export interface CreateOwnVacancyOptions {
	/** The draft was built from pasted text: the `ml_results` row of its parse. */
	fromText?: { mlResultId: string };
}

/** Saves a new vacancy as a draft; its matches and pool are computed right away for the preview. */
export async function createOwnVacancy(
	deps: VacancyDeps,
	author: VacancyAuthor,
	raw: unknown,
	options: CreateOwnVacancyOptions = {}
): Promise<VacancyRow> {
	const input = parseInput(raw);
	return deps.db.transaction(async (tx) => {
		const taxonomy = await loadVacancyTaxonomy(tx);
		checkAgainstTaxonomy(input, taxonomy);
		const id = options.fromText
			? (await draftParse(tx, options.fromText.mlResultId, author.companyId)).vacancyId
			: uuidv7();
		const [row] = await tx
			.insert(vacancies)
			.values({
				id,
				companyId: author.companyId,
				createdByMemberId: author.memberId,
				...columnsOf(input, taxonomy),
				...(await minorTerms(tx, input, author.companyId, deps.now())),
				draftMlResultId: options.fromText?.mlResultId ?? null,
				textCheck: checkVacancyText({ title: input.title, description: input.description }),
				status: 'draft'
			})
			.returning();
		if (!row) throw new Error('vacancy was not inserted');
		await enqueueRevisionDerivations(tx, row.id, row.revision, { kind: 'user', id: author.memberId });
		return row;
	});
}

export interface UpdateOptions {
	/** The employer read and confirms the warnings of the new text. */
	confirmWarnings?: boolean;
}

function confirmed(check: TextCheck, memberId: string, now: Date): TextCheck {
	return { ...check, warnings_confirmed: { member_id: memberId, at: now.toISOString() } };
}

/**
 * Replaces the fields of a vacancy that is not closed. The text is checked again: a listed vacancy whose new text is
 * blocked leaves the catalog for moderation, unless the operator approved the same blocking findings; a vacancy in
 * moderation whose new text passes returns to where the check would have let it — `published`, or `paused` when it was
 * paused (`draft` when the company is no longer verified), and one still blocked stays with the operator with the new
 * findings. New warnings must be confirmed; unchanged warnings keep their confirmation.
 */
export async function updateOwnVacancy(
	deps: VacancyDeps,
	author: VacancyAuthor,
	vacancyId: string,
	raw: unknown,
	options: UpdateOptions = {}
): Promise<VacancyRow> {
	const input = parseInput(raw);
	return deps.db.transaction(async (tx) => {
		const current = await lockOwnVacancy(tx, vacancyId, author.companyId);
		if (current.status === 'closed') throw violation('vacancy_not_editable');
		const taxonomy = await loadVacancyTaxonomy(tx);
		checkAgainstTaxonomy(input, taxonomy);
		const now = deps.now();
		const previous = textCheckSchema.parse(current.textCheck);
		const listedAs = current.status === 'published' || current.status === 'paused' ? current.status : null;
		const listed = listedAs !== null;
		const moderated = current.status === 'pending_moderation';
		let check = checkVacancyText({ title: input.title, description: input.description });
		if (check.result === 'warnings') {
			if (previous.warnings_confirmed !== null && sameFindings(previous, check)) {
				check = { ...check, warnings_confirmed: previous.warnings_confirmed };
			} else if (options.confirmWarnings === true) {
				check = confirmed(check, author.memberId, now);
			} else if (listed || moderated) {
				throw violation('text_warnings_unconfirmed');
			}
		}
		let status = current.status;
		let moderation = previous.moderation;
		if (check.result === 'blocked') {
			const approved = previous.moderation?.decision?.outcome === 'published' && sameBlockingFindings(previous, check);
			if (listedAs !== null && !approved) {
				status = 'pending_moderation';
				moderation = { opened_at: now.toISOString(), resume_to: listedAs, decision: null };
			}
		} else if (moderated) {
			const resumeTo = moderationCaseOf(previous).resume_to;
			status = (await companyAdmitted(tx, author.companyId)) ? resumeTo : 'draft';
			moderation = null;
		} else if (listed) {
			moderation = null;
		}
		const [row] = await tx
			.update(vacancies)
			.set({
				...columnsOf(input, taxonomy),
				...(await minorTerms(tx, input, author.companyId, now)),
				textCheck: { ...check, moderation },
				// Publication itself, with its moment and journal, is `publishNow` below.
				status: status === 'published' ? current.status : status,
				revision: sql`${vacancies.revision} + 1`,
				// The pool was counted at the previous revision: until `match.refresh` of this one it is «being counted».
				poolCount: null,
				poolCountedAt: null
			})
			.where(eq(vacancies.id, vacancyId))
			.returning();
		if (!row) throw new Error('vacancy disappeared while locked');
		if (status === 'pending_moderation' && listed) {
			await recordAuditEvent(tx, {
				action: 'vacancy.blocked_text_check',
				outcome: 'success',
				actor: author.audit,
				object: { type: 'vacancy', id: vacancyId },
				requestId: author.requestId,
				details: { rules: blockingRules(check) }
			});
		}
		await enqueueRevisionDerivations(tx, row.id, row.revision, { kind: 'user', id: author.memberId });
		if (moderated && status !== 'pending_moderation') {
			await recordAuditEvent(tx, {
				action: 'vacancy.moderation_cleared',
				outcome: 'success',
				actor: author.audit,
				object: { type: 'vacancy', id: vacancyId },
				requestId: author.requestId,
				details: { status }
			});
			if (status === 'published') {
				return publishNow(tx, row, now, author.audit, author.requestId, { kind: 'user', id: author.memberId });
			}
		}
		return row;
	});
}

/**
 * The operator's case of a vacancy in `pending_moderation`: every way into moderation opens one, so a vacancy there
 * without it is a broken record, not a state to decide on.
 */
export function moderationCaseOf(check: TextCheck): TextCheckModeration {
	if (check.moderation === null) throw new Error('a vacancy in moderation carries no moderation case');
	return check.moderation;
}

const blockingRules = (check: TextCheck) => check.phrases.filter((p) => p.severity === 'block').map((p) => p.rule);

export type PublishOutcome =
	| { status: 'published'; vacancy: VacancyRow }
	| { status: 'pending_moderation'; vacancy: VacancyRow; textCheck: TextCheck };

/**
 * Lists a vacancy leaving a draft or moderation: its moment, the journal and the matches of its revision.
 */
export async function publishNow(
	tx: Transaction,
	row: VacancyRow,
	now: Date,
	audit: AuditActor,
	requestId: string,
	createdBy: JobCreator
): Promise<VacancyRow> {
	const [published] = await tx
		.update(vacancies)
		.set({ status: 'published', publishedAt: now })
		.where(eq(vacancies.id, row.id))
		.returning();
	if (!published) throw new Error('vacancy disappeared while locked');
	await recordAuditEvent(tx, {
		action: 'vacancy.published',
		outcome: 'success',
		actor: audit,
		object: { type: 'vacancy', id: row.id },
		requestId,
		details: { revision: published.revision }
	});
	await enqueueMatchRefresh(tx, row.id, published.revision, createdBy);
	return published;
}

/**
 * `draft → published` for a verified company with a full range and a clean text (or confirmed warnings); a blocked
 * text sends the vacancy to an operator (`pending_moderation`) instead.
 */
export async function publishOwnVacancy(
	deps: VacancyDeps,
	author: VacancyAuthor,
	vacancyId: string,
	options: UpdateOptions = {}
): Promise<PublishOutcome> {
	return deps.db.transaction(async (tx) => {
		const row = await lockOwnVacancy(tx, vacancyId, author.companyId);
		if (row.status !== 'draft') throw violation('vacancy_not_editable');
		await requireAdmission(tx, author.companyId, { forUpdate: true });
		if (
			row.salaryMin === null ||
			row.salaryMax === null ||
			row.salaryTaxBase === null ||
			row.salaryTaxBase === 'unknown'
		) {
			throw violation('salary_incomplete', 'salary');
		}
		let check = textCheckSchema.parse(row.textCheck);
		const now = deps.now();
		if (check.result === 'blocked') {
			// A new case: a vacancy the operator returned for editing and published again is decided anew.
			check = { ...check, moderation: { opened_at: now.toISOString(), resume_to: 'published', decision: null } };
			const [pending] = await tx
				.update(vacancies)
				.set({ status: 'pending_moderation', textCheck: check })
				.where(eq(vacancies.id, vacancyId))
				.returning();
			if (!pending) throw new Error('vacancy disappeared while locked');
			await recordAuditEvent(tx, {
				action: 'vacancy.blocked_text_check',
				outcome: 'success',
				actor: author.audit,
				object: { type: 'vacancy', id: vacancyId },
				requestId: author.requestId,
				details: { rules: blockingRules(check) }
			});
			return { status: 'pending_moderation', vacancy: pending, textCheck: check };
		}
		if (check.result === 'warnings' && check.warnings_confirmed === null) {
			if (options.confirmWarnings !== true) throw violation('text_warnings_unconfirmed');
			check = confirmed(check, author.memberId, now);
		}
		// The reason of an earlier return stays on the draft until it is published.
		await tx
			.update(vacancies)
			.set({ textCheck: { ...check, moderation: null } })
			.where(eq(vacancies.id, vacancyId));
		const vacancy = await publishNow(tx, row, now, author.audit, author.requestId, {
			kind: 'user',
			id: author.memberId
		});
		return { status: 'published', vacancy };
	});
}

/** An operator of the platform deciding on a vacancy the text check sent to moderation (domain 13.1). */
export interface ModerationDecision {
	operatorUserId: string;
	/**
	 * `publish` — the requirement is lawful (a citizenship for a state secret clearance): the vacancy returns to the
	 * catalog, or to the pause it came from; `return` — back to a draft for the employer to edit; `reject` — the vacancy
	 * is closed.
	 */
	decision: 'publish' | 'return' | 'reject';
	/**
	 * The revision of the vacancy the operator read: the employer may edit a vacancy in moderation, and a decision on a
	 * text the operator has not seen is refused (`conflict`, `vacancy_changed`).
	 */
	revision: number;
	/** Required for a return and a rejection: the employer reads it on the vacancy. */
	reason: string | null;
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
}

export const MODERATION_REASON_MAX = 2000;

const OUTCOMES = { publish: 'published', return: 'returned', reject: 'rejected' } as const;

/** Active accounts of the vacancy's author and of the owners of its company, each once. */
async function moderationRecipients(
	tx: Transaction,
	companyId: string,
	authorMemberId: string | null
): Promise<string[]> {
	const rows = await tx
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.status, 'active'),
				authorMemberId === null
					? eq(companyMembers.role, 'owner')
					: or(eq(companyMembers.id, authorMemberId), eq(companyMembers.role, 'owner'))
			)
		);
	return [...new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])))];
}

const vacancyChanged = () =>
	conflict('vacancy_changed', 'Вакансия изменилась, пока вы её смотрели: откройте её заново и проверьте текущий текст');

export async function decideVacancyModeration(
	deps: VacancyDeps,
	vacancyId: string,
	decision: ModerationDecision
): Promise<VacancyRow> {
	const reason = decision.reason?.trim() || null;
	if (reason === null && decision.decision !== 'publish') throw invalid('reason', 'a reason is required');
	if (reason !== null && reason.length > MODERATION_REASON_MAX) throw invalid('reason', 'the reason is too long');
	return deps.db.transaction(async (tx) => {
		const [row] = await tx.select().from(vacancies).where(eq(vacancies.id, vacancyId)).for('update');
		if (!row) throw refuse('not_found', 'vacancy_not_found');
		if (row.status !== 'pending_moderation') throw violation('vacancy_not_editable');
		if (row.revision !== decision.revision) throw vacancyChanged();
		const now = deps.now();
		const audit: AuditActor = { kind: 'user', userId: decision.operatorUserId };
		const createdBy = { kind: 'user', id: decision.operatorUserId } as const;
		const check = textCheckSchema.parse(row.textCheck);
		const outcome = OUTCOMES[decision.decision];
		const open = moderationCaseOf(check);
		const resumeTo = open.resume_to;
		const status = decision.decision === 'publish' ? resumeTo : decision.decision === 'return' ? 'draft' : 'closed';
		if (decision.decision === 'publish') await requireAdmission(tx, row.companyId, { forUpdate: true });
		const openedAt = open.opened_at;
		const textCheck: TextCheck = {
			...check,
			moderation: { ...open, decision: { outcome, reason, at: now.toISOString() } }
		};
		const [decided] = await tx
			.update(vacancies)
			.set({
				// Publication itself, with its moment and journal, is `publishNow` below.
				status: status === 'published' ? row.status : status,
				textCheck,
				...(status === 'closed' ? { closedAt: now } : {})
			})
			.where(eq(vacancies.id, vacancyId))
			.returning();
		if (!decided) throw new Error('vacancy disappeared while locked');
		const journal = {
			actor: audit,
			object: { type: 'vacancy', id: vacancyId },
			requestId: decision.requestId,
			ip: decision.ip ?? null,
			userAgent: decision.userAgent ?? null,
			occurredAt: now
		};
		await recordAuditEvent(tx, {
			...journal,
			action: 'vacancy.moderation_decided',
			outcome: 'success',
			details: { decision: outcome, status, rules: blockingRules(check) }
		});
		// The author and the owners learn the decision; its reason is read on the vacancy. One decision per case: the
		// case is named by the moment it opened.
		for (const userId of await moderationRecipients(tx, row.companyId, row.createdByMemberId)) {
			await notify(tx, {
				userId,
				type: 'vacancy.moderation_decided',
				objectId: vacancyId,
				stage: `${openedAt}:${userId}`,
				payload: { vacancy_id: vacancyId, decision: outcome, status }
			});
		}
		if (status === 'published') return publishNow(tx, decided, now, audit, decision.requestId, createdBy);
		if (status === 'closed') {
			await recordAuditEvent(tx, {
				...journal,
				action: 'vacancy.closed',
				outcome: 'success',
				details: { from: row.status }
			});
			// A vacancy that was listed before the edit may hold unanswered invitations (domain 13.5).
			await withdrawOpenInvitations(tx, { vacancyId }, 'vacancy_closed', { requestId: decision.requestId, at: now });
		}
		return decided;
	});
}

async function transition(
	deps: VacancyDeps,
	author: VacancyAuthor,
	vacancyId: string,
	from: readonly VacancyRow['status'][],
	to: 'published' | 'paused' | 'closed'
): Promise<VacancyRow> {
	return deps.db.transaction(async (tx) => {
		const row = await lockOwnVacancy(tx, vacancyId, author.companyId);
		if (!from.includes(row.status)) throw violation('vacancy_not_editable');
		if (to === 'published') await requireAdmission(tx, author.companyId, { forUpdate: true });
		const now = deps.now();
		const [updated] = await tx
			.update(vacancies)
			.set({ status: to, ...(to === 'closed' ? { closedAt: now } : {}) })
			.where(eq(vacancies.id, vacancyId))
			.returning();
		if (!updated) throw new Error('vacancy disappeared while locked');
		if (to === 'closed') {
			await recordAuditEvent(tx, {
				action: 'vacancy.closed',
				outcome: 'success',
				actor: author.audit,
				object: { type: 'vacancy', id: vacancyId },
				requestId: author.requestId,
				details: { from: row.status }
			});
			// Unanswered invitations by a closed vacancy are withdrawn and their candidates told (domain 13.5); accepted
			// ones keep their hiring processes.
			await withdrawOpenInvitations(tx, { vacancyId }, 'vacancy_closed', { requestId: author.requestId, at: now });
		}
		// Returning to the catalog refreshes the matches computed while the vacancy was paused.
		if (to === 'published')
			await enqueueMatchRefresh(tx, vacancyId, updated.revision, { kind: 'user', id: author.memberId });
		return updated;
	});
}

export const pauseOwnVacancy = (deps: VacancyDeps, author: VacancyAuthor, vacancyId: string) =>
	transition(deps, author, vacancyId, ['published'], 'paused');

export const resumeOwnVacancy = (deps: VacancyDeps, author: VacancyAuthor, vacancyId: string) =>
	transition(deps, author, vacancyId, ['paused'], 'published');

/**
 * Closing removes the vacancy from the catalog at once, with the teenagers visible in its context (domain 13.1), and
 * withdraws its unanswered invitations (domain 13.5).
 */
export const closeOwnVacancy = (deps: VacancyDeps, author: VacancyAuthor, vacancyId: string) =>
	transition(deps, author, vacancyId, ['draft', 'pending_moderation', 'published', 'paused'], 'closed');
