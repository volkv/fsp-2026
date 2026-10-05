// The candidate's survey and declared grade (domain 12.2): every survey is a new version, every declaration a new row;
// both are append-only (the triggers are in the migration). The confirmed grade lives with the category, not here.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { DIRECTION_KEYS, GRADE_KEYS, SPECIALIZATION_KEYS } from '../../assessments/contract/catalog';
import { enumCheck, id, ts } from './_columns';
import { candidates } from './candidates';
import { taxonomyVersions } from './taxonomy';

export const candidateSurveys = pgTable(
	'candidate_surveys',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		version: integer().notNull(),
		catalogVersion: text().notNull(),
		taxonomyVersionId: uuid()
			.notNull()
			.references(() => taxonomyVersions.id),
		direction: text({ enum: DIRECTION_KEYS }).notNull(),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		/** The declared stack: 1–10 skills of the taxonomy; it never becomes the confirmed stack. */
		declaredSkillKeys: text().array().notNull(),
		/** Work format, employment, region, relocation and the salary expectation as answered (`candidates.preferences`). */
		preferences: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('candidate_surveys_version').on(t.candidateId, t.version),
		check('candidate_surveys_version_positive', sql`${t.version} >= 1`),
		enumCheck('candidate_surveys', 'direction', t.direction, DIRECTION_KEYS),
		enumCheck('candidate_surveys', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		check(
			'candidate_surveys_declared_skills',
			sql`cardinality(${t.declaredSkillKeys}) between 1 and 10 and array_position(${t.declaredSkillKeys}, null) is null`
		),
		check('candidate_surveys_preferences', sql`jsonb_typeof(${t.preferences}) = 'object'`)
	]
);

export const gradeDeclarations = pgTable(
	'grade_declarations',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		/** The survey the grade was declared by. */
		surveyId: uuid()
			.notNull()
			.references(() => candidateSurveys.id),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		grade: text({ enum: GRADE_KEYS }).notNull(),
		/** The grade hint as it was shown at the moment of the declaration; `{suggested: null}` without grounds. */
		hint: jsonb().notNull(),
		declaredAt: ts().notNull()
	},
	(t) => [
		index('grade_declarations_candidate').on(t.candidateId, t.specialization, t.declaredAt),
		enumCheck('grade_declarations', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		enumCheck('grade_declarations', 'grade', t.grade, GRADE_KEYS),
		check('grade_declarations_hint', sql`jsonb_typeof(${t.hint}) = 'object'`)
	]
);
