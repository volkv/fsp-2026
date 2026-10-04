import { describe, expect, it } from 'vitest';
import { pageCsp } from '../../../../vite.config.ts';
import { CORE_CSP, applySecurityHeaders, coreCspDirectives } from './security-headers';

describe('content security policy', () => {
	it('sends the core directives on every response the framework left without a policy', () => {
		const headers = new Headers();
		applySecurityHeaders(headers, { https: false, api: true });
		expect(headers.get('content-security-policy')).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
		expect(CORE_CSP).toBe(headers.get('content-security-policy'));
	});

	it('keeps the same core directives in the page policy that replaces the header on rendered pages', () => {
		const core = coreCspDirectives();
		expect(Object.keys(core)).toEqual(['frame-ancestors', 'base-uri', 'object-src']);
		expect(pageCsp.directives).toMatchObject(core);
	});

	it('yields to a policy the framework has already set', () => {
		const headers = new Headers({ 'content-security-policy': "default-src 'self'" });
		applySecurityHeaders(headers, { https: false, api: false });
		expect(headers.get('content-security-policy')).toBe("default-src 'self'");
	});
});
