import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { hero } from '../src/seed/heroes.ts';
import {
	Browser,
	CLIENT_ID,
	REDIRECT_URI,
	authorize,
	basicAuth,
	exchangeCode,
	location,
	startMock,
	verifyIdToken,
	type RunningMock,
	type TokenSet
} from './helpers.ts';

describe('authorization code with PKCE', () => {
	let mock: RunningMock;
	const athlete = hero('algo_kms');

	beforeAll(async () => {
		mock = await startMock();
	});
	afterAll(() => mock.close());

	it('issues a signed ID token with nonce, auth_time and profile claims, and returns iss and state', async () => {
		const outcome = await authorize(mock, { sub: athlete.fspId, scope: 'openid profile email' });
		assert.equal(outcome.callback.origin + outcome.callback.pathname, REDIRECT_URI);
		assert.equal(outcome.callback.searchParams.get('state'), outcome.state);
		assert.equal(outcome.callback.searchParams.get('iss'), mock.app.issuer);
		const code = outcome.callback.searchParams.get('code');
		assert.ok(code);

		const response = await exchangeCode(mock, code, outcome.verifier);
		assert.equal(response.status, 200);
		const tokens = (await response.json()) as TokenSet;
		const claims = await verifyIdToken(mock, tokens.id_token);
		assert.equal(claims.iss, mock.app.issuer);
		assert.equal(claims.sub, athlete.fspId);
		assert.equal(claims.aud, CLIENT_ID);
		assert.equal(claims.nonce, outcome.nonce);
		assert.equal(typeof claims.auth_time, 'number');
		assert.equal(claims.given_name, athlete.name.firstName);
		assert.equal(claims.family_name, athlete.name.lastName);
		assert.equal(typeof claims.email, 'string');
		assert.equal(typeof claims.preferred_username, 'string');
		assert.equal(claims.birthdate, undefined);
		assert.equal(tokens.refresh_token, undefined, 'no refresh token without offline_access');

		const userinfo = await fetch(`${mock.app.issuer}/protocol/openid-connect/userinfo`, {
			headers: { authorization: `Bearer ${tokens.access_token}` }
		});
		assert.equal(userinfo.status, 200);
		assert.equal(((await userinfo.json()) as { sub: string }).sub, athlete.fspId);
	});

	it('issues a refresh token when offline_access is requested', async () => {
		const outcome = await authorize(mock, { sub: athlete.fspId, scope: 'openid offline_access fsp_achievements' });
		const response = await exchangeCode(mock, outcome.callback.searchParams.get('code') ?? '', outcome.verifier);
		const tokens = (await response.json()) as TokenSet;
		assert.ok(tokens.refresh_token);
		const refreshed = await fetch(`${mock.app.issuer}/protocol/openid-connect/token`, {
			method: 'POST',
			headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString()
		});
		assert.equal(refreshed.status, 200);
		assert.match(((await refreshed.json()) as TokenSet).scope, /fsp_achievements/);
	});

	it('rejects a code exchanged with a wrong verifier', async () => {
		const outcome = await authorize(mock, { sub: athlete.fspId });
		const response = await exchangeCode(mock, outcome.callback.searchParams.get('code') ?? '', 'x'.repeat(43));
		assert.equal(response.status, 400);
		assert.equal(((await response.json()) as { error: string }).error, 'invalid_grant');
	});

	it('refuses an authorization request without a code challenge', async () => {
		const url = new URL(`${mock.app.issuer}/protocol/openid-connect/auth`);
		url.search = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: 'openid',
			state: 's',
			nonce: 'n'
		}).toString();
		const response = await fetch(url, { redirect: 'manual' });
		const target = new URL(response.headers.get('location') ?? '', mock.origin);
		assert.equal(target.searchParams.get('error'), 'invalid_request');
		assert.equal(target.searchParams.get('code'), null);
	});

	it('refuses a redirect_uri that is not registered exactly', async () => {
		const url = new URL(`${mock.app.issuer}/protocol/openid-connect/auth`);
		url.search = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: `${REDIRECT_URI}/extra`,
			response_type: 'code',
			scope: 'openid',
			code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			code_challenge_method: 'S256'
		}).toString();
		const response = await fetch(url, { redirect: 'manual' });
		assert.equal(response.status, 400);
	});

	it('asks to log in again for prompt=login and max_age=0 and reports a fresh auth_time', async () => {
		const first = await authorize(mock, { sub: athlete.fspId });
		const firstTokens = (await (
			await exchangeCode(mock, first.callback.searchParams.get('code') ?? '', first.verifier)
		).json()) as TokenSet;
		const firstAuthTime = Number((await verifyIdToken(mock, firstTokens.id_token)).auth_time);

		// Same browser session without prompt: no login page.
		const silent = await authorize(mock, { sub: athlete.fspId, browser: first.browser });
		assert.equal(silent.loginShown, false);

		await new Promise((resolve) => setTimeout(resolve, 1100));
		const again = await authorize(mock, { sub: athlete.fspId, browser: first.browser, prompt: 'login', maxAge: 0 });
		assert.equal(again.loginShown, true);
		const tokens = (await (
			await exchangeCode(mock, again.callback.searchParams.get('code') ?? '', again.verifier)
		).json()) as TokenSet;
		const authTime = Number((await verifyIdToken(mock, tokens.id_token)).auth_time);
		assert.ok(authTime > firstAuthTime, 'auth_time must be refreshed');
	});

	it('returns access_denied when the user refuses', async () => {
		const url = new URL(`${mock.app.issuer}/protocol/openid-connect/auth`);
		url.search = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: 'openid',
			state: 'refused',
			code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			code_challenge_method: 'S256'
		}).toString();
		const browser = new Browser();
		const interaction = location(await browser.request(url.href), mock.origin);
		const page = await browser.request(interaction.href);
		assert.match(await page.text(), /Имитатор ФСП ID/);
		const resume = location(await browser.request(`${interaction.href}/abort`, { method: 'POST' }), mock.origin);
		const callback = location(await browser.request(resume.href), mock.origin);
		assert.equal(callback.searchParams.get('error'), 'access_denied');
		assert.equal(callback.searchParams.get('state'), 'refused');
	});
});

describe('demo accounts of the login page', () => {
	const interactionPage = async (mock: RunningMock, query?: string): Promise<string> => {
		const url = new URL(`${mock.app.issuer}/protocol/openid-connect/auth`);
		url.search = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: 'openid',
			state: 'listed',
			code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			code_challenge_method: 'S256'
		}).toString();
		const browser = new Browser();
		const interaction = location(await browser.request(url.href), mock.origin);
		if (query !== undefined) interaction.searchParams.set('q', query);
		return (await browser.request(interaction.href)).text();
	};

	it('offers every hero by default and leaves out the heroes the stand names', async () => {
		const shown = hero('captain_backend');
		const kept = hero('long_history');
		const every = await startMock();
		try {
			const page = await interactionPage(every);
			assert.ok(page.includes(shown.fspId));
			assert.ok(page.includes(kept.fspId));
		} finally {
			await every.close();
		}
		const stand = await startMock({ FSP_MOCK_UNLISTED_HEROES: 'captain_backend, algo_kms' });
		try {
			const page = await interactionPage(stand);
			assert.ok(!page.includes(shown.fspId));
			assert.ok(!page.includes(hero('algo_kms').fspId));
			assert.ok(page.includes(kept.fspId));
		} finally {
			await stand.close();
		}
	});

	it('does not find the heroes the stand names by search either', async () => {
		const hidden = hero('captain_backend');
		const kept = hero('long_history');
		const stand = await startMock({ FSP_MOCK_UNLISTED_HEROES: 'captain_backend' });
		// The page repeats the query in the search field; an offered account is a button with its subject.
		const offers = (page: string, fspId: string) => page.includes(`name="sub" value="${fspId}"`);
		try {
			for (const query of [hidden.fspId, `${hidden.name.lastName} ${hidden.name.firstName}`]) {
				const page = await interactionPage(stand, query);
				assert.ok(!offers(page, hidden.fspId), `search by ${query} shows the unlisted hero`);
			}
			assert.ok((await interactionPage(stand, hidden.fspId)).includes('Никого не нашлось.'));
			const found = await interactionPage(stand, kept.fspId);
			assert.ok(!found.includes('Никого не нашлось.'));
			assert.ok(offers(found, kept.fspId));
		} finally {
			await stand.close();
		}
	});

	it('refuses to start with an unknown hero', async () => {
		await assert.rejects(startMock({ FSP_MOCK_UNLISTED_HEROES: 'nobody' }), /unknown hero nobody/);
	});
});
