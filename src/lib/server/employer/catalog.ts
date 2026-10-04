// The employer catalog page (docs/domain.md, sections 12.2, 12.4, 13.4, 14): the query from the address of the page,
// the search of the matching service, and a short summary of each found candidate for the list — the primary category,
// FSP levels and directly confirmed skills of the valid published run. The candidate id never leaves the server.
import { and, eq, inArray } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf } from '$lib/server/companies/context';
import type { Executor } from '$lib/server/db';
import { publishedRun, runInForce } from '$lib/server/db/conditions';
import {
	candidates,
	categorizationRuns,
	categoryAssignments,
	fspLevelAssignments,
	skillInferences
} from '$lib/server/db/schema';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { ApiError } from '$lib/server/errors/api-error';
import {
	compareCandidates,
	searchCandidates,
	type CandidateComparison,
	type CandidateSearchFilters,
	type CompanyMatch,
	type SearchMode
} from '$lib/server/matching/search';
import { regionReference, type RegionReference } from '$lib/server/regions';
import { loadVacancyTaxonomy, resolveSkill, type VacancyTaxonomy } from '$lib/server/vacancies/taxonomy';
import type { ShowExtra } from '$lib/server/visibility/can-show';

const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
type FspLevel = (typeof FSP_LEVELS)[number];

/** The filters as the page form holds them, so the form shows what was searched. */
export interface CatalogQueryValues {
	text: string;
	roles: string[];
	grades: string[];
	includeGradeUnknown: boolean;
	stack: string;
	fspDiscipline: string;
	fspLevel: string;
	formats: string[];
	/** Codes of the reference of regions. */
	regions: string[];
	uncategorized: boolean;
}

interface CatalogQuery {
	values: CatalogQueryValues;
	text: string | undefined;
	filters: CandidateSearchFilters;
	cursor: string | undefined;
	/** Stack skills the taxonomy does not know: the filter is not applied and the page says so. */
	unknownStack: string[];
	/** Region codes the reference does not know: the query is refused, not searched with nothing to find. */
	unknownRegions: string[];
}

const list = (url: URL, name: string) => url.searchParams.getAll(name).filter((value) => value !== '');

/** The query of the catalog from the address; empty filters are not sent to the search. */
function catalogQueryOf(url: URL, taxonomy: VacancyTaxonomy, regions: RegionReference): CatalogQuery {
	const values: CatalogQueryValues = {
		text: url.searchParams.get('q') ?? '',
		roles: list(url, 'role'),
		grades: list(url, 'grade'),
		includeGradeUnknown: url.searchParams.get('gradeUnknown') === 'on',
		stack: url.searchParams.get('stack') ?? '',
		fspDiscipline: url.searchParams.get('fspDiscipline') ?? '',
		fspLevel: url.searchParams.get('fspLevel') ?? '',
		formats: list(url, 'format'),
		regions: [...new Set(list(url, 'region'))],
		uncategorized: url.searchParams.get('uncategorized') === 'on'
	};
	const filters: CandidateSearchFilters = {};
	const unknownStack: string[] = [];
	if (values.uncategorized) filters.uncategorized = true;
	else {
		if (values.roles.length > 0) filters.roleKeys = values.roles;
		if (values.grades.length > 0) {
			filters.grade = { keys: values.grades, includeNotEstablished: values.includeGradeUnknown };
		}
		const stack: string[] = [];
		for (const raw of values.stack.split(',')) {
			const item = raw.trim();
			if (item === '') continue;
			const key = resolveSkill(taxonomy, item);
			if (key === null) unknownStack.push(item);
			else if (!stack.includes(key)) stack.push(key);
		}
		if (stack.length > 0) filters.stackSkillKeys = stack;
	}
	if (values.fspDiscipline !== '' && (FSP_LEVELS as readonly string[]).includes(values.fspLevel)) {
		filters.fspLevel = { discipline: values.fspDiscipline, minLevel: values.fspLevel as FspLevel };
	}
	if (values.formats.length > 0) filters.workFormats = values.formats;
	if (values.regions.length > 0) filters.regionCodes = values.regions;
	return {
		values,
		text: values.text.trim() === '' ? undefined : values.text.trim(),
		filters,
		cursor: url.searchParams.get('cursor') ?? undefined,
		unknownStack,
		unknownRegions: values.regions.filter((code) => !regions.has(code))
	};
}

export interface CandidateSummary {
	/** `available` — a valid published run; `recalculating` — below the evidence floor; `none` — no run. */
	categoryState: 'available' | 'recalculating' | 'none';
	primary: {
		roleKey: string | null;
		grade: { min: string; max: string } | null;
		stackSkillKeys: string[];
	} | null;
	fspLevels: { discipline: string; level: string }[];
	/** Skills with a direct attestation and their trust badge. */
	confirmedSkills: { skillKey: string; badgeTrust: string }[];
}

/** Summaries of the listed candidates in three queries for the whole page. */
async function candidateSummaries(
	executor: Executor,
	candidateIds: readonly string[]
): Promise<Map<string, CandidateSummary>> {
	const result = new Map<string, CandidateSummary>();
	if (candidateIds.length === 0) return result;
	const runs = await executor
		.select({
			candidateId: categorizationRuns.candidateId,
			runId: categorizationRuns.id,
			valid: runInForce(categorizationRuns, candidates)
		})
		.from(categorizationRuns)
		.innerJoin(candidates, eq(candidates.id, categorizationRuns.candidateId))
		.where(and(inArray(categorizationRuns.candidateId, [...candidateIds]), publishedRun(categorizationRuns)));
	const validRuns = runs.filter((run) => run.valid).map((run) => run.runId);
	const [assignments, levels, skills] = validRuns.length
		? await Promise.all([
				executor
					.select()
					.from(categoryAssignments)
					.where(and(inArray(categoryAssignments.runId, validRuns), eq(categoryAssignments.rank, 'primary'))),
				executor.select().from(fspLevelAssignments).where(inArray(fspLevelAssignments.runId, validRuns)),
				executor
					.select({
						runId: skillInferences.runId,
						skillKey: skillInferences.skillKey,
						badgeTrust: skillInferences.badgeTrust
					})
					.from(skillInferences)
					.where(and(inArray(skillInferences.runId, validRuns), eq(skillInferences.attestation, 'direct')))
			])
		: [[], [], []];
	for (const id of candidateIds) {
		const run = runs.find((row) => row.candidateId === id);
		if (!run?.valid) {
			result.set(id, {
				categoryState: run ? 'recalculating' : 'none',
				primary: null,
				fspLevels: [],
				confirmedSkills: []
			});
			continue;
		}
		const primary = assignments.find((row) => row.runId === run.runId);
		result.set(id, {
			categoryState: 'available',
			primary: primary
				? {
						roleKey: primary.roleStatus === 'established' ? primary.roleKey : null,
						grade:
							primary.gradeStatus === 'established' && primary.gradeMin !== null && primary.gradeMax !== null
								? { min: primary.gradeMin, max: primary.gradeMax }
								: null,
						stackSkillKeys: primary.stackSkillKeys
					}
				: null,
			fspLevels: levels
				.filter((row) => row.runId === run.runId)
				.map((row) => ({ discipline: row.discipline, level: row.level })),
			confirmedSkills: skills.flatMap((row) =>
				row.runId === run.runId && row.badgeTrust !== null
					? [{ skillKey: row.skillKey, badgeTrust: row.badgeTrust }]
					: []
			)
		});
	}
	return result;
}

export interface CatalogItem {
	pseudonym: string;
	extras: ShowExtra[];
	match: CompanyMatch | null;
	gradeGroup: 'in_range' | 'not_established' | null;
	summary: CandidateSummary;
}

export interface CatalogPage {
	items: CatalogItem[];
	nextCursor: string | null;
	mode: SearchMode;
}

/** One page of the catalog with the summaries of its candidates, without candidate ids. */
async function catalogPage(
	deps: MatchingDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	query: { vacancyId?: string; text?: string; filters: CandidateSearchFilters; cursor?: string },
	signal?: AbortSignal
): Promise<CatalogPage> {
	const page = await searchCandidates(
		deps,
		subject,
		{
			...(query.vacancyId === undefined ? {} : { vacancyId: query.vacancyId }),
			...(query.text === undefined ? {} : { text: query.text }),
			filters: query.filters,
			...(query.cursor === undefined ? {} : { cursor: query.cursor })
		},
		signal
	);
	await recordAuditEvent(deps.db, {
		action: 'catalog.searched',
		outcome: 'success',
		actor: auditActorOf(subject),
		...(query.vacancyId === undefined ? {} : { object: { type: 'vacancy', id: query.vacancyId } }),
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		details: { result_count: page.items.length }
	});
	const summaries = await candidateSummaries(
		deps.db,
		page.items.map((item) => item.candidateId)
	);
	return {
		items: page.items.map((item) => {
			const summary = summaries.get(item.candidateId);
			if (!summary) throw new Error('a listed candidate has no summary');
			return {
				pseudonym: item.pseudonym,
				extras: item.extras,
				match: item.match,
				gradeGroup: item.gradeGroup,
				summary
			};
		}),
		nextCursor: page.nextCursor,
		mode: page.mode
	};
}

export interface CatalogView {
	query: CatalogQueryValues;
	unknownStack: string[];
	/** `null` — the query was refused; `problem` says why. */
	page: CatalogPage | null;
	problem: string | null;
	/** Chosen candidates compared by the requirements of the vacancy. */
	comparison: CandidateComparison | null;
	compared: string[];
	/** The query without its cursor and comparison: the «next page» form repeats it. */
	params: [string, string][];
}

/** The catalog page for the address: the search, the refusal of a malformed query, the comparison of chosen ones. */
export async function catalogView(
	deps: MatchingDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	url: URL,
	vacancyId: string | undefined,
	signal?: AbortSignal
): Promise<CatalogView> {
	const [taxonomy, regions] = await Promise.all([loadVacancyTaxonomy(deps.db), regionReference()]);
	const query = catalogQueryOf(url, taxonomy, regions);
	const compared = [...new Set(url.searchParams.getAll('compare'))].slice(0, 10);
	let page: CatalogPage | null = null;
	let problem: string | null = null;
	if (query.unknownRegions.length > 0) {
		problem = `Таких регионов нет в справочнике: ${query.unknownRegions.join(', ')}`;
	} else {
		try {
			page = await catalogPage(
				deps,
				subject,
				meta,
				{
					...(vacancyId === undefined ? {} : { vacancyId }),
					...(query.text === undefined ? {} : { text: query.text }),
					filters: query.filters,
					...(query.cursor === undefined ? {} : { cursor: query.cursor })
				},
				signal
			);
		} catch (cause) {
			// A query the search refuses (a facet that does not combine, a stale cursor) is shown, not thrown.
			if (!(cause instanceof ApiError) || cause.code !== 'validation_failed') throw cause;
			problem = cause.details?.map((detail) => detail.message).join('; ') ?? cause.message;
		}
	}
	const comparison =
		vacancyId !== undefined && compared.length >= 2
			? await compareCandidates(deps, subject, vacancyId, compared, signal)
			: null;
	const params = [...url.searchParams.entries()].filter(([name]) => name !== 'cursor' && name !== 'compare');
	return { query: query.values, unknownStack: query.unknownStack, page, problem, comparison, compared, params };
}
