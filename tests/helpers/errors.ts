import { expect } from 'vitest';

/** SQLSTATE of a database error, looking through the query wrapper of Drizzle. */
function sqlState(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
		const code = (current as Error & { code?: unknown }).code;
		if (typeof code === 'string') return code;
		current = current.cause;
	}
	return undefined;
}

/** Asserts that the operation fails with the given SQLSTATE (for example `23514` check, `23505` unique). */
export async function expectDbError(operation: Promise<unknown>, state: string, message?: RegExp): Promise<void> {
	let failure: unknown;
	try {
		await operation;
	} catch (error) {
		failure = error;
	}
	expect(failure, `expected SQLSTATE ${state}, the operation succeeded`).toBeInstanceOf(Error);
	expect(sqlState(failure)).toBe(state);
	if (message) {
		const texts: string[] = [];
		for (let current: unknown = failure; current instanceof Error; current = current.cause) texts.push(current.message);
		expect(texts.join('\n')).toMatch(message);
	}
}

export const SQLSTATE = {
	checkViolation: '23514',
	uniqueViolation: '23505',
	foreignKeyViolation: '23503',
	restrictViolation: '23001',
	insufficientPrivilege: '42501'
} as const;
