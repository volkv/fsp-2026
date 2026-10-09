// What a failed statement says of itself: the SQLSTATE of PostgreSQL behind the query wrapper of Drizzle, which carries
// the database error as its cause and whose own message is the statement with its parameters.

import { DrizzleQueryError } from 'drizzle-orm';

export interface DatabaseError {
	/** SQLSTATE: `40P01` deadlock, `23505` unique violation and so on. */
	code: string;
	/**
	 * The primary message of PostgreSQL when its class names only schema objects; otherwise (a data exception quotes the
	 * value it could not take — `invalid input syntax for type uuid: "…"`) just the SQLSTATE.
	 */
	message: string;
	constraint: string | null;
	column: string | null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Classes of SQLSTATE whose primary messages name tables, columns, constraints, types and row ids, never a value that
 * came in: connection (08), integrity (23 — the key values are in the detail, which is not kept), transaction state (25),
 * rollback (40), syntax and access (42), resources (53), object state (55), operator intervention (57). The messages of
 * every other class, data exceptions (22) first, may quote input and are withheld.
 */
const MESSAGE_SAFE_CLASSES = new Set(['08', '23', '25', '40', '42', '53', '55', '57']);

/** The database error behind `error` (itself or its causes); `null` — the failure is not one of the database. */
export function databaseError(error: unknown): DatabaseError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
		const fields = current as Error & { code?: unknown; constraint_name?: unknown; column_name?: unknown };
		// A SQLSTATE is five characters; the driver's own failures (a closed connection) carry codes of words.
		if (typeof fields.code === 'string' && SQLSTATE.test(fields.code)) {
			const code = fields.code;
			return {
				code,
				message: MESSAGE_SAFE_CLASSES.has(code.slice(0, 2)) ? current.message : `SQLSTATE ${code}`,
				constraint: typeof fields.constraint_name === 'string' ? fields.constraint_name : null,
				column: typeof fields.column_name === 'string' ? fields.column_name : null
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

/** The frames of a stack, without its first line, which repeats the message. */
function frames(error: Error): string | null {
	const header = `${error.name}: ${error.message}\n`;
	return error.stack?.startsWith(header) ? error.stack.slice(header.length) : null;
}

/**
 * The one way an error leaves the process for a log or a stored field. The query wrapper of Drizzle says the statement
 * with its parameters — names, addresses, resume texts — so it is replaced by what is behind it. For a failed statement
 * that is the SQLSTATE, the constraint, the column and the primary message of PostgreSQL as `databaseError` keeps it (its
 * detail quotes key values and is left out); for a failure of the driver, its own message. The stack keeps only its
 * frames under the kept message. Any other error is kept as it is.
 */
export function loggedError(error: unknown): LoggedError {
	if (!(error instanceof Error)) return { name: typeof error, message: String(error), stack: null, database: null };
	const database = databaseError(error);
	if (!(error instanceof DrizzleQueryError) && database === null) {
		return { name: error.name, message: error.message, stack: error.stack ?? null, database };
	}
	// What failed: the cause behind the wrapper of Drizzle, or the error of the driver itself.
	const failed = error instanceof DrizzleQueryError ? (error.cause instanceof Error ? error.cause : null) : error;
	const name = failed?.name ?? 'DrizzleQueryError';
	const message = database?.message ?? failed?.message ?? 'query failed';
	// The stack of the outermost error shows where the query ran; its first line is the message and is replaced.
	const kept = frames(error);
	return { name, message, stack: kept === null ? null : `${name}: ${message}\n${kept}`, database };
}
