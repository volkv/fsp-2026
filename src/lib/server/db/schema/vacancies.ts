// Vacancies companies publish on the platform (domain 13.1).
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { enumCheck, fullSalary, id, salaryChecks, salaryColumns, timestamps, ts } from './_columns';
import { companies, companyMembers } from './companies';
import { documentAcceptances } from './consent';
import { mlResults } from './ml';
import { taxonomyVersions } from './taxonomy';

const VACANCY_STATUSES = ['draft', 'pending_moderation', 'published', 'paused', 'closed'] as const;

export const vacancies = pgTable(
	'vacancies',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		revision: bigint({ mode: 'number' }).notNull().default(1),
		title: text().notNull(),
		description: text().notNull(),
		taxonomyVersionId: uuid()
			.notNull()
			.references(() => taxonomyVersions.id),
		roleKey: text().notNull(),
		gradeMin: text().notNull(),
		gradeMax: text().notNull(),
		requiredSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		niceSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		workFormat: text().notNull(),
		employmentForm: text().notNull(),
		contractTypes: text().array().notNull(),
		cityId: text(),
		timezoneOverlapHours: integer(),
		...salaryColumns(),
		minAge: integer(),
		minorTermsAcceptanceId: uuid().references((): AnyPgColumn => documentAcceptances.id),
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
		enumCheck('vacancies', 'status', t.status, VACANCY_STATUSES),
		...salaryChecks('vacancies', t),
		// The employer reaches a candidate with the salary: a full range with a known tax base (domain 13.1).
		check('vacancies_full_salary', fullSalary(t)),
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
		index('vacancies_status').on(t.status)
	]
);
