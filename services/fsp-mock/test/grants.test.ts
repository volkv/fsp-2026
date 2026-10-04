import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { ASSERTION_HEADER, encodeAssertion, signAssertion } from '../src/api/grants.ts';
import { SERVICE_ACCOUNTS, hero } from '../src/seed/heroes.ts';
import { ASSERTION_SECRET, login, serviceToken, startMock, type RunningMock } from './helpers.ts';

type ErrorBody = { error: { code: string } };

async function achievements(mock: RunningMock, fspId: string, headers: Record<string, string>): Promise<Response> {
	return fetch(`${mock.origin}/v1/athletes/${fspId}/achievements`, { headers });
}

function assertion(fspId: string, overrides: { issuedAt?: Date; lifetimeMs?: number; secret?: string } = {}) {
	const issuedAt = overrides.issuedAt ?? new Date();
	return encodeAssertion(
		signAssertion(
			{
				sourceAthleteId: fspId,
				consentEventId: 'consent-event-1',
				issuedAt: issuedAt.toISOString(),
				expiresAt: new Date(issuedAt.getTime() + (overrides.lifetimeMs ?? 120_000)).toISOString()
			},
			overrides.secret ?? ASSERTION_SECRET
		)
	);
}

describe('delegated_user_token', () => {
	let mock: RunningMock;
	const owner = hero('captain_backend');
	const other = hero('team_no_spec');
	let token: string;

	beforeAll(async () => {
		mock = await startMock();
		token = (await login(mock, owner.fspId)).access_token;
	});
	afterAll(() => mock.close());

	it('gives the owner their own achievements', async () => {
		const response = await achievements(mock, owner.fspId, { authorization: `Bearer ${token}` });
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as { athlete: { fspId: string } }).athlete.fspId, owner.fspId);
	});

	it('answers grant_mismatch for somebody else, for the achievements and the profile', async () => {
		for (const path of [`/v1/athletes/${other.fspId}/achievements`, `/v1/athletes/${other.fspId}`]) {
			const response = await fetch(`${mock.origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
			assert.equal(response.status, 403, path);
			assert.equal(((await response.json()) as ErrorBody).error.code, 'grant_mismatch');
		}
	});

	it('does not reveal whether another athlete exists', async () => {
		const response = await achievements(mock, 'no-such-athlete', { authorization: `Bearer ${token}` });
		assert.equal(response.status, 403);
	});

	it('answers grant_invalid without a token, with a garbage token or without the achievements scope', async () => {
		const noScope = (await login(mock, owner.fspId, 'openid profile')).access_token;
		for (const headers of [{}, { authorization: 'Bearer garbage' }, { authorization: `Bearer ${noScope}` }] as Record<
			string,
			string
		>[]) {
			const response = await achievements(mock, owner.fspId, headers);
			assert.equal(response.status, 401);
			assert.equal(((await response.json()) as ErrorBody).error.code, 'grant_invalid');
		}
	});

	it('answers not_found for an FSP ID account without an athlete profile', async () => {
		const noProfile = SERVICE_ACCOUNTS.find((s) => s.account.kind === 'no_athlete_profile');
		assert.ok(noProfile);
		const own = (await login(mock, noProfile.account.sub)).access_token;
		const response = await achievements(mock, noProfile.account.sub, { authorization: `Bearer ${own}` });
		assert.equal(response.status, 404);
		assert.equal(((await response.json()) as ErrorBody).error.code, 'not_found');
	});
});

describe('service_with_assertion', () => {
	let mock: RunningMock;
	const athlete = hero('online_vs_final');
	const other = hero('annulled');
	let service: string;

	beforeAll(async () => {
		mock = await startMock();
		service = await serviceToken(mock);
	});
	afterAll(() => mock.close());

	const call = (fspId: string, assertionValue: string, token = service) =>
		achievements(mock, fspId, { authorization: `Bearer ${token}`, [ASSERTION_HEADER]: assertionValue });

	it('accepts a signed, fresh assertion for the requested athlete', async () => {
		const response = await call(athlete.fspId, assertion(athlete.fspId));
		assert.equal(response.status, 200);
	});

	it('answers grant_mismatch when the assertion names another athlete', async () => {
		const response = await call(other.fspId, assertion(athlete.fspId));
		assert.equal(response.status, 403);
		assert.equal(((await response.json()) as ErrorBody).error.code, 'grant_mismatch');
	});

	it('answers grant_invalid for a wrong signature, an expired or too long assertion', async () => {
		const cases = {
			'wrong secret': assertion(athlete.fspId, { secret: 'another-secret-0123456789abcdef0123' }),
			expired: assertion(athlete.fspId, { issuedAt: new Date(Date.now() - 10 * 60_000) }),
			'lifetime over 5 minutes': assertion(athlete.fspId, { lifetimeMs: 6 * 60_000 }),
			'issued in the future': assertion(athlete.fspId, { issuedAt: new Date(Date.now() + 5 * 60_000) }),
			'not base64url JSON': '!!!'
		};
		for (const [name, value] of Object.entries(cases)) {
			const response = await call(athlete.fspId, value);
			assert.equal(response.status, 401, name);
			assert.equal(((await response.json()) as ErrorBody).error.code, 'grant_invalid', name);
		}
	});

	it('answers grant_invalid when the athlete id in a signed assertion is altered', async () => {
		const original = JSON.parse(Buffer.from(assertion(athlete.fspId), 'base64url').toString('utf8')) as Record<
			string,
			string
		>;
		const forged = Buffer.from(JSON.stringify({ ...original, sourceAthleteId: other.fspId }), 'utf8').toString(
			'base64url'
		);
		const response = await call(other.fspId, forged);
		assert.equal(response.status, 401);
	});

	it('requires a service token, not a user token, together with an assertion', async () => {
		const user = (await login(mock, athlete.fspId)).access_token;
		const response = await call(athlete.fspId, assertion(athlete.fspId), user);
		assert.equal(response.status, 401);
	});
});
