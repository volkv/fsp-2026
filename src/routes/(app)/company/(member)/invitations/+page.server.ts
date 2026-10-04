import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { listOwnVacancies } from '$lib/server/employer/vacancies';
import { invitationDeps } from '$lib/server/invitations/deps';
import { listInvitations } from '$lib/server/invitations/read';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	try {
		const [invitations, vacancies] = await Promise.all([
			listInvitations(invitationDeps(), subject, 'company'),
			listOwnVacancies(db(), membership.companyId, new Date())
		]);
		const titles = Object.fromEntries(vacancies.map((vacancy) => [vacancy.id, vacancy.title]));
		return {
			invitations: invitations.map((invitation) => ({
				...invitation,
				vacancyTitle: titles[invitation.vacancyId] ?? null
			}))
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
