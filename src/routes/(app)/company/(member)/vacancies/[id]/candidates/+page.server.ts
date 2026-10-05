import { CATEGORY_OPTIONS } from '$lib/server/categories/labels';
import { db } from '$lib/server/db';
import { catalogView } from '$lib/server/employer/catalog';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf, vocabularyOf } from '$lib/server/employer/vocabulary';
import { matchingDeps } from '$lib/server/matching/deps';
import { regionReference } from '$lib/server/regions';
import type { PageServerLoad } from './$types';

/** Candidates for a vacancy: ranked by the match with it, with the decomposition and the comparison of chosen ones. */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	try {
		const vacancy = await getOwnVacancy(database, membership.companyId, event.params.id, new Date());
		const [written, current, regions] = await Promise.all([
			vocabularyOf(database, vacancy.taxonomyVersionId),
			currentVocabulary(database),
			regionReference()
		]);
		const labels = labelsOf(written);
		const base = {
			vacancy: {
				id: vacancy.id,
				title: vacancy.title,
				status: vacancy.status,
				roleKey: vacancy.roleKey,
				gradeMin: vacancy.gradeMin,
				gradeMax: vacancy.gradeMax,
				requiredSkillKeys: vacancy.requiredSkillKeys,
				salary: vacancy.salary,
				pool: vacancy.pool
			},
			labels,
			filters: {
				specializations: CATEGORY_OPTIONS.specializations,
				grades: CATEGORY_OPTIONS.grades,
				formats: current.terms.work_format,
				regions: regions.regions
			}
		};
		if (vacancy.status === 'closed') return { ...base, catalog: null };
		// The catalog is open to a verified company only (domain 4.2); the page says why instead of an error.
		if (membership.companyStatus !== 'verified') return { ...base, catalog: null };
		return {
			...base,
			catalog: await catalogView(matchingDeps(), subject, meta, event.url, vacancy.id, event.request.signal)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
