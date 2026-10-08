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

/** A URL of the site with the path and the query. */
const at = (path: string) => new URL(`http://localhost${path}`);

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
			'/api/v1/partner-pools/0193/candidates',
			'/company/shortlists/0194',
			'/company/shortlists/0194/__data.json',
			'/company/shortlists/0194/evaluate',
			'/api/v1/shortlists/0194',
			'/api/v1/shortlists/0194/what-if'
		]) {
			expect(accountRuleFor('GET', at(path)), path).toBe(RATE_LIMIT_RULES.catalog);
		}
		expect(accountRuleFor('HEAD', at('/company/candidates'))).toBe(RATE_LIMIT_RULES.catalog);
		// Posts of the card (an invitation) count as form posts of the address; other pages are not catalog reads.
		expect(accountRuleFor('POST', at('/company/vacancies/0192/candidates/k-7f3a'))).toBeNull();
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
			expect(accountRuleFor('GET', at(path)), path).toBeNull();
		}
	});

	it('limits the export of own data per account, on the page and in the API', () => {
		expect(accountRuleFor('GET', at('/me/export/download'))).toBe(RATE_LIMIT_RULES.dataExport);
		expect(accountRuleFor('GET', at('/api/v1/me/data'))).toBe(RATE_LIMIT_RULES.dataExport);
		// The page that offers the file is not the export itself.
		expect(accountRuleFor('GET', at('/me/export'))).toBeNull();
		expect(accountRuleFor('GET', at('/me/export/__data.json'))).toBeNull();
	});

	it('limits the parses of a pasted text per account, in the API and by the form actions that parse', () => {
		for (const path of [
			'/api/v1/needs',
			'/api/v1/vacancies/drafts/from-text',
			'/company/needs?/create',
			'/company/vacancies/new?/parse'
		]) {
			expect(accountRuleFor('POST', at(path)), path).toBe(RATE_LIMIT_RULES.textParse);
		}
		// Other actions of the same pages and reads of the same paths parse nothing.
		for (const [method, path] of [
			['POST', '/company/vacancies/new?/create'],
			['POST', '/company/vacancies/new?/position'],
			['GET', '/company/needs'],
			['GET', '/api/v1/needs'],
			['POST', '/api/v1/needs/0195/shortlists']
		] as const) {
			expect(accountRuleFor(method, at(path)), `${method} ${path}`).toBeNull();
		}
		// The page refuses a parse over the limit in its form; the API answers the JSON error.
		expect(refusedByPage('POST', at('/company/needs?/create'), RATE_LIMIT_RULES.textParse)).toBe(true);
		expect(refusedByPage('POST', at('/api/v1/needs'), RATE_LIMIT_RULES.textParse)).toBe(false);
		// Over the limit of the address, a form post is refused by the hook as before.
		expect(refusedByPage('POST', at('/company/needs?/create'), RATE_LIMIT_RULES.form)).toBe(false);
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
			expect(refusedByPage('GET', at(path), RATE_LIMIT_RULES.catalog), path).toBe(true);
		}
		expect(refusedByPage('HEAD', at('/company/candidates'), RATE_LIMIT_RULES.catalog)).toBe(true);
		expect(refusedByPage('POST', at('/company/candidates/k-7f3a'), RATE_LIMIT_RULES.catalog)).toBe(false);
		expect(refusedByPage('GET', at('/api/v1/catalog/candidates'), RATE_LIMIT_RULES.catalog)).toBe(false);
		expect(refusedByPage('GET', at('/api/v1/verify/abcdefghijklmnopqrstuvwxyz'), RATE_LIMIT_RULES.catalog)).toBe(false);
		expect(
			refusedByPage('GET', at('/api/v1/verify/categories/abcdefghijklmnopqrstuvwxyz'), RATE_LIMIT_RULES.catalog)
		).toBe(false);
		expect(refusedByPage('POST', at('/verify/categories/abcdefghijklmnopqrstuvwxyz'), RATE_LIMIT_RULES.catalog)).toBe(
			false
		);
		expect(refusedByPage('GET', at('/company/vacancies'), RATE_LIMIT_RULES.catalog)).toBe(false);
	});
});
