// Candidate profile, age and company block list (domain 7.1, 7.2); external profiles (domain 9.4).
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, timestamps, ts } from './_columns';
import { companies } from './companies';
import { demoSessions } from './demo';
import { users } from './identity';

const CANDIDATE_STATUSES = ['onboarding', 'active', 'ineligible_age', 'deletion_pending', 'deleted'] as const;
const BIRTH_DATE_PRECISIONS = ['day', 'year'] as const;
const BIRTH_DATE_SOURCES = ['self_declared', 'fsp_import', 'operator_document'] as const;
const BIRTH_DATE_STATUSES = ['unknown', 'unverified', 'verified', 'conflict'] as const;
const CANDIDATE_VISIBILITIES = ['hidden', 'catalog'] as const;
const SEARCH_STATUSES = ['active', 'open_to_offers', 'not_looking'] as const;

export const candidates = pgTable(
	'candidates',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.unique('candidates_user')
			.references(() => users.id),
		status: text({ enum: CANDIDATE_STATUSES }).notNull(),
		profileRevision: bigint({ mode: 'number' }).notNull().default(0),
		evidenceFloorRevision: bigint({ mode: 'number' }).notNull().default(0),
		lastNameEnc: bytea(),
		firstNameEnc: bytea(),
		middleNameEnc: bytea(),
		phoneEnc: bytea(),
		/** The Telegram contact the candidate states (`@handle`), encrypted. */
		telegramEnc: bytea(),
		birthDate: date({ mode: 'string' }),
		birthDatePrecision: text({ enum: BIRTH_DATE_PRECISIONS }),
		birthDateSource: text({ enum: BIRTH_DATE_SOURCES }),
		birthDateStatus: text({ enum: BIRTH_DATE_STATUSES }).notNull().default('unknown'),
		birthDateVerifiedBy: uuid().references(() => users.id),
		birthDateVerifiedAt: ts(),
		eligibleFrom: date({ mode: 'string' }),
		visibility: text({ enum: CANDIDATE_VISIBILITIES }).notNull().default('hidden'),
		searchStatus: text({ enum: SEARCH_STATUSES }).notNull(),
		headline: text(),
		desiredRoleKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		/** Soft skills the candidate states (keys of `profile/soft-skills.ts`): their own word, never matched on. */
		softSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		preferences: jsonb().notNull(),
		purgeAfter: date({ mode: 'string' }),
		seedBatchId: text(),
		/** The profile of a demo clone, of the same demo session as its account (domain 19.3). */
		demoSessionId: uuid().references(() => demoSessions.id),
		/** A hero of the demo scenario whose clones the demo sessions hold: not shown inside a session (domain 19.3). */
		demoOriginal: boolean().notNull().default(false),
		...timestamps()
	},
	(t) => [
		enumCheck('candidates', 'status', t.status, CANDIDATE_STATUSES),
		check('candidates_demo_original', sql`not ${t.demoOriginal} or ${t.demoSessionId} is null`),
		enumCheck('candidates', 'birth_date_precision', t.birthDatePrecision, BIRTH_DATE_PRECISIONS),
		enumCheck('candidates', 'birth_date_source', t.birthDateSource, BIRTH_DATE_SOURCES),
		enumCheck('candidates', 'birth_date_status', t.birthDateStatus, BIRTH_DATE_STATUSES),
		enumCheck('candidates', 'visibility', t.visibility, CANDIDATE_VISIBILITIES),
		enumCheck('candidates', 'search_status', t.searchStatus, SEARCH_STATUSES),
		check(
			'candidates_revisions',
			sql`${t.profileRevision} >= 0 and ${t.evidenceFloorRevision} >= 0 and ${t.evidenceFloorRevision} <= ${t.profileRevision}`
		),
		// Under 14 the birth date is replaced by the date of the 14th birthday (domain 7.3).
		check(
			'candidates_ineligible_age',
			sql`case when ${t.status} = 'ineligible_age'
				then ${t.birthDate} is null and ${t.eligibleFrom} is not null
				else ${t.eligibleFrom} is null end`
		),
		check(
			'candidates_birth_date_fields',
			sql`case when ${t.birthDate} is null
				then ${t.birthDatePrecision} is null and ${t.birthDateSource} is null and ${t.birthDateStatus} = 'unknown'
				else ${t.birthDatePrecision} is not null and ${t.birthDateSource} is not null and ${t.birthDateStatus} <> 'unknown' end`
		),
		check(
			'candidates_birth_date_verification',
			sql`(${t.birthDateStatus} = 'verified') = (${t.birthDateVerifiedAt} is not null)`
		),
		check('candidates_desired_roles', sql`cardinality(${t.desiredRoleKeys}) <= 3`),
		check('candidates_soft_skills', sql`cardinality(${t.softSkillKeys}) <= 12`),
		index('candidates_demo_session')
			.on(t.demoSessionId)
			.where(sql`${t.demoSessionId} is not null`),
		check(
			'candidates_tombstone',
			sql`${t.status} <> 'deleted' or (${t.lastNameEnc} is null and ${t.firstNameEnc} is null
				and ${t.middleNameEnc} is null and ${t.phoneEnc} is null and ${t.telegramEnc} is null and ${t.birthDate} is null
				and ${t.headline} is null and cardinality(${t.softSkillKeys}) = 0)`
		)
	]
);

/** Companies the candidate is not shown to (domain 7.1). */
export const candidateCompanyBlocks = pgTable(
	'candidate_company_blocks',
	{
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id, { onDelete: 'cascade' }),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [primaryKey({ name: 'candidate_company_blocks_pk', columns: [t.candidateId, t.companyId] })]
);

export const EXTERNAL_PLATFORMS = ['codeforces', 'github'] as const;
const OWNERSHIP_STATUSES = ['unverified', 'verified'] as const;
const OWNERSHIP_METHODS = ['oauth', 'handle_challenge'] as const;
export const EXTERNAL_SYNC_STATUSES = ['pending', 'ok', 'source_unavailable', 'not_found'] as const;

export const externalProfiles = pgTable(
	'external_profiles',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		platform: text({ enum: EXTERNAL_PLATFORMS }).notNull(),
		handle: text().notNull(),
		/** Stable account id of the platform where it has one (GitHub): a renamed account stays the same profile. */
		externalId: text(),
		ownershipStatus: text({ enum: OWNERSHIP_STATUSES }).notNull(),
		ownershipMethod: text({ enum: OWNERSHIP_METHODS }),
		verifiedAt: ts(),
		// One-time code of `handle_challenge`: shown to the candidate until it is found in the profile or expires.
		challengeCode: text(),
		challengeExpiresAt: ts(),
		challengeAttempts: integer().notNull().default(0),
		// Reading of the public data of a verified profile.
		syncStatus: text({ enum: EXTERNAL_SYNC_STATUSES }),
		/** Why the last reading failed, a code: `timeout`, `network`, `rate_limited`, `server_error`, `protocol_error`. */
		syncError: text(),
		syncCheckedAt: ts(),
		/** The last reading that got an answer from the source. */
		syncedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('external_profiles', 'platform', t.platform, EXTERNAL_PLATFORMS),
		enumCheck('external_profiles', 'ownership_status', t.ownershipStatus, OWNERSHIP_STATUSES),
		enumCheck('external_profiles', 'ownership_method', t.ownershipMethod, OWNERSHIP_METHODS),
		enumCheck('external_profiles', 'sync_status', t.syncStatus, EXTERNAL_SYNC_STATUSES),
		check(
			'external_profiles_verification',
			sql`(${t.ownershipStatus} = 'verified') = (${t.verifiedAt} is not null and ${t.ownershipMethod} is not null)`
		),
		check('external_profiles_challenge', sql`(${t.challengeCode} is null) = (${t.challengeExpiresAt} is null)`),
		// The code is one-time: a verified profile keeps none; only a verified profile is read.
		check('external_profiles_verified_state', sql`${t.ownershipStatus} <> 'verified' or ${t.challengeCode} is null`),
		check('external_profiles_sync_verified', sql`${t.syncStatus} is null or ${t.ownershipStatus} = 'verified'`),
		check('external_profiles_challenge_attempts', sql`${t.challengeAttempts} >= 0`),
		uniqueIndex('external_profiles_candidate_platform').on(t.candidateId, t.platform)
	]
);
