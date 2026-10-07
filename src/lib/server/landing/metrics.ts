// Figures of the platform for the first screen of the landing page, read from the database as it stands: the size of
// the published taxonomy (roles and skills that vacancies, resumes and categories are read against) and the families
// of tasks in the released test banks (domain 10.1: every candidate gets instances of their own).
import { count, eq, sql } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { bankReleases, roles, skills } from '$lib/server/db/schema';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';

export interface PlatformMetrics {
	/** `null` before the first published taxonomy. */
	taxonomy: { roles: number; skills: number } | null;
	/** Families of tasks across the released banks; 0 before the first release. */
	taskFamilies: number;
}

export async function platformMetrics(executor: Executor): Promise<PlatformMetrics> {
	const version = await latestPublishedVersion(executor);
	const [families] = await executor
		.select({
			n: sql<number>`coalesce(sum(jsonb_array_length(${bankReleases.manifest} -> 'families')), 0)::int`
		})
		.from(bankReleases)
		.where(eq(bankReleases.status, 'released'));
	const taskFamilies = families?.n ?? 0;
	if (version === null) return { taxonomy: null, taskFamilies };
	const [[roleCount], [skillCount]] = await Promise.all([
		executor.select({ n: count() }).from(roles).where(eq(roles.taxonomyVersionId, version.id)),
		executor.select({ n: count() }).from(skills).where(eq(skills.taxonomyVersionId, version.id))
	]);
	return { taxonomy: { roles: roleCount?.n ?? 0, skills: skillCount?.n ?? 0 }, taskFamilies };
}
