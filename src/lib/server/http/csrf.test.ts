import { describe, expect, it } from 'vitest';
import { checkRequestOrigin, csrfTokenMatches } from './csrf';

const appOrigin = 'https://career.example.org';
const base = { method: 'POST', pathname: '/api/v1/invitations', origin: appOrigin, hasSessionCookie: true, appOrigin };

describe('checkRequestOrigin', () => {
	it('accepts same-origin state changes and any safe request', () => {
		expect(checkRequestOrigin(base)).toEqual({ ok: true });
		expect(checkRequestOrigin({ ...base, method: 'GET', origin: 'https://evil.example' })).toEqual({ ok: true });
	});

	it('refuses a cross-origin state change, with or without a session', () => {
		expect(checkRequestOrigin({ ...base, origin: 'https://evil.example' })).toEqual({
			ok: false,
			reason: 'origin_mismatch'
		});
		expect(checkRequestOrigin({ ...base, origin: 'https://evil.example', hasSessionCookie: false })).toEqual({
			ok: false,
			reason: 'origin_mismatch'
		});
	});

	it('refuses a session request without Origin but lets a non-browser client through', () => {
		expect(checkRequestOrigin({ ...base, origin: null })).toEqual({ ok: false, reason: 'origin_missing' });
		expect(checkRequestOrigin({ ...base, origin: null, hasSessionCookie: false })).toEqual({ ok: true });
	});

	it('leaves signed webhooks to their signature check', () => {
		expect(
			checkRequestOrigin({ ...base, pathname: '/api/v1/integrations/fsp/webhooks', origin: 'https://fsp.example' })
		).toEqual({ ok: true });
	});
});

describe('csrfTokenMatches', () => {
	it('compares tokens exactly', () => {
		expect(csrfTokenMatches('token-1', 'token-1')).toBe(true);
		expect(csrfTokenMatches('token-1', 'token-2')).toBe(false);
		expect(csrfTokenMatches('token-1', 'token-10')).toBe(false);
		expect(csrfTokenMatches('token-1', null)).toBe(false);
	});
});
