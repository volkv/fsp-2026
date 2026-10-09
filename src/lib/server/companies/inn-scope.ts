// The taxpayer number of a live company is unique outside demo sessions and, separately, within each demo session
// (docs/domain.md, 19.3): visitors of different sessions register the same company, and the clone of a company of the
// cast keeps its number. Two unique indexes hold it, one for each place of the company.
import { sql } from 'drizzle-orm';
import { companies } from '$lib/server/db/schema';
import { isUniqueViolation } from '$lib/server/db/errors';

/** The conflict target of an insert of a live company into its place: `null` — outside sessions. */
export function innConflict(demoSessionId: string | null) {
	return demoSessionId === null
		? { target: companies.inn, where: sql`status <> 'rejected' and demo_session_id is null` }
		: {
				target: [companies.inn, companies.demoSessionId],
				where: sql`status <> 'rejected' and demo_session_id is not null`
			};
}

/** The number is taken by another live company of the same place. */
export function isInnTaken(error: unknown): boolean {
	return (
		isUniqueViolation(error, 'companies_inn_not_rejected') ||
		isUniqueViolation(error, 'companies_inn_not_rejected_demo')
	);
}
