// Feedback «what the market asks for ↔ what FSP gives» (docs/domain.md 13.9) for disciplines and competition cases:
// demand is how often a skill is required by vacancies seen in the window, supply is how many candidates have the
// skill inferred from their FSP results in the published categorization. It is a correlation of two counts, not a
// measured value of a skill, and the page says so. Counts below the threshold are «< N»; seeded demo records mark the
// numbers they enter as synthetic. Nothing is stored: every call counts from live data. Clones of demo sessions and the
// vacancies of their companies are left out: they repeat the cast, which is counted already (domain 19.3).
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requirePermission } from '$lib/server/companies/context';
import { vacancySeenAt, vacancySkillDemand } from '$lib/server/candidates/demand';
import type { Executor } from '$lib/server/db';
import { runInForce } from '$lib/server/db/conditions';
import { candidates, categorizationRuns, skillInferences, vacancies } from '$lib/server/db/schema';
import { companySession, outsideDemoSessions } from '$lib/server/demo/scope';
import { smallCell, type SmallCell } from './small-numbers';

export const FEEDBACK_WINDOWS = [30, 90, 180, 365] as const;
export type FeedbackWindow = (typeof FEEDBACK_WINDOWS)[number];

export function parseFeedbackWindow(value: string | null): FeedbackWindow {
	const days = Number(value);
	return FEEDBACK_WINDOWS.find((window) => window === days) ?? 90;
}

/** Vacancies that were open to candidates: published own ones and external ones seen by an import. */
const OPEN_STATUSES = ['published', 'paused', 'closed', 'active', 'stale'] as const;

export interface SkillFeedbackRow {
	skillKey: string;
	/** Vacancies of the window requiring the skill, and their share of all vacancies of the window. */
	demand: SmallCell;
	demandShare: number | null;
	/** Candidates with the skill inferred from FSP results, and their share of all candidates with FSP results. */
	supply: SmallCell;
	supplyShare: number | null;
	/** Of `supply`: inferences confirmed directly by an FSP result, not derived from neighbouring skills. */
	supplyDirect: SmallCell;
}

export interface SkillFeedback {
	windowDays: FeedbackWindow;
	since: Date;
	threshold: number;
	vacancies: SmallCell;
	fspCandidates: SmallCell;
	/** Some vacancies or candidates of the counts are seeded demo records. */
	synthetic: boolean;
	rows: SkillFeedbackRow[];
}

const ROWS_LIMIT = 40;

/** Counts of both sides, joined by skill key; the most demanded skills first, then the most supplied. */
export async function skillFeedback(
	executor: Executor,
	subject: AccessSubject,
	input: { windowDays: FeedbackWindow; now: Date; threshold: number }
): Promise<SkillFeedback> {
	requirePermission(subject, 'fsp_analytics.read', null);
	const since = new Date(input.now.getTime() - input.windowDays * 86_400_000);
	const windowVacancies = and(
		inArray(vacancies.status, [...OPEN_STATUSES]),
		outsideDemoSessions(companySession(vacancies.companyId)),
		sql`${vacancySeenAt} >= ${since.toISOString()}::timestamptz`
	);
	const demandCounts = await vacancySkillDemand(executor, windowVacancies);

	// Inferences of the published run of a live candidate that rest on at least one FSP fact.
	const fromFsp = sql`${skillInferences.contributions} @> '[{"source": "fsp"}]'::jsonb`;
	const liveCandidate = and(
		runInForce(categorizationRuns, candidates),
		eq(candidates.status, 'active'),
		outsideDemoSessions(candidates.demoSessionId)
	);
	const [supplyTotals] = await executor
		.select({
			n: sql<number>`count(distinct ${skillInferences.candidateId})::int`,
			seeded: sql<boolean>`coalesce(bool_or(${candidates.seedBatchId} is not null), false)`
		})
		.from(skillInferences)
		.innerJoin(categorizationRuns, eq(categorizationRuns.id, skillInferences.runId))
		.innerJoin(candidates, eq(candidates.id, skillInferences.candidateId))
		.where(and(liveCandidate, fromFsp));
	const supplyRows = await executor
		.select({
			skillKey: skillInferences.skillKey,
			n: sql<number>`count(distinct ${skillInferences.candidateId})::int`,
			direct: sql<number>`count(distinct ${skillInferences.candidateId}) filter (where ${skillInferences.attestation} = 'direct')::int`
		})
		.from(skillInferences)
		.innerJoin(categorizationRuns, eq(categorizationRuns.id, skillInferences.runId))
		.innerJoin(candidates, eq(candidates.id, skillInferences.candidateId))
		.where(and(liveCandidate, fromFsp))
		.groupBy(skillInferences.skillKey);

	const vacancyCount = demandCounts.vacancies;
	const fspCount = supplyTotals?.n ?? 0;
	const cell = (value: number) => smallCell(value, input.threshold);
	// A share of a suppressed count would give the count back, so it is shown only for counts above the threshold.
	const share = (value: number, total: number) =>
		total > 0 && (value === 0 || value >= input.threshold) ? value / total : null;
	const demand = new Map(demandCounts.skills.map((row) => [row.skillKey, row.vacancies]));
	const supply = new Map(supplyRows.map((row) => [row.skillKey, row]));
	const keys = [...new Set([...demand.keys(), ...supply.keys()])];
	const rows = keys
		.map((skillKey) => {
			const d = demand.get(skillKey) ?? 0;
			const s = supply.get(skillKey);
			return { skillKey, d, s: s?.n ?? 0, direct: s?.direct ?? 0 };
		})
		.sort((a, b) => b.d - a.d || b.s - a.s || a.skillKey.localeCompare(b.skillKey))
		.slice(0, ROWS_LIMIT)
		.map(({ skillKey, d, s, direct }) => ({
			skillKey,
			demand: cell(d),
			demandShare: share(d, vacancyCount),
			supply: cell(s),
			supplyShare: share(s, fspCount),
			supplyDirect: cell(direct)
		}));
	return {
		windowDays: input.windowDays,
		since,
		threshold: input.threshold,
		vacancies: cell(vacancyCount),
		fspCandidates: cell(fspCount),
		synthetic: demandCounts.seeded || (supplyTotals?.seeded ?? false),
		rows
	};
}
