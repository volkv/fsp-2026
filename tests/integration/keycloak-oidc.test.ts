// «Войти через ФСП ID» against a real Keycloak: FSP ID is the realm `fsp` of a Keycloak, and the OIDC client must
// pass the whole authorization code flow with it unchanged — discovery, the authorization request with PKCE S256,
// state and nonce, the login form of Keycloak, the callback with `iss`, the code exchange and the ID token checked
// against the JWKS of the realm, down to the identity `(issuer, subject)`. A foreign state, a nonce other than the one
// of the flow and a response of another issuer are refused.
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createFspIdClient, type FspIdClient, type StartAuthorizationInput } from '$lib/server/auth/oidc';
import { sha256Hex } from '$lib/server/auth/secrets';
import type { Redis } from '$lib/server/redis';
import { KEYCLOAK_IMAGE } from '../helpers/images';

const KEYCLOAK_PORT = 8080;
const REALM_FSP = fileURLToPath(new URL('../fixtures/keycloak/realm-fsp.json', import.meta.url));
const REALM_OTHER = fileURLToPath(new URL('../fixtures/keycloak/realm-other.json', import.meta.url));
// As in the realm fixtures.
const CLIENT_ID = 'fsp-career-test';
const CLIENT_SECRET = 'keycloak-test-client-secret-0123456789abcdef';
const REDIRECT_URI = 'http://app.test/auth/fsp/callback';
const USER = { username: 'ivan.petrov', password: 'keycloak-test-password' };
const STARTUP_TIMEOUT_MS = 150_000;

let keycloak: StartedTestContainer;
let origin: string;
let issuer: string;
let redis: Redis;
let client: FspIdClient;

/** A browser on the provider side: keeps the cookies of Keycloak and follows no redirect by itself. */
class Browser {
	readonly #cookies = new Map<string, string>();

	async request(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.#cookies.size > 0) headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
		const response = await fetch(url, { ...init, headers, redirect: 'manual' });
		for (const line of response.headers.getSetCookie()) {
			const [pair = ''] = line.split(';');
			const separator = pair.indexOf('=');
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			if (value === '' || /max-age=0/i.test(line) || /expires=Thu, 01[- ]Jan[- ]1970/i.test(line)) {
				this.#cookies.delete(name);
			} else this.#cookies.set(name, value);
		}
		return response;
	}
}

/** The `action` of the Keycloak login form, HTML entities of the attribute decoded. */
function loginFormAction(html: string): string {
	const form = /<form[^>]*id="kc-form-login"[^>]*>/.exec(html)?.[0];
	const action = form ? /action="([^"]+)"/.exec(form)?.[1] : undefined;
	if (action === undefined) throw new Error('the page of Keycloak has no login form');
	return action.replaceAll('&amp;', '&');
}

/**
 * Follows the authorization request through Keycloak as a browser, filling the login form whenever Keycloak shows
 * it, until Keycloak sends the browser back to the redirect URI of the client.
 */
async function signInAtKeycloak(authorizationUrl: string, browser: Browser) {
	let url = new URL(authorizationUrl);
	let loginShown = false;
	for (let hop = 0; hop < 10; hop++) {
		if (url.href.startsWith(REDIRECT_URI)) return { callbackUrl: url, loginShown };
		let response = await browser.request(url.href);
		if (response.status === 200) {
			loginShown = true;
			const action = loginFormAction(await response.text());
			response = await browser.request(new URL(action, url).href, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ ...USER, credentialId: '' }).toString()
			});
		}
		const location = response.headers.get('location');
		if (!location) throw new Error(`Keycloak answered ${response.status} without a redirect at ${url.pathname}`);
		url = new URL(location, url);
	}
	throw new Error('too many redirects');
}

async function start(input: StartAuthorizationInput = { intent: 'login', returnTo: '/' }) {
	const started = await client.startAuthorization(input);
	if (!started.ok) throw new Error(`authorization not started: ${started.error.message}`);
	return started.value;
}

async function authorize(input?: StartAuthorizationInput, browser = new Browser()) {
	const started = await start(input);
	const { callbackUrl, loginShown } = await signInAtKeycloak(started.redirectUrl, browser);
	return { ...started, callbackUrl, loginShown };
}

beforeAll(async () => {
	keycloak = await new GenericContainer(KEYCLOAK_IMAGE)
		.withCommand(['start-dev', '--import-realm'])
		.withCopyFilesToContainer([
			{ source: REALM_FSP, target: '/opt/keycloak/data/import/realm-fsp.json' },
			{ source: REALM_OTHER, target: '/opt/keycloak/data/import/realm-other.json' }
		])
		.withExposedPorts(KEYCLOAK_PORT)
		// The realms are imported before the HTTP listener opens; ready once the discovery of `fsp` answers.
		.withWaitStrategy(Wait.forHttp('/realms/fsp/.well-known/openid-configuration', KEYCLOAK_PORT).forStatusCode(200))
		.withStartupTimeout(STARTUP_TIMEOUT_MS)
		.start();
	origin = `http://${keycloak.getHost()}:${keycloak.getMappedPort(KEYCLOAK_PORT)}`;
	issuer = `${origin}/realms/fsp`;
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	client = createFspIdClient(
		{
			issuer,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			redirectUri: REDIRECT_URI,
			scopes: 'openid profile email'
		},
		{ redis, now: () => new Date() }
	);
}, STARTUP_TIMEOUT_MS + 30_000);

afterAll(async () => {
	redis.destroy();
	await keycloak.stop();
}, 60_000);

describe('the OIDC client against Keycloak', () => {
	it('sends Keycloak an authorization request with PKCE S256, state and nonce', async () => {
		const discovery = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as {
			issuer: string;
			authorization_endpoint: string;
		};
		expect(discovery.issuer).toBe(issuer);

		const { redirectUrl, state } = await start();
		const url = new URL(redirectUrl);
		expect(`${url.origin}${url.pathname}`).toBe(discovery.authorization_endpoint);
		const params = Object.fromEntries(url.searchParams);
		expect(params).toMatchObject({
			response_type: 'code',
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: 'openid profile email',
			state,
			code_challenge_method: 'S256'
		});
		expect(params.code_challenge).toMatch(/^[\w-]{43}$/);
		expect(params.nonce?.length).toBeGreaterThanOrEqual(16);
	});

	it('signs in through the login form of Keycloak and returns the identity of the realm user', async () => {
		const startedAt = Math.floor(Date.now() / 1000);
		const { callbackUrl, state, loginShown } = await authorize({ intent: 'login', returnTo: '/me' });
		expect(loginShown).toBe(true);
		expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
		expect(callbackUrl.searchParams.get('state')).toBe(state);

		const result = await client.completeAuthorization({ callbackUrl, browserState: state });
		if (!result.ok) throw new Error(`sign-in refused: ${JSON.stringify(result.error)}`);
		const { value } = result;
		expect(value.intent).toBe('login');
		expect(value.returnTo).toBe('/me');
		expect(value.identity.issuer).toBe(issuer);
		// Keycloak names a user by the id of the realm, the same on every sign-in.
		expect(value.identity.subject).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(value.authTime).toBeGreaterThanOrEqual(startedAt - 5);
		expect(value.profileClaims).toEqual({
			name: 'Иван Петров',
			given_name: 'Иван',
			family_name: 'Петров',
			preferred_username: USER.username,
			email: 'ivan.petrov@example.org'
		});

		const again = await authorize();
		const second = await client.completeAuthorization({ callbackUrl: again.callbackUrl, browserState: again.state });
		expect(second.ok && second.value.identity).toEqual(value.identity);

		// The flow is used once: the same callback does not sign in twice.
		const replay = await client.completeAuthorization({ callbackUrl, browserState: state });
		expect(replay).toMatchObject({ ok: false, error: { code: 'state_invalid' } });
	});

	it('makes Keycloak authenticate the user again for linking despite its own session', async () => {
		const browser = new Browser();
		const first = await authorize(undefined, browser);
		expect(first.loginShown).toBe(true);
		expect((await client.completeAuthorization({ callbackUrl: first.callbackUrl, browserState: first.state })).ok).toBe(
			true
		);
		// Within the session of Keycloak a plain sign-in passes without the form.
		const silent = await authorize(undefined, browser);
		expect(silent.loginShown).toBe(false);
		expect(
			(await client.completeAuthorization({ callbackUrl: silent.callbackUrl, browserState: silent.state })).ok
		).toBe(true);

		const startedAt = Math.floor(Date.now() / 1000);
		const link = await authorize(
			{ intent: 'link', forUserId: '7d0e7a52-1f7a-4a52-9a6e-0a7c3f1d2b11', returnTo: '/settings' },
			browser
		);
		expect(new URL(link.redirectUrl).searchParams.get('prompt')).toBe('login');
		expect(link.loginShown).toBe(true);
		const result = await client.completeAuthorization({ callbackUrl: link.callbackUrl, browserState: link.state });
		if (!result.ok) throw new Error(`link refused: ${JSON.stringify(result.error)}`);
		expect(result.value.intent).toBe('link');
		expect(result.value.forUserId).toBe('7d0e7a52-1f7a-4a52-9a6e-0a7c3f1d2b11');
		expect(result.value.authTime).toBeGreaterThanOrEqual(startedAt - 5);
	});

	it('refuses a callback whose state is not the one of this browser', async () => {
		const own = await start();
		const { callbackUrl, state } = await authorize();
		const result = await client.completeAuthorization({ callbackUrl, browserState: own.state });
		expect(result).toMatchObject({ ok: false, error: { code: 'state_invalid' } });
		const missing = await client.completeAuthorization({ callbackUrl, browserState: undefined });
		expect(missing).toMatchObject({ ok: false, error: { code: 'state_invalid' } });
		// The refused callbacks did not use the flow up: its own browser still completes it.
		expect((await client.completeAuthorization({ callbackUrl, browserState: state })).ok).toBe(true);
	});

	it('refuses an ID token whose nonce is not the one of the flow', async () => {
		const { callbackUrl, state } = await authorize();
		// The flow of this browser expects another nonce than the one Keycloak put into the ID token.
		const key = `oidc_flow:${sha256Hex(state)}`;
		const flow = JSON.parse((await redis.get(key)) ?? 'null') as { nonce: string } | null;
		if (flow === null) throw new Error('the flow is not in the store');
		await redis.set(key, JSON.stringify({ ...flow, nonce: `${flow.nonce}-substituted` }), {
			expiration: { type: 'EX', value: 60 }
		});
		const result = await client.completeAuthorization({ callbackUrl, browserState: state });
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'token_invalid', message: 'ID token rejected: OAUTH_JWT_CLAIM_COMPARISON_FAILED' }
		});
	});

	it('refuses an authorization response that names another issuer', async () => {
		const { callbackUrl, state } = await authorize();
		const forged = new URL(callbackUrl);
		forged.searchParams.set('iss', 'https://sso.fsp-russia.ru/realms/fsp');
		expect(await client.completeAuthorization({ callbackUrl: forged, browserState: state })).toMatchObject({
			ok: false,
			error: { code: 'iss_mismatch' }
		});

		const unnamed = await authorize();
		const stripped = new URL(unnamed.callbackUrl);
		stripped.searchParams.delete('iss');
		expect(await client.completeAuthorization({ callbackUrl: stripped, browserState: unnamed.state })).toMatchObject({
			ok: false,
			error: { code: 'iss_mismatch' }
		});
	});

	it('refuses a code issued by another realm of the same Keycloak', async () => {
		const started = await start();
		// The same request sent to the realm `other`, where the same client and user exist.
		const misdirected = started.redirectUrl.replace('/realms/fsp/', '/realms/other/');
		const { callbackUrl } = await signInAtKeycloak(misdirected, new Browser());
		expect(callbackUrl.searchParams.get('iss')).toBe(`${origin}/realms/other`);
		expect(await client.completeAuthorization({ callbackUrl, browserState: started.state })).toMatchObject({
			ok: false,
			error: { code: 'iss_mismatch' }
		});

		// With `iss` forged to the expected issuer the code of `other` reaches the token endpoint of `fsp` and fails there.
		const again = await start();
		const second = await signInAtKeycloak(again.redirectUrl.replace('/realms/fsp/', '/realms/other/'), new Browser());
		const forged = new URL(second.callbackUrl);
		forged.searchParams.set('iss', issuer);
		const result = await client.completeAuthorization({ callbackUrl: forged, browserState: again.state });
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'provider_error', message: 'token endpoint answered invalid_grant' }
		});
	});
});
