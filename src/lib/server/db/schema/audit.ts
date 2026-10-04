// Action journal and the erasure ledger (domain 18, 19.2).
import { sql } from 'drizzle-orm';
import { check, index, inet, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, ts } from './_columns';
import { uuidv7 } from '../../ids';

const AUDIT_OUTCOMES = ['success', 'denied', 'failure'] as const;
const AUDIT_ACTOR_KINDS = ['user', 'api_key', 'system', 'anonymous'] as const;

/**
 * Append-only journal partitioned by month of `occurred_at` (migration 0001 creates the table partitioned,
 * migration 0002 adds partitions and the append-only trigger). The partition key is part of the primary key.
 * No foreign keys: the journal outlives the rows it mentions and keeps only identifiers and codes.
 */
export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid()
			.notNull()
			.$defaultFn(() => uuidv7()),
		occurredAt: ts().notNull().defaultNow(),
		action: text().notNull(),
		outcome: text({ enum: AUDIT_OUTCOMES }).notNull(),
		actorKind: text({ enum: AUDIT_ACTOR_KINDS }).notNull(),
		actorUserId: uuid(),
		actorCompanyId: uuid(),
		apiKeyId: uuid(),
		objectType: text(),
		objectId: text(),
		subjectCandidateId: uuid(),
		requestId: text().notNull(),
		ip: inet(),
		userAgent: text(),
		details: jsonb()
	},
	(t) => [
		primaryKey({ name: 'audit_events_pk', columns: [t.id, t.occurredAt] }),
		enumCheck('audit_events', 'outcome', t.outcome, AUDIT_OUTCOMES),
		enumCheck('audit_events', 'actor_kind', t.actorKind, AUDIT_ACTOR_KINDS),
		check('audit_events_user_actor', sql`${t.actorKind} <> 'user' or ${t.actorUserId} is not null`),
		check('audit_events_api_key_actor', sql`${t.actorKind} <> 'api_key' or ${t.apiKeyId} is not null`),
		check('audit_events_object', sql`(${t.objectType} is null) = (${t.objectId} is null)`),
		index('audit_events_subject').on(t.subjectCandidateId, t.occurredAt),
		index('audit_events_action').on(t.action, t.occurredAt)
	]
);

/** Users whose data was purged; re-applied after restoring a backup (domain 19.2). */
export const erasureLedger = pgTable(
	'erasure_ledger',
	{
		userId: uuid().primaryKey(),
		requestedAt: ts().notNull(),
		purgedAt: ts()
	},
	(t) => [check('erasure_ledger_order', sql`${t.purgedAt} is null or ${t.purgedAt} >= ${t.requestedAt}`)]
);
