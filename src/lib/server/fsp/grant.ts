// Access grants of the achievements API (docs/contracts.md, sections 1.2 and 1.8). The platform uses
// `service_with_assertion`: a `client_credentials` token of FSP ID with scope `fsp_achievements_service` plus an
// assertion about one athlete and one `fsp_import` consent, signed with `FSP_ASSERTION_SECRET`. A delegated user
// token needs the refresh token of the user, which the platform stores only in that mode (contracts 2.1).
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { parseJson } from './json';
import type { AccessGrant, AdapterResult } from './types';

const SERVICE_SCOPE = 'fsp_achievements_service';
/** Assertions live at most five minutes (contracts 1.2); two leave room for pagination of a long history. */
const ASSERTION_LIFETIME_MS = 2 * 60 * 1000;
/** A token is renewed this long before it expires. */
const TOKEN_RENEW_MARGIN_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

interface GrantIssuerOptions {
	/** FSP ID issuer: discovery at `{issuer}/.well-known/openid-configuration`. */
	issuer: string;
	clientId: string;
	clientSecret: string;
	assertionSecret: string;
	fetch?: typeof fetch;
	now?: () => Date;
}

type GrantErrorCode = 'grant_invalid' | 'unavailable' | 'protocol_error';

export interface GrantIssuer {
	/** A grant for one call about `sourceAthleteId` under the consent event `consentEventId`. */
	issue(input: {
		sourceAthleteId: string;
		consentEventId: string;
	}): Promise<AdapterResult<AccessGrant, GrantErrorCode>>;
}

/** HMAC-SHA-256 in lowercase hex over the four fields joined by `\n`, as they stand in the JSON (contracts 1.8). */
function signAssertion(
	fields: { sourceAthleteId: string; consentEventId: string; issuedAt: string; expiresAt: string },
	secret: string
): string {
	const input = [fields.sourceAthleteId, fields.consentEventId, fields.issuedAt, fields.expiresAt].join('\n');
	return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

const discoverySchema = z.object({ issuer: z.string(), token_endpoint: z.url({ protocol: /^https?$/ }) });
const tokenSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().regex(/^bearer$/i),
	expires_in: z.int().positive(),
	scope: z.string().optional()
});

type Answer = { status: number; json: unknown };
type Failure = { ok: false; error: { code: GrantErrorCode; retryable: boolean; message: string } };
const fail = (code: GrantErrorCode, retryable: boolean, message: string): Failure => ({
	ok: false,
	error: { code, retryable, message }
});

export class ServiceGrantIssuer implements GrantIssuer {
	readonly #options: GrantIssuerOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => Date;
	#tokenEndpoint: string | undefined;
	#token: { value: string; expiresAt: number } | undefined;

	constructor(options: GrantIssuerOptions) {
		this.#options = { ...options, issuer: options.issuer.replace(/\/+$/, '') };
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? (() => new Date());
	}

	async #request(url: string, init: RequestInit = {}): Promise<Answer | Failure> {
		try {
			const response = await this.#fetch(url, {
				...init,
				redirect: 'error',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			return { status: response.status, json: parseJson(await response.text()) };
		} catch (cause) {
			return fail('unavailable', true, `FSP ID request failed: ${cause instanceof Error ? cause.name : 'error'}`);
		}
	}

	async #endpoint(): Promise<AdapterResult<string, GrantErrorCode>> {
		if (this.#tokenEndpoint !== undefined) return { ok: true, value: this.#tokenEndpoint };
		const response = await this.#request(`${this.#options.issuer}/.well-known/openid-configuration`, {
			headers: { accept: 'application/json' }
		});
		if ('error' in response) return response;
		if (response.status >= 500) return fail('unavailable', true, `FSP ID discovery answered ${response.status}`);
		if (response.status !== 200) return fail('protocol_error', false, `FSP ID discovery answered ${response.status}`);
		const document = discoverySchema.safeParse(response.json);
		if (!document.success) return fail('protocol_error', false, 'FSP ID discovery document is invalid');
		// The issuer is compared exactly (contracts 2.1): a document of another issuer is not this provider.
		if (document.data.issuer !== this.#options.issuer) return fail('protocol_error', false, 'FSP ID issuer mismatch');
		this.#tokenEndpoint = document.data.token_endpoint;
		return { ok: true, value: this.#tokenEndpoint };
	}

	async #serviceToken(): Promise<AdapterResult<string, GrantErrorCode>> {
		const now = this.#now().getTime();
		if (this.#token && this.#token.expiresAt - TOKEN_RENEW_MARGIN_MS > now)
			return { ok: true, value: this.#token.value };
		const endpoint = await this.#endpoint();
		if (!endpoint.ok) return endpoint;
		const { clientId, clientSecret } = this.#options;
		const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
		const response = await this.#request(endpoint.value, {
			method: 'POST',
			headers: {
				authorization: `Basic ${basic}`,
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json'
			},
			body: new URLSearchParams({ grant_type: 'client_credentials', scope: SERVICE_SCOPE }).toString()
		});
		if ('error' in response) return response;
		if (response.status >= 500 || response.status === 429) {
			return fail('unavailable', true, `FSP ID token endpoint answered ${response.status}`);
		}
		if (response.status !== 200) {
			// invalid_client, unauthorized_client, invalid_scope: the platform's credentials or registration are wrong.
			return fail('grant_invalid', false, `FSP ID refused the service token (${response.status})`);
		}
		const token = tokenSchema.safeParse(response.json);
		if (!token.success) return fail('protocol_error', false, 'FSP ID token answer is invalid');
		if (token.data.scope !== undefined && !token.data.scope.split(' ').includes(SERVICE_SCOPE)) {
			return fail('grant_invalid', false, `FSP ID did not grant ${SERVICE_SCOPE}`);
		}
		this.#token = { value: token.data.access_token, expiresAt: now + token.data.expires_in * 1000 };
		return { ok: true, value: token.data.access_token };
	}

	async issue(input: {
		sourceAthleteId: string;
		consentEventId: string;
	}): Promise<AdapterResult<AccessGrant, GrantErrorCode>> {
		const token = await this.#serviceToken();
		if (!token.ok) return token;
		const issued = this.#now();
		const fields = {
			sourceAthleteId: input.sourceAthleteId,
			consentEventId: input.consentEventId,
			issuedAt: issued.toISOString(),
			expiresAt: new Date(issued.getTime() + ASSERTION_LIFETIME_MS).toISOString()
		};
		return {
			ok: true,
			value: {
				kind: 'service_with_assertion',
				serviceToken: token.value,
				assertion: { ...fields, signature: signAssertion(fields, this.#options.assertionSecret) }
			}
		};
	}
}
