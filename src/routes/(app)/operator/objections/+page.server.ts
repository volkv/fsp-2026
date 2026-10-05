import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { objectionQueueView } from '$lib/server/operator/objections';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const now = new Date();
	try {
		return { now, queue: await objectionQueueView(db(), subject, now) };
	} catch (cause) {
		pageError(event, cause);
	}
};
