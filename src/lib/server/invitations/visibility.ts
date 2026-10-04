// `canShow` for invitations (docs/domain.md, sections 7.4, 13.5): every sent version requires the candidate to be
// visible in the catalog context of the vacancy, and the card of an invitation is the recipient projection only after
// acceptance with the disclosure consent of this very invitation in effect.
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import type { invitations, vacancies } from '$lib/server/db/schema';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { canShow, type ShowDecision, type Viewer } from '$lib/server/visibility/can-show';
import { effectiveDisclosure, type EffectiveDisclosure } from './consent';

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

/** The decision for a member of the subject's company in the catalog context of the vacancy. */
export async function showInVacancyContext(
	executor: Executor,
	subject: AccessSubject,
	candidateId: string,
	vacancy: VacancyRow,
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
			vacancy: vacancyFacts(vacancy)
		})
	).get(candidateId);
	if (!facts) return { decision: { allowed: false, reason: 'not_visible' }, viewer: viewer.viewer };
	return { decision: canShow(facts, viewer.viewer, { kind: 'catalog', vacancyId: vacancy.id }), viewer: viewer.viewer };
}

/** The decision in the context of the invitation, with the disclosure consent it rests on. */
export async function showInInvitationContext(
	executor: Executor,
	subject: AccessSubject,
	invitation: InvitationRow,
	vacancy: VacancyRow,
	now: Date
): Promise<VisibilityOutcome & { disclosure: EffectiveDisclosure | null }> {
	const disclosure = await effectiveDisclosure(executor, invitation.candidateId, invitation.id, now);
	const viewer = await loadCatalogViewer(executor, subject, now);
	if (!viewer) return { decision: { allowed: false, reason: 'not_member' }, viewer: null, disclosure };
	const facts = (
		await loadVisibilityFacts(executor, [invitation.candidateId], {
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: viewer.viewer.companyId,
			viewerCompany: viewer.company,
			vacancy: vacancyFacts(vacancy)
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
				vacancyId: invitation.vacancyId,
				status: invitation.status,
				disclosureConsentActive: disclosure !== null
			}
		},
		viewer.viewer,
		{ kind: 'invitation', invitationId: invitation.id }
	);
	return { decision, viewer: viewer.viewer, disclosure };
}
