import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import { operatorOverview } from '$lib/server/operator/overview';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	try {
		return { overview: await operatorOverview(db(), subject, new Date()) };
	} catch (cause) {
		pageError(event, cause);
	}
};
