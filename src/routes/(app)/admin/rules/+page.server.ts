import { db } from '$lib/server/db';
import { adminRequest } from '$lib/server/admin/http';
import { rulesView } from '$lib/server/admin/reference';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		return { rules: await rulesView(db(), ctx) };
	} catch (cause) {
		pageError(event, cause);
	}
};
