import { companyHeader } from '$lib/server/employer/company';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { db } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

/** The company of the signed-in member, read on every request: a suspension or a removal shows at once. */
export const load: LayoutServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	return {
		company: await companyHeader(db(), membership.companyId),
		role: membership.role
	};
};
