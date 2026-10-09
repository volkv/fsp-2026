// Ports, origins and the Redis database of an e2e run, from one place: playwright.config.ts and every spec read them here. A run takes a
// slot of three ports: the application under test, the stand-in of the public profile APIs
// (external-profiles.spec.ts) and the demonstration stand of demo.spec.ts. E2E_PORT picks the slot by its first port;
// a second copy of the tree runs its tests at the same time in the other slot (docs/development.md, «Своя база e2e»).
// Only these slots exist because FSP ID of the shared simulator (compose.yaml, FSP_MOCK_REDIRECT_URIS) returns only to
// their callbacks: the list is fixed there, not taken from the environment of the copy that last started the simulator.

/** First ports of the slots the simulator of compose.yaml knows the callbacks of. */
export const E2E_SLOTS = [57175, 57185] as const;

function slot(): number {
	const value = process.env.E2E_PORT;
	if (value === undefined || value === '') return E2E_SLOTS[0];
	const port = Number(value);
	if (!E2E_SLOTS.some((known) => known === port)) {
		throw new Error(
			`E2E_PORT ${value} is not one of ${E2E_SLOTS.join(', ')}, whose FSP ID callbacks compose.yaml registers`
		);
	}
	return port;
}

/** The application under test. */
export const APP_PORT = slot();
/**
 * Public origin of the application under test: form posts are checked against it, and FSP ID returns to its callback.
 * Tests that post forms or sign in open the application at this origin; read-only pages are also served at
 * `LOOPBACK_ORIGIN`.
 */
export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const LOOPBACK_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
/** Offset taking the port of the slot out of the range of outgoing connections: 57175 becomes 27175. */
const BELOW_OUTGOING_RANGE = 30_000;
/** The stand-in of the public APIs of Codeforces and GitHub, served by external-profiles.spec.ts while it runs. */
export const PUBLIC_PROFILES_STUB_PORT = APP_PORT - BELOW_OUTGOING_RANGE + 1;
/** The demonstration stand of demo.spec.ts, with a database and a simulator of its own. */
export const DEMO_STAND_PORT = APP_PORT - BELOW_OUTGOING_RANGE + 2;
/**
 * The Redis database of the run on the server of `.env`: one per slot and never 0, the development one. Sessions, rate
 * limits and the switches of the models live there, and two runs switching a model at once would see each other's.
 */
export const REDIS_DATABASE = E2E_SLOTS.findIndex((known) => known === APP_PORT) + 1;
