// Postings of external vacancies as every reader sees them (domain 13.2): each names its source with the attribution
// the terms of the source require (`terms.attribution`, «По данным Хабр Карьеры»), links the original on the site of the
// source and tells when its freshness was last checked. Pages and the API read postings from here only, so no external
// vacancy is shown without its source.
import { asc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { vacancyPostings, vacancySources } from '$lib/server/db/schema';
import { sourceTermsSchema } from './sources/definitions';

export interface PostingView {
	source: string;
	sourceName: string;
	/** What the terms of the source require every card to show. */
	attribution: string;
	/** The posting on the site of the source. */
	url: string;
	title: string;
	organizationName: string | null;
	freshness: 'active' | 'gone' | 'unknown';
	sourcePublishedAt: Date | null;
	firstFetchedAt: Date;
	lastCheckedAt: Date;
}

/** Postings of the vacancies by vacancy id, oldest first; a vacancy without postings is absent from the map. */
export async function vacancyPostingViews(
	executor: Executor,
	vacancyIds: readonly string[]
): Promise<Map<string, PostingView[]>> {
	const byVacancy = new Map<string, PostingView[]>();
	if (vacancyIds.length === 0) return byVacancy;
	const rows = await executor
		.select({
			vacancyId: vacancyPostings.vacancyId,
			source: vacancyPostings.source,
			sourceName: vacancySources.name,
			terms: vacancySources.terms,
			url: vacancyPostings.url,
			title: vacancyPostings.title,
			organization: vacancyPostings.organization,
			freshness: vacancyPostings.freshness,
			sourcePublishedAt: vacancyPostings.sourcePublishedAt,
			firstFetchedAt: vacancyPostings.firstFetchedAt,
			lastCheckedAt: vacancyPostings.lastCheckedAt
		})
		.from(vacancyPostings)
		.innerJoin(vacancySources, eq(vacancySources.key, vacancyPostings.source))
		.where(inArray(vacancyPostings.vacancyId, [...vacancyIds]))
		.orderBy(asc(vacancyPostings.firstFetchedAt), asc(vacancyPostings.id));
	for (const { vacancyId, organization, terms, ...posting } of rows) {
		const name = (organization as { name?: unknown }).name;
		byVacancy.set(vacancyId, [
			...(byVacancy.get(vacancyId) ?? []),
			{
				...posting,
				attribution: sourceTermsSchema.parse(terms).attribution,
				organizationName: typeof name === 'string' ? name : null
			}
		]);
	}
	return byVacancy;
}

/**
 * The postings a vacancy is shown with. An external vacancy exists only through its postings, so one without them
 * would be shown without its source: that is a broken invariant, not a vacancy to show.
 */
export function shownPostings(
	vacancy: { id: string; origin: 'own' | 'external' },
	postingsOf: ReadonlyMap<string, PostingView[]>
): PostingView[] {
	const postings = postingsOf.get(vacancy.id) ?? [];
	if (vacancy.origin === 'external' && postings.length === 0) {
		throw new Error(`external vacancy ${vacancy.id} has no posting to attribute it to`);
	}
	return postings;
}
