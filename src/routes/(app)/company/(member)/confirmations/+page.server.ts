import { companyRequests } from '$lib/server/confirmations/requests';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

/** The company's requests of a confirmation with their results (domain 13.11), newest first. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	try {
		return { requests: await companyRequests(contactPageDeps(), subject, null), names: catalogNames() };
	} catch (cause) {
		pageError(event, cause);
	}
};
