// How long demo sessions live (docs/domain.md, section 19.3), from the `retention_policy` in effect and the mode of the
// stand. Regular: a session lives a day from its opening and ends after a working day without use; on a full stand
// its place goes to a new visitor after a few quiet minutes; the visitor's own resume shortens the session to its
// term. In review by the jury (`DEMO_REVIEW_MODE`): a judge comes back to the session they started days before, so a
// session lives a week after its last use within a longer term from its opening, keeps its place on a full stand while
// used within a day, and the own resume lives as the session does — never longer.
import { config } from '$lib/server/config';
import type { Executor } from '$lib/server/db';
import { currentRetentionPolicy } from '$lib/server/jobs/retention';

export interface DemoTerms {
	/** The stand is in review by the jury. */
	review: boolean;
	/** A session ends this many hours after its opening, whatever its use. */
	sessionHours: number;
	/** An upload of the visitor's own resume shortens the session to this many hours from it; `null` — not shortened. */
	ownResumeHours: number | null;
	/** A session nobody used for this long is ended by `demo.purge`. */
	idleMinutes: number;
	/** A session quiet for this long gives its place on a full stand to a new visitor. */
	evictableMinutes: number;
}

export class DemoTermsMissing extends Error {
	override name = 'DemoTermsMissing';
}

/** The terms of demo sessions on this stand now. */
export async function demoTerms(executor: Executor): Promise<DemoTerms> {
	const policy = await currentRetentionPolicy(executor);
	if (!policy || !('demo_idle_minutes' in policy)) {
		throw new DemoTermsMissing(
			'the retention_policy in effect states no terms of demo sessions in use (version 4 and later)'
		);
	}
	if (config().demo?.review === true) {
		return {
			review: true,
			sessionHours: policy.demo_review_session_hours,
			ownResumeHours: null,
			idleMinutes: policy.demo_review_idle_hours * 60,
			evictableMinutes: policy.demo_review_evictable_hours * 60
		};
	}
	return {
		review: false,
		sessionHours: policy.demo_session_hours,
		ownResumeHours: policy.demo_own_resume_hours,
		idleMinutes: policy.demo_idle_minutes,
		evictableMinutes: policy.demo_evictable_minutes
	};
}
