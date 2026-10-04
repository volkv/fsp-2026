// Who enters the pool of a competition partner (docs/domain.md, sections 5.5, 6.2, 6.3): an active FSP result of the
// competition that satisfies the partnership's `pool_rule`, and a `partner_pool` consent in effect for the competition
// whose list of partners (`choices`, written at the moment of the consent) names the company. A partner added after
// the consent is not on that list and sees nothing until the candidate consents again. The clone of a partner in a demo
// session is the same company within the session: the list naming its original names it (domain 19.3). Only an adult
// signs the consent (domain 6.2); a representative's side does not exist for this kind, so a minor never has it in
// effect.
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PoolRule } from '$lib/server/companies/partnerships';
import { effectiveConsent, type ConsentEventFacts } from '$lib/server/consent/effective';
import type { Executor } from '$lib/server/db';
import { candidates, companies, consentEvents, legalDocuments, sourceFacts } from '$lib/server/db/schema';
import type { Competition, Result } from '$lib/server/fsp/types';
import { awardsAtLeast } from '$lib/server/operator/partnerships';

/** `choices` of a `partner_pool` grant: the partners of the competition the candidate agreed to show the card to. */
export const poolChoicesSchema = z.strictObject({ partner_company_ids: z.array(z.uuid()).min(1) });

export type PoolChoices = z.infer<typeof poolChoicesSchema>;

/** An active FSP result of a competition, as the pool rule reads it. */
export interface CompetitionResult {
	candidateId: string;
	competition: Pick<Competition, 'id' | 'title' | 'discipline' | 'level' | 'stage' | 'startDate'>;
	result: Pick<Result, 'place' | 'award'>;
}

/** The result satisfies the rule: one of its stages and at least its award. */
export function fitsPoolRule(rule: PoolRule, result: CompetitionResult): boolean {
	const stage = result.competition.stage;
	const award = result.result.award;
	return (
		stage !== undefined &&
		(rule.stages as readonly string[]).includes(stage) &&
		award !== undefined &&
		awardsAtLeast(rule.min_award).includes(award)
	);
}

/** Active FSP results of one competition (`competitionRef`) or of one candidate (`candidateId`). */
export async function competitionResults(
	executor: Executor,
	by: { competitionRef: string } | { candidateId: string }
): Promise<CompetitionResult[]> {
	const rows = await executor
		.select({ candidateId: sourceFacts.candidateId, payload: sourceFacts.payload })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				eq(sourceFacts.status, 'active'),
				'competitionRef' in by
					? sql`${sourceFacts.payload}->'competition'->>'id' = ${by.competitionRef}`
					: eq(sourceFacts.candidateId, by.candidateId)
			)
		);
	return rows.map((row) => {
		const payload = row.payload as { competition: Competition; result: Result };
		return {
			candidateId: row.candidateId,
			competition: {
				id: payload.competition.id,
				title: payload.competition.title,
				discipline: payload.competition.discipline,
				level: payload.competition.level,
				...(payload.competition.stage === undefined ? {} : { stage: payload.competition.stage }),
				startDate: payload.competition.startDate
			},
			result: {
				place: payload.result.place,
				...(payload.result.award === undefined ? {} : { award: payload.result.award })
			}
		};
	});
}

/** A `partner_pool` grant in effect: when it was given and the partners it names. */
export interface PoolGrant {
	id: string;
	occurredAt: Date;
	partnerCompanyIds: string[];
}

/** The company the pool is read for: a clone of a demo session names its original (domain 19.3). */
export interface PoolPartner {
	id: string;
	demoCloneOf: string | null;
}

/**
 * The grant names the partner. A clone of a demo session is the same company within the session: a grant naming its
 * original counts for it, while a grant naming any other company does not.
 */
export function grantNamesPartner(grant: PoolGrant | undefined, partner: PoolPartner): boolean {
	return grant !== undefined && grant.partnerCompanyIds.some((id) => id === partner.id || id === partner.demoCloneOf);
}

/** The partner as `grantNamesPartner` reads it. */
export async function poolPartner(executor: Executor, companyId: string): Promise<PoolPartner> {
	const [row] = await executor
		.select({ id: companies.id, demoCloneOf: companies.demoCloneOf })
		.from(companies)
		.where(eq(companies.id, companyId));
	if (!row) throw new Error(`partner company ${companyId} is missing`);
	return row;
}

interface PoolEventRow extends ConsentEventFacts {
	candidateId: string;
	choices: unknown;
}

/**
 * `effectiveConsent(partner_pool)` with the area of the competition (domain 6.3) for each candidate at `at`; a
 * candidate without one is absent.
 */
export async function effectivePoolGrants(
	executor: Executor,
	candidateIds: readonly string[],
	competitionRef: string,
	at: Date
): Promise<Map<string, PoolGrant>> {
	const result = new Map<string, PoolGrant>();
	const ids = [...new Set(candidateIds)];
	if (ids.length === 0) return result;
	const events: PoolEventRow[] = await executor
		.select({
			id: consentEvents.id,
			candidateId: consentEvents.subjectCandidateId,
			action: consentEvents.action,
			signerKind: consentEvents.signerKind,
			representationId: consentEvents.representationId,
			occurredAt: consentEvents.occurredAt,
			choices: consentEvents.choices,
			documentVersion: legalDocuments.version
		})
		.from(consentEvents)
		.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
		.where(
			and(
				inArray(consentEvents.subjectCandidateId, ids),
				eq(consentEvents.kind, 'partner_pool'),
				eq(consentEvents.scopeCompetitionRef, competitionRef),
				lte(consentEvents.occurredAt, at)
			)
		)
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
	if (events.length === 0) return result;
	const eventsOf = Map.groupBy(events, (event) => event.candidateId);
	const births = await executor
		.select({
			id: candidates.id,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(inArray(candidates.id, [...eventsOf.keys()]));
	const reconsentVersions = (
		await executor
			.select({ version: legalDocuments.version })
			.from(legalDocuments)
			.where(
				and(
					eq(legalDocuments.kind, 'partner_pool'),
					eq(legalDocuments.requiresReconsent, true),
					isNotNull(legalDocuments.publishedAt),
					lte(legalDocuments.publishedAt, at)
				)
			)
	).map((row) => row.version);
	for (const birth of births) {
		const grant = effectiveConsent(eventsOf.get(birth.id) ?? [], {
			birth: { birthDate: birth.birthDate, precision: birth.precision, status: birth.status },
			at,
			reconsentVersions,
			// Only an adult signs `partner_pool`: no representative's grant exists to count.
			verifiedRepresentationIds: new Set()
		});
		if (!grant) continue;
		const choices = poolChoicesSchema.safeParse(grant.choices);
		if (!choices.success) throw new Error(`partner_pool grant ${grant.id} does not list the partners`);
		result.set(birth.id, {
			id: grant.id,
			occurredAt: grant.occurredAt,
			partnerCompanyIds: choices.data.partner_company_ids
		});
	}
	return result;
}

/** The title of a competition as its results on the platform name it; `null` — none of them is here. */
export async function competitionTitle(executor: Executor, competitionRef: string): Promise<string | null> {
	const [row] = await executor
		.select({ title: sql<string>`${sourceFacts.payload}->'competition'->>'title'` })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.factType, 'competition_result'),
				sql`${sourceFacts.payload}->'competition'->>'id' = ${competitionRef}`
			)
		)
		.limit(1);
	return row?.title ?? null;
}
