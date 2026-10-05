// The clock of the calls of companies (docs/domain.md, 13.12, 19.3): outside demo sessions it is the clock of the
// application; a company of a demo session runs its calls on the clock of its session, moved on by «промотать неделю»
// (`demo_sessions.clock_offset_seconds`) — the next cycle of delivery is shown without waiting, and no other session or
// row outside sessions is touched.
import { eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { companies, demoSessions } from '$lib/server/db/schema';

/** The shift of the clock of each company asked for, in milliseconds; a company outside sessions has none. */
export async function companyClockOffsets(
	executor: Executor,
	companyIds: readonly string[]
): Promise<Map<string, number>> {
	const ids = [...new Set(companyIds)];
	const result = new Map<string, number>(ids.map((id) => [id, 0]));
	if (ids.length === 0) return result;
	const rows = await executor
		.select({ companyId: companies.id, offset: demoSessions.clockOffsetSeconds })
		.from(companies)
		.innerJoin(demoSessions, eq(demoSessions.id, companies.demoSessionId))
		.where(inArray(companies.id, ids));
	for (const row of rows) result.set(row.companyId, row.offset * 1000);
	return result;
}

/** The moment `now` on the clock of the company. */
export async function companyNow(executor: Executor, companyId: string, now: Date): Promise<Date> {
	const offset = (await companyClockOffsets(executor, [companyId])).get(companyId) ?? 0;
	return new Date(now.getTime() + offset);
}
