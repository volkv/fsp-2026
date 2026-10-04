// Reading the action journal (domain 18) under `audit.read`, with filters by event, outcome, actor, object and time.
// Every reading is itself journaled (`audit.read`) with its filters. The page shows identifiers and codes only: the
// address and the browser of the actor stay in the journal and are not shown. A reader reads the events within its
// reach: a clone of a demo session — the events of its own session only (domain 19.3).
import { and, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import { AUDIT_ACTIONS, type AuditAction } from '$lib/server/audit/events';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { ActionContext } from '$lib/server/companies/context';
import { invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database } from '$lib/server/db';
import { auditEvents } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';

export const JOURNAL_PAGE_SIZE = 50;

const OUTCOMES = ['success', 'denied', 'failure'] as const;
type Outcome = (typeof OUTCOMES)[number];

export interface JournalFilters {
	action: AuditAction | null;
	outcome: Outcome | null;
	actorUserId: string | null;
	objectType: string | null;
	objectId: string | null;
	/** Days, inclusive, in UTC. */
	from: string | null;
	to: string | null;
	cursor: string | null;
}

/** The same shape as a code in journal details: filters are journaled with the reading. */
const token = z.string().regex(/^[A-Za-z0-9_.:@/+-]{1,128}$/);
const day = z.iso.date();
const cursorSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f-]{36}$/);

function optional(params: URLSearchParams, name: string): string | null {
	const value = params.get(name)?.trim() ?? '';
	return value === '' ? null : value;
}

/** Filters from the query of the page; a value that cannot be a filter is a field problem, not ignored. */
export function parseJournalFilters(params: URLSearchParams): JournalFilters {
	const problems: ErrorDetail[] = [];
	const action = optional(params, 'action');
	const outcome = optional(params, 'outcome');
	const actorUserId = optional(params, 'actor');
	const objectType = optional(params, 'objectType');
	const objectId = optional(params, 'objectId');
	const from = optional(params, 'from');
	const to = optional(params, 'to');
	const cursor = optional(params, 'cursor');
	const knownAction = AUDIT_ACTIONS.find((value) => value === action) ?? null;
	const knownOutcome = OUTCOMES.find((value) => value === outcome) ?? null;
	if (action !== null && knownAction === null)
		problems.push({ path: 'action', code: 'invalid', message: 'Нет такого события' });
	if (outcome !== null && knownOutcome === null)
		problems.push({ path: 'outcome', code: 'invalid', message: 'Нет такого исхода' });
	if (actorUserId !== null && !z.uuid().safeParse(actorUserId).success)
		problems.push({ path: 'actor', code: 'invalid', message: 'Идентификатор аккаунта — UUID' });
	if (objectType !== null && !token.safeParse(objectType).success)
		problems.push({ path: 'objectType', code: 'invalid', message: 'Тип объекта — код без пробелов' });
	if (objectId !== null && !token.safeParse(objectId).success)
		problems.push({ path: 'objectId', code: 'invalid', message: 'Идентификатор объекта — без пробелов' });
	if (from !== null && !day.safeParse(from).success)
		problems.push({ path: 'from', code: 'invalid', message: 'Дата в формате ГГГГ-ММ-ДД' });
	if (to !== null && !day.safeParse(to).success)
		problems.push({ path: 'to', code: 'invalid', message: 'Дата в формате ГГГГ-ММ-ДД' });
	if (from !== null && to !== null && from > to)
		problems.push({ path: 'to', code: 'invalid', message: 'Конец периода раньше начала' });
	if (cursor !== null && !cursorSchema.safeParse(cursor).success)
		problems.push({ path: 'cursor', code: 'invalid', message: 'Ссылка на страницу устарела' });
	if (problems.length > 0) throw invalid(problems);
	return { action: knownAction, outcome: knownOutcome, actorUserId, objectType, objectId, from, to, cursor };
}

export interface JournalEntry {
	id: string;
	occurredAt: Date;
	action: string;
	outcome: Outcome;
	actorKind: 'user' | 'api_key' | 'system' | 'anonymous';
	actorUserId: string | null;
	actorCompanyId: string | null;
	apiKeyId: string | null;
	objectType: string | null;
	objectId: string | null;
	subjectCandidateId: string | null;
	requestId: string;
	details: unknown;
}

export interface JournalPage {
	entries: JournalEntry[];
	nextCursor: string | null;
}

const nextDay = (value: string) => new Date(new Date(`${value}T00:00:00Z`).getTime() + 86_400_000);

export async function readJournal(db: Database, ctx: ActionContext, filters: JournalFilters): Promise<JournalPage> {
	requirePermission(ctx.subject, 'audit.read', null);
	const readerId = sessionUserId(ctx.subject);
	const conditions: SQL[] = [];
	const reach = (await StaffReach.of(db, ctx.subject)).journal(auditEvents);
	if (reach) conditions.push(reach);
	if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
	if (filters.outcome) conditions.push(eq(auditEvents.outcome, filters.outcome));
	if (filters.actorUserId) conditions.push(eq(auditEvents.actorUserId, filters.actorUserId));
	if (filters.objectType) conditions.push(eq(auditEvents.objectType, filters.objectType));
	if (filters.objectId) conditions.push(eq(auditEvents.objectId, filters.objectId));
	if (filters.from) conditions.push(gte(auditEvents.occurredAt, new Date(`${filters.from}T00:00:00Z`)));
	if (filters.to) conditions.push(lt(auditEvents.occurredAt, nextDay(filters.to)));
	if (filters.cursor) {
		const at = new Date(filters.cursor.slice(0, filters.cursor.indexOf('_')));
		const id = filters.cursor.slice(filters.cursor.indexOf('_') + 1);
		const keyset = or(lt(auditEvents.occurredAt, at), and(eq(auditEvents.occurredAt, at), lt(auditEvents.id, id)));
		if (keyset) conditions.push(keyset);
	}
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({
				id: auditEvents.id,
				occurredAt: auditEvents.occurredAt,
				action: auditEvents.action,
				outcome: auditEvents.outcome,
				actorKind: auditEvents.actorKind,
				actorUserId: auditEvents.actorUserId,
				actorCompanyId: auditEvents.actorCompanyId,
				apiKeyId: auditEvents.apiKeyId,
				objectType: auditEvents.objectType,
				objectId: auditEvents.objectId,
				subjectCandidateId: auditEvents.subjectCandidateId,
				requestId: auditEvents.requestId,
				details: auditEvents.details
			})
			.from(auditEvents)
			.where(and(...conditions))
			.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
			.limit(JOURNAL_PAGE_SIZE + 1);
		const entries = rows.slice(0, JOURNAL_PAGE_SIZE);
		const last = entries.at(-1);
		await recordAuditEvent(tx, {
			action: 'audit.read',
			outcome: 'success',
			actor: { kind: 'user', userId: readerId },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: {
				result_count: entries.length,
				...(filters.action ? { action: filters.action } : {}),
				...(filters.outcome ? { outcome: filters.outcome } : {}),
				...(filters.actorUserId ? { actor_user_id: filters.actorUserId } : {}),
				...(filters.objectType ? { object_type: filters.objectType } : {}),
				...(filters.objectId ? { object_id: filters.objectId } : {}),
				...(filters.from ? { from: filters.from } : {}),
				...(filters.to ? { to: filters.to } : {}),
				...(filters.cursor ? { page_after: filters.cursor.slice(filters.cursor.indexOf('_') + 1) } : {})
			}
		});
		return {
			entries,
			nextCursor: rows.length > JOURNAL_PAGE_SIZE && last ? `${last.occurredAt.toISOString()}_${last.id}` : null
		};
	});
}

export interface JournalView {
	actions: readonly AuditAction[];
	/** The query as typed, for the filter form. */
	raw: Record<string, string>;
	problems: ErrorDetail[];
	/** `null` while the filters have problems: nothing is read. */
	journal: JournalPage | null;
}

/**
 * The journal page for the query of a request, in any cabinet: the reader's `audit.read` is checked before the filters,
 * so without it the query is not even parsed; filters that cannot be applied come back as field problems.
 */
export async function journalView(db: Database, ctx: ActionContext, params: URLSearchParams): Promise<JournalView> {
	requirePermission(ctx.subject, 'audit.read', null);
	const raw = Object.fromEntries(params);
	let filters: JournalFilters;
	try {
		filters = parseJournalFilters(params);
	} catch (cause) {
		if (!(cause instanceof ApiError) || cause.code !== 'validation_failed') throw cause;
		return { actions: AUDIT_ACTIONS, raw, problems: cause.details ?? [], journal: null };
	}
	return { actions: AUDIT_ACTIONS, raw, problems: [], journal: await readJournal(db, ctx, filters) };
}
