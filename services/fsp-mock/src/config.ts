// Environment of the simulator. Secrets have no defaults: a missing value stops the start with the variable name.

import { HEROES } from './seed/heroes.ts';

export interface MockConfig {
	/** Public origin, identical for browsers and containers, e.g. http://fsp-mock.localhost:57610. */
	origin: string;
	port: number;
	host: string;
	/** Trust X-Forwarded-Proto and X-Forwarded-Host of a TLS-terminating reverse proxy in front of the simulator. */
	trustProxy: boolean;
	client: { clientId: string; clientSecret: string; redirectUris: string[]; postLogoutRedirectUris: string[] };
	/** HMAC secret of `service_with_assertion` grants, shared with the platform. */
	assertionSecret: string;
	/** Subscription created at start; `null` — the platform subscribes itself through `POST /v1/webhooks`. */
	webhook: { url: string; secret: string } | null;
	/** Bearer token of the control endpoints; `null` — the endpoints are disabled. */
	controlToken: string | null;
	seed: string;
	athletes: number;
	/**
	 * Heroes left out of the demo accounts of the login page (their `fspId`): on a demonstration stand the platform keeps
	 * their accounts as the template of its demo sessions and does not sign in to them, so the page does not offer them.
	 */
	unlistedHeroes: ReadonlySet<string>;
}

const MIN_SECRET_LENGTH = 32;

/**
 * Default dataset seed. Names are random combinations of common Russian names, so some combination may coincide with
 * a real person; the datasets of 3000–5000 athletes from this seed were checked to contain no full name of a
 * participant listed in published FSP protocols and the national team list.
 */
export const DEFAULT_SEED = 'fsp-career-2026-7';

export class ConfigError extends Error {}

/** `FSP_MOCK_UNLISTED_HEROES`: comma-separated keys of heroes (`seed/heroes.ts`); an unknown key stops the start. */
function unlistedHeroes(env: NodeJS.ProcessEnv): ReadonlySet<string> {
	const keys = (env.FSP_MOCK_UNLISTED_HEROES ?? '')
		.split(',')
		.map((key) => key.trim())
		.filter((key) => key !== '');
	return new Set(
		keys.map((key) => {
			const found = HEROES.find((h) => h.key === key);
			if (!found) throw new ConfigError(`FSP_MOCK_UNLISTED_HEROES names an unknown hero ${key}`);
			return found.fspId;
		})
	);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === '') throw new ConfigError(`${name} is required`);
	return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
	const value = required(env, name);
	if (value.length < MIN_SECRET_LENGTH)
		throw new ConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
	return value;
}

function httpUrl(name: string, value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`${name} must be an absolute URL`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL`);
	return value;
}

function urlList(env: NodeJS.ProcessEnv, name: string, requiredList: boolean): string[] {
	const raw = requiredList ? required(env, name) : (env[name] ?? '');
	return raw
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '')
		.map((item) => httpUrl(name, item));
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string): boolean {
	const raw = env[name];
	if (raw === undefined || raw === '' || raw === 'false') return false;
	if (raw === 'true') return true;
	throw new ConfigError(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv): MockConfig {
	const origin = httpUrl('FSP_MOCK_ORIGIN', required(env, 'FSP_MOCK_ORIGIN')).replace(/\/+$/, '');
	if (new URL(origin).pathname !== '/') throw new ConfigError('FSP_MOCK_ORIGIN must not contain a path');

	const webhookUrl = env.FSP_MOCK_WEBHOOK_URL;
	const webhook =
		webhookUrl === undefined || webhookUrl === ''
			? null
			: { url: httpUrl('FSP_MOCK_WEBHOOK_URL', webhookUrl), secret: secret(env, 'FSP_MOCK_WEBHOOK_SECRET') };

	const controlToken = env.FSP_MOCK_CONTROL_TOKEN;
	if (controlToken !== undefined && controlToken !== '' && controlToken.length < MIN_SECRET_LENGTH) {
		throw new ConfigError(`FSP_MOCK_CONTROL_TOKEN must be at least ${MIN_SECRET_LENGTH} characters`);
	}

	return {
		origin,
		port: integer(env, 'PORT', 57610, 1, 65535),
		host: env.HOST ?? '0.0.0.0',
		trustProxy: boolean(env, 'FSP_MOCK_TRUST_PROXY'),
		client: {
			clientId: required(env, 'FSP_MOCK_CLIENT_ID'),
			clientSecret: secret(env, 'FSP_MOCK_CLIENT_SECRET'),
			redirectUris: urlList(env, 'FSP_MOCK_REDIRECT_URIS', true),
			postLogoutRedirectUris: urlList(env, 'FSP_MOCK_POST_LOGOUT_REDIRECT_URIS', false)
		},
		assertionSecret: secret(env, 'FSP_MOCK_ASSERTION_SECRET'),
		webhook,
		controlToken: controlToken === undefined || controlToken === '' ? null : controlToken,
		seed: env.FSP_MOCK_SEED ?? DEFAULT_SEED,
		athletes: integer(env, 'FSP_MOCK_ATHLETES', 3000, 200, 5000),
		unlistedHeroes: unlistedHeroes(env)
	};
}
