// External vacancies as clusters of postings (docs/domain.md, sections 13.1, 13.2). A cluster keeps every posting
// that names it; its fields come from the posting updated last; disagreeing postings mark `terms_conflict`. Clustering
// is conservative — a pair that is not clearly the same vacancy stays two vacancies: a false merge is worse than a
// duplicate.
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { productPolicies, vacancies, vacancyPostings } from '$lib/server/db/schema';
import { parsePolicyParams } from '$lib/server/consent/kinds';
import { normalizedPostingSchema, originalTermsSchema, type NormalizedPosting } from './normalize';
import { checkVacancyText, type TextCheck } from './text-check';

// --- Fingerprints ---

const LEGAL_FORMS =
	/(?<![\p{L}\p{N}])(?:ооо|оао|зао|пао|ао|нао|ип|фгуп|гуп|муп|мбу|гбу|фгбу|фгбоу|ано|нко|llc|ltd|inc|gmbh|corp)(?![\p{L}\p{N}])/gu;

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е');

/** Organization name without legal form, quotes and punctuation: «ООО "Яндекс"» and «Яндекс» are one key. */
export function organizationKey(name: string): string {
	return fold(name)
		.replace(LEGAL_FORMS, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Title without the city in parentheses, punctuation and spacing differences. */
export function titleKey(title: string): string {
	return fold(title)
		.replace(/\s*\([^()]*\)\s*$/u, '')
		.replace(/[^\p{L}\p{N}+#]+/gu, ' ')
		.trim();
}

export interface PostingKeys {
	/** Same INN, title and city: the same vacancy of the same legal entity. */
	exact: string | null;
	/** Same organization name, title and city. */
	fingerprint: string;
}

export function postingKeys(input: {
	title: string;
	organization: { name: string; inn: string | null };
	city: string | null;
}): PostingKeys {
	const city = input.city === null ? '' : fold(input.city).trim();
	const title = titleKey(input.title);
	return {
		exact: input.organization.inn === null ? null : `${input.organization.inn}|${title}|${city}`,
		fingerprint: `${organizationKey(input.organization.name)}|${title}|${city}`
	};
}

export interface Dedup {
	method: 'exact' | 'fingerprint' | 'fuzzy' | 'manual';
	score: number;
	exact_key: string | null;
	fingerprint: string;
	decided_by?: string;
}

/**
 * The cluster a new posting joins: the one external vacancy already holding a posting with the same exact key, else
 * with the same fingerprint. Two or more candidate clusters are ambiguous — the posting starts its own. Closed, hidden
 * and replaced clusters are not joined.
 */
export async function findCluster(
	tx: Transaction,
	keys: PostingKeys
): Promise<{ vacancyId: string; dedup: Dedup } | null> {
	const candidates = async (field: 'exact_key' | 'fingerprint', value: string) => {
		const rows = await tx
			.selectDistinct({ vacancyId: vacancyPostings.vacancyId })
			.from(vacancyPostings)
			.innerJoin(vacancies, eq(vacancies.id, vacancyPostings.vacancyId))
			.where(
				and(
					sql`${vacancyPostings.dedup}->>${field} = ${value}`,
					inArray(vacancies.status, ['active', 'stale']),
					sql`${vacancies.supersededByVacancyId} is null`
				)
			);
		return rows.map((r) => r.vacancyId);
	};
	if (keys.exact !== null) {
		const exact = await candidates('exact_key', keys.exact);
		const [only] = exact;
		if (exact.length === 1 && only !== undefined) {
			return {
				vacancyId: only,
				dedup: { method: 'exact', score: 1, exact_key: keys.exact, fingerprint: keys.fingerprint }
			};
		}
		if (exact.length > 1) return null;
	}
	const similar = await candidates('fingerprint', keys.fingerprint);
	const [only] = similar;
	if (similar.length === 1 && only !== undefined) {
		return {
			vacancyId: only,
			dedup: { method: 'fingerprint', score: 0.9, exact_key: keys.exact, fingerprint: keys.fingerprint }
		};
	}
	return null;
}

// --- Cluster fields ---

type PostingRow = typeof vacancyPostings.$inferSelect;
type VacancyRow = typeof vacancies.$inferSelect;

/** `normalized` of a posting imported but not normalized yet. */
export const PENDING_NORMALIZATION = { pending: true } as const;
export const PENDING_VERSION = 'pending';

function normalizedOf(posting: PostingRow): NormalizedPosting | null {
	if (posting.normalizationVersion === PENDING_VERSION) return null;
	return normalizedPostingSchema.parse(posting.normalized);
}

const updatedAt = (p: PostingRow) => (p.sourceUpdatedAt ?? p.sourcePublishedAt ?? p.lastFetchedAt).getTime();

/** The posting whose fields the cluster shows: live over gone, normalized over pending, then the latest. */
export function leadPosting(postings: readonly PostingRow[]): PostingRow {
	const ranked = [...postings].sort(
		(a, b) =>
			Number(b.freshness !== 'gone') - Number(a.freshness !== 'gone') ||
			Number(b.normalizationVersion !== PENDING_VERSION) - Number(a.normalizationVersion !== PENDING_VERSION) ||
			updatedAt(b) - updatedAt(a) ||
			(a.id < b.id ? -1 : 1)
	);
	const [lead] = ranked;
	if (!lead) throw new Error('a cluster without postings');
	return lead;
}

/** Live postings disagree on a known salary range or a known grade (domain 13.2). */
export function termsConflict(postings: readonly PostingRow[]): boolean {
	const live = postings.filter((p) => p.freshness !== 'gone').map(normalizedOf);
	const salaries = new Set<string>();
	const grades = new Set<string>();
	for (const n of live) {
		if (n === null) continue;
		if (n.salary.status === 'stated') {
			salaries.add(`${n.salary.min}|${n.salary.max}|${n.salary.currency}|${n.salary.period}|${n.salary.tax_base}`);
		}
		if (n.grade.min !== null) grades.add(`${n.grade.min}|${n.grade.max}`);
	}
	return salaries.size > 1 || grades.size > 1;
}

export type ExternalStatus = 'active' | 'stale' | 'closed' | 'hidden';

/** Status of an external vacancy from its postings (domain 13.1, transitions of `external`). */
export function externalStatus(
	postings: readonly PostingRow[],
	textCheck: TextCheck,
	now: Date,
	staleAfterDays: number | null
): ExternalStatus {
	const live = postings.filter((p) => p.freshness !== 'gone');
	if (live.length === 0) return 'closed';
	if (textCheck.result === 'blocked') return 'hidden';
	if (staleAfterDays === null) return 'active';
	const confirmed = Math.max(...live.map((p) => p.lastCheckedAt.getTime()));
	return now.getTime() - confirmed > staleAfterDays * 86_400_000 ? 'stale' : 'active';
}

/** `sourcing_policy.stale_after_days` in force; `null` — no policy, vacancies do not go stale. */
export async function loadStaleAfterDays(executor: Executor, now: Date): Promise<number | null> {
	const [row] = await executor
		.select({ params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'sourcing_policy'), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	return row ? parsePolicyParams('sourcing_policy', row.params).stale_after_days : null;
}

/** Fields of the vacancy that matching, the vector and the search read: a change raises `revision`. */
function contentOf(v: Pick<VacancyRow, ContentField>): string {
	return JSON.stringify(CONTENT_FIELDS.map((field) => v[field]));
}

const CONTENT_FIELDS = [
	'title',
	'description',
	'taxonomyVersionId',
	'roleKey',
	'gradeMin',
	'gradeMax',
	'gradeBasis',
	'requiredSkillKeys',
	'niceSkillKeys',
	'workFormat',
	'employmentForm',
	'cityId',
	'salaryMin',
	'salaryMax',
	'salaryCurrency',
	'salaryPeriod',
	'salaryTaxBase',
	'externalOrg'
] as const;

type ContentField = (typeof CONTENT_FIELDS)[number];

export interface ClusterChange {
	vacancyId: string;
	revision: number;
	/** `revision` was raised: the vector and the matches must be recomputed. */
	revised: boolean;
	status: ExternalStatus;
	statusChanged: boolean;
}

/**
 * Recomputes an external vacancy from its postings under a lock of the vacancy row: fields of the lead posting,
 * the organization, `terms_conflict`, the text check and the status. `revision` grows only when content changed.
 */
export async function recomputeCluster(
	tx: Transaction,
	vacancyId: string,
	input: {
		/** The taxonomy version the lead posting was normalized with; `null` — keep the version of the vacancy. */
		taxonomyVersionId: string | null;
		now: Date;
		staleAfterDays: number | null;
	}
): Promise<ClusterChange> {
	const [current] = await tx.select().from(vacancies).where(eq(vacancies.id, vacancyId)).for('update');
	if (current?.origin !== 'external') throw new Error(`vacancy ${vacancyId} is not an external cluster`);
	const postings = await tx.select().from(vacancyPostings).where(eq(vacancyPostings.vacancyId, vacancyId));
	if (postings.length === 0) throw new Error(`external vacancy ${vacancyId} has no postings`);
	const lead = leadPosting(postings);
	const normalized = normalizedOf(lead);
	const terms = originalTermsSchema.parse(lead.originalTerms);
	const leadOrg = lead.organization as { name: string; inn?: string | null };
	const inn = postings
		.map((p) => (p.organization as { inn?: string | null }).inn ?? null)
		.find((value): value is string => value !== null);
	const sourceOrgIds = [
		...new Set(
			postings
				.map((p) => {
					const id = (p.organization as { source_org_id?: string | null }).source_org_id;
					return id ? `${p.source}:${id}` : null;
				})
				.filter((value): value is string => value !== null)
		)
	].sort();

	const salary = normalized?.salary.status === 'stated' ? normalized.salary : null;
	const next = {
		title: lead.title,
		description: terms.description,
		taxonomyVersionId:
			normalized === null ? current.taxonomyVersionId : (input.taxonomyVersionId ?? current.taxonomyVersionId),
		roleKey: normalized?.role.key ?? null,
		gradeMin: normalized?.grade.min ?? null,
		gradeMax: normalized?.grade.max ?? null,
		gradeBasis: normalized?.grade.basis ?? ('unknown' as const),
		requiredSkillKeys: normalized?.skills.required ?? [],
		niceSkillKeys: normalized?.skills.nice ?? [],
		workFormat: normalized?.work_format ?? null,
		employmentForm: normalized?.employment_form ?? null,
		cityId: normalized?.city ?? terms.location.city,
		salaryMin: salary?.min ?? null,
		salaryMax: salary?.max ?? null,
		salaryCurrency: salary?.currency ?? null,
		salaryPeriod: salary?.period ?? null,
		salaryTaxBase: salary?.tax_base ?? null,
		externalOrg: { name: leadOrg.name, ...(inn === undefined ? {} : { inn }), source_org_ids: sourceOrgIds }
	};
	const revised = contentOf(current) !== contentOf(next);
	const textCheck = checkVacancyText({ title: next.title, description: next.description });
	const status = externalStatus(postings, textCheck, input.now, input.staleAfterDays);
	const [row] = await tx
		.update(vacancies)
		.set({
			...next,
			termsConflict: termsConflict(postings),
			textCheck,
			status,
			closedAt: status === 'closed' ? (current.closedAt ?? input.now) : null,
			// The pool was counted at the previous revision: until `match.refresh` of this one it is «being counted».
			...(revised ? { revision: sql`${vacancies.revision} + 1`, poolCount: null, poolCountedAt: null } : {})
		})
		.where(eq(vacancies.id, vacancyId))
		.returning({ revision: vacancies.revision });
	if (!row) throw new Error('vacancy disappeared while locked');
	return { vacancyId, revision: row.revision, revised, status, statusChanged: status !== current.status };
}

/**
 * Moves external vacancies between `active` and `stale` by the last confirmation of their live postings; postings
 * themselves do not change. Returns how many moved.
 */
export async function sweepStaleness(tx: Transaction, now: Date, staleAfterDays: number | null): Promise<number> {
	if (staleAfterDays === null) return 0;
	// Raw SQL parameters carry no column type: the moment is passed as text and cast.
	const threshold = sql`${new Date(now.getTime() - staleAfterDays * 86_400_000).toISOString()}::timestamptz`;
	const confirmed = sql`(select max(${vacancyPostings.lastCheckedAt}) from ${vacancyPostings}
		where ${vacancyPostings.vacancyId} = ${vacancies.id} and ${vacancyPostings.freshness} <> 'gone')`;
	const toStale = await tx
		.update(vacancies)
		.set({ status: 'stale' })
		.where(and(eq(vacancies.origin, 'external'), eq(vacancies.status, 'active'), sql`${confirmed} < ${threshold}`))
		.returning({ id: vacancies.id });
	const toActive = await tx
		.update(vacancies)
		.set({ status: 'active' })
		.where(and(eq(vacancies.origin, 'external'), eq(vacancies.status, 'stale'), sql`${confirmed} >= ${threshold}`))
		.returning({ id: vacancies.id });
	return toStale.length + toActive.length;
}
