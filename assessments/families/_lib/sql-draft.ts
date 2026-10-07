// SQL items built from drafts: a draft of a class gives the schema with data, the query and, by the id of each
// misconception that applies to the class, the query that misconception reads instead. Data are drawn until every
// listed misconception changes the rows and the result is not empty, so a wrong answer is rejected on every instance
// its misconception applies to.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type FamilyDescriptor,
	type GenerateInput
} from './family.ts';
import type { Rng } from './rng.ts';
import { runSql, sqlProbeSource, SQL_ROW_FORMAT } from './sql.ts';

export interface SqlDraft {
	setup: string;
	query: string;
	/** The query a misconception reads instead, by its id; a misconception absent here does not apply to the class. */
	wrong: Readonly<Record<string, string>>;
	/** What the query is for, in the words of the analyst who wrote it; the first sentence of the statement. */
	purpose: string;
}

/** The instance of a class from its draft and the gate material: the probe of the query and the wrong answers. */
export function buildFromDraft(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	draft: (rng: Rng) => SqlDraft,
	tries = 300
): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const wrongIds = descriptor.wrongSolutions.map((w) => w.id);
	for (let attempt = 0; attempt < tries; attempt += 1) {
		const d = draft(rng);
		for (const id of Object.keys(d.wrong)) {
			if (!wrongIds.includes(id)) throw new Error(`${descriptor.key}: the draft names an unknown misconception ${id}`);
		}
		const rows = runSql(d.setup, d.query);
		if (rows.length === 0) continue;
		const same = JSON.stringify(rows);
		const wrongRows = Object.fromEntries(Object.entries(d.wrong).map(([id, q]) => [id, runSql(d.setup, q)]));
		if (Object.values(wrongRows).some((w) => JSON.stringify(w) === same)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `${d.purpose} Что вернёт запрос? База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${d.setup}\n\n${d.query}` }
			},
			answer: { kind: 'sequence', value: rows }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(d.setup, d.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					wrongIds.map((id) => {
						const value = wrongRows[id];
						return [
							id,
							value === undefined ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
						];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after ${tries} tries`);
}

/** `YYYY-MM-DD` of a day `offset` days after `base` (`YYYY-MM-DD`). */
export function addDays(base: string, offset: number): string {
	const date = new Date(`${base}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + offset);
	return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:MM:SS` of a moment `minutes` after `base` (`YYYY-MM-DD HH:MM:SS`), the form SQLite's `datetime()` gives. */
export function addMinutes(base: string, minutes: number): string {
	const date = new Date(`${base.replace(' ', 'T')}Z`);
	date.setUTCMinutes(date.getUTCMinutes() + minutes);
	return date.toISOString().slice(0, 19).replace('T', ' ');
}
