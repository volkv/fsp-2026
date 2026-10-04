import { journalView } from '$lib/server/admin/audit';
import { adminRequest } from '$lib/server/admin/http';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// `journalView` checks `audit.read` itself; the administrator role includes it.
	const ctx = await adminRequest(event);
	try {
		return await journalView(db(), ctx, event.url.searchParams);
	} catch (cause) {
		pageError(event, cause);
	}
};
