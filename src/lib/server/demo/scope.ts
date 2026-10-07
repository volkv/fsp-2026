// What a viewer sees across demo sessions (docs/domain.md, section 19.3). A row of a session — a clone account, profile
// or company, or a row of theirs — is seen from inside that session only; rows outside every session are seen from
// everywhere, except the originals of the scenario cast: a viewer inside a session has their clones in front of them,
// and the originals are not shown there. A viewer inside session S therefore sees the rows of S and the rows outside
// sessions that are not of an original, and a viewer outside sessions (a real person, an original of the cast, an
// anonymous visitor) sees every row outside sessions and no row of any session. Aggregates of the stand — the career
// funnel, the market, the feedback of skills — count the rows outside sessions only: a session is a copy of the cast,
// and counting it would count the cast twice. What the staff work — cases, their files, accounts, the journal — is
// reached by a stricter rule of its own (`access/demo-actor.ts`).
import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

/** Where the root of a row — its profile or company — stands: its demo session and whether it is an original of the cast. */
export interface DemoPlace {
	demoSessionId: string | null;
	demoOriginal: boolean;
}

/** The same place as SQL expressions: the columns of a profile or a company, or expressions over them. */
export interface DemoPlaceColumns {
	demoSessionId: AnyColumn | SQL;
	demoOriginal: AnyColumn | SQL;
}

/** The row is visible to a viewer of the session `viewerSession` (`null` — outside every session). */
export function inDemoScope(row: DemoPlace, viewerSession: string | null): boolean {
	if (viewerSession === null) return row.demoSessionId === null;
	return row.demoSessionId === viewerSession || (row.demoSessionId === null && !row.demoOriginal);
}

/** `inDemoScope` as a condition over the place of the row; never `null`, so it can be a value as well as a filter. */
export function demoScope(row: DemoPlaceColumns, viewerSession: string | null): SQL {
	return viewerSession === null
		? sql`(${row.demoSessionId} is null)`
		: sql`coalesce(${row.demoSessionId} = ${viewerSession}::uuid, not ${row.demoOriginal})`;
}

/** `demoScope` of the company named by the expression. */
export function companyInDemoScope(companyId: AnyColumn | SQL, viewerSession: string | null): SQL {
	const company = {
		demoSessionId: sql`demo_scope_company.demo_session_id`,
		demoOriginal: sql`demo_scope_company.demo_original`
	};
	return sql`(select ${demoScope(company, viewerSession)} from companies demo_scope_company
		where demo_scope_company.id = ${companyId})`;
}

/** The row belongs to no demo session: what the aggregates of the stand count. */
export function outsideDemoSessions(rowSession: AnyColumn | SQL): SQL {
	return sql`${rowSession} is null`;
}

/** The session of the company named by the expression; `null` for a company outside sessions. */
export function companySession(companyId: AnyColumn | SQL): SQL {
	return sql`(select demo_scope_company.demo_session_id from companies demo_scope_company
		where demo_scope_company.id = ${companyId})`;
}

/** The session of the candidate named by the expression. */
export function candidateSession(candidateId: AnyColumn | SQL): SQL {
	return sql`(select demo_scope_candidate.demo_session_id from candidates demo_scope_candidate
		where demo_scope_candidate.id = ${candidateId})`;
}

/** The demo session of the signed-in account; `null` — a real account, an original of the cast or no account. */
export async function demoSessionOfUser(executor: Executor, userId: string | null): Promise<string | null> {
	if (userId === null) return null;
	const [row] = await executor.select({ session: users.demoSessionId }).from(users).where(eq(users.id, userId));
	if (!row) throw new ApiError('unauthenticated');
	return row.session;
}
