import { db } from '$lib/server/db';
import { platformMetrics } from '$lib/server/landing/metrics';
import type { PageServerLoad } from './$types';

/** The landing page: the figures of the first screen come from the database, not from the page. */
export const load: PageServerLoad = async () => ({ metrics: await platformMetrics(db()) });
