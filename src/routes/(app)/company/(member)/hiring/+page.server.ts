import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { listOwnVacancies } from '$lib/server/employer/vacancies';
import { getHiringProcess } from '$lib/server/hiring/process';
import { invitationDeps } from '$lib/server/invitations/deps';
import { getInvitation, listInvitations } from '$lib/server/invitations/read';
import type { PageServerLoad } from './$types';

/** Hiring processes of the company: one per invitation accepted at least once, with the stages both sides reported. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const deps = invitationDeps();
	try {
		const [invitations, vacancies] = await Promise.all([
			listInvitations(deps, subject, 'company'),
			listOwnVacancies(db(), membership.companyId, new Date())
		]);
		const titles = new Map(vacancies.map((vacancy) => [vacancy.id, vacancy.title]));
		const processes = [];
		for (const summary of invitations) {
			const invitation = await getInvitation(deps, subject, summary.id);
			if (invitation.hiringProcessId === null) continue;
			processes.push({
				invitationId: invitation.id,
				pseudonym: invitation.candidatePseudonym,
				vacancyTitle: titles.get(invitation.vacancyId) ?? null,
				process: await getHiringProcess(deps, subject, invitation.hiringProcessId)
			});
		}
		return { processes };
	} catch (cause) {
		pageError(event, cause);
	}
};
