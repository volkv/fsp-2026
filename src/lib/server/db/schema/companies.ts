// Companies, verification, membership, API keys and competition partnerships (domain 5).
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { legalDocuments } from './consent';
import { demoSessions } from './demo';
import { files } from './documents';
import { users } from './identity';

const COMPANY_STATUSES = ['draft', 'submitted', 'verified', 'rejected', 'suspended'] as const;

export const companies = pgTable(
	'companies',
	{
		id: id(),
		inn: text().notNull(),
		ogrn: text(),
		kpp: text(),
		legalName: text().notNull(),
		displayName: text().notNull(),
		status: text({ enum: COMPANY_STATUSES }).notNull(),
		/** About the organization, up to 3000 characters; required to send an offer (domain 5.1, 13.5). */
		description: text(),
		/** Line of business, up to 200 characters; required with the description. */
		activity: text(),
		/** Contacts of the organization, not of an employee: `{website?, email?, phone?, telegram?}`. */
		contacts: jsonb(),
		registrySnapshot: jsonb(),
		verifiedAt: ts(),
		minorTermsDocumentId: uuid().references((): AnyPgColumn => legalDocuments.id),
		/** The company was created by the demo seed (domain 7.1: demonstration records are labelled). */
		seedBatchId: text(),
		/** A clone of a demo company in this demo session (domain 19.3); removed with the session. */
		demoSessionId: uuid().references(() => demoSessions.id),
		/** A company of the demo scenario whose clones the demo sessions hold: not shown inside a session (domain 19.3). */
		demoOriginal: boolean().notNull().default(false),
		/** The original a clone of the demo session was copied from: the same company within the session (domain 19.3). */
		demoCloneOf: uuid().references((): AnyPgColumn => companies.id),
		...timestamps()
	},
	(t) => [
		enumCheck('companies', 'status', t.status, COMPANY_STATUSES),
		check('companies_description_length', sql`char_length(${t.description}) between 1 and 3000`),
		check('companies_activity_length', sql`char_length(${t.activity}) between 1 and 200`),
		check('companies_contacts_object', sql`jsonb_typeof(${t.contacts}) = 'object'`),
		check('companies_demo_original', sql`not ${t.demoOriginal} or ${t.demoSessionId} is null`),
		check('companies_demo_clone_of', sql`${t.demoCloneOf} is null or ${t.demoSessionId} is not null`),
		// Length and digits only; the checksum is verified by the application.
		check('companies_inn_format', sql`${t.inn} ~ '^([0-9]{10}|[0-9]{12})$'`),
		// A suspended company may never have been verified: the admission policy lets a company act before its check.
		check('companies_verified_at', sql`${t.status} <> 'verified' or ${t.verifiedAt} is not null`),
		// One live company per taxpayer number outside sessions and, separately, within each demo session: the clone of a
		// company of the cast keeps its number, and visitors of different sessions register the same one (domain 19.3).
		uniqueIndex('companies_inn_not_rejected')
			.on(t.inn)
			.where(sql`${t.status} <> 'rejected' and ${t.demoSessionId} is null`),
		uniqueIndex('companies_inn_not_rejected_demo')
			.on(t.inn, t.demoSessionId)
			.where(sql`${t.status} <> 'rejected' and ${t.demoSessionId} is not null`),
		index('companies_demo_session')
			.on(t.demoSessionId)
			.where(sql`${t.demoSessionId} is not null`)
	]
);

const MEMBER_ROLES = ['owner', 'recruiter'] as const;
const MEMBER_STATUSES = ['invited', 'active', 'removed'] as const;

export const companyMembers = pgTable(
	'company_members',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		userId: uuid().references(() => users.id),
		invitedEmailHmac: text(),
		role: text({ enum: MEMBER_ROLES }).notNull(),
		status: text({ enum: MEMBER_STATUSES }).notNull(),
		invitedBy: uuid().references(() => users.id),
		joinedAt: ts(),
		removedAt: ts(),
		removedBy: uuid().references(() => users.id),
		...timestamps()
	},
	(t) => [
		enumCheck('company_members', 'role', t.role, MEMBER_ROLES),
		enumCheck('company_members', 'status', t.status, MEMBER_STATUSES),
		check(
			'company_members_status_fields',
			sql`case ${t.status}
				when 'invited' then ${t.invitedEmailHmac} is not null
				when 'active' then ${t.userId} is not null and ${t.joinedAt} is not null
				else ${t.removedAt} is not null end`
		),
		uniqueIndex('company_members_active_user')
			.on(t.companyId, t.userId)
			.where(sql`${t.status} = 'active'`),
		index('company_members_user').on(t.userId)
	]
);

const AUTHORITY_METHODS = [
	'director_self',
	'power_of_attorney',
	'corporate_email_domain',
	'signed_letter',
	'esign'
] as const;
const VERIFICATION_DECISIONS = ['approved', 'rejected', 'needs_info'] as const;

export const companyVerifications = pgTable(
	'company_verifications',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		applicantMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		registryCheck: jsonb(),
		authorityMethod: text({ enum: AUTHORITY_METHODS }).notNull(),
		authorityEvidenceFileId: uuid().references((): AnyPgColumn => files.id),
		decision: text({ enum: VERIFICATION_DECISIONS }),
		decidedBy: uuid().references(() => users.id),
		decidedAt: ts(),
		reason: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('company_verifications', 'authority_method', t.authorityMethod, AUTHORITY_METHODS),
		enumCheck('company_verifications', 'decision', t.decision, VERIFICATION_DECISIONS),
		check(
			'company_verifications_decision_fields',
			sql`(${t.decision} is null) = (${t.decidedBy} is null) and (${t.decision} is null) = (${t.decidedAt} is null)`
		),
		check(
			'company_verifications_rejection_reason',
			sql`${t.decision} not in ('rejected', 'needs_info') or ${t.reason} is not null`
		),
		index('company_verifications_company').on(t.companyId),
		// One open request per company.
		uniqueIndex('company_verifications_open')
			.on(t.companyId)
			.where(sql`${t.decision} is null`)
	]
);

export const apiKeys = pgTable(
	'api_keys',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		name: text().notNull(),
		prefix: text().notNull().unique('api_keys_prefix'),
		secretHash: text().notNull().unique('api_keys_secret_hash'),
		permissions: text().array().notNull(),
		expiresAt: ts(),
		lastUsedAt: ts(),
		revokedAt: ts(),
		...timestamps()
	},
	(t) => [
		check('api_keys_prefix_format', sql`char_length(${t.prefix}) = 8`),
		sha256Check('api_keys', 'secret_hash', t.secretHash),
		index('api_keys_member').on(t.createdByMemberId)
	]
);

const PARTNERSHIP_SOURCES = ['fsp'] as const;
const PARTNERSHIP_KINDS = ['case_provider', 'sponsor', 'organizer_partner'] as const;
const PARTNERSHIP_STATUSES = ['active', 'ended'] as const;

export const competitionPartnerships = pgTable(
	'competition_partnerships',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		competitionRef: text().notNull(),
		competitionSource: text({ enum: PARTNERSHIP_SOURCES }).notNull(),
		kind: text({ enum: PARTNERSHIP_KINDS }).notNull(),
		poolRule: jsonb().notNull(),
		status: text({ enum: PARTNERSHIP_STATUSES }).notNull(),
		validFrom: date({ mode: 'string' }).notNull(),
		validTo: date({ mode: 'string' }),
		grantedBy: uuid()
			.notNull()
			.references(() => users.id),
		basis: text().notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('competition_partnerships', 'competition_source', t.competitionSource, PARTNERSHIP_SOURCES),
		enumCheck('competition_partnerships', 'kind', t.kind, PARTNERSHIP_KINDS),
		enumCheck('competition_partnerships', 'status', t.status, PARTNERSHIP_STATUSES),
		check('competition_partnerships_validity', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
		index('competition_partnerships_competition').on(t.competitionSource, t.competitionRef),
		index('competition_partnerships_company').on(t.companyId)
	]
);
