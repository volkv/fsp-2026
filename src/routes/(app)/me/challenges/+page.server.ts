import { myChallenges } from '$lib/server/challenges/candidate';
import { advanceDemoClock, demoClockOf } from '$lib/server/challenges/deliver';
import { candidateRequest } from '$lib/server/candidates/http';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * Calls of companies delivered to the candidate (domain 13.12): the newest first, with the range, the goal and what
 * became of the candidate's solution. In a demo session the visitor may move its clock a week on.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, userId } = await candidateRequest(event);
	try {
		return {
			deliveries: await myChallenges(contactPageDeps(), subject),
			names: catalogNames(),
			demoClockSeconds: await demoClockOf(db(), userId)
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	/** «Промотать неделю»: the calls of the companies of the session run on the clock a week ahead. */
	advanceClock: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		try {
			const advanced = await advanceDemoClock(db(), subject, meta, new Date());
			return { advanced: advanced.runs.reduce((sum, run) => sum + run.delivered, 0) };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
