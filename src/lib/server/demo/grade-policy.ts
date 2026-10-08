// The demo mode of the grade policy (docs/domain.md, sections 12.3 and 19.3): a candidate of a demo session retakes a
// grade and changes a confirmed one without waiting for the intervals of the policy, so a visitor sees the tests repeat
// within the visit; the order of grades, the declared grade and the attempt limit stay as in production. A session can
// turn the production policy on («Политика как в эксплуатации» on `/demo`) — then its candidates wait for the intervals
// as everybody outside demo sessions. What the policy reads to know it, the switch, and the note of the screens of tests.
import { and, eq, gt } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { candidates, demoSessions } from '$lib/server/db/schema';
import { DEMO_INTERVALS_LIFTED_NOTE, DEMO_PRODUCTION_POLICY_NOTE } from '$lib/server/grades/texts';

/**
 * How the grade policy applies to a candidate: `production` — outside demo sessions; `demo_intervals_lifted` — in a demo
 * session, the intervals lifted; `demo_production` — in a demo session that turned the production policy on.
 */
export type GradePolicyMode = 'production' | 'demo_intervals_lifted' | 'demo_production';

/** The mode of the grade policy for the candidate, from the demo session of the profile. */
export async function gradePolicyMode(executor: Executor, candidateId: string): Promise<GradePolicyMode> {
	const [row] = await executor
		.select({ session: candidates.demoSessionId, production: demoSessions.productionGradePolicy })
		.from(candidates)
		.leftJoin(demoSessions, eq(demoSessions.id, candidates.demoSessionId))
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	if (row.session === null) return 'production';
	if (row.production === null) throw new Error(`demo session ${row.session} of candidate ${candidateId} is missing`);
	return row.production ? 'demo_production' : 'demo_intervals_lifted';
}

/** Whether the intervals of the grade policy are lifted for the candidate. */
export async function gradeIntervalsLifted(executor: Executor, candidateId: string): Promise<boolean> {
	return (await gradePolicyMode(executor, candidateId)) === 'demo_intervals_lifted';
}

/** The note of the demo mode for the screens of the candidate's tests; `null` — outside demo sessions. */
export async function demoPolicyNote(executor: Executor, candidateId: string): Promise<string | null> {
	const mode = await gradePolicyMode(executor, candidateId);
	if (mode === 'demo_intervals_lifted') return DEMO_INTERVALS_LIFTED_NOTE;
	if (mode === 'demo_production') return DEMO_PRODUCTION_POLICY_NOTE;
	return null;
}

/**
 * Turns the production grade policy of a live demo session on or off; touches no other session. `false` — the session
 * ended before the switch.
 */
export async function setProductionGradePolicy(
	executor: Executor,
	sessionId: string,
	production: boolean,
	now: Date
): Promise<boolean> {
	const rows = await executor
		.update(demoSessions)
		.set({ productionGradePolicy: production })
		.where(and(eq(demoSessions.id, sessionId), gt(demoSessions.expiresAt, now)))
		.returning({ id: demoSessions.id });
	return rows.length === 1;
}

/** Whether a demo session keeps the production grade policy. */
export async function productionGradePolicyOf(executor: Executor, sessionId: string): Promise<boolean> {
	const [row] = await executor
		.select({ production: demoSessions.productionGradePolicy })
		.from(demoSessions)
		.where(eq(demoSessions.id, sessionId));
	if (!row) throw new Error(`demo session ${sessionId} is missing`);
	return row.production;
}
