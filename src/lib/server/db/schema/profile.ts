// The candidate's own profile fields beyond the evidence (docs/domain.md, sections 7.1, 12.9, 23): experience stated by
// hand, what the reading of a resume suggests for the name, the contacts and the soft skills, and the signed
// confirmations of a category the QR code of the PDF profile leads to.
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { gradeDecisions } from './assessments';
import { candidateCategories } from './categories';
import { candidates } from './candidates';
import { documentExtractions } from './documents';

/** Lengths of the hand-written fields (domain 7.1). */
export const PROFILE_TEXT_LIMITS = { title: 200, organization: 200, description: 1000 } as const;

/** Experience the candidate states by hand: their own words, without a quote and without a document behind them. */
export const profileExperienceEntries = pgTable(
	'profile_experience_entries',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		positionTitle: text().notNull(),
		organizationName: text(),
		roleKey: text(),
		/** The first day of the month the job started. */
		periodFrom: date({ mode: 'string' }).notNull(),
		/** The first day of the month the job ended; `null` while it goes on. */
		periodTo: date({ mode: 'string' }),
		isCurrent: boolean().notNull(),
		skillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		description: text(),
		...timestamps()
	},
	(t) => [
		check(
			'profile_experience_entries_title_length',
			sql`char_length(${t.positionTitle}) between 1 and ${sql.raw(String(PROFILE_TEXT_LIMITS.title))}`
		),
		check(
			'profile_experience_entries_organization_length',
			sql`char_length(${t.organizationName}) between 1 and ${sql.raw(String(PROFILE_TEXT_LIMITS.organization))}`
		),
		check(
			'profile_experience_entries_description_length',
			sql`char_length(${t.description}) between 1 and ${sql.raw(String(PROFILE_TEXT_LIMITS.description))}`
		),
		check('profile_experience_entries_period', sql`(${t.isCurrent}) = (${t.periodTo} is null)`),
		check('profile_experience_entries_order', sql`${t.periodTo} is null or ${t.periodTo} >= ${t.periodFrom}`),
		check('profile_experience_entries_skills', sql`cardinality(${t.skillKeys}) <= 30`),
		index('profile_experience_entries_candidate').on(t.candidateId)
	]
);

/** Fields of the profile a resume can suggest a value for (contracts 3.2, `resume-extract/v3`). */
export const PROFILE_SUGGESTION_FIELDS = ['full_name', 'phone', 'email', 'telegram', 'soft_skill'] as const;
export const PROFILE_SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;

/**
 * A value of a profile field found in the candidate's resume, with the place of its quote in the extraction text: the
 * candidate accepts it into the profile or rejects it. The name and the contacts are encrypted; the quote is kept as
 * offsets only, its text is the extraction's.
 */
export const profileSuggestions = pgTable(
	'profile_suggestions',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		extractionId: uuid()
			.notNull()
			.references(() => documentExtractions.id),
		field: text({ enum: PROFILE_SUGGESTION_FIELDS }).notNull(),
		/** The name (JSON of its parts) or a contact, normalized and encrypted (`profile_suggestions.value`). */
		valueEnc: bytea(),
		/** A soft skill key: not personal data. */
		skillKey: text(),
		/** `{block_id, start, end}`: code points of the block text (docs/contracts.md, section 3.2). */
		quote: jsonb().notNull(),
		status: text({ enum: PROFILE_SUGGESTION_STATUSES }).notNull(),
		decidedAt: ts(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('profile_suggestions', 'field', t.field, PROFILE_SUGGESTION_FIELDS),
		enumCheck('profile_suggestions', 'status', t.status, PROFILE_SUGGESTION_STATUSES),
		check(
			'profile_suggestions_value',
			sql`case when ${t.field} = 'soft_skill' then ${t.skillKey} is not null and ${t.valueEnc} is null
				else ${t.valueEnc} is not null and ${t.skillKey} is null end`
		),
		check('profile_suggestions_decided', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
		index('profile_suggestions_candidate').on(t.candidateId),
		index('profile_suggestions_extraction').on(t.extractionId)
	]
);

/**
 * A signed statement of the platform about one assignment of a category (domain 12.9): what the QR code of the PDF
 * profile opens. The status is computed from the category at the moment of the check, never stored.
 */
export const categoryAttestations = pgTable(
	'category_attestations',
	{
		id: id(),
		/** 128 random bits in base32: nothing about the candidate or the category can be read from it. */
		handle: text().notNull().unique('category_attestations_handle'),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		categoryId: uuid()
			.notNull()
			.references(() => candidateCategories.id),
		/** The grade decision of the category and the bank release of that decision: the version of the ground. */
		decisionId: uuid()
			.notNull()
			.references(() => gradeDecisions.id),
		bankReleaseId: text().notNull(),
		statement: jsonb().notNull(),
		statementSha256: text().notNull(),
		/** Ed25519 over the canonical JSON of the statement, base64url; the keys of the receipts (domain 9.6). */
		signature: text().notNull(),
		signingKeyId: text().notNull(),
		/** The salt of the holder commitment; never published. */
		holderNonce: bytea().notNull(),
		issuedAt: ts().notNull()
	},
	(t) => [
		sha256Check('category_attestations', 'statement_sha256', t.statementSha256),
		check('category_attestations_handle_format', sql`${t.handle} ~ '^[a-z2-7]{26}$'`),
		check('category_attestations_nonce_length', sql`octet_length(${t.holderNonce}) = 32`),
		// A repeated PDF of the same assignment does not issue a new confirmation (domain 12.9).
		uniqueIndex('category_attestations_category').on(t.categoryId),
		index('category_attestations_candidate').on(t.candidateId)
	]
);
