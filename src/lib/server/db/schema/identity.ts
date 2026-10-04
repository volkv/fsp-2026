// Users, local credentials, external identities and staff roles (domain 3, 4.1).
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { STAFF_EXTRA_PERMISSIONS } from '../../access/permissions';
import { bytea, enumCheck, id, sha256Check, subsetOf, timestamps, ts } from './_columns';
import { demoSessions } from './demo';

const USER_STATUSES = ['pending_email', 'active', 'suspended', 'deletion_pending', 'deleted'] as const;

export const users = pgTable(
	'users',
	{
		id: id(),
		status: text({ enum: USER_STATUSES }).notNull(),
		emailEnc: bytea(),
		emailHmac: text(),
		emailVerifiedAt: ts(),
		displayName: text(),
		lockedUntil: ts(),
		lastLoginAt: ts(),
		deletionRequestedAt: ts(),
		deletedAt: ts(),
		/**
		 * The account was created by the demo seed (a batch of `seeds/`) or cloned from a demo account; `null` — a real
		 * account. Demonstration records are labelled so analytics and the reset can tell them apart (domain 7.1, 19.2).
		 */
		seedBatchId: text(),
		/** A clone of a demo account in this demo session (domain 19.3); removed with the session. */
		demoSessionId: uuid().references((): AnyPgColumn => demoSessions.id),
		...timestamps()
	},
	(t) => [
		enumCheck('users', 'status', t.status, USER_STATUSES),
		// A tombstone keeps only id, status and deleted_at; every other user keeps an address.
		check(
			'users_tombstone',
			sql`case when ${t.status} = 'deleted'
				then ${t.emailEnc} is null and ${t.emailHmac} is null and ${t.displayName} is null and ${t.deletedAt} is not null
				else ${t.emailEnc} is not null and ${t.emailHmac} is not null and ${t.deletedAt} is null end`
		),
		uniqueIndex('users_email_hmac_live')
			.on(t.emailHmac)
			.where(sql`${t.status} <> 'deleted'`),
		index('users_demo_session')
			.on(t.demoSessionId)
			.where(sql`${t.demoSessionId} is not null`)
	]
);

export const passwordCredentials = pgTable('password_credentials', {
	userId: uuid()
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	hash: text().notNull(),
	changedAt: ts().notNull(),
	...timestamps()
});

/**
 * `representative_consent` and `representative_disclosure` are the links of a legal representative, who has no account:
 * signing the consents after the authority check, and the answer on the disclosure of one invitation (domain 6.4).
 */
const EMAIL_TOKEN_PURPOSES = [
	'verify_email',
	'reset_password',
	'member_invite',
	'representative_invite',
	'representative_consent',
	'representative_disclosure'
] as const;

export const emailTokens = pgTable(
	'email_tokens',
	{
		id: id(),
		purpose: text({ enum: EMAIL_TOKEN_PURPOSES }).notNull(),
		tokenHash: text().notNull().unique('email_tokens_token_hash'),
		userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
		targetRef: uuid(),
		expiresAt: ts().notNull(),
		usedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('email_tokens', 'purpose', t.purpose, EMAIL_TOKEN_PURPOSES),
		sha256Check('email_tokens', 'token_hash', t.tokenHash),
		check(
			'email_tokens_target',
			sql`case when ${t.purpose} in ('verify_email', 'reset_password')
				then ${t.userId} is not null and ${t.targetRef} is null
				else ${t.targetRef} is not null end`
		)
	]
);

const IDENTITY_LINK_METHODS = ['signup_via_provider', 'linked_by_user'] as const;

export const externalIdentities = pgTable(
	'external_identities',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		issuer: text().notNull(),
		subject: text().notNull(),
		linkedAt: ts().notNull(),
		linkMethod: text({ enum: IDENTITY_LINK_METHODS }).notNull(),
		lastLoginAt: ts(),
		profileClaims: jsonb(),
		/**
		 * The identity of an account in this demo session (domain 19.3) — of a clone of the cast or of an account the
		 * visitor signed up with FSP ID within the session; `null` — of a real account or of an account of the seed.
		 */
		demoSessionId: uuid().references((): AnyPgColumn => demoSessions.id),
		...timestamps()
	},
	(t) => [
		enumCheck('external_identities', 'link_method', t.linkMethod, IDENTITY_LINK_METHODS),
		// One account per identity outside demo sessions, and one per identity within each demo session.
		uniqueIndex('external_identities_issuer_subject')
			.on(t.issuer, t.subject)
			.where(sql`${t.demoSessionId} is null`),
		uniqueIndex('external_identities_issuer_subject_demo')
			.on(t.issuer, t.subject, t.demoSessionId)
			.where(sql`${t.demoSessionId} is not null`),
		index('external_identities_user').on(t.userId)
	]
);

const ATHLETE_SOURCES = ['fsp'] as const;
const ATHLETE_RESOLUTION_METHODS = [
	'subject_equals_athlete_id',
	'resolved_by_source_api',
	'operator_confirmed'
] as const;
const ATHLETE_LINK_STATUSES = ['active', 'unlinked'] as const;

export const athleteLinks = pgTable(
	'athlete_links',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		source: text({ enum: ATHLETE_SOURCES }).notNull(),
		sourceAthleteId: text().notNull(),
		// The identity may be removed on unlink (contracts 2.5) while the link stays as `unlinked`.
		basisIdentityId: uuid().references((): AnyPgColumn => externalIdentities.id, { onDelete: 'set null' }),
		resolutionMethod: text({ enum: ATHLETE_RESOLUTION_METHODS }).notNull(),
		status: text({ enum: ATHLETE_LINK_STATUSES }).notNull(),
		linkedAt: ts().notNull(),
		unlinkedAt: ts(),
		/**
		 * The link of a clone in this demo session (domain 19.3): active within the session, never synchronized with the
		 * source; `null` — the link of a real account or of an original of the cast.
		 */
		demoSessionId: uuid().references((): AnyPgColumn => demoSessions.id),
		...timestamps()
	},
	(t) => [
		enumCheck('athlete_links', 'source', t.source, ATHLETE_SOURCES),
		enumCheck('athlete_links', 'resolution_method', t.resolutionMethod, ATHLETE_RESOLUTION_METHODS),
		enumCheck('athlete_links', 'status', t.status, ATHLETE_LINK_STATUSES),
		check(
			'athlete_links_status_fields',
			sql`case when ${t.status} = 'active'
				then ${t.unlinkedAt} is null and ${t.basisIdentityId} is not null
				else ${t.unlinkedAt} is not null end`
		),
		// One active account per athlete outside demo sessions, and one per athlete within each demo session.
		uniqueIndex('athlete_links_active_athlete')
			.on(t.source, t.sourceAthleteId)
			.where(sql`${t.status} = 'active' and ${t.demoSessionId} is null`),
		uniqueIndex('athlete_links_active_athlete_demo')
			.on(t.source, t.sourceAthleteId, t.demoSessionId)
			.where(sql`${t.status} = 'active' and ${t.demoSessionId} is not null`),
		index('athlete_links_user').on(t.userId)
	]
);

const STAFF_ROLES = ['operator', 'admin'] as const;

export const staffRoles = pgTable(
	'staff_roles',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		role: text({ enum: STAFF_ROLES }).notNull(),
		/** Permissions granted on top of the role (domain 4.1: `audit.read` for an operator). */
		extraPermissions: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		grantedBy: uuid().references(() => users.id),
		grantedAt: ts().notNull(),
		revokedAt: ts(),
		revokedBy: uuid().references(() => users.id)
	},
	(t) => [
		enumCheck('staff_roles', 'role', t.role, STAFF_ROLES),
		check('staff_roles_extra_permissions_values', subsetOf(t.extraPermissions, STAFF_EXTRA_PERMISSIONS)),
		check(
			'staff_roles_extra_permissions_operator',
			sql`${t.role} = 'operator' or cardinality(${t.extraPermissions}) = 0`
		),
		check('staff_roles_revocation', sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`),
		uniqueIndex('staff_roles_active')
			.on(t.userId, t.role)
			.where(sql`${t.revokedAt} is null`)
	]
);
