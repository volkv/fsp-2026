// The Huntflow adapter (docs/contracts.md, section 13.3): a receiver of the company's events that turns them into calls
// of the public Huntflow API v2 — the accepted offer creates the applicant with the contacts the candidate disclosed to
// this company and puts them on the company's vacancy in the mapped status; a stage or an outcome the company reports
// moves the applicant to the mapped status. The platform calls Huntflow only when `HUNTFLOW_API_URL` is set; the token
// is the company's, stored encrypted with the subscription. The shapes of the requests follow the OpenAPI document of
// Huntflow (`tests/fixtures/huntflow/`).
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Database } from '$lib/server/db';
import { atsLinks, companies, companyMembers, invitations, invitationTerms } from '$lib/server/db/schema';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import { recipientContacts } from '$lib/server/invitations/disclosure';
import { Refusal } from '$lib/server/invitations/errors';
import { sendJson, type PostResult } from './http';

const statusId = z.int().positive();

/** What the owner maps: the account, the vacancy applicants go to, and the Huntflow status of each platform stage. */
export const huntflowSettingsSchema = z.strictObject({
	account_id: z.int().positive(),
	vacancy_id: z.int().positive(),
	statuses: z.strictObject({
		accepted: statusId,
		interview_scheduled: statusId.optional(),
		interview_done: statusId.optional(),
		offer_made: statusId.optional(),
		offer_accepted: statusId.optional(),
		hired: statusId.optional(),
		not_hired: statusId.optional()
	})
});

export type HuntflowSettings = z.infer<typeof huntflowSettingsSchema>;

/** The events the adapter acts on. */
export const HUNTFLOW_EVENTS = ['invitation.accepted', 'hiring.reported'] as const;

export interface HuntflowDeps {
	db: Database;
	crypto: FieldCrypto;
	apiUrl: string;
	signal: AbortSignal;
	timeoutMs: number;
	now: () => Date;
}

export interface HuntflowDelivery {
	subscriptionId: string;
	companyId: string;
	createdByMemberId: string;
	token: string;
	settings: HuntflowSettings;
	eventType: string;
	invitationId: string | null;
	payload: Record<string, unknown>;
}

/** What one delivery to Huntflow came to: done, nothing to do, or the last answer that failed it. */
export type HuntflowOutcome =
	{ kind: 'done'; status: number } | { kind: 'skipped'; reason: string } | { kind: 'failed'; result: PostResult };

/** The body of `POST /accounts/{account_id}/applicants` from the disclosed contacts (`ApplicantCreateRequest`). */
export function applicantBody(contacts: {
	fullName?: { last: string | null; first: string | null; middle: string | null };
	email?: string;
	phone?: string | null;
}): Record<string, string> {
	const body: Record<string, string> = {};
	if (contacts.fullName?.last) body.last_name = contacts.fullName.last;
	if (contacts.fullName?.first) body.first_name = contacts.fullName.first;
	if (contacts.fullName?.middle) body.middle_name = contacts.fullName.middle;
	if (contacts.email) body.email = contacts.email;
	if (contacts.phone) body.phone = contacts.phone;
	return body;
}

/** The body of `POST`/`PUT /accounts/{account_id}/applicants/{applicant_id}/vacancy` (`AddApplicantToVacancyRequest`). */
export function vacancyStatusBody(
	settings: HuntflowSettings,
	status: number,
	extra: { comment?: string; employmentDate?: string }
): Record<string, string | number> {
	return {
		vacancy: settings.vacancy_id,
		status,
		...(extra.comment === undefined ? {} : { comment: extra.comment }),
		...(extra.employmentDate === undefined ? {} : { employment_date: extra.employmentDate })
	};
}

const reportSchema = z.looseObject({
	party: z.enum(['company', 'candidate']),
	kind: z.enum(['stage', 'outcome']),
	value: z.string(),
	start_date: z.string().nullable().optional()
});

/** The member who connected Huntflow, as the reader of the disclosed contacts: the read is journaled as theirs. */
async function connectorSubject(db: Database, delivery: HuntflowDelivery): Promise<AccessSubject | null> {
	const [member] = await db
		.select({
			userId: companyMembers.userId,
			role: companyMembers.role,
			status: companyMembers.status,
			companyStatus: companies.status
		})
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.id, delivery.createdByMemberId), eq(companyMembers.companyId, delivery.companyId)));
	if (!member || member.status !== 'active' || member.userId === null) return null;
	return {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: delivery.createdByMemberId,
			companyId: delivery.companyId,
			role: member.role,
			status: member.status,
			companyStatus: member.companyStatus
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

function call(deps: HuntflowDeps, token: string, method: 'POST' | 'PUT', path: string, body: object) {
	return sendJson(method, `${deps.apiUrl.replace(/\/$/, '')}${path}`, JSON.stringify(body), {
		headers: { authorization: `Bearer ${token}` },
		timeoutMs: deps.timeoutMs,
		signal: deps.signal,
		// The address is the platform's configuration, not a company's.
		allowPrivateNetwork: true
	});
}

const ok = (result: PostResult): result is Extract<PostResult, { kind: 'answered' }> =>
	result.kind === 'answered' && result.status >= 200 && result.status < 300;

async function accepted(deps: HuntflowDeps, delivery: HuntflowDelivery): Promise<HuntflowOutcome> {
	if (delivery.invitationId === null) throw new Error('an accepted offer event names no offer');
	const [linked] = await deps.db
		.select({ id: atsLinks.id })
		.from(atsLinks)
		.where(and(eq(atsLinks.subscriptionId, delivery.subscriptionId), eq(atsLinks.invitationId, delivery.invitationId)));
	if (linked) return { kind: 'skipped', reason: 'already_linked' };
	const subject = await connectorSubject(deps.db, delivery);
	if (subject === null) return { kind: 'skipped', reason: 'connector_inactive' };
	let contacts;
	try {
		contacts = await recipientContacts(
			deps,
			subject,
			{ requestId: `event:${delivery.subscriptionId}` },
			delivery.invitationId
		);
	} catch (error) {
		// The candidate revoked the disclosure or the offer is gone: nothing may go to the ATS.
		if (error instanceof Refusal) return { kind: 'skipped', reason: 'contacts_not_disclosed' };
		throw error;
	}
	const { account_id: account } = delivery.settings;
	const created = await call(deps, delivery.token, 'POST', `/accounts/${account}/applicants`, applicantBody(contacts));
	if (!ok(created)) return { kind: 'failed', result: created };
	const applicant = z.looseObject({ id: z.int().positive() }).parse(JSON.parse(created.body));
	const [terms] = await deps.db
		.select({ title: invitationTerms.title })
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.acceptedTermsId))
		.where(eq(invitations.id, delivery.invitationId));
	const placed = await call(
		deps,
		delivery.token,
		'POST',
		`/accounts/${account}/applicants/${applicant.id}/vacancy`,
		vacancyStatusBody(delivery.settings, delivery.settings.statuses.accepted, {
			comment: `Принял предложение на платформе ФСП Карьера${terms ? `: «${terms.title}»` : ''}`
		})
	);
	await deps.db
		.insert(atsLinks)
		.values({
			subscriptionId: delivery.subscriptionId,
			invitationId: delivery.invitationId,
			externalId: String(applicant.id)
		})
		.onConflictDoNothing();
	return ok(placed) ? { kind: 'done', status: placed.status } : { kind: 'failed', result: placed };
}

async function reported(deps: HuntflowDeps, delivery: HuntflowDelivery): Promise<HuntflowOutcome> {
	const report = reportSchema.parse(delivery.payload);
	// The company's ATS follows the company's own reports; the candidate's word does not move its statuses.
	if (report.party !== 'company') return { kind: 'skipped', reason: 'candidate_report' };
	const key = report.kind === 'stage' ? report.value : report.value === 'hired' ? 'hired' : 'not_hired';
	const status = delivery.settings.statuses[key as keyof HuntflowSettings['statuses']];
	if (status === undefined) return { kind: 'skipped', reason: 'status_not_mapped' };
	if (delivery.invitationId === null) throw new Error('a hiring report event names no offer');
	const [link] = await deps.db
		.select({ externalId: atsLinks.externalId })
		.from(atsLinks)
		.where(and(eq(atsLinks.subscriptionId, delivery.subscriptionId), eq(atsLinks.invitationId, delivery.invitationId)));
	if (!link) return { kind: 'skipped', reason: 'applicant_not_linked' };
	const moved = await call(
		deps,
		delivery.token,
		'PUT',
		`/accounts/${delivery.settings.account_id}/applicants/${link.externalId}/vacancy`,
		vacancyStatusBody(delivery.settings, status, {
			...(key === 'hired' && report.start_date ? { employmentDate: report.start_date } : {})
		})
	);
	return ok(moved) ? { kind: 'done', status: moved.status } : { kind: 'failed', result: moved };
}

/** One event to Huntflow. */
export function deliverToHuntflow(deps: HuntflowDeps, delivery: HuntflowDelivery): Promise<HuntflowOutcome> {
	switch (delivery.eventType) {
		case 'invitation.accepted':
			return accepted(deps, delivery);
		case 'hiring.reported':
			return reported(deps, delivery);
		default:
			return Promise.resolve({ kind: 'skipped', reason: 'event_not_used' });
	}
}
