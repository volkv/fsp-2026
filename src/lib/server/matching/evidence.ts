// Snapshots `matchScore` reads (docs/domain.md, sections 12.4, 12.6, 13.1, 13.4, 17.3): the vacancy at its revision and
// the candidate at the current profile revision with the evidence of the published evidence run, if it is valid, and
// the categories in force.
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ADMITTED_COMPANY_STATUSES } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { publishedRun, runInForce } from '$lib/server/db/conditions';
import { activeCategories } from '$lib/server/categories/read';
import {
	candidates,
	companies,
	evidenceRuns,
	grades,
	skillInferences,
	sourceFacts,
	vacancies
} from '$lib/server/db/schema';
import { companyInDemoScope } from '$lib/server/demo/scope';
import { parsePreferences, salaryExpectation, type CandidatePreferences } from '$lib/server/candidates/preferences';
import type { CandidateEvidence, ConfirmedCategory, MatchCandidate, MatchVacancy, SkillEvidence } from './score';

export interface CandidateSnapshot extends MatchCandidate {
	id: string;
	/** `profile_revision` the snapshot was read at: `match_scores.candidate_revision`. */
	revision: number;
	evidenceFloorRevision: number;
	preferences: CandidatePreferences;
	/** The categories in force with what their tests confirmed: the ranking for a need reads them (domain 13.10). */
	confirmed: ConfirmedCategory[];
}

export interface VacancySnapshot extends MatchVacancy {
	id: string;
	revision: number;
	origin: 'own' | 'external';
	companyId: string | null;
	status: string;
	title: string;
	description: string | null;
	taxonomyVersionId: string;
	workFormat: string | null;
	minAge: number | null;
	supersededByVacancyId: string | null;
	publishedAt: Date | null;
}

/**
 * The part of `skill_inferences.contributions` matching needs: which facts stand behind the inference. Only the fact ids
 * are read from the database (`strict` fails on a contribution without one): a whole contribution carries the rule,
 * the claim and every factor, ≈ 2.6 KB per inference, and the catalog has tens of thousands of inferences.
 */
const factIdsSchema = z.array(z.uuid());

/**
 * Candidates at the current revision with their categories in force. The published evidence run is used only while
 * `input_revision ≥ evidence_floor_revision`: a withdrawal raises the floor in its own transaction, so from that moment
 * nothing of the run reaches a score, even before the run is blocked and recomputed. Fact ids of an inference are
 * limited to facts active right now.
 */
export async function loadCandidateSnapshots(
	executor: Executor,
	candidateIds: readonly string[]
): Promise<Map<string, CandidateSnapshot>> {
	const result = new Map<string, CandidateSnapshot>();
	if (candidateIds.length === 0) return result;
	const ids = [...new Set(candidateIds)];

	const rows = await executor
		.select({
			id: candidates.id,
			revision: candidates.profileRevision,
			floor: candidates.evidenceFloorRevision,
			preferences: candidates.preferences
		})
		.from(candidates)
		.where(inArray(candidates.id, ids));

	const runs = await executor
		.select({
			id: evidenceRuns.id,
			candidateId: evidenceRuns.candidateId,
			inForce: runInForce(evidenceRuns, candidates)
		})
		.from(evidenceRuns)
		.innerJoin(candidates, eq(candidates.id, evidenceRuns.candidateId))
		.where(and(inArray(evidenceRuns.candidateId, ids), publishedRun(evidenceRuns)));
	const runByCandidate = new Map(runs.map((run) => [run.candidateId, run]));
	const validRunIds = runs.filter((run) => run.inForce).map((run) => run.id);
	const categories = await activeCategories(executor, ids);
	const inferences = validRunIds.length
		? await executor
				.select({
					runId: skillInferences.runId,
					skillKey: skillInferences.skillKey,
					band: skillInferences.strengthBand,
					attestation: skillInferences.attestation,
					badgeTrust: skillInferences.badgeTrust,
					factIds: sql<unknown>`jsonb_path_query_array(${skillInferences.contributions}, 'strict $[*].fact_id')`
				})
				.from(skillInferences)
				.where(inArray(skillInferences.runId, validRunIds))
		: [];

	const factIdsOf = new Map(
		inferences.map((inference) => {
			const parsed = factIdsSchema.safeParse(inference.factIds);
			if (!parsed.success) {
				throw new Error(`contributions of inference ${inference.skillKey} in run ${inference.runId} are malformed`);
			}
			return [inference, [...new Set(parsed.data)]] as const;
		})
	);
	const allFactIds = [...new Set([...factIdsOf.values()].flat())];
	const activeFacts = new Set(
		allFactIds.length
			? (
					await executor
						.select({ id: sourceFacts.id })
						.from(sourceFacts)
						.where(and(inArray(sourceFacts.id, allFactIds), eq(sourceFacts.status, 'active')))
				).map((row) => row.id)
			: []
	);

	const skillsByRun = new Map<string, SkillEvidence[]>();
	for (const [inference, factIds] of factIdsOf) {
		const list = skillsByRun.get(inference.runId) ?? [];
		list.push({
			skillKey: inference.skillKey,
			band: inference.band,
			attestation: inference.attestation,
			badgeTrust: inference.badgeTrust,
			factIds: factIds.filter((id) => activeFacts.has(id))
		});
		skillsByRun.set(inference.runId, list);
	}

	const valid = new Set(validRunIds);
	for (const row of rows) {
		const run = runByCandidate.get(row.id);
		let evidence: CandidateEvidence;
		if (!run) evidence = { status: 'unavailable', reason: 'no_published_run' };
		else if (!valid.has(run.id)) evidence = { status: 'unavailable', reason: 'run_below_evidence_floor' };
		else {
			evidence = { status: 'available', runId: run.id, skills: skillsByRun.get(run.id) ?? [] };
		}
		const preferences = parsePreferences(row.id, row.preferences);
		const held = categories.get(row.id) ?? [];
		result.set(row.id, {
			id: row.id,
			revision: row.revision,
			evidenceFloorRevision: row.floor,
			evidence,
			categories: held.map((c) => ({ specialization: c.specialization, grade: c.grade })),
			confirmed: held.map((c) => ({
				specialization: c.specialization,
				grade: c.grade,
				decisionId: c.decisionId,
				confirmedBlocks: c.confirmedBlocks,
				confirmedSkillKeys: c.confirmedSkillKeys,
				assignedAt: c.assignedAt
			})),
			preferences,
			salaryExpectation: salaryExpectation(preferences)
		});
	}
	return result;
}

type VacancyRow = typeof vacancies.$inferSelect;

export function vacancySnapshot(row: VacancyRow): VacancySnapshot {
	return {
		id: row.id,
		revision: row.revision,
		origin: row.origin,
		companyId: row.companyId,
		status: row.status,
		title: row.title,
		description: row.description,
		taxonomyVersionId: row.taxonomyVersionId,
		workFormat: row.workFormat,
		minAge: row.minAge,
		supersededByVacancyId: row.supersededByVacancyId,
		publishedAt: row.publishedAt,
		roleKey: row.roleKey,
		grade: row.gradeMin !== null && row.gradeMax !== null ? { min: row.gradeMin, max: row.gradeMax } : null,
		requiredSkillKeys: row.requiredSkillKeys,
		niceSkillKeys: row.niceSkillKeys,
		salary: {
			min: row.salaryMin,
			max: row.salaryMax,
			currency: row.salaryCurrency,
			period: row.salaryPeriod,
			taxBase: row.salaryTaxBase
		}
	};
}

export async function loadVacancySnapshot(executor: Executor, vacancyId: string): Promise<VacancySnapshot | null> {
	const [row] = await executor.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	return row ? vacancySnapshot(row) : null;
}

/**
 * Vacancies a candidate may be matched with: published own vacancies of companies the admission policy lets act
 * (domain 5.1: a check by an operator is not required) and external vacancies
 * that are active or awaiting a freshness check and not replaced by an own one (domain 13.1, 13.2).
 */
export const matchableVacancy = sql`(
	(${vacancies.origin} = 'own' and ${vacancies.status} = 'published'
		and exists (select 1 from ${companies} where ${companies.id} = ${vacancies.companyId}
			and ${companies.status} in (${sql.join(
				ADMITTED_COMPANY_STATUSES.map((status) => sql`${status}`),
				sql`, `
			)})))
	or (${vacancies.origin} = 'external' and ${vacancies.status} in ('active', 'stale')
		and ${vacancies.supersededByVacancyId} is null)
)`;

/**
 * The vacancies a viewer of demo session `viewerSession` (`null` — outside sessions) may be shown or matched with
 * (domain 13.1, 13.2, 19.3): matchable vacancies of the companies the viewer sees, and inside a session no external
 * vacancy that a company of that session replaced with its own published one — the replacement is recorded on the
 * shared vacancy only by a company outside sessions.
 */
export function matchableVacancyFor(viewerSession: string | null): SQL {
	const scoped = sql`${matchableVacancy} and ${companyInDemoScope(vacancies.companyId, viewerSession)}`;
	if (viewerSession === null) return sql`(${scoped})`;
	return sql`(${scoped} and not exists (select 1 from vacancies replacement
		join companies replacing on replacing.id = replacement.company_id
		where replacement.derived_from_vacancy_id = ${vacancies.id} and replacement.published_at is not null
		and replacing.demo_session_id = ${viewerSession}::uuid))`;
}

/** Grade ordinals of each taxonomy version asked for. */
export async function loadGradeOrdinals(
	executor: Executor,
	taxonomyVersionIds: readonly string[]
): Promise<Map<string, Map<string, number>>> {
	const ids = [...new Set(taxonomyVersionIds)];
	const result = new Map<string, Map<string, number>>(ids.map((id) => [id, new Map()]));
	if (ids.length === 0) return result;
	const rows = await executor
		.select({ version: grades.taxonomyVersionId, key: grades.key, ordinal: grades.ordinal })
		.from(grades)
		.where(inArray(grades.taxonomyVersionId, ids));
	for (const row of rows) result.get(row.version)?.set(row.key, row.ordinal);
	return result;
}
