// Legal documents, consents, legal representatives and disclosures (domain 6).
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	inet,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import {
	CATALOG_SCOPE_FIELDS,
	CONSENT_KINDS,
	DISCLOSURE_FIELDS,
	DOCUMENT_KINDS,
	PUBLIC_SCOPE_FIELDS,
	REPRESENTATIVE_AUTHORITY_METHODS
} from '../../consent/kinds';
import { bytea, enumCheck, id, sha256Check, subsetOf, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { companies, companyMembers } from './companies';
import { files } from './documents';
import { invitations } from './hiring';
import { users } from './identity';

export const pdOperators = pgTable(
	'pd_operators',
	{
		id: id(),
		legalName: text().notNull(),
		inn: text().notNull(),
		ogrn: text().notNull(),
		address: text().notNull(),
		contactEmail: text().notNull(),
		validFrom: date({ mode: 'string' }).notNull(),
		validTo: date({ mode: 'string' }),
		...timestamps()
	},
	(t) => [check('pd_operators_validity', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`)]
);

const DOCUMENT_FORMS = ['electronic_separate_screen', 'electronic_signature'] as const;

/** Immutable once published: a trigger rejects changes except setting `superseded_at` (migration 0002). */
export const legalDocuments = pgTable(
	'legal_documents',
	{
		id: id(),
		kind: text({ enum: DOCUMENT_KINDS }).notNull(),
		version: integer().notNull(),
		title: text().notNull(),
		body: text().notNull(),
		bodySha256: text().notNull(),
		pdOperatorId: uuid()
			.notNull()
			.references(() => pdOperators.id),
		operatorSnapshot: jsonb().notNull(),
		processorsSnapshot: jsonb().notNull(),
		purposes: text().array().notNull(),
		dataCategories: text().array().notNull(),
		operations: text().array().notNull(),
		form: text({ enum: DOCUMENT_FORMS }).notNull(),
		available: boolean().notNull(),
		requiresReconsent: boolean().notNull(),
		publishedAt: ts(),
		supersededAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('legal_documents', 'kind', t.kind, DOCUMENT_KINDS),
		enumCheck('legal_documents', 'form', t.form, DOCUMENT_FORMS),
		sha256Check('legal_documents', 'body_sha256', t.bodySha256),
		check('legal_documents_version_positive', sql`${t.version} >= 1`),
		check(
			'legal_documents_superseded_after_publication',
			sql`${t.supersededAt} is null or ${t.publishedAt} is not null`
		),
		unique('legal_documents_kind_version').on(t.kind, t.version)
	]
);

/** Acceptance of agreements that are not personal-data consents. Append-only. */
export const documentAcceptances = pgTable(
	'document_acceptances',
	{
		id: id(),
		documentId: uuid()
			.notNull()
			.references(() => legalDocuments.id),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		companyId: uuid().references((): AnyPgColumn => companies.id),
		acceptedAt: ts().notNull(),
		ip: inet(),
		ua: text()
	},
	(t) => [index('document_acceptances_user').on(t.userId), index('document_acceptances_company').on(t.companyId)]
);

const CONSENT_ACTIONS = ['grant', 'revoke', 'lapse'] as const;
const CONSENT_SIGNER_KINDS = ['subject', 'representative', 'system'] as const;
const CONSENT_METHODS = ['separate_screen_button', 'email_link', 'esign', 'system'] as const;

/**
 * Append-only consent history. A trigger (migration 0002) also checks that `kind` matches the document and that
 * a grant of a document with `form = electronic_signature` carries a signature reference in `evidence`.
 */
export const consentEvents = pgTable(
	'consent_events',
	{
		id: id(),
		subjectCandidateId: uuid()
			.notNull()
			.references((): AnyPgColumn => candidates.id),
		kind: text({ enum: CONSENT_KINDS }).notNull(),
		documentId: uuid()
			.notNull()
			.references(() => legalDocuments.id),
		action: text({ enum: CONSENT_ACTIONS }).notNull(),
		signerKind: text({ enum: CONSENT_SIGNER_KINDS }).notNull(),
		signerUserId: uuid().references(() => users.id),
		representationId: uuid().references((): AnyPgColumn => representations.id),
		scopeCompanyId: uuid().references((): AnyPgColumn => companies.id),
		scopeInvitationId: uuid().references((): AnyPgColumn => invitations.id),
		scopeCompetitionRef: text(),
		scopeFields: text().array(),
		choices: jsonb(),
		method: text({ enum: CONSENT_METHODS }).notNull(),
		evidence: jsonb().notNull(),
		reason: text(),
		occurredAt: ts().notNull()
	},
	(t) => [
		enumCheck('consent_events', 'kind', t.kind, CONSENT_KINDS),
		enumCheck('consent_events', 'action', t.action, CONSENT_ACTIONS),
		enumCheck('consent_events', 'signer_kind', t.signerKind, CONSENT_SIGNER_KINDS),
		enumCheck('consent_events', 'method', t.method, CONSENT_METHODS),
		check(
			'consent_events_signer',
			sql`case ${t.signerKind}
				when 'subject' then ${t.signerUserId} is not null and ${t.representationId} is null and ${t.method} <> 'system'
				when 'representative' then ${t.representationId} is not null and ${t.signerUserId} is null and ${t.method} <> 'system'
				else ${t.action} = 'lapse' and ${t.method} = 'system' and ${t.signerUserId} is null and ${t.representationId} is null end`
		),
		// Kinds that only an adult subject signs (domain 6.2).
		check(
			'consent_events_adult_only_kinds',
			sql`${t.kind} not in ('partner_pool', 'public_distribution', 'demo_resume_upload') or ${t.signerKind} <> 'representative'`
		),
		check(
			'consent_events_scope',
			sql`case ${t.kind}
				when 'contact_disclosure' then ${t.scopeCompanyId} is not null and ${t.scopeInvitationId} is not null and ${t.scopeCompetitionRef} is null
				when 'partner_pool' then ${t.scopeCompetitionRef} is not null and ${t.scopeCompanyId} is null and ${t.scopeInvitationId} is null
				else ${t.scopeCompanyId} is null and ${t.scopeInvitationId} is null and ${t.scopeCompetitionRef} is null end`
		),
		check(
			'consent_events_scope_fields',
			sql`case ${t.kind}
				when 'catalog_visibility' then ${t.scopeFields} is null or ${subsetOf(t.scopeFields, CATALOG_SCOPE_FIELDS)}
				when 'contact_disclosure' then ${t.action} <> 'grant'
					or (${subsetOf(t.scopeFields, DISCLOSURE_FIELDS)} and ${t.scopeFields} @> array['full_name', 'email']::text[])
				when 'public_distribution' then ${t.scopeFields} is null or ${subsetOf(t.scopeFields, PUBLIC_SCOPE_FIELDS)}
				else ${t.scopeFields} is null end`
		),
		index('consent_events_subject_kind').on(t.subjectCandidateId, t.kind, t.occurredAt),
		index('consent_events_representation').on(t.representationId)
	]
);

export const legalRepresentatives = pgTable(
	'legal_representatives',
	{
		id: id(),
		fullNameEnc: bytea().notNull(),
		emailEnc: bytea().notNull(),
		emailHmac: text().notNull(),
		phoneEnc: bytea(),
		...timestamps()
	},
	(t) => [index('legal_representatives_email_hmac').on(t.emailHmac)]
);

const REPRESENTATION_RELATIONS = ['parent', 'adoptive_parent', 'guardian', 'custodian'] as const;
const REPRESENTATION_STATUSES = [
	'invited',
	'contact_confirmed',
	'authority_pending',
	'authority_verified',
	'ended'
] as const;
const REPRESENTATION_END_REASONS = [
	'majority',
	'revoked_by_representative',
	'authority_rejected',
	'operator_revoked',
	'candidate_deleted',
	'invitation_expired'
] as const;

export const representations = pgTable(
	'representations',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references((): AnyPgColumn => candidates.id),
		representativeId: uuid()
			.notNull()
			.references(() => legalRepresentatives.id),
		relation: text({ enum: REPRESENTATION_RELATIONS }).notNull(),
		status: text({ enum: REPRESENTATION_STATUSES }).notNull(),
		invitedAt: ts().notNull(),
		contactConfirmedAt: ts(),
		endedAt: ts(),
		endReason: text({ enum: REPRESENTATION_END_REASONS }),
		...timestamps()
	},
	(t) => [
		enumCheck('representations', 'relation', t.relation, REPRESENTATION_RELATIONS),
		enumCheck('representations', 'status', t.status, REPRESENTATION_STATUSES),
		enumCheck('representations', 'end_reason', t.endReason, REPRESENTATION_END_REASONS),
		check(
			'representations_end',
			sql`(${t.status} = 'ended') = (${t.endedAt} is not null) and (${t.status} = 'ended') = (${t.endReason} is not null)`
		),
		check(
			'representations_contact_confirmed',
			sql`${t.status} not in ('contact_confirmed', 'authority_pending', 'authority_verified') or ${t.contactConfirmedAt} is not null`
		),
		index('representations_candidate').on(t.candidateId)
	]
);

const AUTHORITY_CHECK_METHODS = REPRESENTATIVE_AUTHORITY_METHODS;
const AUTHORITY_BASIS_KINDS = [
	'birth_certificate',
	'adoption_decision',
	'guardianship_act',
	'custodianship_act'
] as const;
const AUTHORITY_CHECK_RESULTS = ['verified', 'rejected'] as const;

export const authorityChecks = pgTable(
	'authority_checks',
	{
		id: id(),
		representationId: uuid()
			.notNull()
			.references(() => representations.id),
		method: text({ enum: AUTHORITY_CHECK_METHODS }).notNull(),
		basisKind: text({ enum: AUTHORITY_BASIS_KINDS }).notNull(),
		basisNote: text(),
		evidenceFileId: uuid().references((): AnyPgColumn => files.id),
		evidenceRetentionUntil: date({ mode: 'string' }),
		checkedBy: uuid()
			.notNull()
			.references(() => users.id),
		checkedAt: ts().notNull(),
		result: text({ enum: AUTHORITY_CHECK_RESULTS }).notNull(),
		note: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('authority_checks', 'method', t.method, AUTHORITY_CHECK_METHODS),
		enumCheck('authority_checks', 'basis_kind', t.basisKind, AUTHORITY_BASIS_KINDS),
		enumCheck('authority_checks', 'result', t.result, AUTHORITY_CHECK_RESULTS),
		// A copy of the document is stored only for document_upload, always with its own retention date.
		check('authority_checks_evidence_method', sql`${t.evidenceFileId} is null or ${t.method} = 'document_upload'`),
		check(
			'authority_checks_evidence_retention',
			sql`(${t.evidenceFileId} is null) = (${t.evidenceRetentionUntil} is null)`
		),
		index('authority_checks_representation').on(t.representationId)
	]
);

const DISCLOSURE_CHANNELS = ['ui', 'api'] as const;

/** Append-only journal of identifying data handed to a company (domain 6.5). */
export const disclosures = pgTable(
	'disclosures',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references((): AnyPgColumn => candidates.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		recipientMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		invitationId: uuid()
			.notNull()
			.references((): AnyPgColumn => invitations.id),
		consentEventId: uuid()
			.notNull()
			.references(() => consentEvents.id),
		fields: text().array().notNull(),
		channel: text({ enum: DISCLOSURE_CHANNELS }).notNull(),
		disclosedAt: ts().notNull()
	},
	(t) => [
		enumCheck('disclosures', 'channel', t.channel, DISCLOSURE_CHANNELS),
		check('disclosures_fields', sql`cardinality(${t.fields}) > 0 and ${subsetOf(t.fields, DISCLOSURE_FIELDS)}`),
		index('disclosures_candidate').on(t.candidateId),
		index('disclosures_invitation').on(t.invitationId)
	]
);
