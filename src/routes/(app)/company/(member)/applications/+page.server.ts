import { companyApplications } from '$lib/server/applications/service';
import { contactPageDeps } from '$lib/server/contact/page';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

/** Applications of candidates to the company's own vacancies (domain 13.5), by pseudonym, newest first. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	try {
		return { applications: await companyApplications(contactPageDeps(), subject) };
	} catch (cause) {
		pageError(event, cause);
	}
};
