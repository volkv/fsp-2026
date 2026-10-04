import { candidateRequest } from '$lib/server/candidates/http';
import { pageError } from '$lib/server/http/page';
import { candidateInvitationList } from '$lib/server/candidates/invitations';
import { invitationDeps } from '$lib/server/invitations/deps';
import type { PageServerLoad } from './$types';

/** Invitations companies sent the candidate, newest first, with the status and the deadline of the current terms. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		return { invitations: await candidateInvitationList(invitationDeps(), subject) };
	} catch (cause) {
		pageError(event, cause);
	}
};
