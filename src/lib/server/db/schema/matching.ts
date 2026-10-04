// Vacancy ↔ candidate match scores (domain 13.4): the significant pairs with their decomposition as codes and numbers.
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	doublePrecision,
	index,
	numeric,
	pgTable,
	text,
	unique,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { COMPONENT_KEYS, COMPONENT_STATUS_CODES } from '../../matching/params';
import { id, ts } from './_columns';
import { candidates } from './candidates';
import { categorizationRuns } from './categorization';
import { jobs } from './jobs';
import { embeddingSpaces } from './ml';
import { matchRulesets } from './taxonomy';
import { vacancies } from './vacancies';

const statusCodes = Object.values(COMPONENT_STATUS_CODES).join('');

export const matchScores = pgTable(
	'match_scores',
	{
		id: id(),
		vacancyId: uuid()
			.notNull()
			.references(() => vacancies.id),
		vacancyRevision: bigint({ mode: 'number' }).notNull(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		candidateRevision: bigint({ mode: 'number' }).notNull(),
		categorizationRunId: uuid().references(() => categorizationRuns.id),
		matchRulesetId: uuid()
			.notNull()
			.references(() => matchRulesets.id),
		embeddingSpaceId: text().references((): AnyPgColumn => embeddingSpaces.id),
		/** Model of the reranker component when it was computed. */
		rerankerModelId: text(),
		score: numeric({ precision: 4, scale: 3 }).notNull(),
		/** One letter of `COMPONENT_STATUS_CODES` per component, in the order of `COMPONENT_KEYS`. */
		componentStatuses: text().notNull(),
		// The value of each component; `null` when the component was not computed.
		requiredValue: doublePrecision(),
		niceValue: doublePrecision(),
		trustValue: doublePrecision(),
		gradeValue: doublePrecision(),
		salaryValue: doublePrecision(),
		semanticValue: doublePrecision(),
		rerankerValue: doublePrecision(),
		roleValue: doublePrecision(),
		computedAt: ts().notNull(),
		jobId: uuid().references((): AnyPgColumn => jobs.id)
	},
	(t) => [
		check('match_scores_score_range', sql`${t.score} >= 0 and ${t.score} <= 1`),
		check(
			'match_scores_component_statuses',
			sql`${t.componentStatuses} ~ ${sql.raw(`'^[${statusCodes}]{${COMPONENT_KEYS.length}}$'`)}`
		),
		// A value is stored exactly for a computed component.
		check(
			'match_scores_component_values',
			sql.join(
				COMPONENT_KEYS.map(
					(key, index) =>
						sql`((substr(${t.componentStatuses}, ${sql.raw(String(index + 1))}, 1) = ${sql.raw(`'${COMPONENT_STATUS_CODES.computed}'`)}) = (${t[`${key}Value`]} is not null))`
				),
				sql` and `
			)
		),
		// The candidate side of a snapshot is the profile revision together with the published category it read: a
		// category recomputed, replaced or blocked at the same revision is another snapshot. No category is one value.
		unique('match_scores_snapshot')
			.on(t.vacancyId, t.vacancyRevision, t.candidateId, t.candidateRevision, t.categorizationRunId, t.matchRulesetId)
			.nullsNotDistinct(),
		index('match_scores_candidate').on(t.candidateId, t.candidateRevision)
	]
);
