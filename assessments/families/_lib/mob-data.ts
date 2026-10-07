// Shared code of the Mobile data families (`mob.data.*`): an SQL item on the local database of an app, the way Room
// creates it, and a computed item proven by an independent Python program. A generator draws a scenario until every
// misconception its class must expose changes the answer; a misconception that gives the right answer on an instance
// does not apply there (`null`).
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type ComputedAnswer,
	type FamilyDescriptor,
	type GenerateInput
} from './family.ts';
import type { Rng } from './rng.ts';
import { runSql, sqlProbeSource, SQL_ROW_FORMAT } from './sql.ts';

/** How many scenarios a generator draws before it gives up: a class that needs more is a defect of the family. */
const TRIES = 300;

/**
 * One SQL item: the script (schema, data, statements) and the query whose rows are the answer. A wrong solution is the
 * query the misconception effectively runs, or its answer lines when SQL cannot express it.
 */
export interface SqlItem {
	setup: string;
	query: string;
	/** What to answer, before the common note on the database and the row format. */
	statement: string;
	/** A query on the same script, another script with its query, or the answer lines. */
	wrong: Readonly<Record<string, string | { setup: string; query: string } | readonly string[]>>;
}

/** The misconceptions every instance of a class must expose: `<grade>/<class>` → ids. */
export type Required = Readonly<Record<string, readonly string[]>>;

function wrongIds(descriptor: FamilyDescriptor): string[] {
	return descriptor.wrongSolutions.map((w) => w.id);
}

function requiredOf(required: Required, input: GenerateInput): readonly string[] {
	const ids = required[`${input.grade}/${input.classId}`];
	if (!ids || ids.length === 0) throw new Error(`no required misconceptions for ${input.grade}/${input.classId}`);
	return ids;
}

/** Builds an SQL instance: the answer is the query's rows in SQLite of Node, the gate reruns it in Python. */
export function buildSql(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	required: Required,
	make: (rng: Rng) => SqlItem
): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const must = requiredOf(required, input);
	for (let tries = 0; tries < TRIES; tries += 1) {
		const item = make(rng);
		const answer = runSql(item.setup, item.query);
		if (answer.length === 0 || answer.some((line) => line.trim() !== line || line === '')) continue;
		const wrong: Record<string, string[] | null> = {};
		for (const id of wrongIds(descriptor)) {
			const w = item.wrong[id];
			const lines =
				w === undefined
					? null
					: typeof w === 'string'
						? runSql(item.setup, w)
						: 'setup' in w
							? runSql(w.setup, w.query)
							: [...w];
			wrong[id] = lines === null || sameLines(lines, answer) ? null : lines;
		}
		if (must.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `${item.statement} База — SQLite, схема, данные и операции приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${item.setup}\n\n${item.query}` }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(item.setup, item.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no instance for ${input.grade}/${input.classId} after ${TRIES} tries`);
}

/**
 * One computed item: the statement, the answer of the model in TypeScript, the answers of the misconceptions and the
 * input of the independent Python reference.
 */
export interface ComputeItem {
	markdown: string;
	/** Code shown with the statement as an illustration of the scenario; the answer follows the model in `markdown`. */
	code?: { language: string; source: string };
	answer: ComputedAnswer;
	wrong: Readonly<Record<string, ComputedAnswer>>;
	stdin: string;
}

/** Builds a computed instance proven by `reference` (a Python program reading `stdin`). */
export function buildCompute(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	required: Required,
	reference: string,
	make: (rng: Rng) => ComputeItem | null
): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const must = requiredOf(required, input);
	for (let tries = 0; tries < TRIES; tries += 1) {
		const item = make(rng);
		if (item === null) continue;
		const wrong: Record<string, ComputedAnswer | null> = {};
		for (const id of wrongIds(descriptor)) {
			const w = item.wrong[id];
			wrong[id] = w === undefined || answerText(w) === answerText(item.answer) ? null : w;
		}
		if (must.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: item.markdown, code: item.code ?? null },
			answer: item.answer
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: reference, stdin: item.stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: value }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no instance for ${input.grade}/${input.classId} after ${TRIES} tries`);
}

/** A column of a Room entity: name, SQLite type, `NOT NULL`, and the `DEFAULT` clause text if any. */
export type Column = readonly [name: string, type: 'INTEGER' | 'TEXT', notNull: boolean, defaultValue?: string];

/**
 * `CREATE TABLE` the way Room writes it for an entity: backticked names, `PRIMARY KEY(...)` as a table constraint, or
 * `INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL` for an auto-generated key; `extra` — foreign keys and other constraints.
 */
export function roomTable(
	name: string,
	columns: readonly Column[],
	key: { autoGenerate: string } | { primary: readonly string[] },
	extra: readonly string[] = []
): string {
	const defs = columns.map(([col, type, notNull, def]) =>
		'autoGenerate' in key && key.autoGenerate === col
			? `\`${col}\` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`
			: `\`${col}\` ${type}${notNull ? ' NOT NULL' : ''}${def === undefined ? '' : ` DEFAULT ${def}`}`
	);
	if ('primary' in key) defs.push(`PRIMARY KEY(${key.primary.map((c) => `\`${c}\``).join(', ')})`);
	return `CREATE TABLE IF NOT EXISTS \`${name}\` (${[...defs, ...extra].join(', ')});`;
}

export const CHAT_TITLES = [
	'Семья',
	'Работа',
	'Дача',
	'Футбол',
	'Книжный клуб',
	'Соседи',
	'Курс Kotlin',
	'Поездка',
	'Родители',
	'Спортзал'
] as const;

export const MESSAGE_BODIES = [
	'привет',
	'буду в семь',
	'ок',
	'созвон завтра',
	'фото с дачи',
	'кто идёт?',
	'спасибо',
	'уже еду',
	'купи хлеб',
	'ссылка на билеты',
	'отличная идея',
	'перенесём?'
] as const;

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function answerText(answer: ComputedAnswer): string {
	if (answer.kind === 'set') return JSON.stringify([...new Set(answer.value)].sort());
	return JSON.stringify(answer.value);
}
