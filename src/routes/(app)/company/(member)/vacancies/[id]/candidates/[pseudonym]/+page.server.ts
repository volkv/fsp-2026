import { error, redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { findInCatalog, journalCardView, loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { labelsOf, vocabularyOf } from '$lib/server/employer/vocabulary';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { invitationDeps } from '$lib/server/invitations/deps';
import { currentPolicy } from '$lib/server/invitations/policies';
import { listInvitations } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import { matchingDeps } from '$lib/server/matching/deps';
import type { Actions, PageServerLoad } from './$types';

/** The catalog card in the context of a vacancy: why the candidate fits, what is confirmed, and the invitation. */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	try {
		const vacancy = await getOwnVacancy(database, membership.companyId, event.params.id, now);
		if (membership.companyStatus !== 'verified' || vacancy.status === 'closed') {
			error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
		}
		const item = await findInCatalog(matchingDeps(), subject, event.params.pseudonym, vacancy.id, event.request.signal);
		// Not visible to this company in this context right now: the same answer whatever the reason (domain 7.4).
		if (!item) error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
		const card = await loadCatalogCard(database, {
			candidateId: item.candidateId,
			companyId: membership.companyId,
			pseudonym: item.pseudonym,
			extras: item.extras,
			now,
			signer: configuredReceiptSigner()
		});
		await journalCardView(database, subject, meta, {
			candidateId: item.candidateId,
			pseudonym: item.pseudonym,
			vacancyId: vacancy.id
		});
		const vocabulary = await vocabularyOf(database, vacancy.taxonomyVersionId);
		const existing = (await listInvitations(invitationDeps(), subject, 'company')).find(
			(invitation) => invitation.vacancyId === vacancy.id && invitation.candidatePseudonym === item.pseudonym
		);
		const policy = await currentPolicy(database, 'invitation_policy', now);
		return {
			vacancy: {
				id: vacancy.id,
				title: vacancy.title,
				status: vacancy.status,
				salary: vacancy.salary
			},
			pseudonym: item.pseudonym,
			match: item.match,
			...card,
			labels: labelsOf(vocabulary),
			grades: vocabulary.grades,
			invitation: existing ? { id: existing.id, status: existing.status } : null,
			responseWindowHours: policy?.params.response_window_hours ?? null
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const amount = (value: string) => Number(value.replace(/\s/gu, ''));

export const actions: Actions = {
	invite: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const found = await findInCatalog(
			matchingDeps(),
			subject,
			event.params.pseudonym,
			event.params.id,
			event.request.signal
		);
		if (!found) error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
		let invitationId: string;
		try {
			const sent = await createInvitation(
				invitationDeps(),
				subject,
				{ ...meta, sessionHash },
				{
					vacancyId: event.params.id,
					candidateId: found.candidateId,
					salaryMin: amount(formText(form, 'salaryMin')),
					salaryMax: amount(formText(form, 'salaryMax')),
					message: formText(form, 'message')
				}
			);
			invitationId = sent.invitationId;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/invitations/${invitationId}?sent=1`);
	}
};
