// Own and external vacancies, sources, postings, imports and «this is our vacancy» claims (domain 13.1–13.3).
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, fullSalary, id, oneOf, salaryChecks, salaryColumns, sha256Check, timestamps, ts } from './_columns';
import { companies, companyMembers } from './companies';
import { documentAcceptances } from './consent';
import { demoSessions } from './demo';
import { users } from './identity';
import { jobs } from './jobs';
import { mlResults } from './ml';
import { taxonomyVersions } from './taxonomy';

const VACANCY_ORIGINS = ['own', 'external'] as const;
const GRADE_BASES = ['stated', 'inferred', 'unknown'] as const;
const OWN_VACANCY_STATUSES = ['draft', 'pending_moderation', 'published', 'paused', 'closed'] as const;
const EXTERNAL_VACANCY_STATUSES = ['active', 'stale', 'closed', 'hidden'] as const;
const VACANCY_STATUSES = [...OWN_VACANCY_STATUSES, 'active', 'stale', 'hidden'] as const;

export const vacancies = pgTable(
	'vacancies',
	{
		id: id(),
		origin: text({ enum: VACANCY_ORIGINS }).notNull(),
		companyId: uuid().references(() => companies.id),
		createdByMemberId: uuid().references(() => companyMembers.id),
		externalOrg: jsonb(),
		/** The company outside demo sessions whose claim was approved; a session keeps its approval in its claim (19.3). */
		claimedCompanyId: uuid().references(() => companies.id),
		derivedFromVacancyId: uuid().references((): AnyPgColumn => vacancies.id),
		/** The own vacancy of a company outside demo sessions that replaced this external one everywhere (19.3). */
		supersededByVacancyId: uuid().references((): AnyPgColumn => vacancies.id),
		revision: bigint({ mode: 'number' }).notNull().default(1),
		title: text().notNull(),
		description: text(),
		taxonomyVersionId: uuid()
			.notNull()
			.references(() => taxonomyVersions.id),
		roleKey: text(),
		gradeMin: text(),
		gradeMax: text(),
		gradeBasis: text({ enum: GRADE_BASES }).notNull(),
		requiredSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		niceSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		workFormat: text(),
		employmentForm: text(),
		contractTypes: text().array(),
		cityId: text(),
		timezoneOverlapHours: integer(),
		...salaryColumns(),
		minAge: integer(),
		minorTermsAcceptanceId: uuid().references((): AnyPgColumn => documentAcceptances.id),
		termsConflict: boolean().notNull().default(false),
		poolCount: integer(),
		poolCountedAt: ts(),
		draftMlResultId: uuid().references((): AnyPgColumn => mlResults.id),
		textCheck: jsonb().notNull(),
		status: text({ enum: VACANCY_STATUSES }).notNull(),
		publishedAt: ts(),
		closedAt: ts(),
		seedBatchId: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('vacancies', 'origin', t.origin, VACANCY_ORIGINS),
		enumCheck('vacancies', 'grade_basis', t.gradeBasis, GRADE_BASES),
		...salaryChecks('vacancies', t),
		check(
			'vacancies_status_by_origin',
			sql`case ${t.origin}
				when 'own' then ${oneOf(t.status, OWN_VACANCY_STATUSES)}
				else ${oneOf(t.status, EXTERNAL_VACANCY_STATUSES)} end`
		),
		// Own vacancy: a verified company's offer with role, grade and a full range with a known tax base (domain 13.1).
		check(
			'vacancies_own_fields',
			sql`${t.origin} <> 'own' or (${t.companyId} is not null and ${t.createdByMemberId} is not null
				and ${t.description} is not null and ${t.roleKey} is not null
				and ${t.gradeMin} is not null and ${t.gradeMax} is not null and ${t.gradeBasis} = 'stated'
				and ${t.workFormat} is not null and ${t.employmentForm} is not null and ${t.contractTypes} is not null
				and ${fullSalary(t)}
				and ${t.externalOrg} is null and ${t.claimedCompanyId} is null and ${t.supersededByVacancyId} is null
				and ${t.termsConflict} = false)`
		),
		// External vacancy: an organization as the postings name it, never a platform company.
		check(
			'vacancies_external_fields',
			sql`${t.origin} <> 'external' or (${t.companyId} is null and ${t.createdByMemberId} is null
				and ${t.externalOrg} is not null and ${t.derivedFromVacancyId} is null
				and ${t.minAge} is null and ${t.minorTermsAcceptanceId} is null and ${t.draftMlResultId} is null)`
		),
		check('vacancies_grade_pair', sql`(${t.gradeMin} is null) = (${t.gradeMax} is null)`),
		check('vacancies_grade_basis', sql`(${t.gradeBasis} = 'unknown') = (${t.gradeMin} is null)`),
		check(
			'vacancies_min_age',
			sql`${t.minAge} is null or (${t.minAge} in (14, 15, 16) and ${t.minorTermsAcceptanceId} is not null)`
		),
		check('vacancies_revision_positive', sql`${t.revision} >= 1`),
		check('vacancies_published_at', sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
		check('vacancies_closed_at', sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
		check(
			'vacancies_pool_count',
			sql`(${t.poolCount} is null) = (${t.poolCountedAt} is null) and (${t.poolCount} is null or ${t.poolCount} >= 0)`
		),
		index('vacancies_company').on(t.companyId),
		index('vacancies_origin_status').on(t.origin, t.status)
	]
);

export const vacancySources = pgTable(
	'vacancy_sources',
	{
		key: text().primaryKey(),
		name: text().notNull(),
		siteUrl: text().notNull(),
		adapterVersion: text().notNull(),
		terms: jsonb().notNull(),
		enabled: boolean().notNull().default(false),
		schedule: jsonb().notNull(),
		...timestamps()
	},
	(t) => [
		check(
			'vacancy_sources_terms_status',
			sql`${t.terms}->>'status' in ('unchecked', 'allowed', 'restricted', 'forbidden')`
		),
		// A source whose terms forbid use cannot be enabled (domain 13.2).
		check('vacancy_sources_forbidden_disabled', sql`not (${t.enabled} and ${t.terms}->>'status' = 'forbidden')`)
	]
);

const IMPORT_MODES = ['full', 'incremental', 'check'] as const;
const IMPORT_STATUSES = ['running', 'succeeded', 'failed'] as const;
const IMPORT_COMPLETENESS = ['complete', 'partial'] as const;

export const vacancyImportRuns = pgTable(
	'vacancy_import_runs',
	{
		id: id(),
		source: text()
			.notNull()
			.references(() => vacancySources.key),
		adapterVersion: text().notNull(),
		jobId: uuid().references((): AnyPgColumn => jobs.id),
		mode: text({ enum: IMPORT_MODES }).notNull(),
		startedAt: ts().notNull(),
		finishedAt: ts(),
		status: text({ enum: IMPORT_STATUSES }).notNull(),
		completeness: text({ enum: IMPORT_COMPLETENESS }),
		incompleteReason: text(),
		cursorState: jsonb(),
		counts: jsonb().notNull()
	},
	(t) => [
		enumCheck('vacancy_import_runs', 'mode', t.mode, IMPORT_MODES),
		enumCheck('vacancy_import_runs', 'status', t.status, IMPORT_STATUSES),
		enumCheck('vacancy_import_runs', 'completeness', t.completeness, IMPORT_COMPLETENESS),
		check(
			'vacancy_import_runs_finish',
			sql`(${t.status} = 'running') = (${t.finishedAt} is null) and (${t.status} = 'running') = (${t.completeness} is null)`
		),
		check(
			'vacancy_import_runs_incomplete_reason',
			sql`(${t.completeness} = 'partial') = (${t.incompleteReason} is not null)`
		),
		// Incremental and check runs never prove that a posting is gone (domain 13.2, contracts 7.2).
		check(
			'vacancy_import_runs_complete_only_full',
			sql`${t.completeness} is distinct from 'complete' or ${t.mode} = 'full'`
		),
		index('vacancy_import_runs_source').on(t.source, t.startedAt)
	]
);

const POSTING_FRESHNESS = ['active', 'gone', 'unknown'] as const;

export const vacancyPostings = pgTable(
	'vacancy_postings',
	{
		id: id(),
		vacancyId: uuid()
			.notNull()
			.references(() => vacancies.id),
		source: text()
			.notNull()
			.references(() => vacancySources.key),
		externalId: text().notNull(),
		url: text().notNull(),
		organization: jsonb().notNull(),
		title: text().notNull(),
		originalTerms: jsonb().notNull(),
		rawSha256: text().notNull(),
		normalized: jsonb().notNull(),
		normalizationVersion: text().notNull(),
		sourcePublishedAt: ts(),
		sourceUpdatedAt: ts(),
		firstFetchedAt: ts().notNull(),
		lastFetchedAt: ts().notNull(),
		lastCheckedAt: ts().notNull(),
		freshness: text({ enum: POSTING_FRESHNESS }).notNull(),
		goneAt: ts(),
		dedup: jsonb().notNull(),
		lastImportRunId: uuid()
			.notNull()
			.references(() => vacancyImportRuns.id),
		/** The posting was created by the demo seed through its synthetic source (domain 13.2, 12.5). */
		seedBatchId: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('vacancy_postings', 'freshness', t.freshness, POSTING_FRESHNESS),
		sha256Check('vacancy_postings', 'raw_sha256', t.rawSha256),
		check('vacancy_postings_gone_at', sql`(${t.freshness} = 'gone') = (${t.goneAt} is not null)`),
		check('vacancy_postings_dedup_method', sql`${t.dedup}->>'method' in ('exact', 'fingerprint', 'fuzzy', 'manual')`),
		unique('vacancy_postings_source_external').on(t.source, t.externalId),
		index('vacancy_postings_vacancy').on(t.vacancyId)
	]
);

const CLAIM_STATUSES = [
	'awaiting_company_verification',
	'pending_review',
	'approved',
	'rejected',
	'withdrawn'
] as const;

export const vacancyClaims = pgTable(
	'vacancy_claims',
	{
		id: id(),
		vacancyId: uuid()
			.notNull()
			.references(() => vacancies.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		requestedByUserId: uuid()
			.notNull()
			.references(() => users.id),
		status: text({ enum: CLAIM_STATUSES }).notNull(),
		matchEvidence: jsonb().notNull(),
		decidedBy: uuid().references(() => users.id),
		decidedAt: ts(),
		reason: text(),
		/** The demo session of the claiming company, copied from it: an approval holds within its place (domain 19.3). */
		demoSessionId: uuid().references(() => demoSessions.id),
		...timestamps()
	},
	(t) => [
		enumCheck('vacancy_claims', 'status', t.status, CLAIM_STATUSES),
		check('vacancy_claims_rejection_reason', sql`${t.status} <> 'rejected' or ${t.reason} is not null`),
		check(
			'vacancy_claims_operator_decision',
			sql`${t.status} <> 'approved' or (${t.decidedBy} is not null and ${t.decidedAt} is not null)`
		),
		// One approved claim of a vacancy outside sessions and, separately, within each demo session: a session approving a
		// claim leaves the vacancy free for the other sessions and for the companies outside them (domain 13.3, 19.3).
		uniqueIndex('vacancy_claims_one_approved')
			.on(t.vacancyId)
			.where(sql`${t.status} = 'approved' and ${t.demoSessionId} is null`),
		uniqueIndex('vacancy_claims_one_approved_demo')
			.on(t.vacancyId, t.demoSessionId)
			.where(sql`${t.status} = 'approved' and ${t.demoSessionId} is not null`),
		index('vacancy_claims_company').on(t.companyId)
	]
);
