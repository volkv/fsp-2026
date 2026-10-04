// Versioned product policies (domain 13.8). Immutable: a change is a new version (migration 0002).
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { POLICY_KINDS } from '../../consent/kinds';
import { enumCheck, id, ts } from './_columns';

export const productPolicies = pgTable(
	'product_policies',
	{
		id: id(),
		kind: text({ enum: POLICY_KINDS }).notNull(),
		version: integer().notNull(),
		params: jsonb().notNull(),
		effectiveFrom: ts().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('product_policies', 'kind', t.kind, POLICY_KINDS),
		check('product_policies_version_positive', sql`${t.version} >= 1`),
		unique('product_policies_kind_version').on(t.kind, t.version)
	]
);
