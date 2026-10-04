import { generateKeyPairSync, randomBytes } from 'node:crypto';

import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';

import type { AccountDirectory } from '../accounts.ts';
import type { MockConfig } from '../config.ts';
import { escapeHtml } from '../http.ts';
import { memoryAdapterFactory } from './memory-adapter.ts';
import {
	ACHIEVEMENTS_SCOPE,
	ACHIEVEMENTS_SERVICE_SCOPE,
	ISSUER_PATH,
	KEYCLOAK_ROUTES,
	REAL_PROVIDER_PARITY
} from './parity.ts';

export const INTERACTION_PATH = `${ISSUER_PATH}/login-actions`;

/** Lifetimes follow Keycloak defaults where the platform can observe them. */
const TTL = {
	AccessToken: 300,
	AuthorizationCode: 60,
	ClientCredentials: 300,
	IdToken: 300,
	Interaction: 600,
	RefreshToken: 30 * 24 * 3600,
	Session: 10 * 3600,
	Grant: 30 * 24 * 3600
} as const;

export function createProvider(config: MockConfig, accounts: AccountDirectory): Provider {
	const issuer = `${config.origin}${ISSUER_PATH}`;
	// Keys live for the process: after a restart clients refetch JWKS by the new `kid`, as with key rotation.
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const signingKey = {
		...privateKey.export({ format: 'jwk' }),
		use: 'sig',
		alg: 'RS256',
		kid: randomBytes(8).toString('hex')
	};

	const configuration: Configuration = {
		adapter: memoryAdapterFactory(),
		clients: [
			{
				client_id: config.client.clientId,
				client_secret: config.client.clientSecret,
				redirect_uris: config.client.redirectUris,
				post_logout_redirect_uris: config.client.postLogoutRedirectUris,
				response_types: ['code'],
				grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
				token_endpoint_auth_method: 'client_secret_basic',
				id_token_signed_response_alg: 'RS256',
				// Keycloak always puts auth_time into the ID token; the platform checks it (contracts 2.1, 2.4).
				require_auth_time: true,
				scope: ['openid', 'profile', 'email', 'offline_access', ACHIEVEMENTS_SCOPE, ACHIEVEMENTS_SERVICE_SCOPE].join(
					' '
				)
			}
		],
		jwks: { keys: [signingKey] },
		cookies: { keys: [randomBytes(32).toString('base64url')] },
		scopes: ['openid', 'offline_access', 'profile', 'email', ACHIEVEMENTS_SCOPE, ACHIEVEMENTS_SERVICE_SCOPE],
		claims: {
			openid: ['sub'],
			profile: ['name', 'given_name', 'family_name', 'preferred_username'],
			email: ['email']
		},
		// Keycloak puts scope claims into the ID token; the platform reads profile claims from it (contracts 2.2).
		conformIdTokenClaims: false,
		acrValues: ['0', '1'],
		findAccount(_ctx, sub) {
			const account = accounts.get(sub);
			if (!account) return undefined;
			return {
				accountId: account.sub,
				claims() {
					return {
						sub: account.sub,
						name: `${account.givenName} ${account.familyName}`,
						given_name: account.givenName,
						family_name: account.familyName,
						preferred_username: account.preferredUsername,
						email: account.email
					};
				}
			};
		},
		features: {
			devInteractions: { enabled: false },
			clientCredentials: { enabled: true },
			introspection: { enabled: true },
			revocation: { enabled: true },
			rpInitiatedLogout: { enabled: true }
		},
		pkce: { required: () => true },
		interactions: {
			url: (_ctx: KoaContextWithOIDC, interaction) => `${INTERACTION_PATH}/${interaction.uid}`
		},
		issueRefreshToken: (_ctx, client, code) =>
			client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),
		routes: KEYCLOAK_ROUTES,
		ttl: TTL,
		renderError(ctx, out) {
			ctx.type = 'html';
			ctx.body = errorPage(out.error, out.error_description);
		}
	};

	const provider = new Provider(issuer, configuration);
	// Behind a TLS-terminating proxy the endpoints in discovery and the cookies follow the public https address.
	provider.proxy = config.trustProxy;

	provider.use(async (ctx, next) => {
		// Keycloak issues an offline token for `offline_access` without `prompt=consent`; the library requires the
		// consent prompt for it, so the simulator adds it. The login page is shown then, as it always is here.
		if (ctx.method === 'GET' && ctx.path === KEYCLOAK_ROUTES.authorization) {
			const { scope, prompt } = ctx.query;
			const prompts = typeof prompt === 'string' ? prompt.split(' ').filter((p) => p !== '') : [];
			if (
				typeof scope === 'string' &&
				scope.split(' ').includes('offline_access') &&
				!prompts.includes('consent') &&
				!prompts.includes('none')
			) {
				ctx.query = { ...ctx.query, prompt: [...prompts, 'consent'].join(' ') };
				// The provider derives its mount path from the original URL: keep it in step with the rewritten one.
				(ctx.req as typeof ctx.req & { originalUrl?: string }).originalUrl = `${ISSUER_PATH}${ctx.url}`;
			}
		}
		await next();
		// Repeat the real discovery document in the fields the contract compares (see parity.ts).
		const { oidc } = ctx as Partial<KoaContextWithOIDC>;
		if (oidc?.route === 'discovery' && typeof ctx.body === 'object' && ctx.body !== null) {
			Object.assign(ctx.body, REAL_PROVIDER_PARITY);
		}
	});

	return provider;
}

function errorPage(error: string, description: string | undefined): string {
	return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ошибка — имитатор ФСП ID</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<p style="background:#fff3cd;padding:.5rem 1rem;border-radius:.5rem">Имитатор ФСП ID для тестового стенда</p>
<h1>Ошибка входа</h1><p><code>${escapeHtml(error)}</code></p><p>${escapeHtml(description ?? '')}</p></body></html>`;
}
