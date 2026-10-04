import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { findInCatalog, journalCardView, loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { searchableVacancies } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { matchingDeps } from '$lib/server/matching/deps';
import type { PageServerLoad } from './$types';

/** The catalog card outside a vacancy: no match and no invitation — those are made for a vacancy. */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	try {
		if (membership.companyStatus !== 'verified') {
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
		return {
			pseudonym: item.pseudonym,
			...card,
			labels: labelsOf(vocabulary),
			grades: vocabulary.grades,
			vacancies: await searchableVacancies(database, membership.companyId)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
