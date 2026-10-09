// What a failed statement says of itself: the SQLSTATE of PostgreSQL behind the query wrapper of Drizzle, which carries
// the database error as its cause and whose own message is the statement with its parameters.

export interface DatabaseError {
	/** SQLSTATE: `40P01` deadlock, `23505` unique violation and so on. */
	code: string;
	/** The primary message of PostgreSQL, without the statement and its parameters. */
	message: string;
	constraint: string | null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The database error behind `error` (itself or its causes); `null` — the failure is not one of the database. */
export function databaseError(error: unknown): DatabaseError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
		const fields = current as Error & { code?: unknown; constraint_name?: unknown };
		// A SQLSTATE is five characters; the driver's own failures (a closed connection) carry codes of words.
		if (typeof fields.code === 'string' && SQLSTATE.test(fields.code)) {
			return {
				code: fields.code,
				message: current.message,
				constraint: typeof fields.constraint_name === 'string' ? fields.constraint_name : null
			};
		}
		current = current.cause;
	}
	return null;
}

/** Whether the error is a violation of the named unique constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
	const state = databaseError(error);
	return state?.code === '23505' && state.constraint === constraint;
}
