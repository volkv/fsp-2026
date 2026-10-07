// Moderation of own vacancies as the operator works it (docs/domain.md 13.1): the vacancies a blocked text check sent
// to the operator, oldest case first, with the phrases that blocked them quoted in their surroundings; the case of one
// vacancy with its history; and the decision of `vacancies/own.ts` — publish, return for editing with a reason, or
// reject, which the author and the owners of the company are notified of. It stands on `vacancy.moderate`. The
// operator sees the vacancies of the companies within its reach: a clone operator of a demo session — those of its
// session only (domain 19.3).
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { CompanyStatus } from '$lib/server/companies/gate';
import type { Database, Executor } from '$lib/server/db';
import { getOwnVacancy, type OwnVacancyView } from '$lib/server/employer/vacancies';
import { auditEvents, companies, vacancies } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import {
	decideVacancyModeration,
	moderationCaseOf,
	MODERATION_REASON_MAX,
	type ModerationDecision
} from '$lib/server/vacancies/own';
import {
	quoteOf,
	textCheckSchema,
	type PhraseQuote,
	type TextCheckModeration,
	type TextCheckPhrase
} from '$lib/server/vacancies/text-check';

export interface ModerationFinding {
	rule: string;
	category: TextCheckPhrase['category'];
	severity: TextCheckPhrase['severity'];
	/** `title` or `description`. */
	field: string;
	explanation: string;
	quote: PhraseQuote;
}

export interface ModerationQueueItem {
	vacancyId: string;
	title: string;
	company: { id: string; displayName: string; inn: string; status: CompanyStatus };
	/** The revision the findings are of: a decision names it (`decideModeration`). */
	revision: number;
	/** When the vacancy went to the operator. */
	openedAt: Date;
	resumeTo: TextCheckModeration['resume_to'];
	/** The blocking phrases; warnings are read in the case. */
	findings: ModerationFinding[];
}

type Row = Pick<typeof vacancies.$inferSelect, 'title' | 'description' | 'textCheck'>;

function findingsOf(row: Row, severity?: TextCheckPhrase['severity']): ModerationFinding[] {
	const fields: Record<string, string> = { title: row.title, description: row.description };
	return textCheckSchema
		.parse(row.textCheck)
		.phrases.filter((phrase) => severity === undefined || phrase.severity === severity)
		.map((phrase) => {
			const value = fields[phrase.field];
			if (value === undefined) throw new Error(`a text check phrase names an unknown field ${phrase.field}`);
			return {
				rule: phrase.rule,
				category: phrase.category,
				severity: phrase.severity,
				field: phrase.field,
				explanation: phrase.explanation,
				quote: quoteOf(value, phrase)
			};
		});
}

const openedAtSql = sql`(${vacancies.textCheck} -> 'moderation' ->> 'opened_at')::timestamptz`;

const pending = (reach: StaffReach) =>
	and(eq(vacancies.status, 'pending_moderation'), reach.rows(companies.demoSessionId));

/** Vacancies waiting for the operator's decision, oldest case first. */
export async function vacancyModerationQueue(
	executor: Executor,
	subject: AccessSubject
): Promise<ModerationQueueItem[]> {
	requirePermission(subject, 'vacancy.moderate', null);
	const reach = await StaffReach.of(executor, subject);
	const rows = await executor
		.select({
			id: vacancies.id,
			title: vacancies.title,
			description: vacancies.description,
			revision: vacancies.revision,
			textCheck: vacancies.textCheck,
			companyId: companies.id,
			displayName: companies.displayName,
			inn: companies.inn,
			companyStatus: companies.status
		})
		.from(vacancies)
		.innerJoin(companies, eq(companies.id, vacancies.companyId))
		.where(pending(reach))
		.orderBy(asc(openedAtSql), asc(vacancies.id));
	return rows.map((row) => {
		const moderation = moderationCaseOf(textCheckSchema.parse(row.textCheck));
		return {
			vacancyId: row.id,
			title: row.title,
			company: { id: row.companyId, displayName: row.displayName, inn: row.inn, status: row.companyStatus },
			revision: row.revision,
			openedAt: new Date(moderation.opened_at),
			resumeTo: moderation.resume_to,
			findings: findingsOf(row, 'block')
		};
	});
}

/** How many vacancies wait for the operator, for the first screen of the cabinet. */
export async function pendingVacancyModeration(executor: Executor, reach: StaffReach): Promise<number> {
	const [row] = await executor
		.select({ n: count() })
		.from(vacancies)
		.innerJoin(companies, eq(companies.id, vacancies.companyId))
		.where(pending(reach));
	return row?.n ?? 0;
}

/** Events of the journal that make the history of a moderation case. */
const HISTORY_ACTIONS = [
	'vacancy.blocked_text_check',
	'vacancy.moderation_decided',
	'vacancy.moderation_cleared',
	'vacancy.published',
	'vacancy.closed'
] as const;

export interface ModerationHistoryEntry {
	at: Date;
	action: (typeof HISTORY_ACTIONS)[number];
	/** `company` — a member of the vacancy's company; `operator` — anybody else (the staff). */
	by: 'company' | 'operator' | 'system';
	decision: 'published' | 'returned' | 'rejected' | null;
	status: string | null;
}

export interface ModerationCase {
	/** The vacancy as its company sees it: terms, text, status and the stored check with the case. */
	vacancy: OwnVacancyView;
	company: { id: string; displayName: string; legalName: string; inn: string; status: CompanyStatus };
	/** Every finding of the check, blocking and warnings, quoted in place. */
	findings: ModerationFinding[];
	history: ModerationHistoryEntry[];
}

const historyDetails = z.looseObject({
	decision: z.enum(['published', 'returned', 'rejected']).optional(),
	status: z.string().optional()
});

async function reachedVacancy(executor: Executor, subject: AccessSubject, vacancyId: string) {
	requirePermission(subject, 'vacancy.moderate', null);
	if (!z.uuid().safeParse(vacancyId).success) throw new ApiError('not_found');
	const [row] = await executor
		.select({ vacancy: vacancies, company: companies })
		.from(vacancies)
		.innerJoin(companies, eq(companies.id, vacancies.companyId))
		.where(eq(vacancies.id, vacancyId));
	if (!row) throw new ApiError('not_found');
	(await StaffReach.of(executor, subject)).require(row.company.demoSessionId);
	return row;
}

/**
 * One vacancy as the operator decides on it: its terms, every finding of the check quoted in place, the case and its
 * history from the journal. A vacancy that is no longer in moderation is still readable, with the decision taken.
 */
export async function vacancyModerationCase(
	executor: Executor,
	subject: AccessSubject,
	vacancyId: string,
	now: Date
): Promise<ModerationCase> {
	const { vacancy, company } = await reachedVacancy(executor, subject, vacancyId);
	const view = await getOwnVacancy(executor, company.id, vacancy.id, now);
	const events = await executor
		.select({
			at: auditEvents.occurredAt,
			action: auditEvents.action,
			actorKind: auditEvents.actorKind,
			actorCompanyId: auditEvents.actorCompanyId,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.objectType, 'vacancy'),
				eq(auditEvents.objectId, vacancy.id),
				inArray(auditEvents.action, [...HISTORY_ACTIONS])
			)
		)
		.orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
	return {
		vacancy: view,
		company: {
			id: company.id,
			displayName: company.displayName,
			legalName: company.legalName,
			inn: company.inn,
			status: company.status
		},
		findings: findingsOf(vacancy),
		history: events.map((event) => {
			const details = historyDetails.parse(event.details ?? {});
			const action = HISTORY_ACTIONS.find((known) => known === event.action);
			if (action === undefined) throw new Error(`unexpected journal action ${event.action}`);
			return {
				at: event.at,
				action,
				by: event.actorKind === 'system' ? 'system' : event.actorCompanyId === company.id ? 'company' : 'operator',
				decision: details.decision ?? null,
				status: details.status ?? null
			};
		})
	};
}

export type ModerationChoice = ModerationDecision['decision'];

/**
 * The operator's decision on a vacancy in moderation; a return and a rejection need a reason. `revision` is the one the
 * operator read: the employer may have edited the vacancy since, and then the decision is refused.
 */
export async function decideModeration(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	vacancyId: string,
	decision: ModerationChoice,
	reason: string,
	revision: number
): Promise<void> {
	const { vacancy } = await reachedVacancy(db, subject, vacancyId);
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw invalid([{ path: 'revision', code: 'invalid', message: 'Не указана версия вакансии, которую вы смотрели' }]);
	}
	const text = reason.trim();
	if (text === '' && decision !== 'publish') {
		throw invalid([{ path: 'reason', code: 'required', message: 'Напишите компании, что исправить или почему отказ' }]);
	}
	if (text.length > MODERATION_REASON_MAX) {
		throw invalid([
			{ path: 'reason', code: 'invalid_length', message: `Не длиннее ${MODERATION_REASON_MAX} символов` }
		]);
	}
	// Another operator may have answered first, or the employer cleared the text: the case is just no longer open.
	if (vacancy.status !== 'pending_moderation') {
		throw conflict('vacancy_not_in_moderation', 'Вакансия уже не на модерации: решение принято или текст исправлен');
	}
	await decideVacancyModeration({ db, now: () => new Date() }, vacancyId, {
		operatorUserId: sessionUserId(subject),
		decision,
		revision,
		reason: text === '' ? null : text,
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent
	});
}
