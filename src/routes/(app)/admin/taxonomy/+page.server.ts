import { db } from '$lib/server/db';
import { adminRequest } from '$lib/server/admin/http';
import { taxonomyView } from '$lib/server/admin/reference';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	const versionId = event.url.searchParams.get('version');
	const query = event.url.searchParams.get('q') ?? '';
	try {
		return { query, taxonomy: await taxonomyView(db(), ctx, { versionId, query }) };
	} catch (cause) {
		pageError(event, cause);
	}
};
