import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { getApplication, rejectApplication } from '$lib/server/applications/service';
import { candidateOfPseudonym } from '$lib/server/api/read/pseudonyms';
import { solutionsOfCandidate } from '$lib/server/challenges/company';
import { resultsVisibleTo } from '$lib/server/confirmations/requests';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { formFailure, pageError } from '$lib/server/http/page';
import { invitationDeps } from '$lib/server/invitations/deps';
import { offerFormContext, offerFromForm, pointOption, type WhyYouOption } from '$lib/server/invitations/offer-form';
import { listInvitations } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import type { Actions, PageServerLoad } from './$types';

const applicationIdOf = (value: string, requestId: string): string => {
	const parsed = z.uuid().safeParse(value);
	if (!parsed.success) error(404, { message: 'Отклик не найден', requestId });
	return parsed.data;
};

/**
 * One application with the match at the moment of applying and the contacts the candidate disclosed by it, while the
 * consent holds (domain 6.5, 13.6), and the offer by it: the application is the candidate's own consent to contact with
 * this company, so the offer goes even to a profile hidden from the catalog (domain 13.13). Reading it marks it viewed;
 * reading the contacts is journaled.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	event.setHeaders({ 'cache-control': 'private, no-store' });
	const applicationId = applicationIdOf(event.params.id, event.locals.requestId);
	try {
		const database = db();
		const now = new Date();
		const found = await getApplication(contactPageDeps(), subject, meta, applicationId);
		const pseudonym = found.application.candidatePseudonym;
		const candidateId =
			pseudonym === null ? null : await candidateOfPseudonym(database, fieldCrypto(), membership.companyId, pseudonym);
		const vocabulary = await currentVocabulary(database);
		const labels = labelsOf(vocabulary);
		const names = catalogNames();
		const options: WhyYouOption[] = [];
		if (candidateId !== null) {
			const pair = { candidateId, companyId: membership.companyId };
			for (const result of await resultsVisibleTo(database, membership.companyId, candidateId, {
				confirmedOnly: true
			})) {
				options.push(
					pointOption(`Подтвердил блок «${names.blocks[result.block] ?? result.block}»`, {
						kind: 'confirmation',
						ref: result.id
					})
				);
			}
			for (const solution of await solutionsOfCandidate(database, pair)) {
				options.push(
					pointOption(`Решение вызова «${solution.challengeTitle}»`, { kind: 'challenge_solution', ref: solution.id })
				);
			}
		}
		// The skills the match of the application found: what the candidate showed in applying.
		for (const match of found.application.match.matches) {
			const key = match.skill_key;
			if (match.kind === 'skill' && typeof key === 'string') {
				options.push(pointOption(`В отклике — ${labels.skills[key] ?? key}`, { kind: 'declared_skill', ref: key }));
			}
		}
		const existing = (await listInvitations(invitationDeps(), subject, 'company')).find(
			(invitation) => invitation.candidatePseudonym === pseudonym
		);
		return {
			...found,
			offer: await offerFormContext(database, membership.companyId, vocabulary, now),
			whyYouOptions: options,
			invitation: existing ? { id: existing.id, status: existing.status } : null
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	reject: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const applicationId = applicationIdOf(event.params.id, event.locals.requestId);
		try {
			await rejectApplication(contactPageDeps(), subject, meta, applicationId);
		} catch (cause) {
			return formFailure(cause);
		}
		return { rejected: true };
	},
	/** The offer by the application: to this candidate, whether the catalog shows them or not (domain 13.13). */
	offer: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const membership = membershipOf(event, subject);
		const applicationId = applicationIdOf(event.params.id, event.locals.requestId);
		const form = await event.request.formData();
		let invitationId: string;
		try {
			const found = await getApplication(contactPageDeps(), subject, meta, applicationId);
			const pseudonym = found.application.candidatePseudonym;
			const candidateId =
				pseudonym === null ? null : await candidateOfPseudonym(db(), fieldCrypto(), membership.companyId, pseudonym);
			if (candidateId === null) error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
			const sent = await createInvitation(
				invitationDeps(),
				subject,
				{ ...meta, sessionHash },
				{
					...offerFromForm(form),
					candidateId
				}
			);
			invitationId = sent.invitationId;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/invitations/${invitationId}?sent=1`);
	}
};
