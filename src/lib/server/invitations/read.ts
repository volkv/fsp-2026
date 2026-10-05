// Reading offers (docs/domain.md, sections 13.5, 4.2): an offer and its versions are seen only by members of the
// sending company and by the candidate it is addressed to. The company sees the candidate by pseudonym; the candidate
// sees the company with its profile and the label of its check, and every version with its differences. Across demo
// sessions the candidate sees the invitations of the companies within their reach (domain 19.3): an invitation a clone
// company sent to an original of the cast is not the original's.
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import {
	blockConfirmations,
	companies,
	hiringProcesses,
	invitationResponses,
	invitations,
	invitationTerms
} from '$lib/server/db/schema';
import type { DisclosureField } from '$lib/server/consent/kinds';
import { companyInDemoScope, demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { loadCompanyProfile, type CompanyPublicProfile } from '$lib/server/companies/public-profile';
import { companyTrust, type CompanyTrust } from '$lib/server/companies/trust';
import type { InvitationDeps } from './deps';
import { refuse } from './errors';
import { termsContent, termsHistory, termsSalary, type InvitationRow, type TermsRow } from './records';
import { pendingRepresentativeDisclosure } from './respond';
import type {
	CategorySnapshot,
	ContactMethod,
	OfferedSalary,
	TermsChanges,
	VacancySnapshot,
	WhyYouPoint
} from './terms';

export interface TermsVersionView {
	id: string;
	version: number;
	title: string;
	description: string;
	/** The vacancy the version names, as it was then; `null` — an offer without a vacancy. */
	vacancy: { id: string; snapshot: VacancySnapshot } | null;
	/** The candidate's category at the version; `null` — «категория не подтверждена». */
	category: CategorySnapshot | null;
	salary: OfferedSalary;
	workFormat: string;
	contactMethod: ContactMethod;
	/**
	 * The points as sent; `basisAnnulled` — a point naming the result of a block test whose attempt was annulled since
	 * (domain 13.11): the sent version stays as it was, the reading marks the point.
	 */
	whyYou: (WhyYouPoint & { basisAnnulled: boolean })[];
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

export interface InvitationView {
	id: string;
	viewer: 'company' | 'candidate';
	status: InvitationRow['status'];
	/** The company with its profile and the label of the check: the candidate reads it before answering. */
	company: CompanyPublicProfile;
	/** Facts of trust in the company, each with its number of observations (domain 5.6). */
	companyTrust: CompanyTrust;
	needId: string | null;
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
	/**
	 * The candidate aged 14–17 accepted the current version, and the acceptance waits for the legal representative's
	 * consent to the disclosure until the deadline of the version. The fields are shown to the candidate only.
	 */
	awaitingRepresentative: { requestedAt: Date; dueAt: Date; fields: DisclosureField[] | null } | null;
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

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
	const confirmationRefs = [
		...new Set(
			history.flatMap((terms) =>
				termsContent(terms)
					.whyYou.filter((point) => point.source.kind === 'confirmation')
					.map((point) => point.source.ref)
			)
		)
	].filter(isUuid);
	const annulled = new Set(
		confirmationRefs.length === 0
			? []
			: (
					await executor
						.select({ id: blockConfirmations.id })
						.from(blockConfirmations)
						.where(and(inArray(blockConfirmations.id, confirmationRefs), eq(blockConfirmations.status, 'annulled')))
				).map((row) => row.id)
	);
	return history.map((terms: TermsRow) => {
		const response = responseOf.get(terms.id);
		const content = termsContent(terms);
		return {
			id: terms.id,
			version: terms.version,
			...content,
			whyYou: content.whyYou.map((point) => ({
				...point,
				basisAnnulled: point.source.kind === 'confirmation' && annulled.has(point.source.ref)
			})),
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
		.select({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
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
	if (!versions.some((v) => v.id === invitation.currentTermsId)) {
		throw new Error(`invitation ${invitation.id} lost its current terms`);
	}
	const pending = await pendingRepresentativeDisclosure(executor, invitation, deps.now());
	return {
		id: invitation.id,
		viewer,
		status: invitation.status,
		company: await loadCompanyProfile(executor, invitation.companyId),
		companyTrust: await companyTrust(executor, invitation.companyId, deps.now()),
		needId: invitation.needId,
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
	companyId: string;
	companyName: string;
	/** «Проверена» / «не проверена» — the label the candidate sees next to the company. */
	companyVerification: 'verified' | 'unverified';
	candidatePseudonym: string | null;
	version: number;
	title: string;
	/** The vacancy the current version names; `null` — an offer without a vacancy. */
	vacancyId: string | null;
	vacancyTitle: string | null;
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
		.select({
			invitation: invitations,
			terms: invitationTerms,
			companyName: companies.displayName,
			companyStatus: companies.status
		})
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.innerJoin(companies, eq(companies.id, invitations.companyId))
		.where(and(...conditions))
		.orderBy(desc(invitations.sentAt), asc(invitations.id));
	const now = deps.now();
	const summaries: InvitationSummary[] = [];
	for (const { invitation, terms, companyName, companyStatus } of rows) {
		summaries.push({
			id: invitation.id,
			status: invitation.status,
			companyId: invitation.companyId,
			companyName,
			companyVerification: companyStatus === 'verified' ? 'verified' : 'unverified',
			candidatePseudonym:
				side === 'company' ? deps.crypto.pseudonym(invitation.candidateId, invitation.companyId) : null,
			version: terms.version,
			title: terms.title,
			vacancyId: terms.vacancyId,
			vacancyTitle: terms.vacancyId === null ? null : (terms.vacancySnapshot as VacancySnapshot).title,
			salary: termsSalary(terms),
			responseDueAt: terms.responseDueAt,
			sentAt: invitation.sentAt,
			awaitingRepresentative: (await pendingRepresentativeDisclosure(executor, invitation, now)) !== null
		});
	}
	return summaries;
}
