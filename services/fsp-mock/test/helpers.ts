import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { createServer } from 'node:net';

import { loadConfig, type MockConfig } from '../src/config.ts';
import { createMockApp, type MockApp } from '../src/server.ts';

export const CLIENT_ID = 'fsp-career';
export const CLIENT_SECRET = 'test-client-secret-0123456789abcdef';
export const ASSERTION_SECRET = 'test-assertion-secret-0123456789abcdef';
export const CONTROL_TOKEN = 'test-control-token-0123456789abcdef';
export const REDIRECT_URI = 'http://127.0.0.1:1/auth/fsp/callback';
/** Small dataset keeps tests fast; generation and scenarios do not depend on the size. */
export const TEST_ATHLETES = 400;

export interface RunningMock {
	app: MockApp;
	config: MockConfig;
	origin: string;
	close(): Promise<void>;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => {
				if (address && typeof address === 'object') resolve(address.port);
				else reject(new Error('no port'));
			});
		});
	});
}

export async function startMock(env: Record<string, string> = {}): Promise<RunningMock> {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const config = loadConfig({
		FSP_MOCK_ORIGIN: origin,
		PORT: String(port),
		HOST: '127.0.0.1',
		FSP_MOCK_CLIENT_ID: CLIENT_ID,
		FSP_MOCK_CLIENT_SECRET: CLIENT_SECRET,
		FSP_MOCK_REDIRECT_URIS: REDIRECT_URI,
		FSP_MOCK_ASSERTION_SECRET: ASSERTION_SECRET,
		FSP_MOCK_CONTROL_TOKEN: CONTROL_TOKEN,
		FSP_MOCK_ATHLETES: String(TEST_ATHLETES),
		...env
	});
	const app = createMockApp(config, () => undefined);
	await new Promise<void>((resolve) => app.server.listen(config.port, config.host, resolve));
	return {
		app,
		config,
		origin,
		close: () =>
			new Promise<void>((resolve, reject) => {
				app.server.closeAllConnections();
				app.server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			})
	};
}

/** Minimal browser: follows nothing by itself, keeps cookies by name. */
export class Browser {
	readonly #cookies = new Map<string, string>();

	async request(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.#cookies.size > 0) {
			headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
		}
		const response = await fetch(url, { ...init, headers, redirect: 'manual' });
		for (const line of response.headers.getSetCookie()) {
			const [pair = ''] = line.split(';');
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.#cookies.delete(name);
			else this.#cookies.set(name, value);
		}
		return response;
	}
}

export function location(response: Response, base: string): URL {
	const value = response.headers.get('location');
	if (!value) throw new Error(`expected a redirect, got ${response.status}`);
	return new URL(value, base);
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function basicAuth(): string {
	return `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`;
}

export interface AuthorizeOptions {
	sub: string;
	scope?: string;
	prompt?: string;
	maxAge?: number;
	browser?: Browser;
}

export interface AuthorizeOutcome {
	callback: URL;
	state: string;
	nonce: string;
	verifier: string;
	browser: Browser;
	/** Whether the login page was shown (false when an existing session was reused). */
	loginShown: boolean;
}

/** Runs the authorization request through the login page up to the redirect back to the client. */
export async function authorize(mock: RunningMock, options: AuthorizeOptions): Promise<AuthorizeOutcome> {
	const browser = options.browser ?? new Browser();
	const { verifier, challenge } = pkcePair();
	const state = randomBytes(32).toString('base64url');
	const nonce = randomBytes(16).toString('base64url');
	const discovery = (await (await fetch(`${mock.app.issuer}/.well-known/openid-configuration`)).json()) as {
		authorization_endpoint: string;
	};
	const url = new URL(discovery.authorization_endpoint);
	url.search = new URLSearchParams({
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		scope: options.scope ?? 'openid profile email',
		state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		...(options.prompt ? { prompt: options.prompt } : {}),
		...(options.maxAge !== undefined ? { max_age: String(options.maxAge) } : {})
	}).toString();

	let response = await browser.request(url.href);
	let next = location(response, mock.origin);
	let loginShown = false;
	if (next.pathname.includes('/login-actions/')) {
		loginShown = true;
		const page = await browser.request(next.href);
		if (page.status !== 200) throw new Error(`login page answered ${page.status}`);
		response = await browser.request(`${next.href}/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ sub: options.sub }).toString()
		});
		next = location(response, mock.origin);
		// Resume the authorization request after the interaction.
		response = await browser.request(next.href);
		next = location(response, mock.origin);
	}
	return { callback: next, state, nonce, verifier, browser, loginShown };
}

export interface TokenSet {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	scope: string;
	token_type: string;
}

export async function exchangeCode(mock: RunningMock, code: string, verifier: string): Promise<Response> {
	return fetch(`${mock.app.issuer}/protocol/openid-connect/token`, {
		method: 'POST',
		headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier
		}).toString()
	});
}

/** Full login of an account; returns the token set. */
export async function login(
	mock: RunningMock,
	sub: string,
	scope = 'openid profile email fsp_achievements'
): Promise<TokenSet> {
	const outcome = await authorize(mock, { sub, scope });
	const code = outcome.callback.searchParams.get('code');
	if (!code) throw new Error(`no code in ${outcome.callback.href}`);
	const response = await exchangeCode(mock, code, outcome.verifier);
	if (response.status !== 200) throw new Error(`token endpoint answered ${response.status}: ${await response.text()}`);
	return (await response.json()) as TokenSet;
}

export async function serviceToken(mock: RunningMock, scope = 'fsp_achievements_service'): Promise<string> {
	const response = await fetch(`${mock.app.issuer}/protocol/openid-connect/token`, {
		method: 'POST',
		headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString()
	});
	if (response.status !== 200)
		throw new Error(`client credentials answered ${response.status}: ${await response.text()}`);
	const body = (await response.json()) as { access_token: string };
	return body.access_token;
}

export function decodeJwtPart(part: string | undefined): Record<string, unknown> {
	if (part === undefined) throw new Error('malformed JWT');
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Verifies an RS256 JWT against the provider's JWKS and returns its payload. */
export async function verifyIdToken(mock: RunningMock, jwt: string): Promise<Record<string, unknown>> {
	const [headerPart, payloadPart, signaturePart] = jwt.split('.');
	const header = decodeJwtPart(headerPart);
	if (header.alg !== 'RS256') throw new Error(`unexpected alg ${String(header.alg)}`);
	const jwks = (await (await fetch(`${mock.app.issuer}/protocol/openid-connect/certs`)).json()) as {
		keys: (JsonWebKey & { kid?: string })[];
	};
	const jwk = jwks.keys.find((k) => k.kid === header.kid);
	if (!jwk) throw new Error('signing key not found in JWKS');
	const ok = verify(
		'RSA-SHA256',
		Buffer.from(`${headerPart ?? ''}.${payloadPart ?? ''}`),
		createPublicKey({ key: jwk, format: 'jwk' }),
		Buffer.from(signaturePart ?? '', 'base64url')
	);
	if (!ok) throw new Error('ID token signature is invalid');
	return decodeJwtPart(payloadPart);
}

export function control(mock: RunningMock, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${CONTROL_TOKEN}`);
	if (init.body !== undefined) headers.set('content-type', 'application/json');
	return fetch(`${mock.origin}${path}`, { ...init, headers });
}
