import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import { representationQueue } from '$lib/server/operator/representatives';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	try {
		return { queue: await representationQueue(db(), subject, new Date()) };
	} catch (cause) {
		pageError(event, cause);
	}
};
