import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { getHiringProcess } from '$lib/server/hiring/process';
import { invitationDeps } from '$lib/server/invitations/deps';
import { getInvitation, listInvitations } from '$lib/server/invitations/read';
import type { PageServerLoad } from './$types';

/** Hiring processes of the company: one per offer accepted at least once, with the stages both sides reported. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const deps = invitationDeps();
	try {
		const processes = [];
		for (const summary of await listInvitations(deps, subject, 'company')) {
			const invitation = await getInvitation(deps, subject, summary.id);
			if (invitation.hiringProcessId === null) continue;
			processes.push({
				invitationId: invitation.id,
				pseudonym: invitation.candidatePseudonym,
				title: summary.title,
				process: await getHiringProcess(deps, subject, invitation.hiringProcessId)
			});
		}
		return { processes };
	} catch (cause) {
		pageError(event, cause);
	}
};
