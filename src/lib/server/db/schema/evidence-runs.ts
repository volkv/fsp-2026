// Evidence runs over the profile and the FSP level facet they give (domain 9.3, 9.5, 12.6). A run infers skills, FSP
// levels and experience from a snapshot of the profile evidence; it never assigns a category (domain 12.4).
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	date,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { jobs } from './jobs';
import { categorizationRulesets, taxonomyVersions } from './taxonomy';

const RUN_STATUSES = ['computed', 'published', 'superseded', 'blocked', 'discarded_stale'] as const;

export const evidenceRuns = pgTable(
	'evidence_runs',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		inputRevision: bigint({ mode: 'number' }).notNull(),
		inputSnapshotSha256: text().notNull(),
		inputRefs: jsonb().notNull(),
		taxonomyVersionId: uuid()
			.notNull()
			.references(() => taxonomyVersions.id),
		rulesetId: uuid()
			.notNull()
			.references(() => categorizationRulesets.id),
		asOf: ts().notNull(),
		computedAt: ts().notNull(),
		jobId: uuid().references((): AnyPgColumn => jobs.id),
		experienceSummary: jsonb().notNull(),
		status: text({ enum: RUN_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('evidence_runs', 'status', t.status, RUN_STATUSES),
		sha256Check('evidence_runs', 'input_snapshot_sha256', t.inputSnapshotSha256),
		check('evidence_runs_input_revision', sql`${t.inputRevision} >= 0`),
		// At most one published run per candidate; the previous one becomes superseded.
		uniqueIndex('evidence_runs_published')
			.on(t.candidateId)
			.where(sql`${t.status} = 'published'`),
		index('evidence_runs_candidate').on(t.candidateId, t.computedAt)
	]
);

const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;

export const fspLevelAssignments = pgTable(
	'fsp_level_assignments',
	{
		runId: uuid()
			.notNull()
			.references(() => evidenceRuns.id),
		discipline: text().notNull(),
		level: text({ enum: FSP_LEVELS }).notNull(),
		basisFactIds: uuid().array().notNull(),
		lastResultOn: date({ mode: 'string' })
	},
	(t) => [
		primaryKey({ name: 'fsp_level_assignments_pk', columns: [t.runId, t.discipline] }),
		enumCheck('fsp_level_assignments', 'level', t.level, FSP_LEVELS),
		check('fsp_level_assignments_basis', sql`cardinality(${t.basisFactIds}) >= 1`)
	]
);
