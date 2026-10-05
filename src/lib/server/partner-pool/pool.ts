// The pool of a competition partner as its company reads it (docs/domain.md, sections 5.5, 7.4): `partner_pool.read`
// of an open partnership of the member's own company, then for every participant with a result fitting the pool rule
// the decision of `canShow` in the context `partner_pool` — the visibility setting of the catalog does not apply, the
// consent to the pool of this competition naming this company does, and only adults enter. A partnership of another
// company is «not found»; an own one that is not open refuses. Inviting from the pool follows the general rules: an own
// published vacancy in whose catalog context the candidate is visible (domain 13.5).
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { awardRank } from '$lib/fsp/awards';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { partnershipAccess, type PoolRule } from '$lib/server/companies/partnerships';
import type { Executor } from '$lib/server/db';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import { competitionPartnerships, vacancies } from '$lib/server/db/schema';
import { demoScope } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { textList } from '$lib/server/matching/sql';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { loadInvitability } from '$lib/server/vacancies/invitable';
import { canShow, type ShowExtra } from '$lib/server/visibility/can-show';
import {
	competitionResults,
	competitionTitle,
	effectivePoolGrants,
	fitsPoolRule,
	grantNamesPartner,
	poolPartner,
	type CompetitionResult
} from './membership';

/** Filters of the pool by the category in force (domain 12.4); one category meets both. */
export interface PoolFilters {
	specializations?: SpecializationKey[];
	grades?: GradeKey[];
}

export interface PoolPartnership {
	id: string;
	companyId: string;
	competitionRef: string;
	/** Title of the competition as its results name it; `null` — no result of it is on the platform. */
	competitionTitle: string | null;
	kind: (typeof competitionPartnerships.$inferSelect)['kind'];
	poolRule: PoolRule;
	validFrom: string;
	validTo: string | null;
	/** Open at the moment of reading; a pool is read only when it is. */
	active: boolean;
}

/** A candidate of the pool; the id never leaves the server. */
export interface PoolMember {
	candidateId: string;
	pseudonym: string;
	extras: ShowExtra[];
	result: CompetitionResult['result'] & { stage: string | null };
}

export interface PartnerPool {
	partnership: PoolPartnership;
	members: PoolMember[];
}

/**
 * The partnership the subject reads the pool of: `404` when there is none or it belongs to another company, `403` when
 * it is the company's own but the pool is not readable now (ended, outside its dates, the company not verified).
 */
async function readablePartnership(
	executor: Executor,
	subject: AccessSubject,
	partnershipId: string,
	now: Date
): Promise<PoolPartnership> {
	const membership = subject.membership?.status === 'active' ? subject.membership : null;
	if (subject.userId === null) throw new ApiError('unauthenticated');
	if (!membership) throw new ApiError('forbidden');
	const access = await partnershipAccess(executor, partnershipId, now);
	if (!access || access.partnershipCompanyId !== membership.companyId) throw new ApiError('not_found');
	const decision = can(subject, 'partner_pool.read', {
		partnershipCompanyId: access.partnershipCompanyId,
		partnershipActive: access.partnershipActive
	});
	if (!decision.allowed) {
		throw new ApiError(
			'forbidden',
			access.partnershipActive ? {} : { message: 'Партнёрство не действует: пул закрыт' }
		);
	}
	const [row] = await executor
		.select({
			kind: competitionPartnerships.kind,
			validFrom: competitionPartnerships.validFrom,
			validTo: competitionPartnerships.validTo
		})
		.from(competitionPartnerships)
		.where(eq(competitionPartnerships.id, partnershipId));
	if (!row) throw new Error(`partnership ${partnershipId} disappeared while read`);
	return {
		id: partnershipId,
		companyId: access.partnershipCompanyId,
		active: access.partnershipActive,
		competitionRef: access.competitionRef,
		competitionTitle: await competitionTitle(executor, access.competitionRef),
		kind: row.kind,
		poolRule: access.poolRule,
		validFrom: row.validFrom,
		validTo: row.validTo
	};
}

/** Candidates of `ids` in the viewer's demo reach (domain 19.3) whose category in force passes the filters. */
async function filterCandidates(
	executor: Executor,
	ids: readonly string[],
	viewerSession: string | null,
	filters: PoolFilters
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	if (filters.specializations?.length === 0 || filters.grades?.length === 0) {
		throw new ApiError('validation_failed', {
			details: [
				{
					path: filters.specializations?.length === 0 ? 'specialization' : 'grade',
					code: 'invalid',
					message: 'Пустой список'
				}
			]
		});
	}
	const conditions: SQL[] = [
		sql`c.id in ${textList(ids)}`,
		demoScope({ demoSessionId: sql`c.demo_session_id`, demoOriginal: sql`c.demo_original` }, viewerSession)
	];
	if (filters.specializations || filters.grades) {
		conditions.push(
			categoryPredicate(sql`c.id`, {
				...(filters.specializations ? { specializations: filters.specializations } : {}),
				...(filters.grades ? { grades: filters.grades } : {})
			})
		);
	}
	const rows = await executor.execute<{ id: string }>(sql`
		select c.id::text as id
		from candidates c
		where ${sql.join(conditions, sql` and `)}
	`);
	return new Set(rows.map((row) => row.id));
}

/**
 * The pool of the partnership for the subject's company at this moment, the best results first. Every candidate is
 * decided by `canShow` in the context `partner_pool`; the partnership facts are read once for all of them.
 */
export async function readPartnerPool(
	deps: MatchingDeps,
	subject: AccessSubject,
	partnershipId: string,
	filters: PoolFilters = {}
): Promise<PartnerPool> {
	const executor = deps.db;
	const now = deps.now();
	const partnership = await readablePartnership(executor, subject, partnershipId, now);
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) throw new ApiError('forbidden');
	// The pool shows candidate cards: a key without `candidate.card.read` would get an empty pool, not an answer.
	if (!viewer.company.hasCardReadPermission) {
		throw new ApiError('forbidden', {
			details: [{ code: 'api_key_scope', message: 'У ключа нет права candidate.card.read: пул состоит из карточек' }]
		});
	}

	const results = await competitionResults(executor, { competitionRef: partnership.competitionRef });
	// A participant with several results of the competition is counted by the best one that fits the rule.
	const best = new Map<string, CompetitionResult>();
	for (const result of results) {
		if (!fitsPoolRule(partnership.poolRule, result)) continue;
		const known = best.get(result.candidateId);
		if (!known || rank(result) < rank(known)) best.set(result.candidateId, result);
	}
	const passing = await filterCandidates(executor, [...best.keys()], viewer.viewer.demoSessionId, filters);
	const ids = [...passing];
	const grants = await effectivePoolGrants(executor, ids, partnership.competitionRef, now);
	const partner = await poolPartner(executor, partnership.companyId);
	const facts = await loadVisibilityFacts(executor, ids, {
		now,
		policy: await loadVisibilityPolicy(executor, now),
		viewerCompanyId: viewer.viewer.companyId,
		viewerCompany: viewer.company
	});
	const members: PoolMember[] = [];
	for (const candidateId of ids) {
		const candidateFacts = facts.get(candidateId);
		const result = best.get(candidateId);
		if (!candidateFacts || !result) continue;
		const decision = canShow(
			{
				...candidateFacts,
				partnership: {
					id: partnership.id,
					companyId: partnership.companyId,
					active: partnership.active,
					candidateInPool: grantNamesPartner(grants.get(candidateId), partner)
				}
			},
			viewer.viewer,
			{ kind: 'partner_pool', partnershipId: partnership.id }
		);
		if (!decision.allowed) continue;
		members.push({
			candidateId,
			pseudonym: deps.pseudonym(candidateId, partnership.companyId),
			extras: decision.extras,
			result: { ...result.result, stage: result.competition.stage ?? null }
		});
	}
	members.sort(
		(a, b) =>
			awardRank(a.result.award) - awardRank(b.result.award) ||
			(a.result.place ?? Number.MAX_SAFE_INTEGER) - (b.result.place ?? Number.MAX_SAFE_INTEGER) ||
			a.pseudonym.localeCompare(b.pseudonym)
	);
	return { partnership, members };
}

function rank(result: CompetitionResult): number {
	return awardRank(result.result.award) * 10_000 + (result.result.place ?? 9_999);
}

/** Journals that the company opened the pool: the competition and how many cards it was shown (domain 18.2). */
export async function journalPoolView(
	executor: Executor,
	input: {
		actor: AuditActor;
		meta: { requestId: string; ip: string | null; userAgent: string | null };
		partnershipId: string;
		competitionRef: string;
		cardCount: number;
	}
): Promise<void> {
	await recordAuditEvent(executor, {
		action: 'partner_pool.viewed',
		outcome: 'success',
		actor: input.actor,
		object: { type: 'competition_partnership', id: input.partnershipId },
		requestId: input.meta.requestId,
		ip: input.meta.ip,
		userAgent: input.meta.userAgent,
		details: { competition_ref: input.competitionRef, card_count: input.cardCount }
	});
}

/** An own vacancy the company may invite a pool candidate by. */
export interface InvitableVacancy {
	id: string;
	title: string;
}

/**
 * For each candidate, the own published vacancies of the subject's company that are invitable and in whose catalog
 * context `canShow` shows the candidate — what sending an invitation checks (domain 13.5). An empty list: the pool
 * shows the candidate, but no vacancy of the company can carry an invitation to them now.
 */
export async function invitableVacancies(
	executor: Executor,
	subject: AccessSubject,
	candidateIds: readonly string[],
	now: Date
): Promise<Map<string, InvitableVacancy[]>> {
	const result = new Map<string, InvitableVacancy[]>(candidateIds.map((id) => [id, []]));
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer || candidateIds.length === 0) return result;
	const rows = await executor
		.select()
		.from(vacancies)
		.where(
			and(
				eq(vacancies.origin, 'own'),
				eq(vacancies.companyId, viewer.viewer.companyId),
				inArray(vacancies.status, ['published'])
			)
		);
	const policy = await loadVisibilityPolicy(executor, now);
	for (const vacancy of rows) {
		const invitability = await loadInvitability(executor, vacancy.id);
		if (!invitability?.invitable) continue;
		const facts = await loadVisibilityFacts(executor, candidateIds, {
			now,
			policy,
			viewerCompanyId: viewer.viewer.companyId,
			viewerCompany: viewer.company,
			vacancy: {
				id: vacancy.id,
				companyId: vacancy.companyId,
				origin: vacancy.origin,
				status: vacancy.status,
				minAge: vacancy.minAge
			}
		});
		for (const [candidateId, candidateFacts] of facts) {
			if (canShow(candidateFacts, viewer.viewer, { kind: 'catalog', vacancyId: vacancy.id }).allowed) {
				result.get(candidateId)?.push({ id: vacancy.id, title: vacancy.title });
			}
		}
	}
	return result;
}

/** A partnership of the member's company as the list of its pools shows it. */
export interface CompanyPartnership {
	id: string;
	competitionRef: string;
	competitionTitle: string | null;
	kind: PoolPartnership['kind'];
	validFrom: string;
	validTo: string | null;
	/** The pool is readable now. */
	open: boolean;
}

/** Partnerships of the subject's company, open first, then the latest start first. */
export async function companyPartnerships(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<CompanyPartnership[]> {
	const membership = subject.membership?.status === 'active' ? subject.membership : null;
	if (!membership) throw new ApiError('forbidden');
	const rows = await executor
		.select({ id: competitionPartnerships.id })
		.from(competitionPartnerships)
		.where(eq(competitionPartnerships.companyId, membership.companyId));
	const list: CompanyPartnership[] = [];
	for (const row of rows) {
		const access = await partnershipAccess(executor, row.id, now);
		if (!access) throw new Error(`partnership ${row.id} disappeared while listed`);
		const [details] = await executor
			.select({
				kind: competitionPartnerships.kind,
				validFrom: competitionPartnerships.validFrom,
				validTo: competitionPartnerships.validTo
			})
			.from(competitionPartnerships)
			.where(eq(competitionPartnerships.id, row.id));
		if (!details) throw new Error(`partnership ${row.id} disappeared while listed`);
		list.push({
			id: row.id,
			competitionRef: access.competitionRef,
			competitionTitle: await competitionTitle(executor, access.competitionRef),
			kind: details.kind,
			validFrom: details.validFrom,
			validTo: details.validTo,
			open: access.partnershipActive
		});
	}
	return list.sort((a, b) => Number(b.open) - Number(a.open) || b.validFrom.localeCompare(a.validFrom));
}

/** The company has a partnership whose pool is readable now: the employer's navigation shows the pools. */
export async function hasOpenPartnership(executor: Executor, companyId: string, now: Date): Promise<boolean> {
	const rows = await executor
		.select({ id: competitionPartnerships.id })
		.from(competitionPartnerships)
		.where(eq(competitionPartnerships.companyId, companyId));
	for (const row of rows) if ((await partnershipAccess(executor, row.id, now))?.partnershipActive) return true;
	return false;
}
