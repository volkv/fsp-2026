import { error, redirect } from '@sveltejs/kit';
import { companyAdmission } from '$lib/server/access/permissions';
import { db } from '$lib/server/db';
import { findInCatalog, journalCardView, loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { invitationDeps } from '$lib/server/invitations/deps';
import { offerFormContext, offerFromForm, whyYouOptions } from '$lib/server/invitations/offer-form';
import { listInvitations } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import { matchingDeps } from '$lib/server/matching/deps';
import type { Actions, PageServerLoad } from './$types';

/**
 * The catalog card outside a vacancy, and the offer from it: the company writes first, a vacancy is optional
 * (domain 13.5). The match is computed for a vacancy, on the page of the card in its context.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	try {
		if (!companyAdmission(membership.companyStatus).admitted) {
			error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
		}
		const item = await findInCatalog(matchingDeps(), subject, event.params.pseudonym, undefined, event.request.signal);
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
			vacancyId: null
		});
		const vocabulary = await currentVocabulary(database);
		const labels = labelsOf(vocabulary);
		const existing = (await listInvitations(invitationDeps(), subject, 'company')).find(
			(invitation) => invitation.candidatePseudonym === item.pseudonym
		);
		return {
			pseudonym: item.pseudonym,
			...card,
			labels,
			vacancies: await searchableVacancies(database, membership.companyId),
			offer: await offerFormContext(database, membership.companyId, vocabulary, now),
			whyYouOptions: whyYouOptions(card.card, { skills: labels.skills, workFormats: labels.terms.work_format }),
			invitation: existing ? { id: existing.id, status: existing.status } : null
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	offer: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const found = await findInCatalog(matchingDeps(), subject, event.params.pseudonym, undefined, event.request.signal);
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
