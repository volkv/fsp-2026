import { journalView } from '$lib/server/admin/audit';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// An operator reads the journal only with `audit.read` granted by the administrator; `journalView` checks it.
	const { subject, meta } = await operatorRequest(event);
	try {
		return await journalView(db(), { subject, meta }, event.url.searchParams);
	} catch (cause) {
		pageError(event, cause);
	}
};
