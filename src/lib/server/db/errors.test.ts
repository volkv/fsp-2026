import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loggedError } from './errors';

describe('error for a log', () => {
	it('keeps the statement and parameters of a query that failed in the driver out of every field', () => {
		const email = 'ivan.petrov@example.org';
		const error = new DrizzleQueryError(
			'update users set email = $1',
			[email],
			new Error('write CONNECTION_CLOSED localhost:5432')
		);
		const logged = loggedError(error);
		expect(logged).toMatchObject({ message: 'write CONNECTION_CLOSED localhost:5432', database: null });
		expect(logged.stack).toMatch(/^Error: write CONNECTION_CLOSED localhost:5432\n\s+at /u);
		expect(JSON.stringify(logged)).not.toContain(email);
	});
});
