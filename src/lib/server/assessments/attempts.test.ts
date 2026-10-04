// `allowanceOf` (docs/domain.md 10.2): an attempt annulled through no fault of the candidate — a technical failure or
// a defect of the version — does not count toward the limit of attempts; every other annulled attempt does.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allowanceOf, type AttemptRow } from './attempts';

const NOW = new Date('2026-01-15T12:00:00Z');
const POLICY = { max_attempts: 1, retake_interval_days: 0 };

function annulledAttempt(reason: AttemptRow['annulReason']): AttemptRow {
	const at = new Date('2026-01-10T10:00:00Z');
	return {
		id: randomUUID(),
		candidateId: randomUUID(),
		versionId: randomUUID(),
		startedAt: at,
		submittedAt: at,
		deadlineAt: at,
		status: 'annulled',
		integritySignals: null,
		annulledBy: randomUUID(),
		annulledAt: at,
		annulReason: reason,
		createdAt: at,
		updatedAt: at
	};
}

describe('allowanceOf', () => {
	it('does not count an attempt annulled for a technical failure toward the limit', () => {
		const allowance = allowanceOf([annulledAttempt('technical_failure')], POLICY, NOW);
		expect(allowance).toMatchObject({ used: 0, blocked: null });
	});

	it('does not count an attempt annulled for a defect of the version toward the limit', () => {
		const allowance = allowanceOf([annulledAttempt('version_defect')], POLICY, NOW);
		expect(allowance).toMatchObject({ used: 0, blocked: null });
	});

	it('counts an attempt annulled for plagiarism toward the limit', () => {
		const allowance = allowanceOf([annulledAttempt('plagiarism')], POLICY, NOW);
		expect(allowance).toMatchObject({ used: 1, blocked: 'attempts_exhausted' });
	});
});
