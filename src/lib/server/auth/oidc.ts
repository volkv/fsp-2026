// OIDC client to FSP ID (docs/contracts.md, section 2): Authorization Code with PKCE S256, state and nonce kept in
// Redis for ten minutes and bound to the browser that started the flow, `iss` of the authorization response checked,
// ID token signature checked against `jwks_uri`. The client knows only standard OIDC; the simulator and the real
// provider differ by settings alone.
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Redis } from '$lib/server/redis';
import { secretsEqual, sha256Hex } from './secrets';
import { loggedError } from '$lib/server/db/errors';

export interface FspIdSettings {
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string;
}

export type FspIdIntent = 'login' | 'link';

/** `unavailable` — the provider does not answer; `store_unavailable` — the flow store (Redis) of the application fails. */
export type FspIdErrorCode =
	| 'state_invalid'
	| 'iss_mismatch'
	| 'token_invalid'
	| 'provider_error'
	| 'unavailable'
	| 'access_denied'
	| 'store_unavailable';

export interface FspIdError {
	code: FspIdErrorCode;
	retryable: boolean;
	/** Without personal data. */
	message: string;
}

export type FspIdResult<T> = { ok: true; value: T } | { ok: false; error: FspIdError };

export interface ProfileClaims {
	name?: string;
	given_name?: string;
	family_name?: string;
	preferred_username?: string;
	email?: string;
}

export interface FspIdAuthorization {
	intent: FspIdIntent;
	forUserId: string | null;
	returnTo: string;
	identity: { issuer: string; subject: string };
	/** `auth_time` of the ID token, seconds since the epoch. */
	authTime: number;
	profileClaims: ProfileClaims;
}

export interface StartAuthorizationInput {
	intent: FspIdIntent;
	/** For `link`: the user who started linking; checked again on return (contracts 2.4, step 3). */
	forUserId?: string;
	/** Relative path of the application only. */
	returnTo: string;
	/**
	 * Ask the provider for a new authentication (`prompt=login`, `max_age=0`) and accept only an `auth_time` not
	 * earlier than the start. Always on for `link` (contracts 2.4, step 2).
	 */
	reauthenticate?: boolean;
}

export interface FspIdClient {
	readonly issuer: string;
	/** URL of the provider and the `state` the caller puts into the browser cookie that binds the flow. */
	startAuthorization(input: StartAuthorizationInput): Promise<FspIdResult<{ redirectUrl: string; state: string }>>;
	/** Handles the return to `redirect_uri`: `browserState` is the value of the binding cookie. */
	completeAuthorization(input: {
		callbackUrl: URL;
		browserState: string | undefined;
	}): Promise<FspIdResult<FspIdAuthorization>>;
}

/** The flow lives in Redis for ten minutes (contracts 2.1). */
export const FLOW_TTL_SECONDS = 600;
/** ID token algorithms the client accepts (contracts 2.1). */
const ALLOWED_ALGORITHMS = ['RS256', 'PS256', 'ES256'] as const;
/** Claims the client reads; the provider must declare them (contracts 2.6). */
const USED_CLAIMS = ['sub', 'iss', 'auth_time', 'email', 'name', 'given_name', 'family_name', 'preferred_username'];
/** Clock difference tolerated between the provider and the application when comparing `auth_time`. */
const AUTH_TIME_SKEW_SECONDS = 5;
const REQUEST_TIMEOUT_SECONDS = 10;

const flowSchema = z.object({
	intent: z.enum(['login', 'link']),
	forUserId: z.uuid().nullable(),
	returnTo: z.string(),
	codeVerifier: z.string().min(43),
	nonce: z.string().min(16),
	startedAt: z.number().int(),
	reauthenticate: z.boolean()
});
type Flow = z.infer<typeof flowSchema>;

const flowKey = (state: string) => `oidc_flow:${sha256Hex(state)}`;

const fail = (code: FspIdErrorCode, message: string, retryable = false): { ok: false; error: FspIdError } => ({
	ok: false,
	error: { code, retryable, message }
});

/** Checks that the values the client uses are among the declared ones (contracts 2.6, «Сверка discovery»). */
function metadataProblems(metadata: oidc.ServerMetadata): string[] {
	const problems: string[] = [];
	const includes = (list: unknown, value: string) => Array.isArray(list) && list.includes(value);
	if (!includes(metadata.response_types_supported, 'code')) problems.push('response_types_supported lacks code');
	if (!includes(metadata.grant_types_supported, 'authorization_code')) {
		problems.push('grant_types_supported lacks authorization_code');
	}
	if (!includes(metadata.code_challenge_methods_supported, 'S256')) {
		problems.push('code_challenge_methods_supported lacks S256');
	}
	if (metadata.authorization_response_iss_parameter_supported !== true) {
		problems.push('authorization_response_iss_parameter_supported is not true');
	}
	const algorithms = metadata.id_token_signing_alg_values_supported;
	if (!ALLOWED_ALGORITHMS.some((alg) => includes(algorithms, alg))) {
		problems.push('id_token_signing_alg_values_supported has no allowed algorithm');
	}
	for (const claim of USED_CLAIMS) {
		if (!includes(metadata.claims_supported, claim)) problems.push(`claims_supported lacks ${claim}`);
	}
	return problems;
}

/** A failed command of the flow store; the cause names the connection problem and carries no personal data. */
export function storeFailure(cause: unknown): { ok: false; error: FspIdError } {
	return fail(
		'store_unavailable',
		`flow store failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		true
	);
}

function isNetworkFailure(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	if (error instanceof oidc.ClientError) {
		return ['OAUTH_TIMEOUT', 'OAUTH_ABORT', 'OAUTH_RESPONSE_IS_NOT_CONFORM', 'OAUTH_RESPONSE_IS_NOT_JSON'].includes(
			error.code ?? ''
		);
	}
	return false;
}

function headerAlgorithm(jwt: string): unknown {
	const [header] = jwt.split('.');
	if (header === undefined) return undefined;
	const parsed: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
	return typeof parsed === 'object' && parsed !== null ? (parsed as { alg?: unknown }).alg : undefined;
}

function stringClaim(claims: Record<string, unknown>, name: keyof ProfileClaims): Partial<ProfileClaims> {
	const value = claims[name];
	return typeof value === 'string' && value.trim() !== '' ? { [name]: value.trim().slice(0, 200) } : {};
}

export function createFspIdClient(settings: FspIdSettings, deps: { redis: Redis; now: () => Date }): FspIdClient {
	let configuration: oidc.Configuration | undefined;

	async function configure(): Promise<FspIdResult<oidc.Configuration>> {
		if (configuration) return { ok: true, value: configuration };
		const insecure = new URL(settings.issuer).protocol === 'http:';
		let discovered: oidc.Configuration;
		try {
			discovered = await oidc.discovery(
				new URL(settings.issuer),
				settings.clientId,
				{ require_auth_time: true },
				oidc.ClientSecretBasic(settings.clientSecret),
				{
					// The simulator of the stand is served over HTTP; the real provider is HTTPS only.
					execute: [
						// eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated only as a warning sign: the stand's FSP ID simulator is served over HTTP, a real issuer is HTTPS and never takes this branch.
						...(insecure ? [oidc.allowInsecureRequests] : []),
						oidc.enableNonRepudiationChecks
					],
					timeout: REQUEST_TIMEOUT_SECONDS
				}
			);
		} catch (error) {
			if (isNetworkFailure(error)) return fail('unavailable', 'FSP ID discovery is unreachable', true);
			console.error('[fsp-id] discovery rejected', loggedError(error));
			return fail('provider_error', 'FSP ID discovery document is not acceptable');
		}
		const problems = metadataProblems(discovered.serverMetadata());
		if (problems.length > 0) {
			console.error(`[fsp-id] provider does not declare what the client uses: ${problems.join('; ')}`);
			return fail('provider_error', 'FSP ID provider does not support the required protocol features');
		}
		configuration = discovered;
		return { ok: true, value: discovered };
	}

	return {
		issuer: settings.issuer,

		async startAuthorization(input) {
			const configured = await configure();
			if (!configured.ok) return configured;
			const reauthenticate = input.intent === 'link' || input.reauthenticate === true;
			const state = oidc.randomState();
			const flow: Flow = {
				intent: input.intent,
				forUserId: input.forUserId ?? null,
				returnTo: input.returnTo,
				codeVerifier: oidc.randomPKCECodeVerifier(),
				nonce: oidc.randomNonce(),
				startedAt: deps.now().getTime(),
				reauthenticate
			};
			const url = oidc.buildAuthorizationUrl(configured.value, {
				redirect_uri: settings.redirectUri,
				scope: settings.scopes,
				state,
				nonce: flow.nonce,
				code_challenge: await oidc.calculatePKCECodeChallenge(flow.codeVerifier),
				code_challenge_method: 'S256',
				...(reauthenticate ? { prompt: 'login', max_age: '0' } : {})
			});
			try {
				await deps.redis.set(flowKey(state), JSON.stringify(flow), {
					expiration: { type: 'EX', value: FLOW_TTL_SECONDS },
					condition: 'NX'
				});
			} catch (error) {
				return storeFailure(error);
			}
			return { ok: true, value: { redirectUrl: url.href, state } };
		},

		async completeAuthorization({ callbackUrl, browserState }) {
			const state = callbackUrl.searchParams.get('state');
			// The flow must return to the browser that started it: a callback link replayed in another browser is refused.
			if (state === null || browserState === undefined || !secretsEqual(state, browserState)) {
				return fail('state_invalid', 'state does not match the flow of this browser');
			}
			// One use: the flow is taken out of the store before anything else.
			let raw: string | null;
			try {
				raw = await deps.redis.getDel(flowKey(state));
			} catch (error) {
				return storeFailure(error);
			}
			if (raw === null) return fail('state_invalid', 'flow is unknown or expired');
			const flow = flowSchema.parse(JSON.parse(raw));

			const configured = await configure();
			if (!configured.ok) return configured;
			const expectedIssuer = configured.value.serverMetadata().issuer;
			// `iss` of the authorization response (RFC 9207) is compared exactly before the response is used.
			if (callbackUrl.searchParams.get('iss') !== expectedIssuer) {
				return fail('iss_mismatch', 'authorization response comes from another issuer');
			}

			// The token request uses the registered redirect URI, whatever address the request came through.
			const current = new URL(settings.redirectUri);
			current.search = callbackUrl.search;
			const now = deps.now().getTime();
			let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
			try {
				tokens = await oidc.authorizationCodeGrant(configured.value, current, {
					pkceCodeVerifier: flow.codeVerifier,
					expectedState: state,
					expectedNonce: flow.nonce,
					idTokenExpected: true,
					// With `max_age=0` sent, the library requires a bound; the exact rule is checked below.
					...(flow.reauthenticate ? { maxAge: Math.ceil((now - flow.startedAt) / 1000) + AUTH_TIME_SKEW_SECONDS } : {})
				});
			} catch (error) {
				if (error instanceof oidc.AuthorizationResponseError) {
					return error.error === 'access_denied'
						? fail('access_denied', 'the user declined the sign-in')
						: fail('provider_error', `authorization failed: ${error.error}`);
				}
				if (error instanceof oidc.ResponseBodyError) {
					return fail('provider_error', `token endpoint answered ${error.error}`);
				}
				if (isNetworkFailure(error)) return fail('unavailable', 'FSP ID token endpoint is unreachable', true);
				if (error instanceof oidc.ClientError) {
					return fail('token_invalid', `ID token rejected: ${error.code ?? error.message}`);
				}
				throw error;
			}

			const idToken = tokens.id_token;
			const claims = tokens.claims();
			if (idToken === undefined || claims === undefined) return fail('token_invalid', 'no ID token in the response');
			const algorithm = headerAlgorithm(idToken);
			if (typeof algorithm !== 'string' || !(ALLOWED_ALGORITHMS as readonly string[]).includes(algorithm)) {
				return fail('token_invalid', 'ID token algorithm is not allowed');
			}
			if (claims.iss !== expectedIssuer) return fail('iss_mismatch', 'ID token comes from another issuer');
			const authTime = claims.auth_time;
			if (typeof authTime !== 'number') return fail('token_invalid', 'ID token has no auth_time');
			if (flow.reauthenticate && authTime < Math.floor(flow.startedAt / 1000) - AUTH_TIME_SKEW_SECONDS) {
				return fail('token_invalid', 'the provider did not authenticate the user again');
			}
			const record = claims as unknown as Record<string, unknown>;
			return {
				ok: true,
				value: {
					intent: flow.intent,
					forUserId: flow.forUserId,
					returnTo: flow.returnTo,
					identity: { issuer: claims.iss, subject: claims.sub },
					authTime,
					profileClaims: {
						...stringClaim(record, 'name'),
						...stringClaim(record, 'given_name'),
						...stringClaim(record, 'family_name'),
						...stringClaim(record, 'preferred_username'),
						...stringClaim(record, 'email')
					}
				}
			};
		}
	};
}
