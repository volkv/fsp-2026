import { companyAdmission } from '$lib/server/access/permissions';
import { CATEGORY_OPTIONS } from '$lib/server/categories/labels';
import { db } from '$lib/server/db';
import { catalogView } from '$lib/server/employer/catalog';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { matchingDeps } from '$lib/server/matching/deps';
import { regionReference } from '$lib/server/regions';
import type { PageServerLoad } from './$types';

/**
 * The catalog without a vacancy: search by words and meaning with the category filters. Matches and invitations are
 * made for a vacancy, so the page leads to the vacancies of the company.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const [vocabulary, regions] = await Promise.all([currentVocabulary(database), regionReference()]);
	const base = {
		labels: labelsOf(vocabulary),
		filters: {
			specializations: CATEGORY_OPTIONS.specializations,
			grades: CATEGORY_OPTIONS.grades,
			formats: vocabulary.terms.work_format,
			regions: regions.regions
		},
		vacancies: await searchableVacancies(database, membership.companyId)
	};
	if (!companyAdmission(membership.companyStatus).admitted) return { ...base, catalog: null };
	return {
		...base,
		catalog: await catalogView(matchingDeps(), subject, meta, event.url, undefined, event.request.signal)
	};
};
