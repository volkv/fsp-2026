import { complaintQueue } from '$lib/server/complaints/service';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	try {
		return { queue: await complaintQueue(db(), subject) };
	} catch (cause) {
		pageError(event, cause);
	}
};
