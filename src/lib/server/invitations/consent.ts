// `effectiveConsent(candidate, contact_disclosure, invitation | application, at)` (docs/domain.md, sections 6.3, 13.6):
// the consent to hand identifying data to the company of one invitation or of one application of the candidate. Grants
// of other invitations and applications give this company nothing.
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { effectiveConsent, type ConsentEventFacts } from '$lib/server/consent/effective';
import { DISCLOSURE_FIELDS, type DisclosureField } from '$lib/server/consent/kinds';
import type { Executor } from '$lib/server/db';
import {
	applications,
	candidates,
	consentEvents,
	invitations,
	legalDocuments,
	representations,
	resumeDocuments
} from '$lib/server/db/schema';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';

interface DisclosureEvent extends ConsentEventFacts {
	documentId: string;
	scopeFields: string[] | null;
}

export interface EffectiveDisclosure {
	/** The subject's grant in effect. */
	consentEventId: string;
	documentId: string;
	/**
	 * Fields the company may receive: the subject's choice; for ages 14–17 only what the verified representative
	 * granted as well.
	 */
	fields: DisclosureField[];
}

function disclosureFields(event: DisclosureEvent): DisclosureField[] {
	return (event.scopeFields ?? []).map((field) => {
		const known = DISCLOSURE_FIELDS.find((allowed) => allowed === field);
		if (!known) throw new Error(`contact_disclosure event ${event.id} has an unknown field`);
		return known;
	});
}

/**
 * The disclosure consent in effect at `at` for an invitation or for the candidate's own application (domain 13.6);
 * `null` — none (never given, revoked, lapsed).
 */
export async function effectiveDisclosure(
	executor: Executor,
	candidateId: string,
	scope: { invitationId: string } | { applicationId: string },
	at: Date
): Promise<EffectiveDisclosure | null> {
	const [candidate] = await executor
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) return null;
	const birth = { birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.status };

	const events: DisclosureEvent[] = await executor
		.select({
			id: consentEvents.id,
			action: consentEvents.action,
			signerKind: consentEvents.signerKind,
			representationId: consentEvents.representationId,
			occurredAt: consentEvents.occurredAt,
			documentVersion: legalDocuments.version,
			documentId: consentEvents.documentId,
			scopeFields: consentEvents.scopeFields
		})
		.from(consentEvents)
		.innerJoin(legalDocuments, eq(legalDocuments.id, consentEvents.documentId))
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'contact_disclosure'),
				'invitationId' in scope
					? eq(consentEvents.scopeInvitationId, scope.invitationId)
					: eq(consentEvents.scopeApplicationId, scope.applicationId),
				lte(consentEvents.occurredAt, at)
			)
		)
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
	if (events.length === 0) return null;

	const reconsent = await executor
		.select({ version: legalDocuments.version })
		.from(legalDocuments)
		.where(
			and(
				eq(legalDocuments.kind, 'contact_disclosure'),
				eq(legalDocuments.requiresReconsent, true),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, at)
			)
		);
	const representationIds = [...new Set(events.flatMap((e) => (e.representationId ? [e.representationId] : [])))];
	const verified =
		representationIds.length === 0
			? []
			: await executor
					.select({ id: representations.id })
					.from(representations)
					.where(and(inArray(representations.id, representationIds), eq(representations.status, 'authority_verified')));

	const grant = effectiveConsent(events, {
		birth,
		at,
		reconsentVersions: reconsent.map((r) => r.version),
		verifiedRepresentationIds: new Set(verified.map((r) => r.id))
	});
	if (!grant) return null;
	let fields = disclosureFields(grant);
	if (isMinorBand(ageBand(birth, at))) {
		const representative = events.filter((e) => e.signerKind === 'representative' && e.action === 'grant').at(-1);
		if (!representative) throw new Error('an effective consent of a minor has a representative grant');
		const allowed = new Set(disclosureFields(representative));
		fields = fields.filter((field) => allowed.has(field));
	}
	return { consentEventId: grant.id, documentId: grant.documentId, fields };
}

/**
 * The company holds the candidate's contacts at `at`: a disclosure consent is in effect for one of its offers to the
 * candidate or for one of the candidate's applications to it not withdrawn. Until then the candidate's free text reaches
 * the company with its contacts masked (`visibility/contact-mask.ts`).
 */
export async function companyHoldsContacts(
	executor: Executor,
	pair: { candidateId: string; companyId: string },
	at: Date
): Promise<boolean> {
	const [offers, own] = await Promise.all([
		executor
			.select({ id: invitations.id })
			.from(invitations)
			.where(
				and(
					eq(invitations.candidateId, pair.candidateId),
					eq(invitations.companyId, pair.companyId),
					isNull(invitations.purgedAt)
				)
			),
		executor
			.select({ id: applications.id })
			.from(applications)
			.where(
				and(
					eq(applications.candidateId, pair.candidateId),
					eq(applications.companyId, pair.companyId),
					isNull(applications.purgedAt),
					ne(applications.status, 'withdrawn')
				)
			)
	]);
	for (const offer of offers) {
		if (await effectiveDisclosure(executor, pair.candidateId, { invitationId: offer.id }, at)) return true;
	}
	for (const application of own) {
		if (await effectiveDisclosure(executor, pair.candidateId, { applicationId: application.id }, at)) return true;
	}
	return false;
}

/** The current published text of the disclosure consent; the candidate accepts this exact version. */
export async function currentDisclosureDocument(
	executor: Executor,
	at: Date
): Promise<{ id: string; bodySha256: string } | null> {
	const [row] = await executor
		.select({ id: legalDocuments.id, bodySha256: legalDocuments.bodySha256 })
		.from(legalDocuments)
		.where(
			and(
				eq(legalDocuments.kind, 'contact_disclosure'),
				eq(legalDocuments.available, true),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, at),
				isNull(legalDocuments.supersededAt)
			)
		)
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	return row ?? null;
}

/**
 * The disclosure fields the candidate's profile has no value for — no phone, no Telegram, no current resume: allowing
 * them hands the company nothing, so the forms say so next to the field.
 */
export async function emptyDisclosureFields(executor: Executor, candidateId: string): Promise<DisclosureField[]> {
	const [row] = await executor
		.select({ phone: candidates.phoneEnc, telegram: candidates.telegramEnc })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	const [resume] = await executor
		.select({ id: resumeDocuments.id })
		.from(resumeDocuments)
		.where(and(eq(resumeDocuments.candidateId, candidateId), eq(resumeDocuments.isCurrent, true)))
		.limit(1);
	const empty: DisclosureField[] = [];
	if (row.phone === null) empty.push('phone');
	if (row.telegram === null) empty.push('telegram');
	if (!resume) empty.push('resume');
	return empty;
}
