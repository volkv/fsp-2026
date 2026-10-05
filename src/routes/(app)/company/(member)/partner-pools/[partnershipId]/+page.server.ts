import { CATEGORY_OPTIONS, isGradeKey, isSpecializationKey } from '$lib/server/categories/labels';
import { db } from '$lib/server/db';
import { loadCatalogCard } from '$lib/server/employer/card';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { auditActorOf } from '$lib/server/companies/context';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { pageError } from '$lib/server/http/page';
import { matchingDeps } from '$lib/server/matching/deps';
import { invitableVacancies, journalPoolView, readPartnerPool } from '$lib/server/partner-pool/pool';
import type { PageServerLoad } from './$types';

const list = (url: URL, name: string) => url.searchParams.getAll(name).filter((value) => value !== '');

/**
 * The pool of a competition partner: finalists who consented to show the card to this company, each card with the
 * result of the competition exact, and the own vacancies an invitation to the candidate can go by.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	const specializations = list(event.url, 'specialization').filter(isSpecializationKey);
	const grades = list(event.url, 'grade').filter(isGradeKey);
	try {
		const pool = await readPartnerPool(matchingDeps(), subject, event.params.partnershipId, {
			...(specializations.length > 0 ? { specializations } : {}),
			...(grades.length > 0 ? { grades } : {})
		});
		const signer = configuredReceiptSigner();
		const vacancies = await invitableVacancies(
			database,
			subject,
			pool.members.map((member) => member.candidateId),
			now
		);
		const members = [];
		for (const member of pool.members) {
			const card = await loadCatalogCard(database, {
				candidateId: member.candidateId,
				companyId: membership.companyId,
				pseudonym: member.pseudonym,
				extras: member.extras,
				partnerCompetitionRef: pool.partnership.competitionRef,
				now,
				signer
			});
			const offered = vacancies.get(member.candidateId);
			if (!offered) throw new Error('a pool member was not checked against the vacancies');
			members.push({ pseudonym: member.pseudonym, result: member.result, ...card, vacancies: offered });
		}
		await journalPoolView(database, {
			actor: auditActorOf(subject),
			meta: { requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent },
			partnershipId: pool.partnership.id,
			competitionRef: pool.partnership.competitionRef,
			cardCount: members.length
		});
		const vocabulary = await currentVocabulary(database);
		return {
			partnership: pool.partnership,
			members,
			query: { specializations, grades },
			filters: CATEGORY_OPTIONS,
			labels: labelsOf(vocabulary)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
