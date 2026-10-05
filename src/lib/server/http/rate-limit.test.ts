import { describe, expect, it } from 'vitest';
import {
	accountRuleFor,
	accountSubject,
	consume,
	RATE_LIMIT_RULES,
	rateLimitHeaders,
	refusedByPage,
	ruleFor,
	type RateLimitStore
} from './rate-limit';

function memoryStore(): RateLimitStore {
	const counts = new Map<string, number>();
	return {
		hit(key, windowSeconds) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			return Promise.resolve({ count, resetSeconds: windowSeconds });
		}
	};
}

describe('rate limit', () => {
	it('allows up to the limit within a window, then refuses', async () => {
		const store = memoryStore();
		const rule = { name: 'test', limit: 2, windowSeconds: 60 };
		expect((await consume(store, rule, '10.0.0.1')).allowed).toBe(true);
		const second = await consume(store, rule, '10.0.0.1');
		expect(second).toEqual({ allowed: true, limit: 2, remaining: 0, resetSeconds: 60 });
		expect((await consume(store, rule, '10.0.0.1')).allowed).toBe(false);
		expect((await consume(store, rule, '10.0.0.2')).allowed).toBe(true);
		expect(rateLimitHeaders(second)).toEqual({
			'ratelimit-limit': '2',
			'ratelimit-remaining': '0',
			'ratelimit-reset': '60'
		});
	});

	it('limits receipt verification harder than the rest of the API and leaves health and other pages alone', () => {
		expect(ruleFor('GET', '/api/v1/verify/abc')).toBe(RATE_LIMIT_RULES.receiptVerify);
		expect(ruleFor('GET', '/verify/abc')).toBe(RATE_LIMIT_RULES.receiptVerify);
		expect(ruleFor('GET', '/verify/abc/__data.json')).toBe(RATE_LIMIT_RULES.receiptVerify);
		expect(ruleFor('GET', '/verify-email')).toBeNull();
		expect(ruleFor('GET', '/api/v1/vacancies')).toBe(RATE_LIMIT_RULES.api);
		expect(ruleFor('POST', '/api/v1/integrations/telegram/webhook')).toBe(RATE_LIMIT_RULES.webhook);
		expect(ruleFor('POST', '/api/v1/integrations/fsp/webhooks')).toBe(RATE_LIMIT_RULES.webhook);
		expect(ruleFor('POST', '/api/v1/integrations/fsp/webhooks/extra')).toBe(RATE_LIMIT_RULES.api);
		expect(ruleFor('POST', '/login')).toBe(RATE_LIMIT_RULES.form);
		expect(ruleFor('POST', '/demo')).toBe(RATE_LIMIT_RULES.demo);
		expect(ruleFor('POST', '/demo/resume')).toBe(RATE_LIMIT_RULES.form);
		expect(ruleFor('GET', '/demo')).toBeNull();
		expect(ruleFor('GET', '/api/health')).toBeNull();
		expect(ruleFor('GET', '/')).toBeNull();
	});

	it('limits the sign-in through FSP ID per address', () => {
		expect(ruleFor('GET', '/auth/fsp')).toBe(RATE_LIMIT_RULES.fspSignIn);
		expect(ruleFor('GET', '/auth/fsp/callback')).toBe(RATE_LIMIT_RULES.fspSignIn);
		expect(ruleFor('POST', '/auth/fsp/link')).toBe(RATE_LIMIT_RULES.form);
		expect(ruleFor('GET', '/auth/logout')).toBeNull();
	});

	it('limits the reads of the catalog per account, on the pages and in the API', () => {
		for (const path of [
			'/company/candidates',
			'/company/candidates/__data.json',
			'/company/candidates/k-7f3a',
			'/company/candidates/k-7f3a/__data.json',
			'/company/vacancies/0192/candidates',
			'/company/vacancies/0192/candidates/__data.json',
			'/company/vacancies/0192/candidates/k-7f3a',
			'/company/vacancies/0192/candidates/k-7f3a/__data.json',
			'/company/partner-pools/0193',
			'/company/partner-pools/0193/__data.json',
			'/api/v1/catalog/candidates',
			'/api/v1/catalog/comparison',
			'/api/v1/catalog/market',
			'/api/v1/candidates/k-7f3a',
			'/api/v1/vacancies/0192/matches',
			'/api/v1/vacancies/0192/matches/k-7f3a',
			'/api/v1/partner-pools/0193/candidates'
		]) {
			expect(accountRuleFor('GET', path), path).toBe(RATE_LIMIT_RULES.catalog);
		}
		expect(accountRuleFor('HEAD', '/company/candidates')).toBe(RATE_LIMIT_RULES.catalog);
		// Posts of the card (an invitation) count as form posts of the address; other pages are not catalog reads.
		expect(accountRuleFor('POST', '/company/vacancies/0192/candidates/k-7f3a')).toBeNull();
		for (const path of [
			'/company/vacancies',
			'/company/vacancies/0192',
			'/company/vacancies/new',
			'/company/partner-pools',
			'/company/invitations',
			'/api/v1/vacancies/0192',
			'/api/v1/partner-pools',
			'/api/v1/me/matches'
		]) {
			expect(accountRuleFor('GET', path), path).toBeNull();
		}
	});

	it('limits the export of own data per account, on the page and in the API', () => {
		expect(accountRuleFor('GET', '/me/export/download')).toBe(RATE_LIMIT_RULES.dataExport);
		expect(accountRuleFor('GET', '/api/v1/me/data')).toBe(RATE_LIMIT_RULES.dataExport);
		// The page that offers the file is not the export itself.
		expect(accountRuleFor('GET', '/me/export')).toBeNull();
		expect(accountRuleFor('GET', '/me/export/__data.json')).toBeNull();
	});

	it('counts an account rule per account, per API key, or per address without either', () => {
		expect(
			accountSubject(
				{
					kind: 'session',
					userId: 'u-1',
					sessionHash: 'h',
					authTime: new Date(),
					authMethod: 'password',
					csrfToken: 't'
				},
				'10.0.0.1'
			)
		).toBe('user:u-1');
		expect(
			accountSubject(
				{ kind: 'api_key', apiKeyId: 'k-1', companyId: 'c-1', memberId: 'm-1', userId: 'u-1', permissions: [] },
				'10.0.0.1'
			)
		).toBe('key:k-1');
		expect(accountSubject({ kind: 'anonymous' }, '10.0.0.1')).toBe('address:10.0.0.1');
	});

	it('lets the receipt and confirmation pages, the catalog pages and the sign-in through FSP ID refuse by themselves, nothing else', () => {
		for (const path of [
			'/verify/abcdefghijklmnopqrstuvwxyz',
			'/verify/abcdefghijklmnopqrstuvwxyz/__data.json',
			'/verify/categories/abcdefghijklmnopqrstuvwxyz',
			'/verify/categories/abcdefghijklmnopqrstuvwxyz/__data.json',
			'/company/candidates',
			'/company/candidates/__data.json',
			'/company/candidates/k-7f3a',
			'/company/vacancies/0192/candidates/k-7f3a/__data.json',
			'/company/partner-pools/0192',
			'/auth/fsp',
			'/auth/fsp/callback'
		]) {
			expect(refusedByPage('GET', path), path).toBe(true);
		}
		expect(refusedByPage('HEAD', '/company/candidates')).toBe(true);
		expect(refusedByPage('POST', '/company/candidates/k-7f3a')).toBe(false);
		expect(refusedByPage('GET', '/api/v1/catalog/candidates')).toBe(false);
		expect(refusedByPage('GET', '/api/v1/verify/abcdefghijklmnopqrstuvwxyz')).toBe(false);
		expect(refusedByPage('GET', '/api/v1/verify/categories/abcdefghijklmnopqrstuvwxyz')).toBe(false);
		expect(refusedByPage('POST', '/verify/categories/abcdefghijklmnopqrstuvwxyz')).toBe(false);
		expect(refusedByPage('GET', '/company/vacancies')).toBe(false);
	});
});
