import { describe, expect, it } from 'vitest';
import {
	accountRuleFor,
	accountSubject,
	consume,
	paidParseOf,
	paidParseRule,
	RATE_LIMIT_RULES,
	rateLimitHeaders,
	refusedByPage,
	routedPath,
	ruleFor,
	type RateLimitStore
} from './rate-limit';

/** A URL of the site with the path and the query. */
const at = (path: string) => new URL(`http://localhost${path}`);

/** The account rule of a request with the method, the path and the body. */
function accountRuleOf(method: string, path: string, body?: { json: unknown } | { form: Record<string, string> }) {
	const url = at(path);
	let init: RequestInit = { method };
	if (body !== undefined && 'json' in body) {
		init = { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.json) };
	} else if (body !== undefined) {
		init = { method, body: new URLSearchParams(body.form) };
	}
	return accountRuleFor(new Request(url, init), url);
}

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

	it('limits the reads of the catalog per account, on the pages and in the API', async () => {
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
			expect(await accountRuleOf('GET', path), path).toBe(RATE_LIMIT_RULES.catalog);
		}
		expect(await accountRuleOf('HEAD', '/company/candidates')).toBe(RATE_LIMIT_RULES.catalog);
		// Posts of the card (an invitation) count as form posts of the address; other pages are not catalog reads.
		expect(await accountRuleOf('POST', '/company/vacancies/0192/candidates/k-7f3a')).toBeNull();
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
			expect(await accountRuleOf('GET', path), path).toBeNull();
		}
	});

	it('limits the export of own data per account, on the page and in the API', async () => {
		expect(await accountRuleOf('GET', '/me/export/download')).toBe(RATE_LIMIT_RULES.dataExport);
		expect(await accountRuleOf('GET', '/api/v1/me/data')).toBe(RATE_LIMIT_RULES.dataExport);
		// The page that offers the file is not the export itself.
		expect(await accountRuleOf('GET', '/me/export')).toBeNull();
		expect(await accountRuleOf('GET', '/me/export/__data.json')).toBeNull();
	});

	it('limits the parses of a pasted text per account, in the API and by the form actions that parse', async () => {
		const text = 'Ищем бэкенд-разработчика на Go';
		for (const [path, body] of [
			['/api/v1/needs', { json: { text } }],
			['/api/v1/needs', { json: { text, form: { skill_keys: ['go'], nice_skill_keys: [] } } }],
			['/api/v1/vacancies/drafts/from-text', { json: { text } }],
			['/company/needs?/create', { form: { text, grade: 'middle' } }],
			['/company/vacancies/new?/parse', { form: { text } }]
		] as const) {
			expect(await accountRuleOf('POST', path, body), path).toBe(RATE_LIMIT_RULES.textParse);
		}
		// A vacancy draft is counted whatever its body: its text is required, the route refuses an empty one.
		expect(await accountRuleOf('POST', '/api/v1/vacancies/drafts/from-text')).toBe(RATE_LIMIT_RULES.textParse);
		// A need from the form alone, with a blank text or a body that is not one parses nothing.
		for (const [path, body] of [
			['/api/v1/needs', { json: { form: { skill_keys: ['go'], nice_skill_keys: [] } } }],
			['/api/v1/needs', { json: { text: '   ', form: { skill_keys: ['go'], nice_skill_keys: [] } } }],
			['/api/v1/needs', { json: { text: null } }],
			['/api/v1/needs', { json: [text] }],
			['/api/v1/needs', undefined],
			['/company/needs?/create', { form: { text: ' ', grade: 'middle' } }],
			['/company/needs?/create', { form: { grade: 'middle' } }]
		] as const) {
			expect(await accountRuleOf('POST', path, body), `${path} ${JSON.stringify(body)}`).toBeNull();
		}
		// Other actions of the same pages and reads of the same paths parse nothing.
		for (const [method, path] of [
			['POST', '/company/vacancies/new?/create'],
			['POST', '/company/vacancies/new?/position'],
			['GET', '/company/needs'],
			['GET', '/api/v1/needs'],
			['POST', '/api/v1/needs/0195/shortlists']
		] as const) {
			expect(
				await accountRuleOf(method, path, method === 'GET' ? undefined : { form: { text } }),
				`${method} ${path}`
			).toBeNull();
		}
		// The page refuses a parse over the limit in its form; the API answers the JSON error.
		expect(refusedByPage('POST', at('/company/needs?/create'), RATE_LIMIT_RULES.textParse)).toBe(true);
		expect(refusedByPage('POST', at('/api/v1/needs'), RATE_LIMIT_RULES.textParse)).toBe(false);
		// Over the limit of the address, a form post is refused by the hook as before.
		expect(refusedByPage('POST', at('/company/needs?/create'), RATE_LIMIT_RULES.form)).toBe(false);
	});

	it('picks rules by the path the router decodes, so escapes do not step around them', async () => {
		expect(routedPath('/api/v1/n%65eds')).toBe('/api/v1/needs');
		expect(routedPath('/v%65rify/abc')).toBe('/verify/abc');
		// An escaped `%` stays escaped, as in the router: a path escaped twice reaches no route.
		expect(routedPath('/api/v1/n%2565eds')).toBe('/api/v1/n%2565eds');
		// Reserved characters stay escaped too: `%2F` is not a separator of segments.
		expect(routedPath('/api/v1%2Fneeds')).toBe('/api/v1%2Fneeds');
		expect(routedPath('/api/v1/n%E0%A4%A')).toBeNull();
		expect(ruleFor('GET', routedPath('/v%65rify/abc') ?? '')).toBe(RATE_LIMIT_RULES.receiptVerify);
		const text = { json: { text: 'Ищем Go-разработчика' } };
		expect(await accountRuleOf('POST', '/api/v1/n%65eds', text)).toBe(RATE_LIMIT_RULES.textParse);
		expect(await accountRuleOf('POST', '/company/n%65eds?/create', { form: { text: 'Go' } })).toBe(
			RATE_LIMIT_RULES.textParse
		);
		expect(await accountRuleOf('GET', '/api/v1/c%61talog/candidates')).toBe(RATE_LIMIT_RULES.catalog);
		expect(await accountRuleOf('GET', '/me/export/d%6Fwnload')).toBe(RATE_LIMIT_RULES.dataExport);
		expect(refusedByPage('GET', at('/v%65rify/abcdefghijklmnopqrstuvwxyz'), RATE_LIMIT_RULES.receiptVerify)).toBe(true);
	});

	it('names the paid parses: texts with a text and uploads of a resume, on the pages and in the API', async () => {
		const paid = (method: string, path: string, init: RequestInit = {}) =>
			paidParseOf(new Request(at(path), { method, ...init }), at(path));
		const json = (body: unknown): RequestInit => ({
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		expect(await paid('POST', '/api/v1/needs', json({ text: 'Go' }))).toBe('text');
		expect(await paid('POST', '/api/v1/needs', json({ form: { skill_keys: ['go'] } }))).toBeNull();
		expect(await paid('POST', '/api/v1/vacancies/drafts/from-text')).toBe('text');
		expect(await paid('POST', '/api/v1/me/resumes')).toBe('resume');
		expect(await paid('POST', '/api/v1/me/r%65sumes')).toBe('resume');
		expect(await paid('POST', '/me/resume?/upload')).toBe('resume');
		expect(await paid('POST', '/demo/resume')).toBe('resume');
		expect(await paid('POST', '/me/resume?/delete')).toBeNull();
		expect(await paid('GET', '/api/v1/me/resumes')).toBeNull();
		// A resume has no budget of an account: only the paid parses of the address count it.
		expect(await accountRuleOf('POST', '/api/v1/me/resumes')).toBeNull();
		const rule = paidParseRule(60);
		expect(rule).toMatchObject({ name: 'paid-parse', limit: 60, windowSeconds: 3_600 });
		// The pages refuse over the budget in their forms; the API answers the JSON error.
		for (const path of [
			'/me/resume?/upload',
			'/demo/resume',
			'/company/needs?/create',
			'/company/vacancies/new?/parse'
		]) {
			expect(refusedByPage('POST', at(path), rule), path).toBe(true);
		}
		expect(refusedByPage('POST', at('/api/v1/me/resumes'), rule)).toBe(false);
		expect(refusedByPage('POST', at('/api/v1/needs'), rule)).toBe(false);
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
