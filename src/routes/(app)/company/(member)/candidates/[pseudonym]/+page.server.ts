import { error, redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { companyAdmission } from '$lib/server/access/permissions';
import { db } from '$lib/server/db';
import { findInCatalog, journalCardView, loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { invitationDeps } from '$lib/server/invitations/deps';
import {
	offerFormContext,
	offerFromForm,
	offerTermsOfNeed,
	pointOption,
	whyYouFromShortlist,
	whyYouOptions,
	type WhyYouOption
} from '$lib/server/invitations/offer-form';
import { listInvitations } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import { matchingDeps } from '$lib/server/matching/deps';
import { configuredShortlistDeps } from '$lib/server/shortlists/page';
import { disclosingApplication } from '$lib/server/applications/service';
import { solutionsOfCandidate } from '$lib/server/challenges/company';
import {
	companyRequests,
	requestableBlocks,
	requestConfirmation,
	resultsVisibleTo
} from '$lib/server/confirmations/requests';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { shortlistMatchOf } from '$lib/server/shortlists/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * The catalog card outside a vacancy, and the offer from it: the company writes first, a vacancy is optional
 * (domain 13.5). The match is computed for a vacancy, on the page of the card in its context. Opened from a shortlist
 * (`?shortlist=`), the offer starts with the reasons of the shortlist as points of «why you» and names its need.
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
		const fromCard = whyYouOptions(card.card, { skills: labels.skills, workFormats: labels.terms.work_format });
		const shortlistId = event.url.searchParams.get('shortlist');
		const fromShortlist = shortlistId
			? await shortlistMatchOf(configuredShortlistDeps(), subject, shortlistId, item.candidateId, event.request.signal)
			: null;
		const suggested: WhyYouOption[] = fromShortlist
			? whyYouFromShortlist(fromShortlist.match, fromCard, {
					skills: labels.skills,
					workFormats: labels.terms.work_format,
					specializations: labels.specializations,
					grades: labels.grades
				})
			: [];
		const suggestedKeys = new Set(suggested.map((option) => option.key));
		// Points of the contact itself (domain 13.11, 13.12): the block results the company sees and the solutions of its
		// calls; opened from a solution (`?solution=`), the offer starts with that point.
		const pair = { candidateId: item.candidateId, companyId: membership.companyId };
		const results = await resultsVisibleTo(database, membership.companyId, item.candidateId, { confirmedOnly: true });
		const solutions = await solutionsOfCandidate(database, pair);
		const names = catalogNames();
		const contactOptions: WhyYouOption[] = [
			...results.map((result) =>
				pointOption(
					`Подтвердил блок «${names.blocks[result.block] ?? result.block}» на грейде ${names.grades[result.grade] ?? result.grade}`,
					{
						kind: 'confirmation',
						ref: result.id
					}
				)
			),
			...solutions.map((solution) =>
				pointOption(`Решение вызова «${solution.challengeTitle}»`, { kind: 'challenge_solution', ref: solution.id })
			)
		];
		const fromSolution = event.url.searchParams.get('solution');
		const solutionPoint = contactOptions.find(
			(option) => option.source.kind === 'challenge_solution' && option.source.ref === fromSolution
		);
		const confirmations = await companyRequests(contactPageDeps(), subject, item.candidateId);
		return {
			contactOptions,
			requestable: await requestableBlocks(database, item.candidateId),
			confirmations,
			names,
			pseudonym: item.pseudonym,
			...card,
			labels,
			vacancies: await searchableVacancies(database, membership.companyId),
			offer: await offerFormContext(database, membership.companyId, vocabulary, now),
			whyYouOptions: [...contactOptions, ...suggested, ...fromCard.filter((option) => !suggestedKeys.has(option.key))],
			fromShortlist: fromShortlist && {
				shortlistId,
				needId: fromShortlist.needId,
				needTerms: offerTermsOfNeed(fromShortlist.form),
				preselected: suggested.slice(0, 5).map((option) => option.key),
				/** The candidate is of the group «грейд не подтверждён»: the offer records no confirmed category. */
				gradeConfirmed: fromShortlist.match.group === 'confirmed',
				declared: fromShortlist.match.declared
			},
			preselected: solutionPoint ? [solutionPoint.key] : [],
			invitation: existing ? { id: existing.id, status: existing.status } : null,
			application: await disclosingApplication(database, pair, now)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	/** A request to confirm a block the category does not cover (domain 13.11). */
	requestConfirmation: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const found = await findInCatalog(matchingDeps(), subject, event.params.pseudonym, undefined, event.request.signal);
		if (!found) error(404, { message: 'Кандидат не найден', requestId: event.locals.requestId });
		try {
			const outcome = await requestConfirmation(contactPageDeps(), subject, meta, {
				candidateId: found.candidateId,
				block: formText(form, 'block')
			});
			return { confirmation: outcome.kind === 'result' ? 'result' : outcome.created ? 'created' : 'existing' };
		} catch (cause) {
			return formFailure(cause);
		}
	},
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
				{
					...offerFromForm(form),
					candidateId: found.candidateId,
					...(formText(form, 'needId') === '' ? {} : { needId: formText(form, 'needId') })
				}
			);
			invitationId = sent.invitationId;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/invitations/${invitationId}?sent=1`);
	}
};
