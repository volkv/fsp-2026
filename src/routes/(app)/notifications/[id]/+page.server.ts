import { error, redirect } from '@sveltejs/kit';
import { requireSession } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { openNotification } from '$lib/server/notifications/inbox';
import type { PageServerLoad } from './$types';

/**
 * The link of every channel: marks the notification read and leads to its object with the recipient's access checked
 * now — the candidate to their invitation, a member of the company to the company's invitation; an operator's decision
 * to the page where its result is read (a moderation decision — to the company's vacancy); a notice about the
 * candidate's own profile (majority, removal for inactivity, the verified birth date, the representative's revocation)
 * — to the consents; an annulled attempt — to the attempt; the deadline of an objection — an operator to the queue of
 * objections, an admin to the staff management.
 */
export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	event.setHeaders({ 'cache-control': 'private, no-store' });
	const opened = await openNotification(db(), session.userId, event.params.id, new Date());
	if (!opened) error(404, { message: 'Уведомление не найдено', requestId: event.locals.requestId });
	const { target } = opened;
	if (target.kind === 'candidate_invitation') redirect(303, `/me/invitations/${target.invitationId}`);
	if (target.kind === 'company_invitation') redirect(303, `/company/invitations/${target.invitationId}`);
	if (target.kind === 'company_profile') redirect(303, '/company/profile');
	if (target.kind === 'company_vacancy') redirect(303, `/company/vacancies/${target.vacancyId}`);
	if (target.kind === 'candidate_category') redirect(303, '/me/category');
	if (target.kind === 'candidate_visibility') redirect(303, '/me/visibility');
	if (target.kind === 'candidate_representative') redirect(303, '/onboarding');
	if (target.kind === 'candidate_consents') redirect(303, '/me/consents');
	if (target.kind === 'candidate_attempt') redirect(303, `/me/tests/attempts/${target.attemptId}`);
	if (target.kind === 'operator_objections') redirect(303, '/operator/objections');
	if (target.kind === 'admin_staff') redirect(303, '/admin/staff');
	return { title: opened.title };
};
