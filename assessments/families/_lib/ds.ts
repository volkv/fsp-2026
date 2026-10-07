// Shared code of the Data Science / ML families: numbers as statements show them and answers expect them, tables of
// data frames in Markdown, and the input of the gates' Python references.
import type { ComputedAnswer } from '../../../src/lib/server/assessments/contract/bank.ts';

/** `x` rounded half away from zero to `digits` places after the point. */
export function roundTo(x: number, digits: number): number {
	const factor = 10 ** digits;
	const scaled = Math.abs(x) * factor;
	// A tiny nudge keeps values like 0.1235 (stored as 0.12349999…) on the side a person rounds them to.
	const rounded = Math.round(scaled * (1 + 1e-12)) / factor;
	return Math.sign(x) * rounded;
}

/** A number as a statement shows it: integers as they are, others with at most `digits` places and no trailing zeros. */
export function num(x: number, digits = 4): string {
	if (!Number.isFinite(x)) throw new Error(`num(${x}): not a finite number`);
	if (Number.isInteger(x)) return String(x);
	const text = roundTo(x, digits).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
	return text === '-0' ? '0' : text;
}

/** A computed real answer: the candidate rounds to `digits` places, the check accepts a difference up to one unit there. */
export function floatAnswer(value: number, digits: number): ComputedAnswer {
	if (!Number.isFinite(value)) throw new Error(`floatAnswer(${value}): not a finite number`);
	return { kind: 'float_eps', value, eps: 10 ** -digits };
}

/** The rule of a real answer, for the end of a statement. */
export function roundingRule(digits: number): string {
	const example = (0.123456789 * 10).toFixed(digits);
	return digits === 0
		? 'Ответ — целое число.'
		: `Ответ — число, округлённое до ${digits} ${digits === 1 ? 'знака' : 'знаков'} после запятой (например, \`${example}\`); разделитель — точка или запятая.`;
}

/**
 * Whether the answer of a misconception is rejected both by the engine (absolute `eps` after the candidate rounds to
 * `digits` places) and by the gates' comparison, which scales `eps` by the magnitude of the answers: at least five units
 * of the last place, and more than twice the gates' scaled tolerance.
 */
export function farApart(right: number, wrong: number, digits: number): boolean {
	const eps = 10 ** -digits;
	if (!Number.isFinite(wrong)) return false;
	const gap = Math.abs(right - wrong);
	return gap >= 5 * eps && gap > 2 * eps * Math.max(1, Math.abs(right), Math.abs(wrong));
}

/** A cell of a shown table; `null` is a missing value (`NaN` in pandas). */
export type Cell = string | number | null;

/** A table in Markdown: a header of column names and a row per record; a missing value is shown as `NaN`. */
export function frameMarkdown(columns: readonly string[], rows: readonly (readonly Cell[])[], index = false): string {
	const show = (cell: Cell): string => (cell === null ? 'NaN' : typeof cell === 'number' ? num(cell) : cell);
	const head = index ? ['', ...columns] : [...columns];
	return [
		`| ${head.join(' | ')} |`,
		`| ${head.map(() => '---').join(' | ')} |`,
		...rows.map((row, i) => `| ${(index ? [String(i), ...row.map(show)] : row.map(show)).join(' | ')} |`)
	].join('\n');
}

/** Values as a JSON line for the standard input of a Python reference (`json.loads(input())`). */
export function stdinJson(value: unknown): string {
	return JSON.stringify(value);
}
