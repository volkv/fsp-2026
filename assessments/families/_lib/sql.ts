// SQL items run their query on the generated database when the instance is built (SQLite of Node), and the gate
// script runs the same script with `sqlite3` of Python in the sandbox image: two drivers must agree on every row.
// Rows are printed one per line, values joined by ` | `, NULL as `NULL`, numbers in their shortest form.
import { DatabaseSync } from 'node:sqlite';

export const SQL_ROW_FORMAT =
	'Строки результата — по одной на строку ответа, в порядке выдачи; значения столбцов через ` | `, NULL — `NULL`, ' +
	'числа — без лишних нулей (`3`, `2.5`).';

type SqlValue = null | number | bigint | string | Uint8Array;

function formatValue(value: SqlValue): string {
	if (value === null) return 'NULL';
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'string') return value;
	throw new Error('a BLOB in an SQL item result');
}

/** Runs `setup` (schema, data, statements) and then `query`; returns the rows as answer lines. */
export function runSql(setup: string, query: string): string[] {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(setup);
		// Rows as arrays: an object by column names would merge equal names and move numeric names forward.
		const statement = db.prepare(query);
		statement.setReturnArrays(true);
		const rows = statement.all() as unknown as SqlValue[][];
		return rows.map((row) => row.map(formatValue).join(' | '));
	} finally {
		db.close();
	}
}

/** The Python program the gate runs for the same setup and query. */
export function sqlProbeSource(setup: string, query: string): string {
	return [
		'import sqlite3',
		'',
		'def fmt(v):',
		'    if v is None:',
		"        return 'NULL'",
		'    if isinstance(v, float):',
		'        return str(int(v)) if v.is_integer() else repr(v)',
		'    return str(v)',
		'',
		"con = sqlite3.connect(':memory:', isolation_level=None)",
		`con.executescript(${JSON.stringify(setup)})`,
		`for row in con.execute(${JSON.stringify(query)}):`,
		"    print(' | '.join(fmt(v) for v in row))"
	].join('\n');
}

/** SQL string literal. */
export function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** `INSERT` statements of rows; `null` becomes NULL, strings are quoted. */
export function insertRows(
	table: string,
	columns: readonly string[],
	rows: readonly (readonly (string | number | null)[])[]
): string {
	return rows
		.map(
			(row) =>
				`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${row
					.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlText(v)))
					.join(', ')});`
		)
		.join('\n');
}
