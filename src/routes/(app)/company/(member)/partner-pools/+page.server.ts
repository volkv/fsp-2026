import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { companyPartnerships } from '$lib/server/partner-pool/pool';
import type { PageServerLoad } from './$types';

/** The competitions the company partners: a single open partnership leads straight to its pool. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	let partnerships;
	try {
		partnerships = await companyPartnerships(db(), subject, new Date());
	} catch (cause) {
		pageError(event, cause);
	}
	const [only] = partnerships;
	if (partnerships.length === 1 && only?.open) redirect(303, `/company/partner-pools/${only.id}`);
	return { partnerships };
};
