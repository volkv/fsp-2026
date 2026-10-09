// What a failed statement says of itself: the SQLSTATE of PostgreSQL behind the query wrapper of Drizzle, which carries
// the database error as its cause and whose own message is the statement with its parameters.

import { DrizzleQueryError } from 'drizzle-orm';

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

/** An error as a log line or a stored field may keep it. */
export interface LoggedError {
	name: string;
	message: string;
	stack: string | null;
	database: DatabaseError | null;
}

/**
 * The one way an error leaves the process for a log or a stored field. The query wrapper of Drizzle says the statement
 * with its parameters — names, addresses, resume texts — so it is replaced by what is behind it: for a failed statement
 * the SQLSTATE, the constraint and the primary message of PostgreSQL (its detail quotes key values and is left out), for
 * a failure of the driver its own message. Any other error is kept as it is.
 */
export function loggedError(error: unknown): LoggedError {
	if (!(error instanceof Error)) return { name: typeof error, message: String(error), stack: null, database: null };
	const database = databaseError(error);
	if (!(error instanceof DrizzleQueryError)) {
		return { name: error.name, message: error.message, stack: error.stack ?? null, database };
	}
	const cause = error.cause instanceof Error ? error.cause : null;
	const name = cause?.name ?? 'DrizzleQueryError';
	const message = database?.message ?? cause?.message ?? 'query failed';
	// The stack opens with the message of the wrapper; only the frames after it are kept, they show where the query ran.
	const header = `${error.name}: ${error.message}\n`;
	const frames = error.stack?.startsWith(header) ? error.stack.slice(header.length) : null;
	return { name, message, stack: frames === null ? null : `${name}: ${message}\n${frames}`, database };
}
