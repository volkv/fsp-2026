import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { clearSessionCookie, requestMeta, requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { db } from '$lib/server/db';
import { deletionOverview, deletionRefusalMessage } from '$lib/server/erasure/overview';
import { requestAccountDeletion } from '$lib/server/erasure/request';
import type { Actions, PageServerLoad } from './$types';

const RETURN_TO = '/account/delete';

/**
 * Deleting the account (domain 3.1, 19): what goes and what stays, then the confirmation after a fresh sign-in. A
 * candidate's deletion is also the revocation of the processing consent (`?cause=processing_revoked` when it comes
 * from the page of consents). The last owner of a company and a staff account are told what to do first.
 */
export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	event.setHeaders({ 'cache-control': 'private, no-store' });
	const overview = await deletionOverview(db(), session, new Date());
	return {
		candidate: overview.candidate,
		staff: overview.staff,
		membership: overview.membership,
		companiesWithContacts: overview.companiesWithContacts,
		cause: event.url.searchParams.get('cause') === 'processing_revoked' ? 'processing_revoked' : 'account_deleted',
		freshAuth: overview.freshAuth,
		returnTo: `${RETURN_TO}${event.url.search}`
	};
};

export const actions: Actions = {
	default: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		if (formText(form, 'confirm') !== 'yes') {
			return fail(400, { message: 'Отметьте, что понимаете последствия удаления.' });
		}
		const cause = formText(form, 'cause') === 'processing_revoked' ? 'processing_revoked' : 'account_deleted';
		const result = await requestAccountDeletion(await authDeps(), requestMeta(event), session, {
			cause,
			reason: formText(form, 'reason').slice(0, 500)
		});
		if (!result.ok) {
			if (result.refusal.reason === 'stale_auth') {
				redirect(303, `/account/reauth?returnTo=${encodeURIComponent(`${RETURN_TO}?cause=${cause}`)}`);
			}
			return fail(409, { message: deletionRefusalMessage(result.refusal) });
		}
		clearSessionCookie(event.cookies);
		redirect(303, `/account/deleted?letter=${result.letterSent ? 'sent' : 'not_sent'}`);
	}
};
