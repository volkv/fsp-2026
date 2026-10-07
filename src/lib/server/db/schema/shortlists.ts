// Shortlists of hiring needs (domain 13.10): a shortlist keeps the query of each step and the candidates the company
// marked, never the cards — every opening ranks anew through `canShow`. The steps are append-only: a refinement is a
// new step and the shortlist is not lost. The cohort snapshots of salary expectations answer «what if» about the
// range once a day per company and category; the blind evaluations keep how the company judged the ranking against a
// keyword search, without naming candidates once judged.
import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, id, ts } from './_columns';
import { candidates } from './candidates';
import { companies, companyMembers } from './companies';
import { hiringNeeds } from './hiring';

export const SHORTLIST_STATUSES = ['open', 'archived'] as const;

/**
 * What «Оцените подбор» compares (contracts 10.2, item 10): `confirmed_pool` — the shortlist against a keyword search
 * among the candidates of the same categories and filters; `whole_catalog` — an experiment: the keyword search over the
 * whole visible catalog, candidates without a category included.
 */
export const EVALUATION_SCOPES = ['confirmed_pool', 'whole_catalog'] as const;

export const shortlists = pgTable(
	'shortlists',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		needId: uuid()
			.notNull()
			.references(() => hiringNeeds.id),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		status: text({ enum: SHORTLIST_STATUSES }).notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('shortlists', 'status', t.status, SHORTLIST_STATUSES),
		index('shortlists_need').on(t.companyId, t.needId)
	]
);

/** A step of a shortlist: the whole query of the step and what changed against the previous one. */
export const shortlistRevisions = pgTable(
	'shortlist_revisions',
	{
		id: id(),
		shortlistId: uuid()
			.notNull()
			.references(() => shortlists.id),
		seq: integer().notNull(),
		query: jsonb().notNull(),
		change: jsonb().notNull(),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		unique('shortlist_revisions_seq').on(t.shortlistId, t.seq),
		check('shortlist_revisions_seq_positive', sql`${t.seq} >= 1`),
		check('shortlist_revisions_query', sql`jsonb_typeof(${t.query}) = 'object'`),
		check('shortlist_revisions_change', sql`jsonb_typeof(${t.change}) = 'object'`)
	]
);

/** A candidate the company marked in a shortlist; unmarking keeps the row with `unmarked_at`, marking again clears it. */
export const shortlistMarks = pgTable(
	'shortlist_marks',
	{
		shortlistId: uuid()
			.notNull()
			.references(() => shortlists.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		markedByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		markedAt: ts().notNull(),
		unmarkedAt: ts(),
		note: text()
	},
	(t) => [
		primaryKey({ name: 'shortlist_marks_pk', columns: [t.shortlistId, t.candidateId] }),
		check('shortlist_marks_note_length', sql`char_length(${t.note}) between 1 and 500`),
		index('shortlist_marks_candidate').on(t.candidateId)
	]
);

/**
 * The salary expectations of a fixed cohort — every candidate of a category visible to the company — as counts per
 * interval of `catalog_policy.salary_bins`, taken once a day: answers of the day do not change when one candidate
 * comes or goes (domain 13.10).
 */
export const salaryCohortSnapshots = pgTable(
	'salary_cohort_snapshots',
	{
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		specialization: text().notNull(),
		grade: text().notNull(),
		snapshotDate: date({ mode: 'string' }).notNull(),
		policyVersion: integer().notNull(),
		cohort: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		primaryKey({
			name: 'salary_cohort_snapshots_pk',
			columns: [t.companyId, t.specialization, t.grade, t.snapshotDate]
		}),
		check('salary_cohort_snapshots_cohort', sql`jsonb_typeof(${t.cohort}) = 'object'`)
	]
);

/**
 * «Оцените подбор»: a blind comparison of the shortlist's top ten with a keyword search over the same need. Until it is
 * judged, `cards` name the shown candidates by the company's pseudonyms; the judgement removes them and keeps only
 * which system put each card where and whether it was chosen.
 */
export const shortlistEvaluations = pgTable(
	'shortlist_evaluations',
	{
		id: id(),
		shortlistId: uuid()
			.notNull()
			.references(() => shortlists.id),
		revisionSeq: integer().notNull(),
		scope: text({ enum: EVALUATION_SCOPES }).notNull(),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		cards: jsonb().notNull(),
		result: jsonb(),
		createdAt: ts().notNull().defaultNow(),
		judgedAt: ts()
	},
	(t) => [
		enumCheck('shortlist_evaluations', 'scope', t.scope, EVALUATION_SCOPES),
		check('shortlist_evaluations_judged', sql`(${t.judgedAt} is null) = (${t.result} is null)`),
		index('shortlist_evaluations_shortlist').on(t.shortlistId)
	]
);
