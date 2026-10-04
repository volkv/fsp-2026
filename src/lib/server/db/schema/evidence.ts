// Evidence layers: source facts, claims, skill inferences, experience entries, verification receipts (domain 9).
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	jsonb,
	numeric,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { categorizationRuns } from './categorization';
import { companies } from './companies';
import { consentEvents } from './consent';
import { mlResults } from './ml';

const FACT_SOURCES = ['fsp', 'platform_test', 'codeforces', 'github', 'resume', 'self_declared'] as const;
const FACT_TYPES = [
	'competition_result',
	'qualification',
	'national_team',
	'platform_rating',
	'test_score',
	'repo_languages',
	'resume_document',
	'questionnaire'
] as const;
export const TRUST_LEVELS = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed'] as const;
const OWNERSHIP_BASES = [
	'athlete_link',
	'operator_confirmed',
	'protocol_self_claim',
	'own_attempt',
	'oauth_account',
	'handle_challenge',
	'self_upload',
	'self_declared'
] as const;
const FACT_STATUSES = ['active', 'superseded', 'withdrawn', 'annulled'] as const;

export const sourceFacts = pgTable(
	'source_facts',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		source: text({ enum: FACT_SOURCES }).notNull(),
		factType: text({ enum: FACT_TYPES }).notNull(),
		sourceRecordRef: text().notNull(),
		eventKey: text(),
		trustLevel: text({ enum: TRUST_LEVELS }).notNull(),
		ownershipBasis: text({ enum: OWNERSHIP_BASES }).notNull(),
		// Polymorphic: athlete_links, assessment_attempts or external_profiles, by ownership_basis.
		ownershipRef: uuid(),
		consentEventId: uuid().references(() => consentEvents.id),
		payload: jsonb().notNull(),
		payloadSha256: text().notNull(),
		sourceSnapshotSha256: text(),
		sourceVersion: text(),
		observedAt: ts().notNull(),
		lastVerifiedAt: ts().notNull(),
		occurredOn: date({ mode: 'string' }),
		status: text({ enum: FACT_STATUSES }).notNull(),
		statusReason: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('source_facts', 'source', t.source, FACT_SOURCES),
		enumCheck('source_facts', 'fact_type', t.factType, FACT_TYPES),
		enumCheck('source_facts', 'trust_level', t.trustLevel, TRUST_LEVELS),
		enumCheck('source_facts', 'ownership_basis', t.ownershipBasis, OWNERSHIP_BASES),
		enumCheck('source_facts', 'status', t.status, FACT_STATUSES),
		sha256Check('source_facts', 'payload_sha256', t.payloadSha256),
		sha256Check('source_facts', 'source_snapshot_sha256', t.sourceSnapshotSha256),
		// The FSP source always imports under a consent (domain 9.1, contracts 1.4).
		check(
			'source_facts_fsp_consent',
			sql`${t.source} <> 'fsp' or ${t.ownershipBasis} <> 'athlete_link' or ${t.consentEventId} is not null`
		),
		// One current version of a source record per candidate; superseded versions keep the same reference.
		uniqueIndex('source_facts_active_record')
			.on(t.candidateId, t.sourceRecordRef)
			.where(sql`${t.status} = 'active'`),
		index('source_facts_candidate_status').on(t.candidateId, t.status),
		index('source_facts_ownership_ref').on(t.ownershipRef)
	]
);

const CLAIM_TYPES = [
	'skill_mention',
	'experience_period',
	'role_title',
	'organization',
	'education',
	'team_role',
	'responsibility_marker',
	'language_level',
	'achievement_mention'
] as const;
const CLAIM_POLARITIES = ['asserted', 'negated', 'uncertain'] as const;
const CLAIM_EXTRACTORS = ['rules', 'model', 'source_mapping'] as const;
const CLAIM_REVIEWS = ['pending', 'confirmed', 'rejected'] as const;
const CLAIM_STATUSES = ['active', 'invalidated'] as const;

export const claims = pgTable(
	'claims',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		factId: uuid()
			.notNull()
			.references(() => sourceFacts.id),
		claimType: text({ enum: CLAIM_TYPES }).notNull(),
		experienceEntryId: uuid().references((): AnyPgColumn => experienceEntries.id),
		eventKey: text(),
		rawText: text().notNull(),
		polarity: text({ enum: CLAIM_POLARITIES }).notNull(),
		skillKey: text(),
		normalization: jsonb(),
		value: jsonb(),
		quote: jsonb(),
		extractor: text({ enum: CLAIM_EXTRACTORS }).notNull(),
		mlResultId: uuid().references((): AnyPgColumn => mlResults.id),
		candidateReview: text({ enum: CLAIM_REVIEWS }).notNull().default('pending'),
		status: text({ enum: CLAIM_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('claims', 'claim_type', t.claimType, CLAIM_TYPES),
		enumCheck('claims', 'polarity', t.polarity, CLAIM_POLARITIES),
		enumCheck('claims', 'extractor', t.extractor, CLAIM_EXTRACTORS),
		enumCheck('claims', 'candidate_review', t.candidateReview, CLAIM_REVIEWS),
		enumCheck('claims', 'status', t.status, CLAIM_STATUSES),
		// Claims extracted from a document are never stored without a quote (domain 9.2).
		check('claims_document_quote', sql`${t.extractor} = 'source_mapping' or ${t.quote} is not null`),
		check('claims_model_result', sql`${t.extractor} <> 'model' or ${t.mlResultId} is not null`),
		index('claims_candidate_status').on(t.candidateId, t.status),
		index('claims_fact').on(t.factId),
		index('claims_experience_entry').on(t.experienceEntryId)
	]
);

const STRENGTH_BANDS = ['weak', 'moderate', 'strong'] as const;
const ATTESTATIONS = ['direct', 'derived', 'claimed'] as const;

export const skillInferences = pgTable(
	'skill_inferences',
	{
		id: id(),
		runId: uuid()
			.notNull()
			.references((): AnyPgColumn => categorizationRuns.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		skillKey: text().notNull(),
		strength: numeric({ precision: 4, scale: 3 }).notNull(),
		strengthBand: text({ enum: STRENGTH_BANDS }).notNull(),
		attestation: text({ enum: ATTESTATIONS }).notNull(),
		badgeTrust: text({ enum: TRUST_LEVELS }),
		contributions: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('skill_inferences', 'strength_band', t.strengthBand, STRENGTH_BANDS),
		enumCheck('skill_inferences', 'attestation', t.attestation, ATTESTATIONS),
		enumCheck('skill_inferences', 'badge_trust', t.badgeTrust, TRUST_LEVELS),
		check('skill_inferences_strength_range', sql`${t.strength} >= 0 and ${t.strength} <= 1`),
		// A badge is set exactly for direct attestation and is never `claimed` (domain 9.3).
		check(
			'skill_inferences_badge',
			sql`(${t.attestation} = 'direct') = (${t.badgeTrust} is not null) and ${t.badgeTrust} is distinct from 'claimed'`
		),
		unique('skill_inferences_run_skill').on(t.runId, t.skillKey),
		index('skill_inferences_candidate').on(t.candidateId)
	]
);

const DATE_PRECISIONS = ['month', 'year'] as const;
const PERIOD_STATUSES = ['valid', 'missing', 'invalid'] as const;
const EXPERIENCE_REVIEWS = ['pending', 'confirmed', 'rejected', 'edited'] as const;

export const experienceEntries = pgTable(
	'experience_entries',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		factId: uuid()
			.notNull()
			.references(() => sourceFacts.id),
		positionTitle: text(),
		roleKey: text(),
		organizationName: text(),
		periodFrom: date({ mode: 'string' }),
		periodTo: date({ mode: 'string' }),
		periodFromPrecision: text({ enum: DATE_PRECISIONS }),
		periodToPrecision: text({ enum: DATE_PRECISIONS }),
		isCurrent: boolean().notNull(),
		appliedSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		quotes: jsonb().notNull(),
		periodStatus: text({ enum: PERIOD_STATUSES }).notNull(),
		candidateReview: text({ enum: EXPERIENCE_REVIEWS }).notNull().default('pending'),
		status: text({ enum: CLAIM_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('experience_entries', 'period_from_precision', t.periodFromPrecision, DATE_PRECISIONS),
		enumCheck('experience_entries', 'period_to_precision', t.periodToPrecision, DATE_PRECISIONS),
		enumCheck('experience_entries', 'period_status', t.periodStatus, PERIOD_STATUSES),
		enumCheck('experience_entries', 'candidate_review', t.candidateReview, EXPERIENCE_REVIEWS),
		enumCheck('experience_entries', 'status', t.status, CLAIM_STATUSES),
		check(
			'experience_entries_quotes',
			sql`jsonb_typeof(${t.quotes}) = 'array' and jsonb_array_length(${t.quotes}) >= 1`
		),
		check('experience_entries_current_open', sql`not ${t.isCurrent} or ${t.periodTo} is null`),
		check(
			'experience_entries_valid_period',
			sql`${t.periodStatus} <> 'valid' or (${t.periodFrom} is not null and ${t.periodFromPrecision} is not null
				and (${t.periodTo} is null or (${t.periodTo} >= ${t.periodFrom} and ${t.periodToPrecision} is not null))
				and (${t.periodTo} is not null or ${t.isCurrent}))`
		),
		index('experience_entries_candidate').on(t.candidateId),
		index('experience_entries_fact').on(t.factId)
	]
);

const RECEIPT_DISCLOSURE_LEVELS = ['generalized', 'exact'] as const;

export const verificationReceipts = pgTable(
	'verification_receipts',
	{
		id: id(),
		handle: text().notNull().unique('verification_receipts_handle'),
		factId: uuid()
			.notNull()
			.references(() => sourceFacts.id),
		factPayloadSha256: text().notNull(),
		audienceCompanyId: uuid().references(() => companies.id),
		disclosureLevel: text({ enum: RECEIPT_DISCLOSURE_LEVELS }).notNull(),
		statement: jsonb().notNull(),
		statementSha256: text().notNull(),
		signature: text().notNull(),
		signingKeyId: text().notNull(),
		commitmentNonce: bytea().notNull(),
		issuedAt: ts().notNull()
	},
	(t) => [
		enumCheck('verification_receipts', 'disclosure_level', t.disclosureLevel, RECEIPT_DISCLOSURE_LEVELS),
		sha256Check('verification_receipts', 'fact_payload_sha256', t.factPayloadSha256),
		sha256Check('verification_receipts', 'statement_sha256', t.statementSha256),
		// 128 random bits in RFC 4648 base32 without padding: 26 characters.
		check('verification_receipts_handle_format', sql`${t.handle} ~ '^[a-z2-7]{26}$'`),
		unique('verification_receipts_audience_fact')
			.on(t.factId, t.factPayloadSha256, t.audienceCompanyId, t.disclosureLevel)
			.nullsNotDistinct()
	]
);
