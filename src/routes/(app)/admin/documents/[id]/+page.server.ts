import { db } from '$lib/server/db';
import { adminRequest } from '$lib/server/admin/http';
import { documentView } from '$lib/server/admin/reference';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		return { document: await documentView(db(), ctx, event.params.id) };
	} catch (cause) {
		pageError(event, cause);
	}
};
