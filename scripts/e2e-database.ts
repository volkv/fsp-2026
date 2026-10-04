// Recreates the database of the end-to-end tests empty: E2E_DATABASE_URL, which playwright.config.ts derives from the
// DATABASE_URL of .env with a database name of its own (E2E_DATABASE, `fsp_e2e` by default). The tests then migrate and
// seed it themselves, so they never touch the development database and never meet data or a taxonomy release another
// run left there. Runs with plain Node (type stripping), as the first step of the e2e server (playwright.config.ts).
import postgres from 'postgres';

const target = process.env.E2E_DATABASE_URL;
if (!target) throw new Error('E2E_DATABASE_URL is not set: the e2e database is recreated by playwright.config.ts only');

const url = new URL(target);
const name = decodeURIComponent(url.pathname.slice(1));
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`«${name}» is not a database name the e2e tests use`);

// The server's maintenance database: the target cannot be dropped over a connection to itself.
url.pathname = '/postgres';
const admin = postgres(url.toString(), { max: 1, onnotice: () => undefined });
try {
	await admin`drop database if exists ${admin(name)} with (force)`;
	await admin`create database ${admin(name)}`;
	console.log(`e2e database ${name} recreated empty`);
} finally {
	await admin.end({ timeout: 5 });
}
