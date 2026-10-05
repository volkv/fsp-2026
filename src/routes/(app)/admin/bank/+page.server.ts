import { adminRequest } from '$lib/server/admin/http';
import { bankReleasesOverview } from '$lib/server/assessments/bank-store';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { requirePermission } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import type { PageServerLoad } from './$types';

/** Releases of the bank of test items (domain 10.5): what serves each specialization and the reports it passed. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await adminRequest(event);
	try {
		requirePermission(subject, 'policy.manage', null);
		return {
			releases: await bankReleasesOverview(db()),
			specializations: CATALOG.specializations.map((s) => ({
				key: s.key,
				title: s.title,
				availability: s.availability
			}))
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
