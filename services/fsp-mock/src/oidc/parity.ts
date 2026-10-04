// Discovery fields that repeat the real FSP ID (Keycloak realm `fsp` at sso.fsp-russia.ru), as required by the
// contract (docs/contracts.md, section 2.6). The contract test compares them with a saved copy of the real discovery.
//
// The simulator serves the subset the platform client uses: authorization code with PKCE S256, refresh tokens,
// client credentials, RS256 ID tokens, `client_secret_basic`. The remaining advertised values (implicit and hybrid
// response types, the password, CIBA and device grants, `plain` PKCE, HMAC and other signing algorithms) are listed
// only so that the document has the same form as the real one; requests that use them are rejected.

export const REAL_PROVIDER_PARITY = {
	response_types_supported: [
		'code',
		'none',
		'id_token',
		'token',
		'id_token token',
		'code id_token',
		'code token',
		'code id_token token'
	],
	grant_types_supported: [
		'authorization_code',
		'implicit',
		'refresh_token',
		'password',
		'client_credentials',
		'urn:openid:params:grant-type:ciba',
		'urn:ietf:params:oauth:grant-type:device_code'
	],
	code_challenge_methods_supported: ['plain', 'S256'],
	authorization_response_iss_parameter_supported: true,
	id_token_signing_alg_values_supported: [
		'PS384',
		'RS384',
		'EdDSA',
		'ES384',
		'HS256',
		'HS512',
		'ES256',
		'RS256',
		'HS384',
		'ES512',
		'PS256',
		'PS512',
		'RS512'
	],
	claims_supported: [
		'aud',
		'sub',
		'iss',
		'auth_time',
		'name',
		'given_name',
		'family_name',
		'preferred_username',
		'email',
		'acr'
	]
} as const;

/** Keycloak endpoint paths relative to the issuer. */
export const KEYCLOAK_ROUTES = {
	authorization: '/protocol/openid-connect/auth',
	token: '/protocol/openid-connect/token',
	userinfo: '/protocol/openid-connect/userinfo',
	jwks: '/protocol/openid-connect/certs',
	end_session: '/protocol/openid-connect/logout',
	revocation: '/protocol/openid-connect/revoke',
	introspection: '/protocol/openid-connect/token/introspect'
} as const;

export const ISSUER_PATH = '/realms/fsp';

/** Scope of the delegated grant to the achievements API; the platform requests it together with `offline_access`. */
export const ACHIEVEMENTS_SCOPE = 'fsp_achievements';
/** Scope of the service token (client credentials) used with a signed consent assertion. */
export const ACHIEVEMENTS_SERVICE_SCOPE = 'fsp_achievements_service';
