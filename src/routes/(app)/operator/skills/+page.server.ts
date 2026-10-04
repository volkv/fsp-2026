import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { operatorRequest } from '$lib/server/operator/http';
import { FEEDBACK_WINDOWS, parseFeedbackWindow, skillFeedback } from '$lib/server/operator/skills-feedback';
import { smallCountThreshold } from '$lib/server/operator/small-numbers';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const now = new Date();
	try {
		return {
			windows: FEEDBACK_WINDOWS,
			feedback: await skillFeedback(db(), subject, {
				windowDays: parseFeedbackWindow(event.url.searchParams.get('window')),
				now,
				threshold: await smallCountThreshold(db(), now)
			}),
			skills: labelsOf(await currentVocabulary(db())).skills
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
