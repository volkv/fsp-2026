// Comparison of a program's output with the expected output (docs/contracts.md, section 6.2). It runs in the
// application, not in the sandbox: the expected output never becomes a file the candidate's program could read.
import type { CheckerSpec } from './types';

/**
 * `exact` — the same lines, ignoring line endings (`\r\n` and `\n`), whitespace at the end of each line and empty
 * lines at the end of the output.
 */
function normalizeLines(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const trimmed = lines.map((line) => line.replace(/[ \t\f\v]+$/, ''));
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
	return trimmed.join('\n');
}

function tokens(text: string): string[] {
	const trimmed = text.trim();
	return trimmed === '' ? [] : trimmed.split(/\s+/);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Numbers match when the absolute or the relative difference is within `eps`; other tokens must be equal. */
function floatTokenMatches(actual: string, expected: string, eps: number): boolean {
	if (actual === expected) return true;
	if (!NUMBER.test(actual) || !NUMBER.test(expected)) return false;
	const a = Number(actual);
	const e = Number(expected);
	const difference = Math.abs(a - e);
	return difference <= eps || difference <= eps * Math.abs(e);
}

export function outputMatches(checker: CheckerSpec, actual: string, expected: string): boolean {
	switch (checker.kind) {
		case 'exact':
			return normalizeLines(actual) === normalizeLines(expected);
		case 'tokens': {
			const a = tokens(actual);
			const e = tokens(expected);
			return a.length === e.length && a.every((token, index) => token === e[index]);
		}
		case 'float_eps': {
			const a = tokens(actual);
			const e = tokens(expected);
			return a.length === e.length && a.every((token, index) => floatTokenMatches(token, e[index] ?? '', checker.eps));
		}
	}
}
