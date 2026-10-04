// Applies pending SQL migrations. Runs with plain Node (type stripping), without the SvelteKit runtime,
// so it is usable both from the dev shell and as the container start step.
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set');
}

const migrationsFolder = fileURLToPath(new URL('../src/lib/server/db/migrations', import.meta.url));
const client = postgres(databaseUrl, {
	max: 1,
	onnotice: (notice) => {
		console.log(`[migrate] ${notice.severity}: ${notice.message}`);
	}
});

try {
	await migrate(drizzle({ client }), { migrationsFolder });
	console.log(`Migrations applied from ${migrationsFolder}`);
} finally {
	await client.end({ timeout: 5 });
}
