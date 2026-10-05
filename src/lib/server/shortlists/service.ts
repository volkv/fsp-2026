// Shortlists of hiring needs (docs/domain.md, section 13.10): a need gives a shortlist of candidates of its categories,
// ranked by the fit to the need and the strength of the confirmed profile, each with 3–5 reasons and their sources.
// A shortlist keeps the query of every step and the candidates the company marked, never cards: every opening ranks
// anew and shows a candidate only through `canShow` at that moment. A refinement is a new step; the shortlist and its
// marks are not lost — a marked candidate the new step does not admit is shown as «не проходит новое условие», one the
// company no longer sees as «кандидат больше недоступен», without data. Only members of the company see its shortlists.
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { can, companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import {
	GRADE_KEYS,
	gradeOrdinal,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { auditActorOf } from '$lib/server/companies/context';
import { admissionRefusal, requireAdmission } from '$lib/server/companies/gate';
import type { Database, Executor } from '$lib/server/db';
import { hiringNeeds, shortlistMarks, shortlistRevisions, shortlists, sourceFacts } from '$lib/server/db/schema';
import { findInCatalog } from '$lib/server/employer/card';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import type { RequestMeta } from '$lib/server/invitations/deps';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { loadCandidateSnapshots } from '$lib/server/matching/evidence';
import { paginate, queryFingerprint, type PageRequest } from '$lib/server/matching/page';
import {
	rankCandidates,
	visibleAmong,
	type CandidateSearchItem,
	type CompanyNeedMatch,
	type SearchMode
} from '$lib/server/matching/search';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { parseNeedForm, type NeedForm } from '$lib/server/needs/form';
import {
	countCategories,
	needCategoriesOf,
	recommendCategories,
	type CategoryBasis,
	type CategoryCounts,
	type RecommendedCategory
} from '$lib/server/needs/recommend';
import type { SmallCell } from '$lib/server/operator/small-numbers';
import { regionReference } from '$lib/server/regions';
import type { ShowExtra } from '$lib/server/visibility/can-show';
import { offerFit, salaryAnswers, type OfferFit, type SalaryAnswer } from './cohort';
import {
	applyChange,
	categoryPairSchema,
	diffQueries,
	MAX_CATEGORIES,
	searchOf,
	shortlistChangeSchema,
	shortlistQuerySchema,
	whatIfQuery,
	whatIfSchema,
	type CategoryPair,
	type QueryDiff,
	type ShortlistQuery,
	type WhatIf
} from './query';
import { z } from 'zod';

export type ShortlistDeps = MatchingDeps & { db: Database };

const NOTE_MAX = 500;
/** The top of a shortlist the metrics of exposure are counted on. */
const TOP = 10;

const invalid = (details: ErrorDetail[]) => new ApiError('validation_failed', { details });

/** The active membership of an admitted company the shortlists belong to (the permission of needs). */
function memberCompany(subject: AccessSubject): { companyId: string; memberId: string } {
	const membership = subject.membership;
	if (subject.userId === null) throw new ApiError('unauthenticated');
	if (membership?.status !== 'active') throw new ApiError('forbidden');
	const admission = companyAdmission(membership.companyStatus);
	if (!admission.admitted) throw admissionRefusal(admission.reason);
	if (!can(subject, 'need.manage', { companyId: membership.companyId }).allowed) throw new ApiError('forbidden');
	return { companyId: membership.companyId, memberId: membership.memberId };
}

function zodDetails(error: z.ZodError, prefix: string): ErrorDetail[] {
	return error.issues.map((issue) => ({
		path: [prefix, ...issue.path].filter((part) => part !== '').join('.'),
		code: issue.code,
		message: issue.message
	}));
}

async function ownShortlist(executor: Executor, companyId: string, shortlistId: string, forUpdate = false) {
	const query = executor
		.select()
		.from(shortlists)
		.where(and(eq(shortlists.id, shortlistId), eq(shortlists.companyId, companyId)));
	const [row] = forUpdate ? await query.for('update') : await query;
	// Another company's shortlist is not known to the member (contracts 5.3).
	if (!row) throw new ApiError('not_found');
	return row;
}

interface Revision {
	seq: number;
	query: ShortlistQuery;
	change: QueryDiff;
	createdAt: Date;
}

function revisionOf(shortlistId: string, row: typeof shortlistRevisions.$inferSelect): Revision {
	const parsed = shortlistQuerySchema.safeParse(row.query);
	if (!parsed.success) throw new Error(`step ${row.seq} of shortlist ${shortlistId} has a malformed query`);
	return { seq: row.seq, query: parsed.data, change: row.change as QueryDiff, createdAt: row.createdAt };
}

async function revisions(executor: Executor, shortlistId: string): Promise<Revision[]> {
	const rows = await executor
		.select()
		.from(shortlistRevisions)
		.where(eq(shortlistRevisions.shortlistId, shortlistId))
		.orderBy(shortlistRevisions.seq);
	return rows.map((row) => revisionOf(shortlistId, row));
}

/** Categories a refinement or a new shortlist names must be open (domain 10.5). */
async function checkOpen(executor: Executor, categories: readonly CategoryPair[], path: string): Promise<void> {
	const open = await openSpecializations(executor);
	for (const [index, category] of categories.entries()) {
		if (!open.has(category.specialization)) {
			throw new ApiError('policy_violation', {
				details: [
					{
						path: `${path}.${index}.specialization`,
						code: 'specialization_closed',
						message: 'Специализация закрыта: её тест ещё не выпущен или выключен'
					}
				]
			});
		}
	}
}

/**
 * The categories of a new shortlist by default: the pair of the form, or the specializations of its role. Neighbouring
 * grades and suggestions by skills are offered on the need's page, never taken by default: a need whose role no test
 * checks gets no categories rather than the categories of another role.
 */
export function defaultCategories(form: ShortlistQuery['form'], open: ReadonlySet<SpecializationKey>): CategoryPair[] {
	const own = recommendCategories(form, open).filter((c) => c.basis === 'form' || c.basis === 'role');
	return own.slice(0, MAX_CATEGORIES).map(({ specialization, grade }) => ({ specialization, grade }));
}

export interface ShortlistCreated {
	id: string;
	revision: number;
}

/** A shortlist of the subject's need: the first step takes the need's form and the categories chosen or recommended. */
export async function createShortlist(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	needId: string,
	input: { categories?: unknown }
): Promise<ShortlistCreated> {
	const member = memberCompany(subject);
	return deps.db.transaction(async (tx) => {
		await requireAdmission(tx, member.companyId, { forUpdate: true });
		const [need] = await tx
			.select()
			.from(hiringNeeds)
			.where(and(eq(hiringNeeds.id, needId), eq(hiringNeeds.companyId, member.companyId)));
		if (!need) throw new ApiError('not_found');
		if (need.status === 'closed') {
			throw new ApiError('conflict', { details: [{ code: 'need_closed', message: 'Потребность закрыта' }] });
		}
		const form = parseNeedForm(need.id, need.form);
		let categories: CategoryPair[];
		if (input.categories === undefined) {
			// A need without a category of its own gives an empty shortlist that says why (`coverage`), not an error: the
			// employer adds the suggested categories as a refinement.
			categories = defaultCategories(form, await openSpecializations(tx));
		} else {
			const parsed = z.array(categoryPairSchema).min(1).max(MAX_CATEGORIES).safeParse(input.categories);
			if (!parsed.success) throw invalid(zodDetails(parsed.error, 'categories'));
			categories = parsed.data;
			await checkOpen(tx, categories, 'categories');
		}
		const query = shortlistQuerySchema.parse({
			form,
			categories,
			filters: { fsp_only: false, work_formats: [], confirmed_skill_keys: [] }
		});
		const [shortlist] = await tx
			.insert(shortlists)
			.values({ companyId: member.companyId, needId: need.id, createdByMemberId: member.memberId, status: 'open' })
			.returning({ id: shortlists.id });
		if (!shortlist) throw new Error('shortlist not inserted');
		await tx.insert(shortlistRevisions).values({
			shortlistId: shortlist.id,
			seq: 1,
			query,
			change: {},
			createdByMemberId: member.memberId
		});
		await recordAuditEvent(tx, {
			action: 'shortlist.created',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlist.id },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { need_id: need.id, categories: categories.map((c) => `${c.specialization}:${c.grade}`) }
		});
		return { id: shortlist.id, revision: 1 };
	});
}

/** A refinement: a new step from the current one. The marks stay; a change that changes nothing is refused. */
export async function reviseShortlist(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	shortlistId: string,
	rawChange: unknown
): Promise<{ revision: number; change: QueryDiff }> {
	const member = memberCompany(subject);
	const parsed = shortlistChangeSchema.safeParse(rawChange);
	if (!parsed.success) throw invalid(zodDetails(parsed.error, 'change'));
	const change = parsed.data;
	if (change.categories) await checkOpen(deps.db, change.categories, 'change.categories');
	if (change.region_code && !(await regionReference()).has(change.region_code)) {
		throw invalid([{ path: 'change.region_code', code: 'unknown', message: 'Неизвестный регион' }]);
	}
	return deps.db.transaction(async (tx) => {
		await requireAdmission(tx, member.companyId, { forUpdate: true });
		const shortlist = await ownShortlist(tx, member.companyId, shortlistId, true);
		if (shortlist.status !== 'open') {
			throw new ApiError('conflict', { details: [{ code: 'shortlist_archived', message: 'Подборка в архиве' }] });
		}
		const steps = await revisions(tx, shortlistId);
		const current = steps.at(-1);
		if (!current) throw new Error(`shortlist ${shortlistId} has no steps`);
		const next = shortlistQuerySchema.parse(applyChange(current.query, change));
		const diff = diffQueries(current.query, next);
		if (Object.keys(diff).length === 0) {
			throw invalid([{ path: 'change', code: 'no_change', message: 'Уточнение ничего не меняет' }]);
		}
		const seq = current.seq + 1;
		await tx
			.insert(shortlistRevisions)
			.values({ shortlistId, seq, query: next, change: diff, createdByMemberId: member.memberId });
		await recordAuditEvent(tx, {
			action: 'shortlist.revised',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlistId },
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { seq, fields: Object.keys(diff) }
		});
		return { revision: seq, change: diff };
	});
}

export interface ShortlistItem {
	/** Server-side key for the card; never sent to the company. */
	candidateId: string;
	pseudonym: string;
	extras: ShowExtra[];
	needMatch: CompanyNeedMatch;
	offerFit: OfferFit;
	mark: { note: string | null; markedAt: Date } | null;
	hasFsp: boolean;
}

export interface MarkedCandidate {
	/** `null` for a candidate the company no longer sees: no data at all. */
	pseudonym: string | null;
	/** Server-side key of a visible one; `null` for an unavailable one. */
	candidateId: string | null;
	state: 'in_results' | 'not_matching' | 'unavailable';
	/** Position in the current step, for one in the results. */
	position: number | null;
	note: string | null;
	markedAt: Date;
}

export interface ExposureShare {
	withoutFsp: number;
	of: number;
}

/**
 * What a shortlist says of its categories (domain 13.10): where the categories of the need come from and, for a need
 * without one of its own, why and what is suggested by its skills; the neighbouring grades with candidates the step does
 * not take — a deliberate widening; the requirements outside the taxonomy no evidence covers.
 */
export interface ShortlistCoverage {
	basis: CategoryBasis;
	roleKey: string | null;
	/** Specializations of the form or the role that are closed now. */
	closed: SpecializationKey[];
	/** For a step without categories: categories whose blocks confirm required skills of the need. */
	suggestions: RecommendedCategory[];
	/** Grades next to the step's grades of each of its specializations, with the candidates the step does not show. */
	neighbours: (CategoryPair & { candidates: SmallCell; direction: 'below' | 'above' })[];
	otherRequirements: { name: string; requirement: 'required' | 'nice' }[];
}

/** Candidates of the whole ranking by the group of coverage of the required skills. */
export interface CoverageGroups {
	covers: number;
	gaps: number;
}

export interface ShortlistView {
	id: string;
	needId: string;
	needText: string | null;
	status: 'open' | 'archived';
	createdAt: Date;
	revision: Revision;
	latestSeq: number;
	history: { seq: number; change: QueryDiff; createdAt: Date }[];
	items: ShortlistItem[];
	nextCursor: string | null;
	total: number;
	marked: MarkedCandidate[];
	/** The range of the need against the cohorts of the categories; `null` — the need states no range. */
	salary: SalaryAnswer[] | null;
	/** Candidates without FSP results in the top ten against their share in the whole result (contracts 11.2). */
	exposure: { top: ExposureShare; pool: ExposureShare };
	mode: SearchMode;
	coverage: ShortlistCoverage;
	groups: CoverageGroups;
}

/** Candidates of the ids with an FSP result in force. */
async function withFsp(executor: Executor, candidateIds: readonly string[]): Promise<Set<string>> {
	if (candidateIds.length === 0) return new Set();
	const rows = await executor
		.selectDistinct({ id: sourceFacts.candidateId })
		.from(sourceFacts)
		.where(
			and(
				inArray(sourceFacts.candidateId, [...candidateIds]),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.status, 'active')
			)
		);
	return new Set(rows.map((row) => row.id));
}

/** The ranked candidates of a step, each through `canShow` now; a step without categories ranks nobody. */
export async function rankStep(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlist: { id: string; needText: string | null },
	revision: Pick<Revision, 'seq' | 'query'>,
	signal?: AbortSignal
): Promise<{ ranked: CandidateSearchItem[]; mode: SearchMode }> {
	if (revision.query.categories.length === 0) {
		return {
			ranked: [],
			mode: {
				searchMode: 'fts_only',
				embeddingSpaceId: null,
				semanticReason: 'no_categories',
				reranker: { status: 'not_applicable', reason: null }
			}
		};
	}
	const search = searchOf(revision.query, shortlist.needText, { id: shortlist.id, revision: revision.seq });
	return rankCandidates(deps, subject, { need: search.need, filters: search.filters }, signal);
}

/** The grades next to the step's grades of each of its specializations that the step does not take. */
function neighbourCategories(categories: readonly CategoryPair[]): (CategoryPair & { direction: 'below' | 'above' })[] {
	const taken = new Set(categories.map((c) => `${c.specialization}:${c.grade}`));
	const result: (CategoryPair & { direction: 'below' | 'above' })[] = [];
	for (const specialization of [...new Set(categories.map((c) => c.specialization))]) {
		const ordinals = categories.filter((c) => c.specialization === specialization).map((c) => gradeOrdinal(c.grade));
		const below = GRADE_KEYS.find((key) => gradeOrdinal(key) === Math.min(...ordinals) - 1);
		const above = GRADE_KEYS.find((key) => gradeOrdinal(key) === Math.max(...ordinals) + 1);
		for (const [grade, direction] of [
			[below, 'below'],
			[above, 'above']
		] as const) {
			if (grade !== undefined && !taken.has(`${specialization}:${grade}`)) {
				result.push({ specialization, grade, direction });
			}
		}
	}
	return result;
}

/** What the shortlist says of its categories at a step; `shown` — candidates of the step's ranking. */
async function coverageOf(
	deps: ShortlistDeps,
	subject: AccessSubject,
	query: ShortlistQuery,
	shown: ReadonlySet<string>
): Promise<ShortlistCoverage> {
	const form: NeedForm = query.form;
	const own = needCategoriesOf(form, await openSpecializations(deps.db));
	const counted: (CategoryPair & CategoryCounts & { direction: 'below' | 'above' })[] = await countCategories(
		deps.db,
		subject,
		form,
		neighbourCategories(query.categories),
		deps.now(),
		shown
	);
	return {
		basis: own.basis,
		roleKey: form.role_key ?? null,
		closed: own.closed,
		suggestions: query.categories.length === 0 ? own.categories.filter((category) => category.basis === 'skills') : [],
		neighbours: counted
			.filter(({ candidates }) => !('value' in candidates) || candidates.value > 0)
			.map(({ specialization, grade, direction, candidates }) => ({ specialization, grade, direction, candidates })),
		otherRequirements: [
			...(form.other_skills ?? []).map((name) => ({ name, requirement: 'required' as const })),
			...(form.other_nice_skills ?? []).map((name) => ({ name, requirement: 'nice' as const }))
		]
	};
}

function needMatchOf(item: CandidateSearchItem): CompanyNeedMatch {
	if (!item.needMatch) throw new Error('a shortlist ranking has no fit to the need');
	return item.needMatch;
}

/**
 * The shortlist at a step — the latest by default — ranked now: a page of candidates with their reasons and the second
 * axis, the marked candidates with their state, the history of steps, the range against the cohorts.
 */
export async function openShortlist(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlistId: string,
	options: PageRequest & { revision?: number; signal?: AbortSignal } = {}
): Promise<ShortlistView> {
	const member = memberCompany(subject);
	const shortlist = await ownShortlist(deps.db, member.companyId, shortlistId);
	const [need] = await deps.db
		.select({ text: hiringNeeds.text })
		.from(hiringNeeds)
		.where(eq(hiringNeeds.id, shortlist.needId));
	if (!need) throw new Error(`need of shortlist ${shortlistId} is missing`);
	const steps = await revisions(deps.db, shortlistId);
	const latest = steps.at(-1);
	if (!latest) throw new Error(`shortlist ${shortlistId} has no steps`);
	const revision = options.revision === undefined ? latest : steps.find((step) => step.seq === options.revision);
	if (!revision) throw new ApiError('not_found');

	const { ranked, mode } = await rankStep(
		deps,
		subject,
		{ id: shortlistId, needText: need.text },
		revision,
		options.signal
	);
	const page = paginate(
		ranked,
		{
			...(options.limit === undefined ? {} : { limit: options.limit }),
			...(options.cursor === undefined ? {} : { cursor: options.cursor })
		},
		queryFingerprint({ shortlistId, seq: revision.seq })
	);

	const marks = await deps.db
		.select()
		.from(shortlistMarks)
		.where(and(eq(shortlistMarks.shortlistId, shortlistId), isNull(shortlistMarks.unmarkedAt)))
		.orderBy(desc(shortlistMarks.markedAt));
	const markOf = new Map(marks.map((mark) => [mark.candidateId, mark]));
	const position = new Map(ranked.map((item, index) => [item.candidateId, index + 1]));
	const outside = marks.filter((mark) => !position.has(mark.candidateId)).map((mark) => mark.candidateId);
	const stillVisible = await visibleAmong(deps, subject, outside);
	const marked: MarkedCandidate[] = marks.map((mark) => {
		const at = position.get(mark.candidateId);
		if (at !== undefined) {
			const item = ranked[at - 1];
			return {
				pseudonym: item?.pseudonym ?? null,
				candidateId: mark.candidateId,
				state: 'in_results',
				position: at,
				note: mark.note,
				markedAt: mark.markedAt
			};
		}
		const pseudonym = stillVisible.get(mark.candidateId);
		return pseudonym === undefined
			? {
					pseudonym: null,
					candidateId: null,
					state: 'unavailable',
					position: null,
					note: null,
					markedAt: mark.markedAt
				}
			: {
					pseudonym,
					candidateId: mark.candidateId,
					state: 'not_matching',
					position: null,
					note: mark.note,
					markedAt: mark.markedAt
				};
	});

	const form = revision.query.form;
	const snapshots = await loadCandidateSnapshots(
		deps.db,
		page.items.map((item) => item.candidateId)
	);
	const fsp = await withFsp(
		deps.db,
		ranked.map((item) => item.candidateId)
	);
	const items: ShortlistItem[] = page.items.map((item) => {
		const preferences = snapshots.get(item.candidateId)?.preferences ?? {};
		const mark = markOf.get(item.candidateId);
		return {
			candidateId: item.candidateId,
			pseudonym: item.pseudonym,
			extras: item.extras,
			needMatch: needMatchOf(item),
			offerFit: offerFit(
				{ workFormat: form.work_format ?? null, regionCode: form.region_code ?? null },
				{
					workFormats: preferences.work_formats ?? [],
					regionCode: preferences.region_code ?? null,
					relocation: preferences.relocation ?? null
				}
			),
			mark: mark ? { note: mark.note, markedAt: mark.markedAt } : null,
			hasFsp: fsp.has(item.candidateId)
		};
	});
	const share = (list: readonly CandidateSearchItem[]): ExposureShare => ({
		withoutFsp: list.filter((item) => !fsp.has(item.candidateId)).length,
		of: list.length
	});
	const salary = form.salary
		? await salaryAnswers(
				deps,
				subject,
				member.companyId,
				revision.query.categories,
				{ max: form.salary.max, tax_base: form.salary.tax_base },
				deps.now()
			)
		: null;
	return {
		id: shortlist.id,
		needId: shortlist.needId,
		needText: need.text,
		status: shortlist.status,
		createdAt: shortlist.createdAt,
		revision,
		latestSeq: latest.seq,
		history: steps.map((step) => ({ seq: step.seq, change: step.change, createdAt: step.createdAt })),
		items,
		nextCursor: page.nextCursor,
		total: ranked.length,
		marked,
		salary,
		exposure: { top: share(ranked.slice(0, TOP)), pool: share(ranked) },
		mode,
		coverage: await coverageOf(deps, subject, revision.query, new Set(ranked.map((item) => item.candidateId))),
		groups: {
			covers: ranked.filter((item) => needMatchOf(item).coverage.group === 'covers').length,
			gaps: ranked.filter((item) => needMatchOf(item).coverage.group === 'gaps').length
		}
	};
}

/** The shortlists of a need of the subject's company, newest first. */
export async function listShortlists(
	deps: Pick<ShortlistDeps, 'db'>,
	subject: AccessSubject,
	needId: string
): Promise<{ id: string; status: 'open' | 'archived'; createdAt: Date; steps: number }[]> {
	const member = memberCompany(subject);
	const rows = await deps.db
		.select({ id: shortlists.id, status: shortlists.status, createdAt: shortlists.createdAt })
		.from(shortlists)
		.where(and(eq(shortlists.companyId, member.companyId), eq(shortlists.needId, needId)))
		.orderBy(desc(shortlists.createdAt), desc(shortlists.id));
	const result = [];
	for (const row of rows) result.push({ ...row, steps: (await revisions(deps.db, row.id)).length });
	return result;
}

/** Marks a candidate the company sees now, with an optional note; marking again changes the note. */
export async function markCandidate(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	shortlistId: string,
	pseudonym: string,
	rawNote: string | null
): Promise<{ markedAt: Date; note: string | null }> {
	const member = memberCompany(subject);
	const note = rawNote?.trim() ? rawNote.trim() : null;
	if (note !== null && note.length > NOTE_MAX) {
		throw invalid([{ path: 'note', code: 'too_long', message: `Заметка — не длиннее ${NOTE_MAX} символов` }]);
	}
	await ownShortlist(deps.db, member.companyId, shortlistId);
	const found = await findInCatalog(deps, subject, pseudonym, undefined);
	// A candidate the company does not see is not known to it (contracts 10.2).
	if (!found) throw new ApiError('not_found');
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		await ownShortlist(tx, member.companyId, shortlistId, true);
		await tx
			.insert(shortlistMarks)
			.values({
				shortlistId,
				candidateId: found.candidateId,
				markedByMemberId: member.memberId,
				markedAt: now,
				note
			})
			.onConflictDoUpdate({
				target: [shortlistMarks.shortlistId, shortlistMarks.candidateId],
				set: { markedByMemberId: member.memberId, markedAt: now, unmarkedAt: null, note }
			});
		await recordAuditEvent(tx, {
			action: 'shortlist.marked',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlistId },
			subjectCandidateId: found.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null
		});
		return { markedAt: now, note };
	});
}

/**
 * Takes a mark off. The candidate is named by the pseudonym of the company: a candidate it no longer sees is found among
 * the marks of the shortlist by the same pseudonym, so an unavailable mark can be taken off too.
 */
export async function unmarkCandidate(
	deps: ShortlistDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	shortlistId: string,
	pseudonym: string
): Promise<void> {
	const member = memberCompany(subject);
	await deps.db.transaction(async (tx) => {
		await ownShortlist(tx, member.companyId, shortlistId, true);
		const marks = await tx
			.select({ candidateId: shortlistMarks.candidateId })
			.from(shortlistMarks)
			.where(and(eq(shortlistMarks.shortlistId, shortlistId), isNull(shortlistMarks.unmarkedAt)));
		const mark = marks.find((row) => deps.pseudonym(row.candidateId, member.companyId) === pseudonym);
		if (!mark) throw new ApiError('not_found');
		await tx
			.update(shortlistMarks)
			.set({ unmarkedAt: deps.now() })
			.where(and(eq(shortlistMarks.shortlistId, shortlistId), eq(shortlistMarks.candidateId, mark.candidateId)));
		await recordAuditEvent(tx, {
			action: 'shortlist.unmarked',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'shortlist', id: shortlistId },
			subjectCandidateId: mark.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null
		});
	});
}

/** Why a candidate entered or left under a change: only what the company sees on the card, never hidden expectations. */
export type WhatIfReason =
	| { code: 'format_accepted' | 'format_not_accepted' | 'formats_unknown'; format: string }
	| { code: 'category'; specialization: SpecializationKey; grade: GradeKey }
	| { code: 'skill_confirmed' | 'skill_not_confirmed'; skill_key: string }
	| { code: 'fsp_present' | 'fsp_absent' }
	| { code: 'other_condition' };

export interface WhatIfCandidate {
	candidateId: string;
	pseudonym: string;
	reason: WhatIfReason;
	/** Position in the ranking after the change (entered) or before it (left). */
	position: number;
}

export interface WhatIfView {
	change: WhatIf;
	entered: WhatIfCandidate[];
	left: WhatIfCandidate[];
	before: number;
	after: number;
	/** For a change of the range: the cohorts before and after, by intervals only. */
	salary: { before: SalaryAnswer[]; after: SalaryAnswer[] } | null;
}

/**
 * «What if»: one condition changes and the answer names who becomes available and who drops out, and why — by what the
 * company sees on the card. A change of the range is answered only by the cohorts of the categories: who it would suit
 * by their hidden expectations is never said by name.
 */
export async function whatIf(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlistId: string,
	rawChange: unknown,
	signal?: AbortSignal
): Promise<WhatIfView> {
	const member = memberCompany(subject);
	const parsed = whatIfSchema.safeParse(rawChange);
	if (!parsed.success) {
		const many = rawChange !== null && typeof rawChange === 'object' && Object.keys(rawChange).length > 1;
		throw invalid(
			many
				? [{ path: 'change', code: 'one_condition', message: '«Что если» меняет ровно одно условие' }]
				: zodDetails(parsed.error, 'change')
		);
	}
	const change = parsed.data;
	const shortlist = await ownShortlist(deps.db, member.companyId, shortlistId);
	const [need] = await deps.db
		.select({ text: hiringNeeds.text })
		.from(hiringNeeds)
		.where(eq(hiringNeeds.id, shortlist.needId));
	if (!need) throw new Error(`need of shortlist ${shortlistId} is missing`);
	const current = (await revisions(deps.db, shortlistId)).at(-1);
	if (!current) throw new Error(`shortlist ${shortlistId} has no steps`);

	if ('salary' in change) {
		if (change.salary.min > change.salary.max) {
			throw invalid([{ path: 'change.salary.max', code: 'invalid', message: 'Верхняя граница ниже нижней' }]);
		}
		const categories = current.query.categories;
		const now = deps.now();
		const before = current.query.form.salary;
		const count = (await rankStep(deps, subject, { id: shortlistId, needText: need.text }, current, signal)).ranked
			.length;
		return {
			change,
			entered: [],
			left: [],
			before: count,
			after: count,
			salary: {
				before: before ? await salaryAnswers(deps, subject, member.companyId, categories, before, now) : [],
				after: await salaryAnswers(deps, subject, member.companyId, categories, change.salary, now)
			}
		};
	}

	const shortlistRef = { id: shortlistId, needText: need.text };
	const before = (await rankStep(deps, subject, shortlistRef, current, signal)).ranked;
	// The changed query is not stored: the ranking key holds the query itself, so it is never confused with the step.
	const changed = shortlistQuerySchema.parse(whatIfQuery(current.query, change));
	const after = (await rankStep(deps, subject, shortlistRef, { seq: current.seq, query: changed }, signal)).ranked;
	const beforeIds = new Set(before.map((item) => item.candidateId));
	const afterIds = new Set(after.map((item) => item.candidateId));
	const entered = after.flatMap((item, index) =>
		beforeIds.has(item.candidateId) ? [] : [{ item, position: index + 1 }]
	);
	const left = before.flatMap((item, index) => (afterIds.has(item.candidateId) ? [] : [{ item, position: index + 1 }]));
	const snapshots = await loadCandidateSnapshots(
		deps.db,
		[...entered, ...left].map((entry) => entry.item.candidateId)
	);
	const fsp = await withFsp(
		deps.db,
		[...entered, ...left].map((entry) => entry.item.candidateId)
	);

	const reasonOf = (candidateId: string, joined: boolean): WhatIfReason => {
		const snapshot = snapshots.get(candidateId);
		if (!snapshot) throw new Error('a changed candidate has no snapshot');
		if ('work_format' in change) {
			const format =
				change.work_format ?? current.query.filters.work_formats[0] ?? current.query.form.work_format ?? null;
			if (format === null) return { code: 'other_condition' };
			const formats = snapshot.preferences.work_formats ?? [];
			if (formats.length === 0) return { code: 'formats_unknown', format };
			return { code: formats.includes(format) ? 'format_accepted' : 'format_not_accepted', format };
		}
		if ('grade' in change) {
			const wanted = joined ? changed.categories : current.query.categories;
			const held = snapshot.confirmed.find((c) =>
				wanted.some((w) => w.specialization === c.specialization && w.grade === c.grade)
			);
			return held
				? { code: 'category', specialization: held.specialization, grade: held.grade }
				: { code: 'other_condition' };
		}
		if ('confirmed_skill' in change) {
			const key = change.confirmed_skill.skill_key;
			const confirmed = snapshot.confirmed.some((c) => c.confirmedSkillKeys.includes(key));
			return { code: confirmed ? 'skill_confirmed' : 'skill_not_confirmed', skill_key: key };
		}
		return { code: fsp.has(candidateId) ? 'fsp_present' : 'fsp_absent' };
	};
	const view = (entry: { item: CandidateSearchItem; position: number }, joined: boolean): WhatIfCandidate => ({
		candidateId: entry.item.candidateId,
		pseudonym: entry.item.pseudonym,
		reason: reasonOf(entry.item.candidateId, joined),
		position: entry.position
	});
	return {
		change,
		entered: entered.map((entry) => view(entry, true)),
		left: left.map((entry) => view(entry, false)),
		before: before.length,
		after: after.length,
		salary: null
	};
}

/** The step of a shortlist at the given number, or the latest, for pages that build on it. */
export async function shortlistStep(
	deps: Pick<ShortlistDeps, 'db'>,
	subject: AccessSubject,
	shortlistId: string
): Promise<{ shortlist: typeof shortlists.$inferSelect; step: Revision; needText: string | null }> {
	const member = memberCompany(subject);
	const shortlist = await ownShortlist(deps.db, member.companyId, shortlistId);
	const step = (await revisions(deps.db, shortlistId)).at(-1);
	if (!step) throw new Error(`shortlist ${shortlistId} has no steps`);
	const [need] = await deps.db
		.select({ text: hiringNeeds.text })
		.from(hiringNeeds)
		.where(eq(hiringNeeds.id, shortlist.needId));
	if (!need) throw new Error(`need of shortlist ${shortlistId} is missing`);
	return { shortlist, step, needText: need.text };
}

/**
 * The fit of one candidate in the latest step of a shortlist, for the offer made from it: the reasons become points of
 * «why you» (domain 13.5) and the offer names the need. `null` — the candidate is not in the shortlist now.
 */
export async function shortlistMatchOf(
	deps: ShortlistDeps,
	subject: AccessSubject,
	shortlistId: string,
	candidateId: string,
	signal?: AbortSignal
): Promise<{ needId: string; match: CompanyNeedMatch } | null> {
	const { shortlist, step, needText } = await shortlistStep(deps, subject, shortlistId);
	const { ranked } = await rankStep(deps, subject, { id: shortlist.id, needText }, step, signal);
	const item = ranked.find((entry) => entry.candidateId === candidateId);
	return item ? { needId: shortlist.needId, match: needMatchOf(item) } : null;
}
