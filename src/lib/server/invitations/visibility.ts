// `canShow` for offers (docs/domain.md, sections 7.4, 13.5): every sent version requires the candidate to be visible in
// the catalog context — of the vacancy the version names, or of the catalog itself when it names none — and the card of
// an offer is the recipient projection only after acceptance with the disclosure consent of this very offer in effect.
import { eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { invitationTerms, type invitations, type vacancies } from '$lib/server/db/schema';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { canShow, type ShowDecision, type Viewer } from '$lib/server/visibility/can-show';
import { effectiveDisclosure, type EffectiveDisclosure } from './consent';
import { loadVacancy } from './records';

type VacancyRow = typeof vacancies.$inferSelect;
type InvitationRow = typeof invitations.$inferSelect;

export interface VisibilityOutcome {
	decision: ShowDecision;
	viewer: Extract<Viewer, { kind: 'member' }> | null;
}

const vacancyFacts = (vacancy: VacancyRow) => ({
	id: vacancy.id,
	companyId: vacancy.companyId,
	origin: vacancy.origin,
	status: vacancy.status,
	minAge: vacancy.minAge
});

/**
 * The decision for a member of the subject's company in the catalog context: of the vacancy, when the offer names one,
 * otherwise of the catalog itself (a candidate aged 14–17 is then refused: minors are reached only by a vacancy).
 */
export async function showInOfferContext(
	executor: Executor,
	subject: AccessSubject,
	candidateId: string,
	vacancy: VacancyRow | null,
	now: Date
): Promise<VisibilityOutcome> {
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) return { decision: { allowed: false, reason: 'not_member' }, viewer: null };
	const facts = (
		await loadVisibilityFacts(executor, [candidateId], {
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: viewer.viewer.companyId,
			viewerCompany: viewer.company,
			...(vacancy ? { vacancy: vacancyFacts(vacancy) } : {})
		})
	).get(candidateId);
	if (!facts) return { decision: { allowed: false, reason: 'not_visible' }, viewer: viewer.viewer };
	return {
		decision: canShow(facts, viewer.viewer, { kind: 'catalog', ...(vacancy ? { vacancyId: vacancy.id } : {}) }),
		viewer: viewer.viewer
	};
}

/** The vacancy the current version of the offer names; `null` — the version names none. */
async function currentVacancy(executor: Executor, invitation: InvitationRow): Promise<VacancyRow | null> {
	if (invitation.currentTermsId === null) return null;
	const [terms] = await executor
		.select({ vacancyId: invitationTerms.vacancyId })
		.from(invitationTerms)
		.where(eq(invitationTerms.id, invitation.currentTermsId));
	if (!terms) throw new Error(`invitation ${invitation.id} lost its current terms`);
	if (terms.vacancyId === null) return null;
	const vacancy = await loadVacancy(executor, terms.vacancyId);
	if (!vacancy) throw new Error(`vacancy ${terms.vacancyId} of invitation ${invitation.id} does not exist`);
	return vacancy;
}

/** The decision in the context of the offer, with the disclosure consent it rests on. */
export async function showInInvitationContext(
	executor: Executor,
	subject: AccessSubject,
	invitation: InvitationRow,
	now: Date
): Promise<VisibilityOutcome & { disclosure: EffectiveDisclosure | null }> {
	const disclosure = await effectiveDisclosure(executor, invitation.candidateId, invitation.id, now);
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) return { decision: { allowed: false, reason: 'not_member' }, viewer: null, disclosure };
	const vacancy = await currentVacancy(executor, invitation);
	const facts = (
		await loadVisibilityFacts(executor, [invitation.candidateId], {
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: viewer.viewer.companyId,
			viewerCompany: viewer.company,
			...(vacancy ? { vacancy: vacancyFacts(vacancy) } : {})
		})
	).get(invitation.candidateId);
	if (!facts) return { decision: { allowed: false, reason: 'not_visible' }, viewer: viewer.viewer, disclosure };
	const decision = canShow(
		{
			...facts,
			invitation: {
				id: invitation.id,
				companyId: invitation.companyId,
				candidateId: invitation.candidateId,
				vacancyId: vacancy?.id ?? null,
				status: invitation.status,
				disclosureConsentActive: disclosure !== null
			}
		},
		viewer.viewer,
		{ kind: 'invitation', invitationId: invitation.id }
	);
	return { decision, viewer: viewer.viewer, disclosure };
}
