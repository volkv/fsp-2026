// The demo mode of the grade policy (docs/domain.md, sections 12.3 and 19.3): a candidate of a demo session takes any
// grade and retakes it at once, so a visitor sees the tests separate grades and repeat within the visit. What the policy
// reads to know it — whether the candidate belongs to a demo session — and the note the screens of tests show there.
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';
import { DEMO_POLICY_NOTE } from '$lib/server/grades/texts';

/** Whether the candidate's profile belongs to a demo session. */
export async function candidateInDemoSession(executor: Executor, candidateId: string): Promise<boolean> {
	const [row] = await executor
		.select({ session: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	return row.session !== null;
}

/** The note of the demo mode for the screens of the candidate's tests; `null` — the policy applies in full. */
export async function demoPolicyNote(executor: Executor, candidateId: string): Promise<string | null> {
	return (await candidateInDemoSession(executor, candidateId)) ? DEMO_POLICY_NOTE : null;
}
