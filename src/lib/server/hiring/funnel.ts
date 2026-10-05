// `careerFunnel(filters, dimensions)` (docs/domain.md, section 13.9): career outcomes for the FSP operator, counted from
// live data stage by stage — never one «employment rate». Every count says who confirmed it; groups that include seeded
// demo records are marked as synthetic. Nothing is stored: a purged candidate leaves the funnel with the next call.
//
// Small groups. A group of fewer candidates than the catalog policy's `small_count_threshold` is never shown on its own:
// the small groups of a level are pooled into one «small groups» row, and the next smallest groups join the pool until
// it reaches the threshold too. A small row shown as «< N» next to the total would give its numbers away by subtraction;
// a pool of at least N people does not point at a person. A group, or the whole selection, that is still smaller than
// the threshold shows every count as «< N», zeros included: a zero in a group of two tells about both. Inside a group
// of at least N candidates a count from 1 to N − 1 is «< N» as well.
//
// Several groups of one candidate. A candidate with several disciplines, levels or competitions is counted, with each
// of the candidate's hiring processes, in every group of theirs: the rows of such a slice do not sum to the total.
// With a slice or a filter by competition, the discipline and the level are those of the competition's discipline.
//
// Demo sessions. Invitations of a demo session — its clone companies, its clone candidates — are not counted: a session
// is a copy of the cast, whose invitations are counted already, and the funnel is the analytics of the platform
// (domain 19.3). Every viewer, a clone operator included, sees the funnel of the rows outside sessions.
//
// Two SQL statements whatever the size: the invitations with their processes and reports in force, and the facets of
// the invited candidates; plus one for the hiring policy versions the processes refer to.
import { and, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { parsePolicyParams, type PolicyParams } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import { activeCategoryRows } from '$lib/server/categories/read';
import { runAt, runInForce } from '$lib/server/db/conditions';
import { candidates, hiringProcesses, invitations, productPolicies } from '$lib/server/db/schema';
import { candidateSession, companySession, outsideDemoSessions } from '$lib/server/demo/scope';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { refuse } from '$lib/server/invitations/errors';
import { requiredPolicy } from '$lib/server/invitations/policies';
import { hiringState, reportsInForce, type Party, type ReportFacts } from './state';

export const FUNNEL_DIMENSIONS = [
	'fsp_discipline',
	'fsp_level',
	'competition',
	'specialization',
	'grade',
	'region',
	'month',
	'fsp_participant'
] as const;
export type FunnelDimension = (typeof FUNNEL_DIMENSIONS)[number];
/** Dimensions a selection can be narrowed by; the month is narrowed by the period. */
export const FUNNEL_FILTERS = FUNNEL_DIMENSIONS.filter(
	(dimension): dimension is Exclude<FunnelDimension, 'month'> => dimension !== 'month'
);
export type FunnelFilter = (typeof FUNNEL_FILTERS)[number];

/**
 * The key of a group of candidates without a value in the dimension: no category (specialization, grade), no FSP level,
 * no region.
 */
export const NO_VALUE = 'none';
/** The key of the row that pools the small groups. */
export const SMALL_GROUPS = '__small__';

export interface FunnelFilters {
	/** Invitations sent at or after. */
	from?: Date;
	/** Invitations sent before. */
	to?: Date;
	/** The rows and, optionally, the rows inside each row; none — only the total. */
	dimensions: readonly [] | readonly [FunnelDimension] | readonly [FunnelDimension, FunnelDimension];
	/** Only the candidates with this value of the dimension. */
	where?: Partial<Record<FunnelFilter, string>>;
}

/** A count, or «fewer than `below`» for a small cell. */
export type FunnelCell = { value: number } | { below: number };

export interface SourcedCell {
	total: FunnelCell;
	/** Who reported the stage: only the company, only the candidate, or both sides. */
	bySource: Record<'company' | 'candidate' | 'both', FunnelCell>;
}

export interface FunnelGroup {
	/** The value of the dimension, `none` — without one, `SMALL_GROUPS` — the pooled small groups. */
	key: string;
	/** Groups pooled into this row; 0 — a group of its own. */
	pooled: number;
	/** The group includes seeded demo records. */
	synthetic: boolean;
	/** Candidates with at least one invitation. */
	invited: FunnelCell;
	/** Accepted invitations: the disclosure took place. */
	contact: FunnelCell;
	interview: SourcedCell;
	offer: SourcedCell;
	hired: { confirmed: FunnelCell; singleParty: Record<Party, FunnelCell>; diverged: FunnelCell };
	notHired: FunnelCell;
	/** `unknown`, and `pending` after the due date. */
	unknown: FunnelCell;
	/** The groups of the second dimension inside this one; empty without it. */
	children: FunnelGroup[];
}

export interface CareerFunnel {
	dimensions: FunnelDimension[];
	threshold: number;
	/** Every invitation of the selection. */
	total: FunnelGroup;
	groups: FunnelGroup[];
	/** Names of the competitions among the keys shown. */
	competitions: Record<string, { title: string; startDate: string | null }>;
}

// --- Loading ---------------------------------------------------------------------------------------------------------

type Source = 'company' | 'candidate' | 'both';
type Bucket = 'hired' | 'single_company' | 'single_candidate' | 'diverged' | 'not_hired' | 'unknown' | null;

/** What one invitation adds to a group. */
interface InvitationFacts {
	candidateId: string;
	month: string;
	process: { interview: Source | null; offer: Source | null; bucket: Bucket } | null;
}

interface CandidateFacets {
	synthetic: boolean;
	region: string | null;
	/** The latest category in force: its specialization and grade. */
	specialization: string | null;
	grade: string | null;
	levels: { discipline: string; level: string }[];
	competitions: { id: string; title: string; discipline: string; startDate: string | null }[];
}

interface StoredReport {
	id: string;
	party: Party;
	kind: 'stage' | 'outcome';
	stage: ReportFacts['stage'];
	outcome: ReportFacts['outcome'];
	startDate: string | null;
	reasonCode: string | null;
	supersedesReportId: string | null;
	reportedAt: string;
}

/** Which sides reported one of the stages. */
function sourceOf(reports: readonly ReportFacts[], stages: readonly string[]): Source | null {
	const parties = new Set(
		reports.filter((r) => r.kind === 'stage' && r.stage !== null && stages.includes(r.stage)).map((r) => r.party)
	);
	if (parties.size === 2) return 'both';
	const [party] = parties;
	return party ?? null;
}

function bucketOf(state: ReturnType<typeof hiringState>): Bucket {
	switch (state.outcome) {
		case 'confirmed':
			return state.result === 'hired' ? 'hired' : 'not_hired';
		case 'single_party': {
			const reporter = state.reports.company ? 'company' : 'candidate';
			return state.reports[reporter]?.outcome === 'hired' ? `single_${reporter}` : null;
		}
		case 'diverged':
			return 'diverged';
		case 'unknown':
			return 'unknown';
		case 'pending':
			return state.overdue ? 'unknown' : null;
	}
}

function periodOf(filters: FunnelFilters): SQL | undefined {
	return and(
		isNull(invitations.purgedAt),
		outsideDemoSessions(companySession(invitations.companyId)),
		outsideDemoSessions(candidateSession(invitations.candidateId)),
		filters.from ? gte(invitations.sentAt, filters.from) : undefined,
		filters.to ? lt(invitations.sentAt, filters.to) : undefined
	);
}

async function loadInvitations(executor: Executor, filters: FunnelFilters, now: Date): Promise<InvitationFacts[]> {
	const rows = await executor
		.select({
			candidateId: invitations.candidateId,
			sentAt: invitations.sentAt,
			openedAt: hiringProcesses.openedAt,
			outcomeDueAt: hiringProcesses.outcomeDueAt,
			policyId: hiringProcesses.policyId,
			reports: sql<StoredReport[] | null>`(
				select json_agg(json_build_object(
					'id', r.id, 'party', r.party, 'kind', r.kind, 'stage', r.stage, 'outcome', r.outcome,
					'startDate', r.start_date, 'reasonCode', r.reason_code, 'supersedesReportId', r.supersedes_report_id,
					'reportedAt', r.reported_at
				) order by r.reported_at, r.id)
				from hiring_reports r where r.process_id = ${hiringProcesses.id}
			)`
		})
		.from(invitations)
		.leftJoin(hiringProcesses, eq(hiringProcesses.invitationId, invitations.id))
		.where(periodOf(filters));

	const policyIds = [...new Set(rows.flatMap((row) => (row.policyId ? [row.policyId] : [])))];
	const policies = new Map<string, PolicyParams<'hiring_policy'>>();
	if (policyIds.length > 0) {
		const stored = await executor
			.select({ id: productPolicies.id, kind: productPolicies.kind, params: productPolicies.params })
			.from(productPolicies)
			.where(inArray(productPolicies.id, policyIds));
		for (const policy of stored) {
			if (policy.kind !== 'hiring_policy') throw new Error(`policy ${policy.id} of a process is not a hiring policy`);
			policies.set(policy.id, parsePolicyParams('hiring_policy', policy.params));
		}
	}

	return rows.map((row) => {
		const facts: InvitationFacts = {
			candidateId: row.candidateId,
			month: row.sentAt.toISOString().slice(0, 7),
			process: null
		};
		if (row.policyId === null || row.openedAt === null || row.outcomeDueAt === null) return facts;
		const policy = policies.get(row.policyId);
		if (!policy) throw new Error(`hiring policy ${row.policyId} does not exist`);
		const reports = reportsInForce(
			(row.reports ?? []).map((report) => ({ ...report, reportedAt: new Date(report.reportedAt) }))
		);
		const state = hiringState({ openedAt: row.openedAt, outcomeDueAt: row.outcomeDueAt }, reports, policy, now);
		facts.process = {
			interview: sourceOf(reports, ['interview_scheduled', 'interview_done']),
			offer: sourceOf(reports, ['offer_made', 'offer_accepted']),
			bucket: bucketOf(state)
		};
		return facts;
	});
}

/**
 * The facets of every invited candidate: the latest category in force, the FSP levels of the evidence in force, the
 * competitions, the region.
 */
async function loadCandidates(executor: Executor, filters: FunnelFilters): Promise<Map<string, CandidateFacets>> {
	const invited = executor.selectDistinct({ id: invitations.candidateId }).from(invitations).where(periodOf(filters));
	const rows = await executor
		.select({
			id: candidates.id,
			synthetic: sql<boolean>`${candidates.seedBatchId} is not null`,
			region: sql<string | null>`${candidates.preferences}->>'region_code'`,
			specialization: sql<string | null>`ca.specialization`,
			grade: sql<string | null>`ca.grade`,
			levels: sql<{ discipline: string; level: string }[]>`coalesce((
				select json_agg(json_build_object('discipline', f.discipline, 'level', f.level))
				from fsp_level_assignments f where f.run_id = run.id
			), '[]'::json)`,
			competitions: sql<CandidateFacets['competitions']>`coalesce((
				select json_agg(distinct jsonb_build_object(
					'id', s.payload->'competition'->>'id',
					'title', s.payload->'competition'->>'title',
					'discipline', coalesce(s.payload->'competition'->>'discipline', 'unknown'),
					'startDate', s.payload->'competition'->>'startDate'
				))
				from source_facts s
				where s.candidate_id = ${candidates.id} and s.status = 'active' and s.source = 'fsp'
					and s.fact_type = 'competition_result' and s.payload->'competition'->>'id' is not null
			), '[]'::json)`
		})
		.from(candidates)
		.leftJoin(
			sql`evidence_runs run`,
			sql`run.candidate_id = ${candidates.id} and ${runInForce(runAt('run'), candidates)}`
		)
		.leftJoin(
			sql`lateral (select k.specialization, k.grade from ${activeCategoryRows} k
				where k.candidate_id = ${candidates.id} order by k.assigned_at desc limit 1) ca`,
			sql`true`
		)
		.where(inArray(candidates.id, invited));
	return new Map(
		rows.map((row) => [
			row.id,
			{
				synthetic: row.synthetic,
				region: row.region,
				specialization: row.specialization,
				grade: row.grade,
				levels: row.levels,
				competitions: row.competitions
			}
		])
	);
}

// --- Grouping --------------------------------------------------------------------------------------------------------

type Facet = Record<FunnelDimension, string>;

/**
 * The facets of an invitation: one per discipline or per competition of the candidate when the selection is sliced or
 * filtered by them, one otherwise.
 */
function facetsOf(
	invitation: InvitationFacts,
	candidate: CandidateFacets,
	uses: ReadonlySet<FunnelDimension>
): Facet[] {
	const base = {
		month: invitation.month,
		region: candidate.region ?? NO_VALUE,
		specialization: candidate.specialization ?? NO_VALUE,
		grade: candidate.grade ?? NO_VALUE,
		fsp_participant: candidate.levels.length > 0 ? 'fsp' : 'not_fsp'
	};
	const none = { competition: NO_VALUE, fsp_discipline: NO_VALUE, fsp_level: NO_VALUE };
	if (uses.has('competition')) {
		const levelIn = new Map(candidate.levels.map((level) => [level.discipline, level.level]));
		const list = candidate.competitions.map((competition) => ({
			competition: competition.id,
			fsp_discipline: competition.discipline,
			fsp_level: levelIn.get(competition.discipline) ?? NO_VALUE
		}));
		return (list.length > 0 ? list : [none]).map((facet) => ({ ...base, ...facet }));
	}
	const list = candidate.levels.map((level) => ({
		competition: NO_VALUE,
		fsp_discipline: level.discipline,
		fsp_level: level.level
	}));
	return (list.length > 0 ? list : [none]).map((facet) => ({ ...base, ...facet }));
}

interface Members {
	key: string;
	pooled: number;
	/** Indexes of the invitations. */
	invitations: Set<number>;
	candidates: Set<string>;
}

function members(key: string): Members {
	return { key, pooled: 0, invitations: new Set(), candidates: new Set() };
}

/**
 * The groups of one level with the small ones pooled: the groups below the threshold, then the next smallest, until the
 * pool reaches the threshold or nothing is left.
 */
function poolSmall(groups: readonly Members[], threshold: number): Members[] {
	const ascending = [...groups].sort((a, b) => a.candidates.size - b.candidates.size || (a.key < b.key ? -1 : 1));
	const pool = members(SMALL_GROUPS);
	const add = (group: Members) => {
		pool.pooled++;
		for (const index of group.invitations) pool.invitations.add(index);
		for (const id of group.candidates) pool.candidates.add(id);
	};
	let next = 0;
	for (const group of ascending) {
		if (group.candidates.size >= threshold && (pool.pooled === 0 || pool.candidates.size >= threshold)) break;
		add(group);
		next++;
	}
	const kept = ascending.slice(next);
	return pool.pooled > 0 ? [...kept, pool] : kept;
}

/** Month chronologically; any other dimension from the largest group; groups without a value and the pool last. */
function ordered(dimension: FunnelDimension, groups: Members[]): Members[] {
	const rank = (group: Members) => (group.key === SMALL_GROUPS ? 2 : group.key === NO_VALUE ? 1 : 0);
	return groups.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			(dimension === 'month' ? 0 : b.candidates.size - a.candidates.size) ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
	);
}

function summarize(
	group: Members,
	invitationsList: readonly InvitationFacts[],
	candidateFacets: ReadonlyMap<string, CandidateFacets>,
	threshold: number,
	children: FunnelGroup[]
): FunnelGroup {
	// An empty selection has nobody to point at: its zeros are shown.
	const small = group.candidates.size > 0 && group.candidates.size < threshold;
	const cell = (value: number): FunnelCell =>
		small || (value > 0 && value < threshold) ? { below: threshold } : { value };
	const interview = { company: 0, candidate: 0, both: 0 };
	const offer = { company: 0, candidate: 0, both: 0 };
	const buckets = { hired: 0, single_company: 0, single_candidate: 0, diverged: 0, not_hired: 0, unknown: 0 };
	let contact = 0;
	for (const index of group.invitations) {
		const process = invitationsList[index]?.process;
		if (!process) continue;
		contact++;
		if (process.interview) interview[process.interview]++;
		if (process.offer) offer[process.offer]++;
		if (process.bucket) buckets[process.bucket]++;
	}
	const sourced = (counts: Record<Source, number>): SourcedCell => ({
		total: cell(counts.company + counts.candidate + counts.both),
		bySource: { company: cell(counts.company), candidate: cell(counts.candidate), both: cell(counts.both) }
	});
	return {
		key: group.key,
		pooled: group.pooled,
		synthetic: [...group.candidates].some((id) => candidateFacets.get(id)?.synthetic === true),
		invited: cell(group.candidates.size),
		contact: cell(contact),
		interview: sourced(interview),
		offer: sourced(offer),
		hired: {
			confirmed: cell(buckets.hired),
			singleParty: { company: cell(buckets.single_company), candidate: cell(buckets.single_candidate) },
			diverged: cell(buckets.diverged)
		},
		notHired: cell(buckets.not_hired),
		unknown: cell(buckets.unknown),
		children
	};
}

export async function careerFunnel(
	deps: InvitationDeps,
	subject: AccessSubject,
	filters: FunnelFilters
): Promise<CareerFunnel> {
	const access = can(subject, 'fsp_analytics.read', null);
	if (!access.allowed)
		throw refuse(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden', 'not_operator');
	const [primary, secondary] = filters.dimensions;
	if (primary !== undefined && primary === secondary) throw new Error('the two dimensions of a funnel must differ');
	const executor = deps.db;
	const now = deps.now();
	const threshold = (await requiredPolicy(executor, 'catalog_policy', now)).params.small_count_threshold;

	const invitationsList = await loadInvitations(executor, filters, now);
	const candidateFacets = await loadCandidates(executor, filters);
	const where = Object.entries(filters.where ?? {}) as [FunnelFilter, string][];
	const uses = new Set<FunnelDimension>([...filters.dimensions, ...where.map(([dimension]) => dimension)]);

	const total = members('all');
	const byPrimary = new Map<string, Members>();
	const bySecondary = new Map<string, Map<string, Members>>();
	const join = (map: Map<string, Members>, key: string, index: number, candidateId: string) => {
		const group = map.get(key) ?? members(key);
		map.set(key, group);
		group.invitations.add(index);
		group.candidates.add(candidateId);
	};
	invitationsList.forEach((invitation, index) => {
		const candidate = candidateFacets.get(invitation.candidateId);
		if (!candidate) throw new Error(`candidate ${invitation.candidateId} of an invitation was not loaded`);
		const facets = facetsOf(invitation, candidate, uses).filter((facet) =>
			where.every(([dimension, value]) => facet[dimension] === value)
		);
		if (facets.length === 0) return;
		total.invitations.add(index);
		total.candidates.add(invitation.candidateId);
		if (primary === undefined) return;
		for (const facet of facets) {
			join(byPrimary, facet[primary], index, invitation.candidateId);
			if (secondary === undefined) continue;
			const inner = bySecondary.get(facet[primary]) ?? new Map<string, Members>();
			bySecondary.set(facet[primary], inner);
			join(inner, facet[secondary], index, invitation.candidateId);
		}
	});

	const shown = new Set<string>();
	const level = (dimension: FunnelDimension, groups: Members[], childrenOf: (group: Members) => FunnelGroup[]) =>
		ordered(dimension, poolSmall(groups, threshold)).map((group) => {
			if (dimension === 'competition' && group.pooled === 0) shown.add(group.key);
			return summarize(group, invitationsList, candidateFacets, threshold, childrenOf(group));
		});
	// A pool has no inner rows: they would be the inner rows of the groups it keeps unnamed.
	const childrenOf = (group: Members): FunnelGroup[] =>
		secondary === undefined || group.pooled > 0
			? []
			: level(secondary, [...(bySecondary.get(group.key)?.values() ?? [])], () => []);
	const groups = primary === undefined ? [] : level(primary, [...byPrimary.values()], childrenOf);

	const competitions: CareerFunnel['competitions'] = {};
	for (const candidate of candidateFacets.values())
		for (const competition of candidate.competitions)
			if (shown.has(competition.id))
				competitions[competition.id] = { title: competition.title, startDate: competition.startDate };

	return {
		dimensions: [...filters.dimensions],
		threshold,
		total: summarize(total, invitationsList, candidateFacets, threshold, []),
		groups,
		competitions
	};
}
