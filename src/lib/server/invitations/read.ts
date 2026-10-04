// Reading invitations (docs/domain.md, sections 13.5, 4.2): an invitation and its versions are seen only by members of
// the sending company and by the candidate it is addressed to. The company sees the candidate by pseudonym; the
// candidate sees the company, every version with its differences and the other offers of the same company. Across demo
// sessions the candidate sees the invitations of the companies within their reach (domain 19.3): an invitation a clone
// company sent to an original of the cast is not the original's.
import { and, asc, desc, eq, isNull, ne, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { companies, hiringProcesses, invitationResponses, invitations, invitationTerms } from '$lib/server/db/schema';
import type { DisclosureField } from '$lib/server/consent/kinds';
import { companyInDemoScope, demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { compareSalary, type SalaryComparison } from '$lib/server/salary/compare';
import type { InvitationDeps } from './deps';
import { refuse } from './errors';
import { termsHistory, termsSalary, type InvitationRow, type TermsRow } from './records';
import { pendingRepresentativeDisclosure } from './respond';
import { salaryTerms, type OfferedSalary, type TermsChanges, type VacancySnapshot } from './terms';

export interface TermsVersionView {
	id: string;
	version: number;
	vacancy: VacancySnapshot;
	salary: OfferedSalary;
	message: string | null;
	responseDueAt: Date;
	changes: TermsChanges | null;
	createdAt: Date;
	response: {
		decision: 'accept' | 'decline';
		reasonCode: string | null;
		reasonText: string | null;
		respondedAt: Date;
	} | null;
}

export interface OtherOfferView {
	invitationId: string;
	vacancyTitle: string;
	status: InvitationRow['status'];
	salary: OfferedSalary;
	/** `compareSalary(that offer, this offer)`. */
	comparison: SalaryComparison;
}

export interface InvitationView {
	id: string;
	viewer: 'company' | 'candidate';
	status: InvitationRow['status'];
	vacancyId: string;
	companyId: string;
	companyName: string;
	/** The candidate as the company knows them. */
	candidatePseudonym: string | null;
	sentAt: Date;
	viewedAt: Date | null;
	closedAt: Date | null;
	reopenCount: number;
	currentTermsId: string;
	acceptedTermsId: string | null;
	versions: TermsVersionView[];
	hiringProcessId: string | null;
	/** Candidate side only: offers of the same company for its other vacancies. */
	otherOffers: OtherOfferView[];
	/**
	 * The candidate aged 14–17 accepted the current version, and the acceptance waits for the legal representative's
	 * consent to the disclosure until the deadline of the version. The fields are shown to the candidate only.
	 */
	awaitingRepresentative: { requestedAt: Date; dueAt: Date; fields: DisclosureField[] | null } | null;
}

function sideOf(subject: AccessSubject, invitation: InvitationRow): 'company' | 'candidate' {
	const access = can(subject, 'invitation.read', {
		companyId: invitation.companyId,
		candidateId: invitation.candidateId
	});
	if (!access.allowed) throw refuse('not_found', 'not_party');
	return subject.candidate?.id === invitation.candidateId ? 'candidate' : 'company';
}

async function versionsOf(executor: Executor, invitationId: string): Promise<TermsVersionView[]> {
	const history = await termsHistory(executor, invitationId);
	const responses = await executor
		.select()
		.from(invitationResponses)
		.where(eq(invitationResponses.invitationId, invitationId));
	const responseOf = new Map(responses.map((r) => [r.termsId, r]));
	return history.map((terms: TermsRow) => {
		const response = responseOf.get(terms.id);
		return {
			id: terms.id,
			version: terms.version,
			vacancy: terms.vacancySnapshot as VacancySnapshot,
			salary: termsSalary(terms),
			message: terms.message,
			responseDueAt: terms.responseDueAt,
			changes: terms.changes as TermsChanges | null,
			createdAt: terms.createdAt,
			response: response
				? {
						decision: response.decision,
						reasonCode: response.reasonCode,
						reasonText: response.reasonText,
						respondedAt: response.respondedAt
					}
				: null
		};
	});
}

async function otherOffers(
	executor: Executor,
	invitation: InvitationRow,
	current: OfferedSalary
): Promise<OtherOfferView[]> {
	const rows = await executor
		.select({ invitation: invitations, terms: invitationTerms })
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.where(
			and(
				eq(invitations.companyId, invitation.companyId),
				eq(invitations.candidateId, invitation.candidateId),
				ne(invitations.id, invitation.id),
				isNull(invitations.purgedAt)
			)
		)
		.orderBy(desc(invitations.sentAt));
	return rows.map(({ invitation: other, terms }) => {
		const salary = termsSalary(terms);
		return {
			invitationId: other.id,
			vacancyTitle: (terms.vacancySnapshot as VacancySnapshot).title,
			status: other.status,
			salary,
			comparison: compareSalary(salaryTerms(salary), salaryTerms(current))
		};
	});
}

export async function getInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<InvitationView> {
	const executor = deps.db;
	const [invitation] = await executor.select().from(invitations).where(eq(invitations.id, invitationId));
	if (!invitation || invitation.purgedAt !== null || invitation.currentTermsId === null) {
		throw refuse('not_found', 'no_invitation');
	}
	const viewer = sideOf(subject, invitation);
	const [company] = await executor
		.select({
			name: companies.displayName,
			demoSessionId: companies.demoSessionId,
			demoOriginal: companies.demoOriginal
		})
		.from(companies)
		.where(eq(companies.id, invitation.companyId));
	if (!company) throw new Error(`company ${invitation.companyId} does not exist`);
	if (viewer === 'candidate' && !inDemoScope(company, await demoSessionOfUser(executor, subject.userId))) {
		throw refuse('not_found', 'not_in_demo_scope');
	}
	const [process] = await executor
		.select({ id: hiringProcesses.id })
		.from(hiringProcesses)
		.where(eq(hiringProcesses.invitationId, invitation.id));
	const versions = await versionsOf(executor, invitation.id);
	const current = versions.find((v) => v.id === invitation.currentTermsId);
	if (!current) throw new Error(`invitation ${invitation.id} lost its current terms`);
	const pending = await pendingRepresentativeDisclosure(executor, invitation, deps.now());
	return {
		id: invitation.id,
		viewer,
		status: invitation.status,
		vacancyId: invitation.vacancyId,
		companyId: invitation.companyId,
		companyName: company.name,
		candidatePseudonym:
			viewer === 'company' ? deps.crypto.pseudonym(invitation.candidateId, invitation.companyId) : null,
		sentAt: invitation.sentAt,
		viewedAt: invitation.viewedAt,
		closedAt: invitation.closedAt,
		reopenCount: invitation.reopenCount,
		currentTermsId: invitation.currentTermsId,
		acceptedTermsId: invitation.acceptedTermsId,
		versions,
		hiringProcessId: process?.id ?? null,
		otherOffers: viewer === 'candidate' ? await otherOffers(executor, invitation, current.salary) : [],
		awaitingRepresentative: pending
			? {
					requestedAt: pending.requestedAt,
					dueAt: pending.dueAt,
					fields: viewer === 'candidate' ? pending.fields : null
				}
			: null
	};
}

export interface InvitationSummary {
	id: string;
	status: InvitationRow['status'];
	vacancyId: string;
	companyId: string;
	candidatePseudonym: string | null;
	version: number;
	salary: OfferedSalary;
	responseDueAt: Date;
	sentAt: Date;
	/** The candidate accepted and the acceptance waits for the legal representative. */
	awaitingRepresentative: boolean;
}

/** The invitations of the subject's side: sent by its company, or addressed to the candidate. */
export async function listInvitations(
	deps: InvitationDeps,
	subject: AccessSubject,
	side: 'company' | 'candidate'
): Promise<InvitationSummary[]> {
	const executor = deps.db;
	// Each side is checked with the object rule of its own side only: the other side of the rule never matches.
	const conditions: SQL[] = [isNull(invitations.purgedAt)];
	if (side === 'candidate') {
		const candidateId = subject.candidate?.id;
		if (candidateId === undefined) throw refuse('forbidden', 'not_candidate');
		const access = can(subject, 'invitation.read', { companyId: '', candidateId });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		conditions.push(
			eq(invitations.candidateId, candidateId),
			companyInDemoScope(invitations.companyId, await demoSessionOfUser(executor, subject.userId))
		);
	} else {
		const companyId = subject.membership?.companyId;
		if (companyId === undefined) throw refuse('forbidden', 'not_member');
		const access = can(subject, 'invitation.read', { companyId, candidateId: '' });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		conditions.push(eq(invitations.companyId, companyId));
	}
	const rows = await executor
		.select({ invitation: invitations, terms: invitationTerms })
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.where(and(...conditions))
		.orderBy(desc(invitations.sentAt), asc(invitations.id));
	const now = deps.now();
	const summaries: InvitationSummary[] = [];
	for (const { invitation, terms } of rows) {
		summaries.push({
			id: invitation.id,
			status: invitation.status,
			vacancyId: invitation.vacancyId,
			companyId: invitation.companyId,
			candidatePseudonym:
				side === 'company' ? deps.crypto.pseudonym(invitation.candidateId, invitation.companyId) : null,
			version: terms.version,
			salary: termsSalary(terms),
			responseDueAt: terms.responseDueAt,
			sentAt: invitation.sentAt,
			awaitingRepresentative: (await pendingRepresentativeDisclosure(executor, invitation, now)) !== null
		});
	}
	return summaries;
}
