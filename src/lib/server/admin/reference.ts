// The reference books for the administrator, read only: taxonomy versions with roles and skills, rule sets of
// categorization and matching, legal documents and product policies. Every book is versioned and immutable once
// published (migration 0002); a change is a new version published by the seed scripts at start, not an edit here.
// The one thing the administrator marks here is the queue of skills the taxonomy does not know: the mark says what
// became of a spelling, the dictionary itself still changes only by a new version.
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActionContext } from '$lib/server/companies/context';
import { requirePermission } from '$lib/server/companies/context';
import type { Executor } from '$lib/server/db';
import {
	categorizationRulesets,
	fspProjectionRules,
	grades,
	legalDocuments,
	matchRulesets,
	productPolicies,
	roles,
	skillAliases,
	skills,
	taxonomyVersions,
	unknownSkillMentions,
	vacancyPostings,
	vacancies,
	workFormats
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { normalizeSkillText } from '$lib/server/taxonomy/normalize';
import {
	markUnknownSkill,
	UNKNOWN_SKILL_REVIEW_STATUSES,
	type UnknownSkillReviewStatus
} from '$lib/server/taxonomy/unknown-mentions';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import { PENDING_VERSION } from '$lib/server/vacancies/clusters';

// --- Taxonomy ---

export interface TaxonomyVersionRow {
	id: string;
	label: string;
	status: 'draft' | 'published' | 'retired';
	publishedAt: Date | null;
	sources: unknown;
}

export interface SkillRow {
	key: string;
	name: string;
	kind: string;
	parentKey: string | null;
	externalIds: { hh: string | null; habr: string | null; so: string | null };
	aliases: string[];
}

export interface TaxonomyView {
	versions: TaxonomyVersionRow[];
	selected: {
		version: TaxonomyVersionRow;
		counts: { roles: number; skills: number; aliases: number; grades: number; formats: number };
		roles: {
			key: string;
			family: string;
			nameRu: string;
			typicalSkills: string[];
			hhRoleId: string[];
			habrSpec: string[];
			profStandard: string[];
		}[];
		grades: { key: string; ordinal: number; name: string }[];
		formats: { dimension: string; key: string; name: string }[];
		skills: SkillRow[];
		/** More skills match than are shown. */
		skillsTruncated: boolean;
	} | null;
}

const SKILLS_SHOWN = 60;

/** `%` and `_` of the query are literal characters, not patterns. */
function likePattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const isId = (value: string) => z.uuid().safeParse(value).success;

/**
 * The versions and one of them in detail: the one asked for, or the latest published. Skills are searched by name,
 * key and synonym (the normalized alias); without a query the first ones by name are shown.
 */
export async function taxonomyView(
	executor: Executor,
	ctx: ActionContext,
	input: { versionId: string | null; query: string }
): Promise<TaxonomyView> {
	requirePermission(ctx.subject, 'taxonomy.manage', null);
	const versions = await executor
		.select({
			id: taxonomyVersions.id,
			label: taxonomyVersions.label,
			status: taxonomyVersions.status,
			publishedAt: taxonomyVersions.publishedAt,
			sources: taxonomyVersions.sources
		})
		.from(taxonomyVersions)
		.orderBy(desc(taxonomyVersions.createdAt));
	const wanted = input.versionId !== null && isId(input.versionId) ? input.versionId : null;
	const selectedId = wanted ?? (await latestPublishedVersion(executor))?.id;
	const version = selectedId ? versions.find((row) => row.id === selectedId) : versions[0];
	if (wanted && !version) throw new ApiError('not_found');
	if (!version) return { versions, selected: null };

	const query = input.query.trim().toLowerCase();
	const skillFilter = query
		? and(
				eq(skills.taxonomyVersionId, version.id),
				or(
					ilike(skills.name, likePattern(query)),
					ilike(skills.key, likePattern(query)),
					inArray(
						skills.key,
						executor
							.select({ key: skillAliases.skillKey })
							.from(skillAliases)
							.where(
								and(
									eq(skillAliases.taxonomyVersionId, version.id),
									ilike(skillAliases.aliasNormalized, likePattern(query))
								)
							)
					)
				)
			)
		: eq(skills.taxonomyVersionId, version.id);

	const [roleRows, gradeRows, formatRows, skillRows, [skillCount], [aliasCount]] = await Promise.all([
		executor
			.select({
				key: roles.key,
				family: roles.family,
				nameRu: roles.nameRu,
				typicalSkills: roles.typicalSkills,
				hhRoleId: roles.hhRoleId,
				habrSpec: roles.habrSpec,
				profStandard: roles.profStandard
			})
			.from(roles)
			.where(eq(roles.taxonomyVersionId, version.id))
			.orderBy(asc(roles.family), asc(roles.key)),
		executor
			.select({ key: grades.key, ordinal: grades.ordinal, name: grades.name })
			.from(grades)
			.where(eq(grades.taxonomyVersionId, version.id))
			.orderBy(asc(grades.ordinal)),
		executor
			.select({ dimension: workFormats.dimension, key: workFormats.key, name: workFormats.name })
			.from(workFormats)
			.where(eq(workFormats.taxonomyVersionId, version.id))
			.orderBy(asc(workFormats.dimension), asc(workFormats.key)),
		executor
			.select()
			.from(skills)
			.where(skillFilter)
			.orderBy(asc(skills.name))
			.limit(SKILLS_SHOWN + 1),
		executor.select({ n: count() }).from(skills).where(eq(skills.taxonomyVersionId, version.id)),
		executor.select({ n: count() }).from(skillAliases).where(eq(skillAliases.taxonomyVersionId, version.id))
	]);
	const shown = skillRows.slice(0, SKILLS_SHOWN);
	const aliases =
		shown.length === 0
			? []
			: await executor
					.select({ skillKey: skillAliases.skillKey, alias: skillAliases.aliasNormalized })
					.from(skillAliases)
					.where(
						and(
							eq(skillAliases.taxonomyVersionId, version.id),
							inArray(
								skillAliases.skillKey,
								shown.map((skill) => skill.key)
							)
						)
					)
					.orderBy(asc(skillAliases.aliasNormalized));
	return {
		versions,
		selected: {
			version,
			counts: {
				roles: roleRows.length,
				skills: skillCount?.n ?? 0,
				aliases: aliasCount?.n ?? 0,
				grades: gradeRows.length,
				formats: formatRows.length
			},
			roles: roleRows,
			grades: gradeRows,
			formats: formatRows,
			skills: shown.map((skill) => ({
				key: skill.key,
				name: skill.name,
				kind: skill.kind,
				parentKey: skill.parentKey,
				externalIds: { hh: skill.hhId, habr: skill.habrId, so: skill.soTag },
				aliases: aliases.filter((alias) => alias.skillKey === skill.key).map((alias) => alias.alias)
			})),
			skillsTruncated: skillRows.length > SKILLS_SHOWN
		}
	};
}

// --- Queue of unknown skills ---

export type UnknownSkillFilter = UnknownSkillReviewStatus | 'all';

export interface UnknownSkillRow {
	/** The spelling in the canonical form of skill normalization, the key of the queue. */
	spelling: string;
	/** Postings the spelling was found in. */
	count: number;
	firstSeenAt: Date;
	status: UnknownSkillReviewStatus;
	/**
	 * The latest fetched posting that brought the spelling, when it was fetched and how it writes the spelling; `null` —
	 * that posting is gone or no longer carries the spelling.
	 */
	lastSeen: { at: Date; written: string; vacancyId: string; title: string; url: string } | null;
	/** Taxonomy versions whose aliases know the spelling as it is, with the skill it stands for. */
	inTaxonomy: { label: string; status: 'draft' | 'published' | 'retired'; skillKey: string }[];
}

export interface UnknownSkillQueueView {
	filter: UnknownSkillFilter;
	query: string;
	counts: Record<UnknownSkillReviewStatus, number>;
	rows: UnknownSkillRow[];
	/** More spellings match than are shown. */
	truncated: boolean;
}

const UNKNOWN_SKILLS_SHOWN = 100;

const unknownSkillFilterSchema = z.enum([...UNKNOWN_SKILL_REVIEW_STATUSES, 'all']);

/** The filter of the address: `?status=`; without one — the spellings waiting for review. */
export function unknownSkillFilterOf(value: string | null): UnknownSkillFilter {
	if (value === null || value === '') return 'pending';
	const parsed = unknownSkillFilterSchema.safeParse(value);
	if (!parsed.success)
		throw new ApiError('validation_failed', {
			details: [{ path: 'status', code: 'invalid', message: 'Нет такого состояния очереди' }]
		});
	return parsed.data;
}

const unknownMentionsSchema = z.array(z.string());

/**
 * How the posting where a spelling was last seen writes it, while its normalization still leaves the spelling unknown;
 * `null` — the posting no longer carries it (normalized again, or waiting for that).
 */
function writtenIn(posting: { version: string; unknown: unknown }, spelling: string): string | null {
	if (posting.version === PENDING_VERSION) return null;
	return (
		unknownMentionsSchema.parse(posting.unknown).find((written) => normalizeSkillText(written) === spelling) ?? null
	);
}

function lastSeenOf(
	mention: typeof unknownSkillMentions.$inferSelect,
	posting: { version: string; unknown: unknown; url: string; vacancyId: string; title: string } | null
): UnknownSkillRow['lastSeen'] {
	if (posting === null || mention.lastSeenAt === null) return null;
	const written = writtenIn(posting, mention.rawNormalized);
	if (written === null) return null;
	return { at: mention.lastSeenAt, written, vacancyId: posting.vacancyId, title: posting.title, url: posting.url };
}

/**
 * The queue of spellings the taxonomy does not know, the most frequent first: how many postings carry each, since
 * when, the latest posting with it and the taxonomy versions that already know it as an alias.
 */
export async function unknownSkillQueue(
	executor: Executor,
	ctx: ActionContext,
	input: { filter: UnknownSkillFilter; query: string }
): Promise<UnknownSkillQueueView> {
	requirePermission(ctx.subject, 'taxonomy.manage', null);
	const query = normalizeSkillText(input.query);
	const where = and(
		input.filter === 'all' ? undefined : eq(unknownSkillMentions.reviewStatus, input.filter),
		query === '' ? undefined : ilike(unknownSkillMentions.rawNormalized, likePattern(query))
	);
	const [rows, statusCounts] = await Promise.all([
		executor
			.select({
				mention: unknownSkillMentions,
				posting: {
					version: vacancyPostings.normalizationVersion,
					url: vacancyPostings.url,
					vacancyId: vacancyPostings.vacancyId
				},
				unknown: sql<unknown>`${vacancyPostings.normalized}->'skills'->'unknown'`,
				vacancy: { title: vacancies.title }
			})
			.from(unknownSkillMentions)
			.leftJoin(vacancyPostings, eq(vacancyPostings.id, unknownSkillMentions.lastPostingId))
			.leftJoin(vacancies, eq(vacancies.id, vacancyPostings.vacancyId))
			.where(where)
			.orderBy(
				desc(unknownSkillMentions.count),
				asc(unknownSkillMentions.firstSeenAt),
				asc(unknownSkillMentions.rawNormalized)
			)
			.limit(UNKNOWN_SKILLS_SHOWN + 1),
		executor
			.select({ status: unknownSkillMentions.reviewStatus, n: count() })
			.from(unknownSkillMentions)
			.groupBy(unknownSkillMentions.reviewStatus)
	]);
	const shown = rows.slice(0, UNKNOWN_SKILLS_SHOWN);
	const spellings = new Set(shown.map((row) => row.mention.rawNormalized));
	const aliases =
		spellings.size === 0
			? []
			: await executor
					.select({
						alias: skillAliases.aliasNormalized,
						skillKey: skillAliases.skillKey,
						label: taxonomyVersions.label,
						status: taxonomyVersions.status
					})
					.from(skillAliases)
					.innerJoin(taxonomyVersions, eq(taxonomyVersions.id, skillAliases.taxonomyVersionId))
					.where(inArray(skillAliases.aliasNormalized, [...spellings]))
					.orderBy(desc(taxonomyVersions.createdAt));
	const counts: Record<UnknownSkillReviewStatus, number> = { pending: 0, added: 0, rejected: 0 };
	for (const row of statusCounts) counts[row.status] = row.n;
	return {
		filter: input.filter,
		query: input.query.trim(),
		counts,
		rows: shown.map(({ mention, posting, unknown, vacancy }) => ({
			spelling: mention.rawNormalized,
			count: mention.count,
			firstSeenAt: mention.firstSeenAt,
			status: mention.reviewStatus,
			lastSeen: lastSeenOf(mention, posting && vacancy && { ...posting, ...vacancy, unknown }),
			inTaxonomy: aliases
				.filter((alias) => alias.alias === mention.rawNormalized)
				.map(({ label, status, skillKey }) => ({ label, status, skillKey }))
		})),
		truncated: rows.length > UNKNOWN_SKILLS_SHOWN
	};
}

const reviewSchema = z.object({
	spelling: z.string().min(1),
	status: z.enum(UNKNOWN_SKILL_REVIEW_STATUSES)
});

/**
 * The administrator's mark on a spelling of the queue: `added` — it went into the dictionary (an alias of a new taxonomy
 * version), `rejected` — it is not a skill, `pending` — back to the queue.
 */
export async function reviewUnknownSkill(
	executor: Executor,
	ctx: ActionContext,
	input: { spelling: string; status: string }
): Promise<{ spelling: string; status: UnknownSkillReviewStatus }> {
	requirePermission(ctx.subject, 'taxonomy.manage', null);
	const parsed = reviewSchema.safeParse(input);
	if (!parsed.success)
		throw new ApiError('validation_failed', {
			details: [{ path: 'status', code: 'invalid', message: 'Неизвестная отметка' }]
		});
	if (!(await markUnknownSkill(executor, parsed.data.spelling, parsed.data.status))) throw new ApiError('not_found');
	return parsed.data;
}

// --- Rule sets ---

export interface RulesetRow {
	id: string;
	version: number;
	taxonomyLabel: string;
	taxonomyStatus: string;
	params: unknown;
	createdAt: Date;
}

export interface RulesView {
	categorization: RulesetRow[];
	matching: RulesetRow[];
	/** Projection of FSP results onto skills and roles in the latest published taxonomy. */
	projection: {
		taxonomyLabel: string;
		rules: {
			id: string;
			discipline: string;
			targetKind: string;
			targetKey: string;
			weight: string;
			attestation: string;
			requiresSpecialization: string | null;
			appliesTo: string;
		}[];
	} | null;
}

export async function rulesView(executor: Executor, ctx: ActionContext): Promise<RulesView> {
	requirePermission(ctx.subject, 'taxonomy.manage', null);
	const rulesetColumns = (table: typeof categorizationRulesets | typeof matchRulesets) => ({
		id: table.id,
		version: table.version,
		taxonomyLabel: taxonomyVersions.label,
		taxonomyStatus: taxonomyVersions.status,
		params: table.params,
		createdAt: table.createdAt
	});
	const [categorization, matching, published] = await Promise.all([
		executor
			.select(rulesetColumns(categorizationRulesets))
			.from(categorizationRulesets)
			.innerJoin(taxonomyVersions, eq(taxonomyVersions.id, categorizationRulesets.taxonomyVersionId))
			.orderBy(desc(categorizationRulesets.version)),
		executor
			.select(rulesetColumns(matchRulesets))
			.from(matchRulesets)
			.innerJoin(taxonomyVersions, eq(taxonomyVersions.id, matchRulesets.taxonomyVersionId))
			.orderBy(desc(matchRulesets.version)),
		latestPublishedVersion(executor)
	]);
	const projection = published
		? {
				taxonomyLabel: published.label,
				rules: await executor
					.select({
						id: fspProjectionRules.id,
						discipline: fspProjectionRules.discipline,
						targetKind: fspProjectionRules.targetKind,
						targetKey: fspProjectionRules.targetKey,
						weight: fspProjectionRules.weight,
						attestation: fspProjectionRules.attestation,
						requiresSpecialization: fspProjectionRules.requiresSpecialization,
						appliesTo: fspProjectionRules.appliesTo
					})
					.from(fspProjectionRules)
					.where(eq(fspProjectionRules.taxonomyVersionId, published.id))
					.orderBy(
						asc(fspProjectionRules.discipline),
						asc(fspProjectionRules.targetKind),
						desc(fspProjectionRules.weight),
						asc(fspProjectionRules.targetKey)
					)
			}
		: null;
	return { categorization, matching, projection };
}

// --- Legal documents ---

export interface DocumentRow {
	id: string;
	kind: (typeof legalDocuments.$inferSelect)['kind'];
	version: number;
	title: string;
	form: string;
	available: boolean;
	requiresReconsent: boolean;
	publishedAt: Date | null;
	supersededAt: Date | null;
	bodySha256: string;
}

const documentColumns = {
	id: legalDocuments.id,
	kind: legalDocuments.kind,
	version: legalDocuments.version,
	title: legalDocuments.title,
	form: legalDocuments.form,
	available: legalDocuments.available,
	requiresReconsent: legalDocuments.requiresReconsent,
	publishedAt: legalDocuments.publishedAt,
	supersededAt: legalDocuments.supersededAt,
	bodySha256: legalDocuments.bodySha256
};

/** Every version of every document, grouped by kind in the order of the registry, newest version first. */
export async function documentList(executor: Executor, ctx: ActionContext): Promise<DocumentRow[]> {
	requirePermission(ctx.subject, 'policy.manage', null);
	return executor
		.select(documentColumns)
		.from(legalDocuments)
		.orderBy(asc(legalDocuments.kind), desc(legalDocuments.version));
}

export interface DocumentView extends DocumentRow {
	body: string;
	purposes: string[];
	dataCategories: string[];
	operations: string[];
	operatorSnapshot: unknown;
	processorsSnapshot: unknown;
	/** Other versions of the same kind, for moving between them. */
	siblings: { id: string; version: number; publishedAt: Date | null; supersededAt: Date | null }[];
}

export async function documentView(executor: Executor, ctx: ActionContext, id: string): Promise<DocumentView> {
	requirePermission(ctx.subject, 'policy.manage', null);
	if (!isId(id)) throw new ApiError('not_found');
	const [row] = await executor
		.select({
			...documentColumns,
			body: legalDocuments.body,
			purposes: legalDocuments.purposes,
			dataCategories: legalDocuments.dataCategories,
			operations: legalDocuments.operations,
			operatorSnapshot: legalDocuments.operatorSnapshot,
			processorsSnapshot: legalDocuments.processorsSnapshot
		})
		.from(legalDocuments)
		.where(eq(legalDocuments.id, id));
	if (!row) throw new ApiError('not_found');
	const siblings = await executor
		.select({
			id: legalDocuments.id,
			version: legalDocuments.version,
			publishedAt: legalDocuments.publishedAt,
			supersededAt: legalDocuments.supersededAt
		})
		.from(legalDocuments)
		.where(eq(legalDocuments.kind, row.kind))
		.orderBy(desc(legalDocuments.version));
	return { ...row, siblings };
}

// --- Product policies ---

/** The part of a `policies/<kind>.json` file the page reads: the basis of every parameter of each version. */
const policyFileSchema = z.object({
	kind: z.string(),
	source: z.string(),
	versions: z.array(z.object({ version: z.int().positive(), basis: z.record(z.string(), z.string()) }))
});

type PolicyFile = z.infer<typeof policyFileSchema>;

/**
 * The policy files of this build. They are the source the seed publishes from, so the basis of a published version is
 * the one in the file of the same revision.
 */
const POLICY_FILES: PolicyFile[] = Object.entries(
	import.meta.glob<unknown>('/policies/*.json', { eager: true, import: 'default' })
).map(([path, content]) => {
	const parsed = policyFileSchema.safeParse(content);
	if (!parsed.success) throw new Error(`${path} is not a policy file: ${parsed.error.message}`);
	return parsed.data;
});

export interface PolicyVersionRow {
	id: string;
	kind: string;
	version: number;
	effectiveFrom: Date;
	createdAt: Date;
	/** `in_force` — the latest version that has taken effect; `scheduled` — takes effect later; `superseded` — replaced. */
	state: 'in_force' | 'scheduled' | 'superseded';
	params: { key: string; value: unknown; basis: string | null }[];
}

export interface PoliciesView {
	kinds: { kind: string; source: string | null; versions: PolicyVersionRow[] }[];
}

export async function policiesView(executor: Executor, ctx: ActionContext, now: Date): Promise<PoliciesView> {
	requirePermission(ctx.subject, 'policy.manage', null);
	const rows = await executor
		.select()
		.from(productPolicies)
		.orderBy(asc(productPolicies.kind), desc(productPolicies.version));
	const inForce = new Map<string, string>();
	for (const row of rows) {
		if (row.effectiveFrom <= now && !inForce.has(row.kind)) inForce.set(row.kind, row.id);
	}
	const kinds = new Map<string, PolicyVersionRow[]>();
	for (const row of rows) {
		const file = POLICY_FILES.find((candidate) => candidate.kind === row.kind);
		const basis = file?.versions.find((entry) => entry.version === row.version)?.basis ?? {};
		const params =
			typeof row.params === 'object' && row.params !== null && !Array.isArray(row.params)
				? Object.entries(row.params).map(([key, value]) => ({
						key,
						value: value as unknown,
						basis: basis[key] ?? null
					}))
				: [];
		kinds.set(row.kind, [
			...(kinds.get(row.kind) ?? []),
			{
				id: row.id,
				kind: row.kind,
				version: row.version,
				effectiveFrom: row.effectiveFrom,
				createdAt: row.createdAt,
				state: inForce.get(row.kind) === row.id ? 'in_force' : row.effectiveFrom > now ? 'scheduled' : 'superseded',
				params
			}
		]);
	}
	return {
		kinds: [...kinds.entries()].map(([kind, versions]) => ({
			kind,
			source: POLICY_FILES.find((file) => file.kind === kind)?.source ?? null,
			versions
		}))
	};
}
