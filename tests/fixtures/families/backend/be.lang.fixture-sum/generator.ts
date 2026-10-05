// A fixture family for the tests of the bank loader: the sum of a range, with or without its upper bound.
import { createHash } from 'node:crypto';
import type { ItemInstance } from '../../../../../src/lib/server/assessments/contract/bank.ts';
import type { GenerateInput } from '../../../../../src/lib/server/assessments/contract/bank.ts';

export function generate({ seed, grade, classId }: GenerateInput): ItemInstance {
	const n = 3 + (parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 4), 16) % 7);
	const name = ['total', 'acc', 'sum_'][n % 3] ?? 'total';
	const inclusive = classId === 'inclusive';
	const bound = inclusive ? n + 1 : n;
	const sum = (bound * (bound - 1)) / 2;
	return {
		family: 'be.lang.fixture-sum',
		familyVersion: 1,
		grade,
		classId,
		seed,
		format: 'code_trace',
		answerKind: 'exact',
		statement: {
			markdown: 'Что напечатает программа?',
			code: { language: 'python3', source: `${name} = 0\nfor i in range(${bound}):\n    ${name} += i\nprint(${name})` }
		},
		answer: { kind: 'exact', value: String(sum) },
		practice: null,
		qa: null,
		changeStep: null,
		timeNormSec: 120
	};
}
