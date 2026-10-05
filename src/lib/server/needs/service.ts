// Hiring needs of a company (docs/domain.md, section 13.10): the employer writes who they look for — as text, as the
// form, or both; the text is checked for discriminatory requirements and parsed into a suggested form with quotes, the
// employer confirms the form, and the need gives the categories recommended for it. Only members of the company see
// and change its needs, while the admission policy lets the company act.
import { and, desc, eq } from 'drizzle-orm';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { can, companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { auditActorOf } from '$lib/server/companies/context';
import { admissionRefusal, requireAdmission } from '$lib/server/companies/gate';
import type { Database, Executor } from '$lib/server/db';
import { hiringNeeds } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { ApiError, policyViolation, type ErrorDetail } from '$lib/server/errors/api-error';
import type { RequestMeta } from '$lib/server/invitations/deps';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { regionReference } from '$lib/server/regions';
import { checkVacancyText, textCheckSchema, type TextCheck } from '$lib/server/vacancies/text-check';
import { needFormSchema, NEED_TEXT_MAX, parseNeedForm, type NeedForm } from './form';
import { parseNeedText, type NeedParse } from './parse';
import { countRecommendedCategories, type CountedCategory } from './recommend';

export interface NeedDeps {
	db: Database;
	models: Pick<ModelAdapter, 'extract'>;
	now: () => Date;
}

export type NeedStatus = (typeof hiringNeeds.$inferSelect)['status'];

export interface NeedView {
	id: string;
	companyId: string;
	text: string | null;
	form: NeedForm;
	parse: NeedParse | null;
	textCheck: TextCheck;
	status: NeedStatus;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * The active membership the needs belong to. A company the admission policy closed is `403` with its code; any other
 * denial — no role, an API key without the permission — is `403` too.
 */
function memberCompany(subject: AccessSubject): { companyId: string; memberId: string } {
	const membership = subject.membership;
	if (subject.userId === null) throw new ApiError('unauthenticated');
	if (membership?.status !== 'active') throw new ApiError('forbidden');
	const admission = companyAdmission(membership.companyStatus);
	if (!admission.admitted) throw admissionRefusal(admission.reason);
	if (!can(subject, 'need.manage', { companyId: membership.companyId }).allowed) throw new ApiError('forbidden');
	return { companyId: membership.companyId, memberId: membership.memberId };
}

const invalid = (details: ErrorDetail[]) => new ApiError('validation_failed', { details });

/**
 * The form of the request: the schema, a range only in roubles (`422 salary_not_rub`), a known region, a specialization
 * open now — switched on in the catalog and with a released bank (`422 specialization_closed`).
 */
async function validForm(executor: Executor, raw: unknown): Promise<NeedForm> {
	const salary = (raw as { salary?: { currency?: unknown } | null } | null)?.salary;
	if (salary !== undefined && salary !== null && salary.currency !== 'RUB') {
		throw policyViolation('salary_not_rub', 'form.salary.currency');
	}
	const parsed = needFormSchema.safeParse(raw);
	if (!parsed.success) {
		throw invalid(
			parsed.error.issues.map((issue) => ({
				path: ['form', ...issue.path].join('.'),
				code: issue.code,
				message: issue.message
			}))
		);
	}
	const form = parsed.data;
	if (form.region_code !== undefined && !(await regionReference()).has(form.region_code)) {
		throw invalid([{ path: 'form.region_code', code: 'unknown', message: 'Неизвестный регион' }]);
	}
	if (form.specialization !== undefined && !(await openSpecializations(executor)).has(form.specialization)) {
		throw policyViolation('specialization_closed', 'form.specialization');
	}
	return form;
}

function validText(raw: string | null | undefined): string | null {
	const text = raw?.trim() ? raw.trim() : null;
	if (text !== null && text.length > NEED_TEXT_MAX) {
		throw invalid([{ path: 'text', code: 'too_long', message: `Текст — не длиннее ${NEED_TEXT_MAX} символов` }]);
	}
	return text;
}

/** The text check of the need; blocked requirements are not stored (`422 text_blocked`). */
function checkText(text: string | null, form: NeedForm): TextCheck {
	const check = checkVacancyText({ text, team: form.team ?? null });
	if (check.result === 'blocked') throw policyViolation('text_blocked', 'text');
	return check;
}

function viewOf(row: typeof hiringNeeds.$inferSelect): NeedView {
	return {
		id: row.id,
		companyId: row.companyId,
		text: row.text,
		form: parseNeedForm(row.id, row.form),
		parse: row.parse as NeedParse | null,
		textCheck: textCheckSchema.parse(row.textCheck),
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export interface CreateNeedInput {
	text?: string | null;
	/** The form as the employer filled it; with a text, the parse fills only the fields the form leaves empty. */
	form?: unknown;
}

/**
 * A new need of the subject's company. A text is parsed by the model or the rules into a suggested form; the fields the
 * employer filled are kept over the suggestion. Without a text the form is the need. The need is a draft until the
 * employer confirms the form (`updateNeed` with `status: active`).
 */
export async function createNeed(
	deps: NeedDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: CreateNeedInput,
	signal?: AbortSignal
): Promise<NeedView> {
	const member = memberCompany(subject);
	const text = validText(input.text);
	const given = input.form === undefined ? null : await validForm(deps.db, input.form);
	if (text === null && given === null) {
		throw invalid([{ path: 'text', code: 'required', message: 'Опишите потребность текстом или заполните форму' }]);
	}
	checkText(text, given ?? { skill_keys: [], nice_skill_keys: [] });
	const id = uuidv7();
	let parse: NeedParse | null = null;
	let form: NeedForm = given ?? { skill_keys: [], nice_skill_keys: [] };
	if (text !== null) {
		const parsed = await parseNeedText(deps, { id, companyId: member.companyId }, text, signal);
		parse = parsed.parse;
		form = given === null ? parsed.form : mergeForms(given, parsed.form);
	}
	const textCheck = checkText(text, form);
	return deps.db.transaction(async (tx) => {
		await requireAdmission(tx, member.companyId, { forUpdate: true });
		const [row] = await tx
			.insert(hiringNeeds)
			.values({
				id,
				companyId: member.companyId,
				createdByMemberId: member.memberId,
				text,
				form,
				parse,
				textCheck,
				status: 'draft'
			})
			.returning();
		if (!row) throw new Error('need not inserted');
		await recordAuditEvent(tx, {
			action: 'need.created',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'hiring_need', id },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { parse_mode: parse?.mode ?? null, text_check: textCheck.result }
		});
		return viewOf(row);
	});
}

/** The fields the employer filled stay; the suggestion fills only what is left empty. */
function mergeForms(given: NeedForm, suggested: NeedForm): NeedForm {
	return {
		...suggested,
		...Object.fromEntries(Object.entries(given).filter(([, value]) => !(Array.isArray(value) && value.length === 0))),
		skill_keys: given.skill_keys.length > 0 ? given.skill_keys : suggested.skill_keys,
		nice_skill_keys: given.nice_skill_keys.length > 0 ? given.nice_skill_keys : suggested.nice_skill_keys
	};
}

async function ownNeed(executor: Executor, companyId: string, needId: string, forUpdate = false) {
	const query = executor
		.select()
		.from(hiringNeeds)
		.where(and(eq(hiringNeeds.id, needId), eq(hiringNeeds.companyId, companyId)));
	const [row] = forUpdate ? await query.for('update') : await query;
	// Another company's need is not known to the member (contracts 5.3).
	if (!row) throw new ApiError('not_found');
	return row;
}

export interface UpdateNeedInput {
	form?: unknown;
	status?: 'active' | 'closed';
}

/** The employer confirms or corrects the form, activates or closes the need. A closed need is not reopened. */
export async function updateNeed(
	deps: NeedDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	needId: string,
	input: UpdateNeedInput
): Promise<NeedView> {
	const member = memberCompany(subject);
	const form = input.form === undefined ? undefined : await validForm(deps.db, input.form);
	return deps.db.transaction(async (tx) => {
		await requireAdmission(tx, member.companyId, { forUpdate: true });
		const row = await ownNeed(tx, member.companyId, needId, true);
		if (row.status === 'closed') {
			throw new ApiError('conflict', { details: [{ code: 'need_closed', message: 'Потребность закрыта' }] });
		}
		const values: Partial<typeof hiringNeeds.$inferInsert> = {};
		if (form !== undefined) {
			values.form = form;
			values.textCheck = checkText(row.text, form);
		}
		if (input.status !== undefined) values.status = input.status;
		if (Object.keys(values).length === 0) return viewOf(row);
		const [updated] = await tx.update(hiringNeeds).set(values).where(eq(hiringNeeds.id, needId)).returning();
		if (!updated) throw new Error(`need ${needId} disappeared`);
		await recordAuditEvent(tx, {
			action: 'need.updated',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'hiring_need', id: needId },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { fields: Object.keys(values), status: updated.status }
		});
		return viewOf(updated);
	});
}

export async function getNeed(deps: Pick<NeedDeps, 'db'>, subject: AccessSubject, needId: string): Promise<NeedView> {
	const member = memberCompany(subject);
	return viewOf(await ownNeed(deps.db, member.companyId, needId));
}

/** The needs of the subject's company, newest first. */
export async function listNeeds(deps: Pick<NeedDeps, 'db'>, subject: AccessSubject): Promise<NeedView[]> {
	const member = memberCompany(subject);
	const rows = await deps.db
		.select()
		.from(hiringNeeds)
		.where(eq(hiringNeeds.companyId, member.companyId))
		.orderBy(desc(hiringNeeds.createdAt), desc(hiringNeeds.id));
	return rows.map(viewOf);
}

/** The categories recommended for the need, with the numbers of candidates the company sees. */
export async function needCategories(
	deps: NeedDeps,
	subject: AccessSubject,
	needId: string
): Promise<{ need: NeedView; categories: CountedCategory[] }> {
	const member = memberCompany(subject);
	const need = viewOf(await ownNeed(deps.db, member.companyId, needId));
	const categories = await countRecommendedCategories(
		deps.db,
		subject,
		need.form,
		await openSpecializations(deps.db),
		deps.now()
	);
	return { need, categories };
}
