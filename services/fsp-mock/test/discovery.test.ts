import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { startMock, type RunningMock } from './helpers.ts';

/** Saved discovery of the real provider (https://sso.fsp-russia.ru/realms/fsp/.well-known/openid-configuration). */
const REAL = JSON.parse(
	await readFile(new URL('./fixtures/sso-fsp-russia-openid-configuration.json', import.meta.url), 'utf8')
) as Record<string, unknown>;
const REAL_ISSUER = 'https://sso.fsp-russia.ru/realms/fsp';

/** Fields the contract requires to match (docs/contracts.md, section 2.6). */
const PARITY_FIELDS = [
	'response_types_supported',
	'grant_types_supported',
	'code_challenge_methods_supported',
	'authorization_response_iss_parameter_supported',
	'id_token_signing_alg_values_supported',
	'claims_supported'
];

const ENDPOINT_FIELDS = [
	'authorization_endpoint',
	'token_endpoint',
	'userinfo_endpoint',
	'jwks_uri',
	'end_session_endpoint',
	'introspection_endpoint',
	'revocation_endpoint'
];

describe('discovery', () => {
	let mock: RunningMock;
	let discovery: Record<string, unknown>;

	beforeAll(async () => {
		mock = await startMock();
		const response = await fetch(`${mock.app.issuer}/.well-known/openid-configuration`);
		assert.equal(response.status, 200);
		discovery = (await response.json()) as Record<string, unknown>;
	});
	afterAll(() => mock.close());

	it('has the issuer path of the real realm on the simulator origin', () => {
		assert.equal(discovery.issuer, `${mock.origin}/realms/fsp`);
		assert.equal(new URL(REAL_ISSUER).pathname, new URL(discovery.issuer).pathname);
	});

	for (const field of PARITY_FIELDS) {
		it(`repeats ${field} of the real provider`, () => {
			assert.ok(field in REAL, `fixture lacks ${field}`);
			assert.deepEqual(discovery[field], REAL[field]);
		});
	}

	it('serves endpoints at the Keycloak paths relative to the issuer', () => {
		for (const field of ENDPOINT_FIELDS) {
			const real = String(REAL[field]).slice(REAL_ISSUER.length);
			const ours = String(discovery[field]).slice(String(discovery.issuer).length);
			assert.equal(ours, real, field);
		}
	});

	it('does not advertise birthdate or phone claims', () => {
		const claims = discovery.claims_supported as string[];
		assert.ok(!claims.includes('birthdate'));
		assert.ok(!claims.some((c) => c.startsWith('phone')));
	});

	it('publishes an RS256 signing key', async () => {
		const jwks = (await (await fetch(String(discovery.jwks_uri))).json()) as {
			keys: { kty: string; alg?: string; d?: string }[];
		};
		assert.equal(jwks.keys.length, 1);
		const [key] = jwks.keys;
		assert.ok(key);
		assert.equal(key.kty, 'RSA');
		assert.equal(key.alg, 'RS256');
		assert.equal(key.d, undefined, 'private part must not be published');
	});
});
