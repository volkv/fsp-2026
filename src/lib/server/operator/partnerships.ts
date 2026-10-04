// Competition partners as the operator manages them (docs/domain.md 5.5): every partnership with its company and pool
// rule, the FSP competitions known on the platform to open one for, and how many participants hold a result that fits
// the rule. That number is not the pool: a candidate enters the pool of a partner only as an adult with a consent that
// names this partner (domain 5.5), which the pool reader decides at the moment of reading. The operator sees the
// partnerships of the companies within its reach — a clone operator of a demo session, of its session only; the counts
// of participants leave out the clones of demo sessions, which repeat the results of the cast (domain 19.3).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AWARDS, awardRank } from '$lib/fsp/awards';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requirePermission, type ActionContext, type CompanyDeps } from '$lib/server/companies/context';
import { listPartnerships, type PartnershipSummary, type PoolRule } from '$lib/server/companies/partnerships';
import type { CompanyStatus } from '$lib/server/companies/gate';
import type { Executor } from '$lib/server/db';
import { companies, competitionPartnerships, sourceFacts } from '$lib/server/db/schema';
import { candidateSession, outsideDemoSessions } from '$lib/server/demo/scope';
import type { SmallCell } from './small-numbers';
import { smallCell } from './small-numbers';

/** A rule with `min_award` admits it and every award above it. */
export function awardsAtLeast(minAward: PoolRule['min_award']): string[] {
	return AWARDS.slice(0, awardRank(minAward) + 1);
}

export interface KnownCompetition {
	ref: string;
	title: string;
	discipline: string;
	stage: string | null;
	startDate: string | null;
	/** Participants of the competition with an active FSP result on the platform. */
	participants: SmallCell;
}

const COMPETITIONS_LIMIT = 200;

/** Competitions whose results are on the platform, the latest first. */
export async function knownCompetitions(
	executor: Executor,
	subject: AccessSubject,
	threshold: number
): Promise<KnownCompetition[]> {
	requirePermission(subject, 'partnership.manage', null);
	const competition = sql`${sourceFacts.payload}->'competition'`;
	const rows = await executor
		.select({
			ref: sql<string>`${competition}->>'id'`,
			title: sql<string>`max(${competition}->>'title')`,
			discipline: sql<string>`max(${competition}->>'discipline')`,
			stage: sql<string | null>`max(${competition}->>'stage')`,
			startDate: sql<string | null>`max(${competition}->>'startDate')`,
			participants: sql<number>`count(distinct ${sourceFacts.candidateId})::int`
		})
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active'),
				sql`${competition}->>'id' is not null`,
				outsideDemoSessions(candidateSession(sourceFacts.candidateId))
			)
		)
		.groupBy(sql`${competition}->>'id'`)
		.orderBy(sql`max(${competition}->>'startDate') desc nulls last`)
		.limit(COMPETITIONS_LIMIT);
	return rows.map((row) => ({ ...row, participants: smallCell(row.participants, threshold) }));
}

export interface PartnershipRow extends PartnershipSummary {
	company: { id: string; displayName: string; status: CompanyStatus };
	/** Active and today within the validity dates and the company verified — the pool is readable right now. */
	poolOpen: boolean;
	/** Participants with an active result that fits the rule; the pool itself is narrower (adults with consent). */
	fitting: SmallCell;
}

/** Partnerships of every company (or of one), active first, then the latest start first. */
export async function allPartnerships(
	deps: CompanyDeps,
	ctx: ActionContext,
	threshold: number,
	companyId: string | null = null
): Promise<PartnershipRow[]> {
	requirePermission(ctx.subject, 'partnership.manage', null);
	const today = deps.now().toISOString().slice(0, 10);
	const owners = await deps.db
		.selectDistinct({ id: companies.id, displayName: companies.displayName, status: companies.status })
		.from(competitionPartnerships)
		.innerJoin(companies, eq(companies.id, competitionPartnerships.companyId))
		.where(
			and(
				(await StaffReach.of(deps.db, ctx.subject)).rows(companies.demoSessionId),
				companyId === null ? undefined : eq(competitionPartnerships.companyId, companyId)
			)
		);
	const rows: PartnershipRow[] = [];
	for (const company of owners) {
		for (const partnership of await listPartnerships(deps, ctx, company.id)) {
			rows.push({
				...partnership,
				company,
				poolOpen:
					partnership.status === 'active' &&
					partnership.validFrom <= today &&
					(partnership.validTo === null || partnership.validTo >= today) &&
					company.status === 'verified',
				fitting: smallCell(
					await fittingParticipants(deps.db, partnership.competitionRef, partnership.poolRule),
					threshold
				)
			});
		}
	}
	return rows.sort(
		(a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.validFrom.localeCompare(a.validFrom)
	);
}

/** Participants with an active result of the competition at one of the rule's stages and at least its award. */
async function fittingParticipants(executor: Executor, competitionRef: string, rule: PoolRule): Promise<number> {
	const [row] = await executor
		.select({ n: sql<number>`count(distinct ${sourceFacts.candidateId})::int` })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active'),
				sql`${sourceFacts.payload}->'competition'->>'id' = ${competitionRef}`,
				inArray(sql`${sourceFacts.payload}->'competition'->>'stage'`, rule.stages),
				inArray(sql`${sourceFacts.payload}->'result'->>'award'`, awardsAtLeast(rule.min_award)),
				outsideDemoSessions(candidateSession(sourceFacts.candidateId))
			)
		);
	return row?.n ?? 0;
}
