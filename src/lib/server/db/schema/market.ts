// Category market indicators (domain 12.5).
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { enumCheck, id, salaryUnitChecks, salaryUnitColumns, ts } from './_columns';

const MARKET_INDICATORS = ['candidate_expectations', 'vacancy_ranges', 'external_reference'] as const;
const MARKET_STATUSES = ['ok', 'insufficient_data'] as const;
const MARKET_PROVENANCES = ['live', 'synthetic', 'mixed'] as const;

export const marketSnapshots = pgTable(
	'market_snapshots',
	{
		id: id(),
		indicator: text({ enum: MARKET_INDICATORS }).notNull(),
		categoryKey: jsonb().notNull(),
		geography: text().notNull(),
		...salaryUnitColumns(),
		sampleSize: integer().notNull(),
		median: integer(),
		p25: integer(),
		p75: integer(),
		windowFrom: date({ mode: 'string' }).notNull(),
		windowTo: date({ mode: 'string' }).notNull(),
		method: text().notNull(),
		estimated: boolean().notNull(),
		status: text({ enum: MARKET_STATUSES }).notNull(),
		provenance: text({ enum: MARKET_PROVENANCES }).notNull(),
		computedAt: ts().notNull()
	},
	(t) => [
		enumCheck('market_snapshots', 'indicator', t.indicator, MARKET_INDICATORS),
		enumCheck('market_snapshots', 'status', t.status, MARKET_STATUSES),
		enumCheck('market_snapshots', 'provenance', t.provenance, MARKET_PROVENANCES),
		...salaryUnitChecks('market_snapshots', t),
		check('market_snapshots_sample_size', sql`${t.sampleSize} >= 0`),
		check('market_snapshots_window', sql`${t.windowTo} >= ${t.windowFrom}`),
		check('market_snapshots_category_role', sql`${t.categoryKey} ? 'role_key'`),
		// Below the sample threshold no number is stored (domain 12.5).
		check(
			'market_snapshots_values',
			sql`case ${t.status}
				when 'ok' then ${t.median} is not null and ${t.p25} is not null and ${t.p75} is not null
					and ${t.p25} <= ${t.median} and ${t.median} <= ${t.p75}
				else ${t.median} is null and ${t.p25} is null and ${t.p75} is null end`
		),
		index('market_snapshots_lookup').on(t.indicator, t.geography, t.computedAt)
	]
);
