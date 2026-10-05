// Reading a program's output as a computed answer and comparing two answers: the gate script proves the expected
// answer of an instance by running a program and compares the answers of wrong solutions with it.
import type { AnswerKind, ComputedAnswer } from '../../../src/lib/server/assessments/contract/bank.ts';

/** Output lines without trailing whitespace and without empty lines at the end. */
function outputLines(stdout: string): string[] {
	const lines = stdout
		.replaceAll('\r\n', '\n')
		.split('\n')
		.map((line) => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** The answer a program printed, read as the given kind; `eps` is required for `float_eps`. */
export function answerFromStdout(kind: AnswerKind, stdout: string, eps?: number): ComputedAnswer {
	const lines = outputLines(stdout);
	switch (kind) {
		case 'exact':
			return { kind, value: lines.join('\n') };
		case 'tokens':
			return { kind, value: lines.join(' ').split(/\s+/).filter(Boolean).join(' ') };
		case 'sequence':
			return { kind, value: lines };
		case 'set':
			return { kind, value: [...new Set(lines)].sort() };
		case 'line_no':
			return { kind, value: Number.parseInt(lines.join(''), 10) };
		case 'float_eps': {
			if (eps === undefined) throw new Error('float_eps answer without eps');
			return { kind, value: Number.parseFloat(lines.join('')), eps };
		}
		case 'code':
		case 'test_cases':
			throw new Error(`${kind} is not a computed answer`);
	}
}

/** Whether two computed answers are the same answer. */
export function sameAnswer(a: ComputedAnswer, b: ComputedAnswer): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case 'exact':
		case 'tokens':
			return a.value === (b as typeof a).value;
		case 'float_eps': {
			const other = b as typeof a;
			const scale = Math.max(1, Math.abs(a.value), Math.abs(other.value));
			return Math.abs(a.value - other.value) <= a.eps * scale;
		}
		case 'set': {
			const left = [...new Set(a.value)].sort();
			const right = [...new Set((b as typeof a).value)].sort();
			return left.length === right.length && left.every((v, i) => v === right[i]);
		}
		case 'sequence': {
			const other = (b as typeof a).value;
			return a.value.length === other.length && a.value.every((v, i) => v === other[i]);
		}
		case 'line_no':
			return a.value === (b as typeof a).value;
	}
}

/** A stable text of an answer, for counting collisions. */
export function answerKey(answer: ComputedAnswer): string {
	switch (answer.kind) {
		case 'set':
			return JSON.stringify([...new Set(answer.value)].sort());
		case 'float_eps':
			return answer.value.toPrecision(6);
		default:
			return JSON.stringify(answer.value);
	}
}
