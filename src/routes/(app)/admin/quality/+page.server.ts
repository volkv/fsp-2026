import { db } from '$lib/server/db';
import { adminRequest } from '$lib/server/admin/http';
import { qualityPanel } from '$lib/server/admin/quality';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		return { panel: await qualityPanel(db(), ctx) };
	} catch (cause) {
		pageError(event, cause);
	}
};
