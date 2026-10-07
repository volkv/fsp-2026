import { fail, redirect } from '@sveltejs/kit';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { authDeps } from '$lib/server/auth/context';
import { clearSessionCookie, requestMeta, requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { isFreshAuth } from '$lib/server/auth/sessions';
import { db } from '$lib/server/db';
import { candidates, companies, companyMembers, disclosures, staffRoles } from '$lib/server/db/schema';
import { requestAccountDeletion, type DeletionResult } from '$lib/server/erasure/request';
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
	const database = db();
	const [profile] = await database
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(eq(candidates.userId, session.userId), ne(candidates.status, 'deleted')));
	const [staff] = await database
		.select({ id: staffRoles.id })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, session.userId), isNull(staffRoles.revokedAt)))
		.limit(1);
	const [membership] = await database
		.select({ companyName: companies.displayName, role: companyMembers.role })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.userId, session.userId), eq(companyMembers.status, 'active')))
		.limit(1);
	const handedOver = profile
		? await database
				.selectDistinct({ companyId: disclosures.companyId })
				.from(disclosures)
				.where(eq(disclosures.candidateId, profile.id))
		: [];
	return {
		candidate: profile !== undefined,
		staff: staff !== undefined,
		membership: membership ?? null,
		companiesWithContacts: handedOver.length,
		cause: event.url.searchParams.get('cause') === 'processing_revoked' ? 'processing_revoked' : 'account_deleted',
		freshAuth: isFreshAuth(session.authTime, new Date()),
		returnTo: `${RETURN_TO}${event.url.search}`
	};
};

function refusalMessage(result: Extract<DeletionResult, { ok: false }>): string {
	const { refusal } = result;
	switch (refusal.reason) {
		case 'stale_auth':
			return 'Подтвердите вход ещё раз: удаление учётной записи требует свежего входа.';
		case 'already_requested':
			return 'Учётная запись уже удаляется.';
		case 'staff_role':
			return 'У учётной записи есть роль сотрудника платформы: сначала администратор снимает роль, затем учётную запись можно удалить.';
		case 'last_owner':
			return `Вы единственный владелец компании «${refusal.companyName}»: передайте владение другому участнику команды на странице команды, затем удалите учётную запись.`;
	}
}

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
			return fail(409, { message: refusalMessage(result) });
		}
		clearSessionCookie(event.cookies);
		redirect(303, `/account/deleted?letter=${result.letterSent ? 'sent' : 'not_sent'}`);
	}
};
