// Whether a candidate may upload a resume as far as demo sessions are concerned (docs/domain.md, section 19.3): a demo
// clone carries a real person's resume only under the separate consent `demo_resume_upload`.
import { eq } from 'drizzle-orm';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import type { Executor } from '$lib/server/db';
import { candidates, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

export type OwnResumeGate =
	/** Not a demo clone: the ordinary resume rules apply. */
	| 'not_clone'
	/** A clone with the consent in effect. */
	| 'consented'
	/** A clone without it. */
	| 'consent_missing';

/** Whether the candidate may upload a resume as far as demo sessions are concerned. */
export async function ownResumeGate(executor: Executor, candidateId: string, at: Date): Promise<OwnResumeGate> {
	const [row] = await executor
		.select({ session: users.demoSessionId })
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	if (row.session === null) return 'not_clone';
	return (await effectiveConsentOf(executor, candidateId, 'demo_resume_upload', at)) === null
		? 'consent_missing'
		: 'consented';
}
