// The bias audit of the quality panel: the four-fifths rule over groups of candidates the customer cares about —
// FSP participants and the rest (a candidate without FSP must be found on a par: no FSP is no penalty), age groups,
// the stated region. Fields of sex, citizenship or family status do not exist in the product by principle and are not
// audited here.
//
// Three outcomes, each a selection rate — selected among eligible — of every group:
// - `top10`  — the eligible are the candidates ranked by at least one open shortlist of a need not closed, recomputed now
//              as a member of the shortlist's company sees it (latest step, `canShow` at this moment); the selected
//              are those in the first ten of at least one of them;
// - `offer`  — the eligible are the candidates listed in the catalog or offered once; the selected got an offer;
// - `accept` — the eligible got an offer; the selected accepted one.
// Rows of demo sessions are not counted (a session is a copy of the cast); seeded records are counted and marked.
//
// The ratio of a group is its rate against the highest rate of the dimension; a ratio below 0.8 is flagged. It is a
// signal for a look into the data, not a finding of bias: groups differ by grade, specialization and activity.
//
// Small numbers (domain 7.4, 13.9). A group of fewer eligible candidates than `small_count_threshold` shows every count
// as «< N», zeros included, and no rate. Inside a larger group a count of selected from 1 to N − 1 is «< N», and its
// rate is shown only as an upper bound «< (N − 1) / eligible»: the flag is raised only when even that bound is below
// the bar. Only an exact rate can be the reference of a dimension. Totals of a dimension are not shown: a total next
// to its groups gives a small group away by subtraction.
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import type { ActionContext } from '$lib/server/companies/context';
import { requirePermission } from '$lib/server/companies/context';
import type { Executor } from '$lib/server/db';
import { listedInCatalog } from '$lib/server/db/conditions';
import { candidates, companies, companyMembers, hiringNeeds, shortlists } from '$lib/server/db/schema';
import { hasFspResult } from '$lib/server/matching/fsp-results';
import { smallCell, smallCountThreshold, type SmallCell } from '$lib/server/operator/small-numbers';
import { rankStep, shortlistStep, type ShortlistDeps } from '$lib/server/shortlists/service';
import { AGE_GROUPS, ageGroup, type AgeGroup } from '$lib/server/visibility/age';

/** The four-fifths rule: a group selected at less than 0.8 of the most selected group is flagged. */
export const FOUR_FIFTHS = 0.8;
/** The first ten of a shortlist: what the employer sees without scrolling (the same top as the exposure metric). */
const TOP = 10;

export const FAIRNESS_OUTCOMES = ['top10', 'offer', 'accept'] as const;
export type FairnessOutcome = (typeof FAIRNESS_OUTCOMES)[number];

export const REGION_GROUPS = ['moscow', 'saint_petersburg', 'other', 'none'] as const;
export type RegionGroup = (typeof REGION_GROUPS)[number];

export const FAIRNESS_DIMENSIONS = {
	fsp: ['fsp', 'no_fsp'],
	age: AGE_GROUPS,
	region: REGION_GROUPS
} as const;
export type FairnessDimension = keyof typeof FAIRNESS_DIMENSIONS;

/** What the audit knows of one candidate. */
export interface CandidateGroups {
	fsp: boolean;
	age: AgeGroup;
	region: RegionGroup;
	/** A seeded record: synthetic data. */
	synthetic: boolean;
}

/** `exact` — the rate itself; `below` — only an upper bound is shown (few selected); `null` — not shown. */
export type RateCell = { exact: number } | { below: number } | null;

export interface FairnessGroup {
	key: string;
	eligible: SmallCell;
	selected: SmallCell;
	rate: RateCell;
	/** The rate against the reference of the dimension, in the same shape as the rate. */
	ratio: RateCell;
	/** Below the four-fifths bar — for an upper bound, the bound itself is below it. */
	flagged: boolean;
	/** The group whose rate is the reference of the dimension. */
	reference: boolean;
}

/** Whether the counted candidates are seeded records, live ones or both. */
export type Provenance = 'synthetic' | 'live' | 'mixed' | 'empty';

export interface OutcomeAudit {
	outcome: FairnessOutcome;
	provenance: Provenance;
	dimensions: { dimension: FairnessDimension; groups: FairnessGroup[] }[];
}

export interface FairnessAudit {
	threshold: number;
	outcomes: OutcomeAudit[];
	/** Shortlists ranked for `top10`, and those skipped: their company has no active member to see them as. */
	shortlists: { ranked: number; skipped: number };
	computedAt: Date;
}

// --- The rule --------------------------------------------------------------------------------------------------------

interface GroupCounts {
	key: string;
	eligible: number;
	selected: number;
}

/**
 * The groups of one dimension with their rates, ratios and flags under the small-number rule of `threshold`. Groups
 * keep the given order.
 */
export function fourFifths(groups: readonly GroupCounts[], threshold: number): FairnessGroup[] {
	const shown = groups.map((group) => {
		if (group.selected > group.eligible) throw new Error(`group ${group.key} selected more than its eligible`);
		if (group.eligible === 0) {
			return { key: group.key, eligible: { value: 0 }, selected: { value: 0 }, rate: null };
		}
		if (group.eligible < threshold) {
			return { key: group.key, eligible: { below: threshold }, selected: { below: threshold }, rate: null };
		}
		const selected = smallCell(group.selected, threshold);
		const rate: RateCell =
			'value' in selected ? { exact: selected.value / group.eligible } : { below: (threshold - 1) / group.eligible };
		return { key: group.key, eligible: { value: group.eligible }, selected, rate };
	});
	const exact = shown.flatMap((group) => (group.rate !== null && 'exact' in group.rate ? [group.rate.exact] : []));
	const best = exact.length > 0 ? Math.max(...exact) : 0;
	const referenceKey =
		best > 0
			? shown.find((group) => group.rate !== null && 'exact' in group.rate && group.rate.exact === best)?.key
			: undefined;
	return shown.map((group) => {
		let ratio: RateCell = null;
		if (best > 0 && group.rate !== null) {
			ratio = 'exact' in group.rate ? { exact: group.rate.exact / best } : { below: group.rate.below / best };
		}
		const flagged = ratio !== null && ('exact' in ratio ? ratio.exact < FOUR_FIFTHS : ratio.below < FOUR_FIFTHS);
		return { ...group, ratio, flagged, reference: group.key === referenceKey };
	});
}

function groupKey(groups: CandidateGroups, dimension: FairnessDimension): string {
	switch (dimension) {
		case 'fsp':
			return groups.fsp ? 'fsp' : 'no_fsp';
		case 'age':
			return groups.age;
		case 'region':
			return groups.region;
	}
}

function provenanceOf(eligible: readonly CandidateGroups[]): Provenance {
	if (eligible.length === 0) return 'empty';
	const synthetic = eligible.filter((groups) => groups.synthetic).length;
	if (synthetic === eligible.length) return 'synthetic';
	return synthetic === 0 ? 'live' : 'mixed';
}

/** The audit of one outcome: every dimension over the same eligible and selected candidates. */
export function auditOutcome(
	outcome: FairnessOutcome,
	facts: ReadonlyMap<string, CandidateGroups>,
	eligible: ReadonlySet<string>,
	selected: ReadonlySet<string>,
	threshold: number
): OutcomeAudit {
	const rows = [...eligible].map((id) => {
		const groups = facts.get(id);
		if (!groups) throw new Error(`no groups of candidate ${id}`);
		return { groups, selected: selected.has(id) };
	});
	return {
		outcome,
		provenance: provenanceOf(rows.map((row) => row.groups)),
		dimensions: (Object.keys(FAIRNESS_DIMENSIONS) as FairnessDimension[]).map((dimension) => ({
			dimension,
			groups: fourFifths(
				FAIRNESS_DIMENSIONS[dimension].map((key) => {
					const members = rows.filter((row) => groupKey(row.groups, dimension) === key);
					return { key, eligible: members.length, selected: members.filter((row) => row.selected).length };
				}),
				threshold
			)
		}))
	};
}

export function regionGroup(code: string | null): RegionGroup {
	if (code === null) return 'none';
	if (code === 'RU-MOW') return 'moscow';
	if (code === 'RU-SPE') return 'saint_petersburg';
	return 'other';
}

// --- Loading ---------------------------------------------------------------------------------------------------------

/** A member of the company to see a shortlist as: its creator while active, otherwise another active member. */
async function viewerOf(executor: Executor, companyId: string, creatorMemberId: string): Promise<AccessSubject | null> {
	const [member] = await executor
		.select({
			userId: companyMembers.userId,
			memberId: companyMembers.id,
			role: companyMembers.role,
			status: companyMembers.status,
			companyStatus: companies.status
		})
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.status, 'active')))
		.orderBy(sql`${companyMembers.id} = ${creatorMemberId} desc`, companyMembers.id)
		.limit(1);
	if (!member) return null;
	return {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.memberId,
			companyId,
			role: member.role,
			status: member.status,
			companyStatus: member.companyStatus
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

/** The ranked and the first ten of every open shortlist of a need not closed of an admitted company outside sessions. */
async function shortlistTops(deps: ShortlistDeps, signal?: AbortSignal) {
	const rows = await deps.db
		.select({
			id: shortlists.id,
			companyId: shortlists.companyId,
			createdByMemberId: shortlists.createdByMemberId,
			companyStatus: companies.status
		})
		.from(shortlists)
		.innerJoin(companies, eq(companies.id, shortlists.companyId))
		.innerJoin(hiringNeeds, eq(hiringNeeds.id, shortlists.needId))
		.where(and(eq(shortlists.status, 'open'), ne(hiringNeeds.status, 'closed'), isNull(companies.demoSessionId)))
		.orderBy(shortlists.id);
	const pool = new Set<string>();
	const top = new Set<string>();
	let ranked = 0;
	let skipped = 0;
	for (const row of rows) {
		if (!companyAdmission(row.companyStatus).admitted) continue;
		const subject = await viewerOf(deps.db, row.companyId, row.createdByMemberId);
		if (subject === null) {
			skipped += 1;
			continue;
		}
		const { shortlist, step, needText } = await shortlistStep(deps, subject, row.id);
		const result = (await rankStep(deps, subject, { id: shortlist.id, needText }, step, signal)).ranked;
		for (const item of result) pool.add(item.candidateId);
		for (const item of result.slice(0, TOP)) top.add(item.candidateId);
		ranked += 1;
	}
	return { pool, top, ranked, skipped };
}

/** Candidates outside sessions listed in the catalog or offered once, with the groups and the offers they have. */
async function candidateFacts(executor: Executor, now: Date) {
	const offered = sql`exists (select 1 from invitations fairness_offer
		join companies fairness_company on fairness_company.id = fairness_offer.company_id
		where fairness_offer.candidate_id = ${candidates.id} and fairness_offer.purged_at is null
		and fairness_company.demo_session_id is null`;
	const rows = await executor
		.select({
			id: candidates.id,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus,
			region: sql<string | null>`${candidates.preferences}->>'region_code'`,
			synthetic: sql<boolean>`${candidates.seedBatchId} is not null`,
			fsp: hasFspResult(sql`${candidates.id}`),
			listed: listedInCatalog({
				status: candidates.status,
				visibility: candidates.visibility,
				searchStatus: candidates.searchStatus
			}),
			offered: sql<boolean>`${offered})`,
			accepted: sql<boolean>`${offered} and fairness_offer.status = 'accepted')`
		})
		.from(candidates)
		.where(and(isNull(candidates.demoSessionId), inArray(candidates.status, ['active', 'deletion_pending'])));
	return rows.map((row) => ({
		id: row.id,
		listed: row.listed,
		offered: row.offered,
		accepted: row.accepted,
		groups: {
			fsp: row.fsp,
			age: ageGroup({ birthDate: row.birthDate, precision: row.precision, status: row.birthStatus }, now),
			region: regionGroup(row.region),
			synthetic: row.synthetic
		} satisfies CandidateGroups
	}));
}

/** The four-fifths audit of the three outcomes, counted from live data now (nothing is stored). */
export async function fairnessAudit(
	deps: ShortlistDeps,
	ctx: ActionContext,
	signal?: AbortSignal
): Promise<FairnessAudit> {
	requirePermission(ctx.subject, 'policy.manage', null);
	const now = deps.now();
	const threshold = await smallCountThreshold(deps.db, now);
	const rows = await candidateFacts(deps.db, now);
	const tops = await shortlistTops(deps, signal);
	const facts = new Map(rows.map((row) => [row.id, row.groups]));
	const ids = (predicate: (row: (typeof rows)[number]) => boolean) =>
		new Set(rows.filter(predicate).map((row) => row.id));
	return {
		threshold,
		outcomes: [
			auditOutcome('top10', facts, tops.pool, tops.top, threshold),
			auditOutcome(
				'offer',
				facts,
				ids((row) => row.listed || row.offered),
				ids((row) => row.offered),
				threshold
			),
			auditOutcome(
				'accept',
				facts,
				ids((row) => row.offered),
				ids((row) => row.accepted),
				threshold
			)
		],
		shortlists: { ranked: tops.ranked, skipped: tops.skipped },
		computedAt: now
	};
}
