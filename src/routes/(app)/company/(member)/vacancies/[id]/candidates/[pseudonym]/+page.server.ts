import { error, redirect } from '@sveltejs/kit';
import { companyAdmission } from '$lib/server/access/permissions';
import { db } from '$lib/server/db';
import { findInCatalog, journalCardView, loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { labelsOf, vocabularyOf } from '$lib/server/employer/vocabulary';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { invitationDeps } from '$lib/server/invitations/deps';
import { offerFormContext, offerFromForm, whyYouOptions } from '$lib/server/invitations/offer-form';
import { listInvitations } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import { matchingDeps } from '$lib/server/matching/deps';
import type { Actions, PageServerLoad } from './$types';

/** The catalog card in the context of a vacancy: why the candidate fits, what is confirmed, and the offer naming it. */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	try {
		const vacancy = await getOwnVacancy(database, membership.companyId, event.params.id, now);
		if (!companyAdmission(membership.companyStatus).admitted || vacancy.status === 'closed') {
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
		const labels = labelsOf(vocabulary);
		const existing = (await listInvitations(invitationDeps(), subject, 'company')).find(
			(invitation) => invitation.candidatePseudonym === item.pseudonym
		);
		return {
			vacancy: {
				id: vacancy.id,
				title: vacancy.title,
				description: vacancy.description,
				status: vacancy.status,
				salary: vacancy.salary,
				workFormat: vacancy.workFormat
			},
			pseudonym: item.pseudonym,
			match: item.match,
			...card,
			labels,
			offer: await offerFormContext(database, membership.companyId, vocabulary, now),
			whyYouOptions: whyYouOptions(card.card, { skills: labels.skills, workFormats: labels.terms.work_format }),
			invitation: existing ? { id: existing.id, status: existing.status } : null
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

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
				{ ...offerFromForm(form), candidateId: found.candidateId }
			);
			invitationId = sent.invitationId;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/invitations/${invitationId}?sent=1`);
	}
};
