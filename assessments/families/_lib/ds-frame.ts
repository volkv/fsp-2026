// Items about pandas code (Data Science / ML): the tables a statement shows, the code it shows and the input of the
// gates' reference. The sandbox has no pandas, so such an item is a `compute` item: the generator models the semantics
// of pandas, and the gates check the answer with an independent reference on plain Python that reads the tables from
// its standard input as JSON `{"frames": {name: {"columns": [...], "rows": [[...], ...]}}, ...}` (`null` — a missing value).
import { frameMarkdown, type Cell } from './ds.ts';

export interface Frame {
	name: string;
	columns: readonly string[];
	rows: readonly (readonly Cell[])[];
}

/** The tables of a statement, each under its name. */
export function framesMarkdown(frames: readonly Frame[]): string {
	return frames.map((f) => `Таблица \`${f.name}\`:\n\n${frameMarkdown(f.columns, f.rows)}`).join('\n\n');
}

/** The shown program: the import, a note that the tables above are loaded under their names, then the steps. */
export function pandasSource(frames: readonly Frame[], steps: readonly string[]): string {
	const names = frames.map((f) => f.name).join(', ');
	return [
		'import pandas as pd',
		'',
		`# ${names} — ${frames.length === 1 ? 'таблица' : 'таблицы'} из условия (пропуск — NaN)`,
		...steps
	].join('\n');
}

/** The standard input of a reference: the tables and any parameters of the instance. */
export function referenceStdin(frames: readonly Frame[], params: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		frames: Object.fromEntries(frames.map((f) => [f.name, { columns: f.columns, rows: f.rows }])),
		...params
	});
}

/** The values of a column of a frame. */
export function column(frame: Frame, name: string): Cell[] {
	const i = frame.columns.indexOf(name);
	if (i < 0) throw new Error(`frame ${frame.name} has no column ${name}`);
	return frame.rows.map((row) => row[i] ?? null);
}

/** Numbers of a list without missing values. */
export function present(values: readonly Cell[]): number[] {
	return values.filter((v): v is number => typeof v === 'number');
}

/** pandas `sum()`: missing values skipped, the sum of nothing is 0. */
export function sumSkip(values: readonly Cell[]): number {
	return present(values).reduce((s, v) => s + v, 0);
}

/** pandas `mean()`: missing values skipped; `null` when nothing is left (NaN). */
export function meanSkip(values: readonly Cell[]): number | null {
	const xs = present(values);
	return xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Python's ordering of group keys of one type: numbers by value, strings by code points (pandas `sort=True`). */
export function compareKeys(a: string | number, b: string | number): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	const x = String(a);
	const y = String(b);
	return x < y ? -1 : x > y ? 1 : 0;
}
