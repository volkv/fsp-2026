// Partner of a competition (domain 5.5): an FSP operator opens the partnership for a verified company on the basis of
// a contract or the regulations of the competition; a company never makes itself a partner. The pool is readable only
// while the partnership is active and the company is verified, which `partnershipAccess` answers for the pool reader.
// The company must be in the operator's reach: a clone operator of a demo session opens and ends partnerships of the
// companies of its session only (domain 19.3). `openPartnerships` names the partners a candidate's consent to the pool
// of a competition lists: those open at the moment of the consent and seen from the candidate's demo session.
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AWARDS } from '$lib/fsp/awards';
import { StaffReach } from '$lib/server/access/demo-actor';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor } from '$lib/server/db';
import { companies, competitionPartnerships } from '$lib/server/db/schema';
import { demoScope } from '$lib/server/demo/scope';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import {
	auditActorOf,
	conflict,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext,
	type CompanyDeps
} from './context';
import { lockCompany } from './rows';

export type PartnershipKind = (typeof competitionPartnerships.$inferSelect)['kind'];

/** Who enters the pool: a result of one of the stages with at least the award. Finalists of the final by default. */
const poolRuleSchema = z.strictObject({
	min_award: z.enum(AWARDS),
	stages: z.array(z.enum(['qualifier', 'final', 'single'])).min(1)
});

export type PoolRule = z.infer<typeof poolRuleSchema>;

const DEFAULT_POOL_RULE: PoolRule = { min_award: 'finalist', stages: ['final'] };

const isoDate = z.iso.date();

export interface PartnershipInput {
	companyId: string;
	/** ID of the competition in the achievements source (contracts 1.3); an opaque string. */
	competitionRef: string;
	kind: PartnershipKind;
	poolRule?: PoolRule;
	/** `YYYY-MM-DD`. */
	validFrom: string;
	validTo: string | null;
	/** Contract or regulations the partnership rests on. */
	basis: string;
}

function audit(ctx: ActionContext) {
	return {
		actor: auditActorOf(ctx.subject),
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent
	};
}

/** Opens a partnership; one active partnership of a company per competition. */
export async function openPartnership(
	deps: CompanyDeps,
	ctx: ActionContext,
	input: PartnershipInput
): Promise<{ partnershipId: string }> {
	requirePermission(ctx.subject, 'partnership.manage', null);
	const operatorId = sessionUserId(ctx.subject);
	const competitionRef = input.competitionRef.trim();
	const basis = input.basis.trim();
	const poolRule = poolRuleSchema.safeParse(input.poolRule ?? DEFAULT_POOL_RULE);
	const problems: ErrorDetail[] = [];
	if (competitionRef.length === 0 || competitionRef.length > 200) {
		problems.push({ path: 'competitionRef', code: 'required', message: 'Укажите соревнование' });
	}
	if (!poolRule.success) problems.push({ path: 'poolRule', code: 'invalid', message: 'Правило пула не распознано' });
	if (!isoDate.safeParse(input.validFrom).success) {
		problems.push({ path: 'validFrom', code: 'invalid_date', message: 'Дата начала — ГГГГ-ММ-ДД' });
	}
	if (input.validTo !== null && (!isoDate.safeParse(input.validTo).success || input.validTo < input.validFrom)) {
		problems.push({ path: 'validTo', code: 'invalid_date', message: 'Дата окончания — не раньше даты начала' });
	}
	if (basis.length < 3 || basis.length > 1000) {
		problems.push({ path: 'basis', code: 'invalid_length', message: 'Основание — от 3 до 1000 символов' });
	}
	if (problems.length > 0 || !poolRule.success) throw invalid(problems);

	return deps.db.transaction(async (tx) => {
		const company = await lockCompany(tx, input.companyId);
		(await StaffReach.of(tx, ctx.subject)).require(company.demoSessionId);
		if (company.status !== 'verified') {
			throw conflict('company_not_verified', 'Партнёром соревнования может стать только проверенная компания');
		}
		const [existing] = await tx
			.select({ id: competitionPartnerships.id })
			.from(competitionPartnerships)
			.where(
				and(
					eq(competitionPartnerships.companyId, input.companyId),
					eq(competitionPartnerships.competitionSource, 'fsp'),
					eq(competitionPartnerships.competitionRef, competitionRef),
					eq(competitionPartnerships.status, 'active')
				)
			);
		if (existing) throw conflict('already_partner', 'Компания уже партнёр этого соревнования');
		const [created] = await tx
			.insert(competitionPartnerships)
			.values({
				companyId: input.companyId,
				competitionRef,
				competitionSource: 'fsp',
				kind: input.kind,
				poolRule: poolRule.data,
				status: 'active',
				validFrom: input.validFrom,
				validTo: input.validTo,
				grantedBy: operatorId,
				basis
			})
			.returning({ id: competitionPartnerships.id });
		if (!created) throw new Error('partnership not inserted');
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'partnership.opened',
			outcome: 'success',
			object: { type: 'competition_partnership', id: created.id },
			details: { company_id: input.companyId, kind: input.kind }
		});
		return { partnershipId: created.id };
	});
}

/**
 * The last day of a partnership ended today: an earlier planned end stays; a partnership that has not started yet ends
 * on its first day, so `valid_to >= valid_from` holds.
 */
function endDate(validFrom: string, validTo: string | null, today: string): string {
	if (validTo !== null && validTo < today) return validTo;
	return today < validFrom ? validFrom : today;
}

/** Ends a partnership today; the pool closes at once. */
export async function endPartnership(deps: CompanyDeps, ctx: ActionContext, partnershipId: string): Promise<void> {
	requirePermission(ctx.subject, 'partnership.manage', null);
	sessionUserId(ctx.subject);
	const today = deps.now().toISOString().slice(0, 10);
	await deps.db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(competitionPartnerships)
			.where(eq(competitionPartnerships.id, partnershipId))
			.for('update');
		if (!row) throw new ApiError('not_found');
		const [owner] = await tx
			.select({ session: companies.demoSessionId })
			.from(companies)
			.where(eq(companies.id, row.companyId));
		if (!owner) throw new Error(`company ${row.companyId} of partnership ${partnershipId} is missing`);
		(await StaffReach.of(tx, ctx.subject)).require(owner.session);
		if (row.status === 'ended') return;
		const validTo = endDate(row.validFrom, row.validTo, today);
		await tx
			.update(competitionPartnerships)
			.set({ status: 'ended', validTo })
			.where(eq(competitionPartnerships.id, partnershipId));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'partnership.ended',
			outcome: 'success',
			object: { type: 'competition_partnership', id: partnershipId },
			details: { company_id: row.companyId }
		});
	});
}

export interface PartnershipSummary {
	id: string;
	companyId: string;
	competitionRef: string;
	kind: PartnershipKind;
	poolRule: PoolRule;
	status: 'active' | 'ended';
	validFrom: string;
	validTo: string | null;
	basis: string;
}

/** Partnerships of a company, for the operator. */
export async function listPartnerships(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string
): Promise<PartnershipSummary[]> {
	requirePermission(ctx.subject, 'partnership.manage', null);
	const rows = await deps.db
		.select()
		.from(competitionPartnerships)
		.where(eq(competitionPartnerships.companyId, companyId))
		.orderBy(desc(competitionPartnerships.createdAt));
	return rows.map((row) => ({
		id: row.id,
		companyId: row.companyId,
		competitionRef: row.competitionRef,
		kind: row.kind,
		poolRule: poolRuleSchema.parse(row.poolRule),
		status: row.status,
		validFrom: row.validFrom,
		validTo: row.validTo,
		basis: row.basis
	}));
}

/**
 * Facts of `partner_pool.read` for one partnership at this moment: the company that owns it and whether it is active —
 * status `active`, today inside the validity dates and the company verified. `null` — no such partnership.
 */
export async function partnershipAccess(
	executor: Executor,
	partnershipId: string,
	now: Date
): Promise<{
	partnershipCompanyId: string;
	partnershipActive: boolean;
	competitionRef: string;
	poolRule: PoolRule;
} | null> {
	const today = now.toISOString().slice(0, 10);
	const [row] = await executor
		.select({
			companyId: competitionPartnerships.companyId,
			competitionRef: competitionPartnerships.competitionRef,
			poolRule: competitionPartnerships.poolRule,
			active: sql<boolean>`${openAt(today)}`
		})
		.from(competitionPartnerships)
		.innerJoin(companies, eq(companies.id, competitionPartnerships.companyId))
		.where(eq(competitionPartnerships.id, partnershipId));
	if (!row) return null;
	return {
		partnershipCompanyId: row.companyId,
		partnershipActive: row.active,
		competitionRef: row.competitionRef,
		poolRule: poolRuleSchema.parse(row.poolRule)
	};
}

/** A partnership whose pool is readable right now, with its company, as a consent to the pool names it. */
export interface OpenPartnership {
	id: string;
	companyId: string;
	companyName: string;
	competitionRef: string;
	kind: PartnershipKind;
	poolRule: PoolRule;
}

/** Status `active`, today inside the validity dates and the company verified: the rule of `partnershipAccess`. */
function openAt(today: string): SQL {
	const condition = and(
		eq(competitionPartnerships.status, 'active'),
		sql`${competitionPartnerships.validFrom} <= ${today}::date`,
		or(isNull(competitionPartnerships.validTo), sql`${competitionPartnerships.validTo} >= ${today}::date`),
		eq(companies.status, 'verified')
	);
	if (!condition) throw new Error('open partnership condition is empty');
	return condition;
}

/**
 * Partnerships open at `now` of the companies the viewer of the demo session `viewerSession` sees (domain 19.3), of one
 * competition or of all; the earliest opened first.
 */
export async function openPartnerships(
	executor: Executor,
	input: { now: Date; viewerSession: string | null; competitionRef?: string }
): Promise<OpenPartnership[]> {
	const today = input.now.toISOString().slice(0, 10);
	const rows = await executor
		.select({
			id: competitionPartnerships.id,
			companyId: competitionPartnerships.companyId,
			companyName: companies.displayName,
			competitionRef: competitionPartnerships.competitionRef,
			kind: competitionPartnerships.kind,
			poolRule: competitionPartnerships.poolRule
		})
		.from(competitionPartnerships)
		.innerJoin(companies, eq(companies.id, competitionPartnerships.companyId))
		.where(
			and(
				openAt(today),
				demoScope(
					{ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal },
					input.viewerSession
				),
				input.competitionRef === undefined
					? undefined
					: eq(competitionPartnerships.competitionRef, input.competitionRef)
			)
		)
		.orderBy(asc(competitionPartnerships.validFrom), asc(competitionPartnerships.id));
	return rows.map((row) => ({ ...row, poolRule: poolRuleSchema.parse(row.poolRule) }));
}
