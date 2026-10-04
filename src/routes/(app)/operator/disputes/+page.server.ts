import { db } from '$lib/server/db';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { pageError } from '$lib/server/http/page';
import { disputeQueueView } from '$lib/server/operator/disputes';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const now = new Date();
	try {
		return {
			now,
			queue: await disputeQueueView(db(), subject, now),
			roles: labelsOf(await currentVocabulary(db())).roles
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
