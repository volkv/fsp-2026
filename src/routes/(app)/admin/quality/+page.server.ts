import { db } from '$lib/server/db';
import { fairnessAudit } from '$lib/server/admin/fairness';
import { adminRequest } from '$lib/server/admin/http';
import { qualityPanel } from '$lib/server/admin/quality';
import { pageError } from '$lib/server/http/page';
import { configuredShortlistDeps } from '$lib/server/shortlists/page';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = await adminRequest(event);
	try {
		const [panel, fairness] = await Promise.all([
			qualityPanel(db(), ctx),
			fairnessAudit(configuredShortlistDeps(), ctx, event.request.signal)
		]);
		return { panel, fairness };
	} catch (cause) {
		pageError(event, cause);
	}
};
