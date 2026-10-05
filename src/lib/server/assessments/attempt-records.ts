// Attempts of a candidate as the grade policy sees them (docs/domain.md, 10.7, 12.3), for the owner of the policy
// (`grades/sources.ts`): every attempt of purpose `grade` with the outcome and the reason of its valid decision, and an
// attempt of any purpose while it is in progress — one attempt in progress per candidate closes every test.
import { and, eq, or } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { gradeDecisions, testAttempts } from '$lib/server/db/schema';
import { GRADE_KEYS, SPECIALIZATION_KEYS, type GradeKey, type SpecializationKey } from './contract/catalog';
import { GRADE_POLICY, type PolicyAttempt } from './contract/policy';

export interface AttemptRecord extends PolicyAttempt {
	specialization: SpecializationKey;
}

function keyOf<K extends string>(keys: readonly K[], value: string, what: string): K {
	const key = keys.find((k) => k === value);
	if (!key) throw new Error(`attempt of unknown ${what} ${value}`);
	return key;
}

export async function attemptRecords(executor: Executor, candidateId: string): Promise<AttemptRecord[]> {
	const rows = await executor
		.select({
			specialization: testAttempts.specialization,
			grade: testAttempts.grade,
			status: testAttempts.status,
			startedAt: testAttempts.startedAt,
			endedAt: testAttempts.endedAt,
			annulReason: testAttempts.annulReason,
			outcome: gradeDecisions.outcome,
			reason: gradeDecisions.reason
		})
		.from(testAttempts)
		.leftJoin(gradeDecisions, and(eq(gradeDecisions.attemptId, testAttempts.id), eq(gradeDecisions.status, 'valid')))
		.where(
			and(
				eq(testAttempts.candidateId, candidateId),
				or(eq(testAttempts.purpose, 'grade'), eq(testAttempts.status, 'in_progress'))
			)
		);
	const free = GRADE_POLICY.freeRetakeAnnulReasons;
	return rows.map((row): AttemptRecord => {
		const base = {
			specialization: keyOf(SPECIALIZATION_KEYS, row.specialization, 'specialization'),
			grade: keyOf<GradeKey>(GRADE_KEYS, row.grade, 'grade'),
			startedAt: row.startedAt,
			endedAt: row.endedAt
		};
		switch (row.status) {
			case 'in_progress':
				return { ...base, state: 'in_progress' };
			case 'expired':
				return { ...base, state: 'expired' };
			case 'annulled':
				return {
					...base,
					state: row.annulReason && free.includes(row.annulReason) ? 'annulled_free' : 'annulled_counted'
				};
			case 'decided':
				if (!row.outcome || !row.reason) throw new Error('a decided attempt without a valid decision');
				return { ...base, state: { decided: row.outcome, reason: row.reason } };
		}
	});
}
