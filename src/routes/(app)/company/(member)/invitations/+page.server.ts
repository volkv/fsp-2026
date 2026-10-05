import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { invitationDeps } from '$lib/server/invitations/deps';
import { listInvitations } from '$lib/server/invitations/read';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	try {
		return { invitations: await listInvitations(invitationDeps(), subject, 'company') };
	} catch (cause) {
		pageError(event, cause);
	}
};
