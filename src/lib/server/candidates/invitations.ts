// The candidate's invitations (docs/domain.md, sections 13.5–13.7): the list with the company, the vacancy and the
// current terms, and the card of one invitation with everything its answer needs — the versions with their
// differences, the reasons of a refusal, the fields a disclosure may carry with the exact consent text, and the
// hiring process that the acceptance opened. Reading goes through `getInvitation`, so a stranger gets `404`.
import { eq, inArray } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { currentDocument } from '$lib/server/auth/documents';
import type { DisclosureField } from '$lib/server/consent/kinds';
import { candidates, companies, hiringProcesses, invitations, invitationTerms } from '$lib/server/db/schema';
import { getHiringProcess, processReports, type HiringProcessView } from '$lib/server/hiring/process';
import { hiringState } from '$lib/server/hiring/state';
import { effectiveDisclosure } from '$lib/server/invitations/consent';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { policyById } from '$lib/server/invitations/policies';
import {
	getInvitation,
	listInvitations,
	type InvitationSummary,
	type InvitationView
} from '$lib/server/invitations/read';
import type { VacancySnapshot } from '$lib/server/invitations/terms';
import { currentCandidateVocabulary, vocabularyLabels, type VocabularyLabels } from './vocabulary';

export interface InvitationListItem extends InvitationSummary {
	companyName: string;
	vacancyTitle: string;
	/** Outcome state of the hiring process an acceptance opened. */
	hiring: { outcome: 'pending' | 'single_party' | 'confirmed' | 'diverged' | 'unknown' } | null;
}

export async function candidateInvitationList(
	deps: InvitationDeps,
	subject: AccessSubject
): Promise<InvitationListItem[]> {
	const summaries = await listInvitations(deps, subject, 'candidate');
	if (summaries.length === 0) return [];
	const ids = summaries.map((item) => item.id);
	const rows = await deps.db
		.select({ id: invitations.id, companyName: companies.displayName, snapshot: invitationTerms.vacancySnapshot })
		.from(invitations)
		.innerJoin(companies, eq(companies.id, invitations.companyId))
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.where(inArray(invitations.id, ids));
	const processes = await deps.db.select().from(hiringProcesses).where(inArray(hiringProcesses.invitationId, ids));
	const now = deps.now();
	const hiring = new Map<string, InvitationListItem['hiring']>();
	for (const process of processes) {
		const policy = await policyById(deps.db, 'hiring_policy', process.policyId);
		const state = hiringState(process, await processReports(deps.db, process.id), policy.params, now);
		hiring.set(process.invitationId, { outcome: state.outcome });
	}
	return summaries.map((summary) => {
		const row = rows.find((item) => item.id === summary.id);
		if (!row) throw new Error(`invitation ${summary.id} lost its company or terms`);
		return {
			...summary,
			companyName: row.companyName,
			vacancyTitle: (row.snapshot as VacancySnapshot).title,
			hiring: hiring.get(summary.id) ?? null
		};
	});
}

export interface InvitationCard {
	invitation: InvitationView;
	/** Reason codes of a refusal by the policy version of this invitation, and whether a reason is required. */
	decline: { reasonCodes: string[]; reasonRequired: boolean };
	/** Fields the company may receive now under the disclosure consent of this invitation. */
	disclosedFields: DisclosureField[];
	/** The exact text the acceptance consents to; `null` — no disclosure document is published. */
	disclosureDocument: { id: string; title: string; version: number; body: string } | null;
	hasPhone: boolean;
	process: HiringProcessView | null;
	hiringPolicy: { stages: string[]; outcomeReasonCodes: string[] } | null;
	labels: VocabularyLabels;
}

export async function candidateInvitationCard(
	deps: InvitationDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<InvitationCard> {
	const invitation = await getInvitation(deps, subject, invitationId);
	const now = deps.now();
	const [row] = await deps.db
		.select({ policyId: invitations.policyId, candidateId: invitations.candidateId, phone: candidates.phoneEnc })
		.from(invitations)
		.innerJoin(candidates, eq(candidates.id, invitations.candidateId))
		.where(eq(invitations.id, invitation.id));
	if (!row) throw new Error(`invitation ${invitation.id} disappeared`);
	const policy = await policyById(deps.db, 'invitation_policy', row.policyId);
	const disclosure = await effectiveDisclosure(deps.db, row.candidateId, invitation.id, now);
	const document = await currentDocument(deps.db, 'contact_disclosure', now);
	const process = invitation.hiringProcessId ? await getHiringProcess(deps, subject, invitation.hiringProcessId) : null;
	let hiringPolicy: InvitationCard['hiringPolicy'] = null;
	if (invitation.hiringProcessId) {
		const [processRow] = await deps.db
			.select({ policyId: hiringProcesses.policyId })
			.from(hiringProcesses)
			.where(eq(hiringProcesses.id, invitation.hiringProcessId));
		if (!processRow) throw new Error(`hiring process ${invitation.hiringProcessId} disappeared`);
		const hiring = await policyById(deps.db, 'hiring_policy', processRow.policyId);
		hiringPolicy = { stages: hiring.params.stages, outcomeReasonCodes: hiring.params.outcome_reason_codes };
	}
	return {
		invitation,
		decline: {
			reasonCodes: policy.params.decline_reason_codes,
			reasonRequired: policy.params.reason_required
		},
		disclosedFields: disclosure?.fields ?? [],
		disclosureDocument:
			document?.available === true
				? { id: document.id, title: document.title, version: document.version, body: document.body }
				: null,
		hasPhone: row.phone !== null,
		process,
		hiringPolicy,
		labels: vocabularyLabels(await currentCandidateVocabulary(deps.db))
	};
}
