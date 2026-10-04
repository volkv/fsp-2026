import { defineConfig, devices } from '@playwright/test';

// A spec that seeds through the application's own server modules ($lib/server/*) needs `$env/dynamic/private`, which
// only SvelteKit provides. The hook has to be active before Node resolves that spec's own static imports — a call
// inside the spec file is too late whenever the spec is the first one to load it, since static imports resolve before
// any of the importing file's top-level code runs. This side-effecting import registers the hook synchronously, in
// this process: Playwright collects tests by importing every spec file directly here, before any worker starts.
import './tests/e2e/helpers/register-server-env.js';
import {
	APP_ORIGIN,
	APP_PORT,
	LOOPBACK_ORIGIN,
	PUBLIC_PROFILES_STUB_PORT,
	REDIS_DATABASE
} from './tests/e2e/helpers/ports';

// Worker processes are separate Node processes (`fork()`, playwright's `ProcessHost`) that do not inherit the hook
// above; each reads `NODE_OPTIONS` from its own environment at its own startup, so `--import`-ing the same module
// through it registers the hook there too, before the worker loads any spec file. `webServer.env` below clears this
// back out for the built application, which resolves `$env/dynamic/private` on its own (SvelteKit).
process.env.NODE_OPTIONS =
	`${process.env.NODE_OPTIONS ?? ''} --import ${new URL('./tests/e2e/helpers/register-server-env.js', import.meta.url).href}`.trim();

/**
 * The database of the tests: one of their own on the server of `.env` (`make infra`), named by E2E_DATABASE (`fsp_e2e` by
 * default) and recreated empty at every start of the application under test (scripts/e2e-database.ts), which then
 * migrates and seeds it. The development database is never touched, and a run never meets rows or a taxonomy release
 * that another run or a development session left: a second copy of the tree runs its tests at the same time with a name
 * of its own in its `.env`. Every process of the run — this one, the application, the workers and what they spawn —
 * gets it as DATABASE_URL; the workers load this file again and find it already set.
 */
function e2eDatabaseUrl(): string {
	const inherited = process.env.E2E_DATABASE_URL;
	if (inherited) return inherited;
	const development = process.env.DATABASE_URL;
	if (!development) throw new Error('DATABASE_URL must be set in .env');
	const name = process.env.E2E_DATABASE ?? 'fsp_e2e';
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
		throw new Error(`E2E_DATABASE «${name}» is not a lower-case database name`);
	}
	const url = new URL(development);
	if (decodeURIComponent(url.pathname.slice(1)) === name) {
		throw new Error(`E2E_DATABASE names the database of DATABASE_URL (${name}), which the tests would recreate empty`);
	}
	url.pathname = `/${name}`;
	return url.toString();
}

const E2E_DATABASE_URL = e2eDatabaseUrl();
process.env.E2E_DATABASE_URL = E2E_DATABASE_URL;
process.env.DATABASE_URL = E2E_DATABASE_URL;

/** Redis of `.env` with the database of the slot (helpers/ports.ts), for every process of the run as DATABASE_URL is. */
function e2eRedisUrl(): string {
	const inherited = process.env.E2E_REDIS_URL;
	if (inherited) return inherited;
	const development = process.env.REDIS_URL;
	if (!development) throw new Error('REDIS_URL must be set in .env');
	const url = new URL(development);
	url.pathname = `/${REDIS_DATABASE}`;
	return url.toString();
}

const E2E_REDIS_URL = e2eRedisUrl();
process.env.E2E_REDIS_URL = E2E_REDIS_URL;
process.env.REDIS_URL = E2E_REDIS_URL;

/**
 * A stand-in of the public APIs of Codeforces and GitHub that tests/e2e/external-profiles.spec.ts serves while it runs:
 * the application checks a one-time code and reads a profile there instead of the real sources.
 */
const PUBLIC_PROFILES_STUB = `http://127.0.0.1:${PUBLIC_PROFILES_STUB_PORT}`;

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	workers: 2,
	reporter: 'list',
	use: {
		baseURL: LOOPBACK_ORIGIN,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		// Production build against the local infrastructure (`make infra`) and the database of the tests, recreated
		// empty (above); migrations run first, then the taxonomy, legal documents, product policies and assessment bank
		// are published, as the application container does on start (Dockerfile CMD), so tests rely on the seed instead
		// of inserting rows of their own. DATABASE_URL of the environment wins over the one of `--env-file=.env`.
		command:
			'node scripts/e2e-database.ts && node --env-file=.env scripts/migrate.ts && node --env-file=.env scripts/seed-taxonomy.ts && node --env-file=.env scripts/seed-legal.ts && node --env-file=.env scripts/seed-policies.ts && node --env-file=.env scripts/seed-assessments.ts && node --env-file=.env build/index.js',
		// Readiness is probed by TCP port: a URL probe would go through HTTP_PROXY.
		port: APP_PORT,
		reuseExistingServer: false,
		timeout: 60_000,
		env: {
			DATABASE_URL: E2E_DATABASE_URL,
			E2E_DATABASE_URL,
			REDIS_URL: E2E_REDIS_URL,
			HOST: '127.0.0.1',
			PORT: String(APP_PORT),
			ORIGIN: APP_ORIGIN,
			APP_ORIGIN,
			FSP_ID_REDIRECT_URI: `${APP_ORIGIN}/auth/fsp/callback`,
			CODEFORCES_API_URL: `${PUBLIC_PROFILES_STUB}/codeforces`,
			GITHUB_API_URL: `${PUBLIC_PROFILES_STUB}/github`,
			// As in the Dockerfile: 10 MiB resume uploads plus multipart overhead.
			BODY_SIZE_LIMIT: '11M',
			// The client address comes from `X-Forwarded-For`, as on the stand behind Caddy (docker-compose.prod.yml):
			// each test sends an address of its own (tests/e2e/helpers/test.ts), so the per-address limits count every
			// test as a separate visitor rather than the whole suite as one.
			ADDRESS_HEADER: 'X-Forwarded-For',
			XFF_DEPTH: '1',
			// Overrides the NODE_OPTIONS this process otherwise inherits (see the top of this file): the migrate/seed
			// steps and the built application resolve `$env/dynamic/private` on their own (`--env-file`, SvelteKit) and
			// must not load through the test-only hook.
			NODE_OPTIONS: ''
		}
	}
});
