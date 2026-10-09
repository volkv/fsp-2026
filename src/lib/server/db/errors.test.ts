import { DrizzleQueryError } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { loggedError } from './errors';

const email = 'ivan.petrov@example.org';

/** An error of PostgreSQL as postgres.js builds it from the server's fields. */
function postgresError(fields: Record<string, string>): Error {
	const PostgresError = postgres.PostgresError as unknown as new (fields: Record<string, string>) => Error;
	return new PostgresError({ severity: 'ERROR', ...fields });
}

describe('error for a log', () => {
	it('keeps the statement and parameters of a query that failed in the driver out of every field', () => {
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

	it('withholds the message of a data exception, which quotes the value, wrapped by Drizzle or not', () => {
		const cause = () =>
			postgresError({
				code: '22P02',
				message: `invalid input syntax for type uuid: "${email}"`,
				routine: 'string_to_uuid'
			});
		for (const error of [new DrizzleQueryError('select $1::uuid', [email], cause()), cause()]) {
			const logged = loggedError(error);
			expect(logged).toMatchObject({
				name: 'PostgresError',
				message: 'SQLSTATE 22P02',
				database: { code: '22P02', message: 'SQLSTATE 22P02', constraint: null, column: null }
			});
			expect(logged.stack).toMatch(/^PostgresError: SQLSTATE 22P02\n\s+at /u);
			expect(JSON.stringify(logged)).not.toContain(email);
		}
	});

	it('keeps the message of an integrity violation, which names the constraint, and leaves its detail out', () => {
		const error = new DrizzleQueryError(
			'insert into users (email) values ($1)',
			[email],
			postgresError({
				code: '23505',
				message: 'duplicate key value violates unique constraint "users_email_unique"',
				detail: `Key (email)=(${email}) already exists.`,
				constraint_name: 'users_email_unique'
			})
		);
		const logged = loggedError(error);
		expect(logged.database).toEqual({
			code: '23505',
			message: 'duplicate key value violates unique constraint "users_email_unique"',
			constraint: 'users_email_unique',
			column: null
		});
		expect(JSON.stringify(logged)).not.toContain(email);
	});
});
