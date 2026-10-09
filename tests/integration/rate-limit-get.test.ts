// Limits of the reads that cost the most (src/lib/server/http/rate-limit.ts), through the request hooks against Redis:
// the catalog per account — its pages and its API share one budget, a key of the API has its own —, the export of own
// data per account, the parses the model is paid for per account and per address, and the sign-in through FSP ID per
// address. A path spelled with percent-escapes is counted as the route it reaches. A page over the limit is let through to refuse by itself in the layout of the site — the
// catalog pages with `429`, the sign-in with a redirect to the sign-in page — and the API gets its JSON error.
import { randomInt, randomUUID } from 'node:crypto';
import { isHttpError, isRedirect, type Handle, type RequestEvent } from '@sveltejs/kit';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import {
	paidParseRule,
	RATE_LIMIT_RULES,
	rateLimitHandles,
	redisRateLimitStore,
	type RateLimitHandles
} from '$lib/server/http/rate-limit';
import type { Redis } from '$lib/server/redis';
import { employerRequest } from '$lib/server/employer/http';
import { GET as startFspSignIn } from '../../src/routes/auth/fsp/+server';
import { GET as fspCallback } from '../../src/routes/auth/fsp/callback/+server';
import { actions as needsActions } from '../../src/routes/(app)/company/(member)/needs/+page.server';
import { actions as resumeActions } from '../../src/routes/(app)/me/resume/+page.server';
import { actions as demoResumeActions } from '../../src/routes/(auth)/demo/resume/+page.server';

/** The action «Новая потребность» of the page, as SvelteKit calls it. */
function createNeedAction(event: RequestEvent) {
	const action = needsActions.create;
	if (!action) throw new Error('the needs page has no create action');
	return action(event as Parameters<typeof action>[0]);
}

const REDIS_DATABASE = 6;

/** The budget of paid parses of an address in the tests of other limits: out of their way. */
const WIDE_PAID_BUDGET = 1_000;
/** The budget of paid parses of an address in its own tests. */
const PAID_BUDGET = 6;

let redis: Redis;
let hooks: RateLimitHandles;
let paidHooks: RateLimitHandles;

beforeAll(async () => {
	redis = createClient({ url: `${inject('redisUrl')}/${String(REDIS_DATABASE)}` });
	await redis.connect();
	const store = () => Promise.resolve(redisRateLimitStore(redis));
	hooks = rateLimitHandles({ store, waitMs: 1_000, paidParsesPerAddress: () => WIDE_PAID_BUDGET });
	paidHooks = rateLimitHandles({ store, waitMs: 1_000, paidParsesPerAddress: () => PAID_BUDGET });
});

afterAll(async () => {
	await redis.flushDb();
	redis.destroy();
});

const address = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

const person = (userId = randomUUID()): Actor => ({
	kind: 'session',
	userId,
	sessionHash: 'hash',
	authTime: new Date(),
	authMethod: 'password',
	csrfToken: 'token'
});

const apiKey = (userId: string): Actor => ({
	kind: 'api_key',
	apiKeyId: randomUUID(),
	companyId: randomUUID(),
	memberId: randomUUID(),
	userId,
	permissions: []
});

/** The body of a post: JSON of the API or the fields of a page form. */
type Body = { json: unknown } | { form: Record<string, string> };

function requestInit(method: string, body: Body | undefined): RequestInit {
	if (body === undefined) return { method };
	if ('json' in body) {
		return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.json) };
	}
	return { method, body: new URLSearchParams(body.form) };
}

function requestEvent(path: string, from: string, actor: Actor, method = 'GET', body?: Body): RequestEvent {
	const url = new URL(`http://localhost:57173${path}`);
	return {
		url,
		request: new Request(url, requestInit(method, body)),
		locals: { requestId: `req-${randomUUID()}`, actor, rateLimited: null },
		isDataRequest: url.pathname.endsWith('/__data.json'),
		getClientAddress: () => from
	} as unknown as RequestEvent;
}

let resolved = 0;
/** The events the route got over the limit, to be refused there. */
const refusedByRoute: RequestEvent[] = [];
/** The route: it answers `429` itself when the hook marks the request over the limit. */
const resolve = (event: RequestEvent) => {
	if (event.locals.rateLimited) {
		refusedByRoute.push(event);
		return Promise.resolve(new Response('refused by the page', { status: 429 }));
	}
	resolved++;
	return Promise.resolve(new Response('ok'));
};

/** The request through both hooks, in the order of the chain: the address, then the account. */
function send(
	path: string,
	options: { from?: string; actor?: Actor; method?: string; body?: Body; through?: RateLimitHandles } = {}
): Promise<Response> {
	const chain = options.through ?? hooks;
	const event = requestEvent(
		path,
		options.from ?? address(),
		options.actor ?? { kind: 'anonymous' },
		options.method,
		options.body
	);
	const accountStep: Handle = ({ event }) => chain.byAccount({ event, resolve });
	return Promise.resolve(chain.byAddress({ event, resolve: (next) => accountStep({ event: next, resolve }) }));
}

/** A response the route gave over the limit: the headers of the refusal are the hook's. */
function expectRefusedByRoute(response: Response, limit: number) {
	expect(response.status).toBe(429);
	expect(response.headers.get('retry-after')).toMatch(/^\d+$/u);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('ratelimit-limit')).toBe(String(limit));
	expect(response.headers.get('ratelimit-remaining')).toBe('0');
}

/** What a route throws: a page error or a redirect. */
async function thrown(run: () => unknown) {
	try {
		await run();
	} catch (error) {
		if (isHttpError(error) || isRedirect(error)) return error;
		throw error;
	}
	throw new Error('the route was expected to refuse');
}

describe('the catalog budget of an account', () => {
	const { limit } = RATE_LIMIT_RULES.catalog;

	it('is shared by the catalog pages and the catalog API, whatever the address, and refused past the limit', async () => {
		const userId = randomUUID();
		const actor = person(userId);
		const before = resolved;
		const paths = [
			'/company/candidates',
			'/company/candidates/k-7f3a/__data.json',
			'/company/vacancies/0192/candidates/k-7f3a',
			'/api/v1/catalog/candidates',
			'/api/v1/vacancies/0192/matches'
		];
		for (let hit = 1; hit <= limit; hit++) {
			const path = paths[hit % paths.length] ?? '/company/candidates';
			const response = await send(path, { actor });
			expect(response.status, `hit ${String(hit)} ${path}`).toBe(200);
			// The account rule is the more specific one: its headers win over those of the address rule of the API.
			expect(response.headers.get('ratelimit-limit')).toBe(String(limit));
			expect(response.headers.get('ratelimit-remaining')).toBe(String(limit - hit));
		}
		expect(resolved - before).toBe(limit);

		// Pages are let through, marked, to refuse in the layout of the site; the hook adds the headers of the limit.
		const refusedBefore = refusedByRoute.length;
		expectRefusedByRoute(await send('/company/candidates', { actor }), limit);
		expectRefusedByRoute(await send('/company/candidates/k-7f3a/__data.json', { actor }), limit);
		expect(refusedByRoute.length - refusedBefore).toBe(2);
		// The loads of the catalog pages refuse through the glue of the cabinet, before reading anything.
		const [marked] = refusedByRoute.slice(refusedBefore);
		if (!marked) throw new Error('no marked event');
		const page = await thrown(() => employerRequest(marked));
		if (!isHttpError(page)) throw new Error('the page was expected to refuse with a page error');
		expect(page.status).toBe(429);
		expect(page.body.message).toMatch(/^Слишком много запросов подряд/u);
		expect(page.body.requestId).toBe(marked.locals.requestId);

		const api = await send('/api/v1/candidates/k-7f3a', { actor });
		expect(api.status).toBe(429);
		expect(api.headers.get('retry-after')).toMatch(/^\d+$/u);
		expect(api.headers.get('ratelimit-limit')).toBe(String(limit));
		expect(api.headers.get('ratelimit-remaining')).toBe('0');
		expect(await api.json()).toMatchObject({ error: { code: 'rate_limited' } });
		expect(resolved - before).toBe(limit);

		// Another account and a key of the API created by this one keep their own budgets; the rest of the site stays
		// open to this account.
		expect((await send('/company/candidates', { actor: person() })).status).toBe(200);
		expect((await send('/api/v1/catalog/candidates', { actor: apiKey(userId) })).status).toBe(200);
		expect((await send('/company/vacancies', { actor })).status).toBe(200);
	});
});

describe('the export of own data', () => {
	const { limit } = RATE_LIMIT_RULES.dataExport;

	it('shares one budget per account between the file of the page and the API, refused past the limit', async () => {
		const actor = person();
		const before = resolved;
		for (let hit = 1; hit <= limit; hit++) {
			const path = hit % 2 === 0 ? '/me/export/download' : '/api/v1/me/data';
			const response = await send(path, { actor });
			expect(response.status, `hit ${String(hit)} ${path}`).toBe(200);
			expect(response.headers.get('ratelimit-limit')).toBe(String(limit));
			expect(response.headers.get('ratelimit-remaining')).toBe(String(limit - hit));
		}
		expect(resolved - before).toBe(limit);

		// Not a page of the site: the file is refused with the JSON error, before the export runs.
		for (const path of ['/me/export/download', '/api/v1/me/data']) {
			const refused = await send(path, { actor });
			expect(refused.status, path).toBe(429);
			expect(refused.headers.get('retry-after')).toMatch(/^\d+$/u);
			expect(refused.headers.get('ratelimit-remaining')).toBe('0');
			expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
		}
		expect(resolved - before).toBe(limit);

		// Another account keeps its own budget; the page that offers the file stays open to this one.
		expect((await send('/me/export/download', { actor: person() })).status).toBe(200);
		expect((await send('/me/export', { actor })).status).toBe(200);
	});
});

describe('the parses of a pasted text', () => {
	const { limit, message } = RATE_LIMIT_RULES.textParse;
	const text = 'Ищем бэкенд-разработчика на Go в команду платежей';
	/** A post of the path with a text to parse, in the body the path takes. */
	const withText = (path: string): Body => (path.startsWith('/api/') ? { json: { text } } : { form: { text } });

	it('share one budget per account between the API and the forms that parse, refused past it in words', async () => {
		const actor = person();
		const before = resolved;
		const paths = [
			'/api/v1/needs',
			'/company/needs?/create',
			'/api/v1/vacancies/drafts/from-text',
			'/company/vacancies/new?/parse'
		];
		for (let hit = 1; hit <= limit; hit++) {
			const path = paths[hit % paths.length] ?? '/api/v1/needs';
			const response = await send(path, { actor, method: 'POST', body: withText(path) });
			expect(response.status, `hit ${String(hit)} ${path}`).toBe(200);
			expect(response.headers.get('ratelimit-remaining')).toBe(String(limit - hit));
		}
		expect(resolved - before).toBe(limit);

		const api = await send('/api/v1/vacancies/drafts/from-text', {
			actor,
			method: 'POST',
			body: withText('/api/v1/vacancies/drafts/from-text')
		});
		expect(api.status).toBe(429);
		expect(api.headers.get('retry-after')).toMatch(/^\d+$/u);
		expect(await api.json()).toMatchObject({ error: { code: 'rate_limited', message } });

		// The form is let through, marked, and answers in its own words before reading the session or the text.
		const refusedBefore = refusedByRoute.length;
		expectRefusedByRoute(
			await send('/company/needs?/create', { actor, method: 'POST', body: withText('/company/needs?/create') }),
			limit
		);
		const [marked] = refusedByRoute.slice(refusedBefore);
		if (!marked) throw new Error('no marked event');
		const refusal = await createNeedAction(marked);
		expect(refusal).toMatchObject({ status: 429, data: { problem: { code: 'rate_limited', message } } });
		expect(resolved - before).toBe(limit);

		// Another account keeps its own budget; other posts of this one are not parses.
		expect(
			(await send('/api/v1/needs', { actor: person(), method: 'POST', body: withText('/api/v1/needs') })).status
		).toBe(200);
		expect((await send('/company/vacancies/new?/create', { actor, method: 'POST' })).status).toBe(200);
	});

	it('do not count a need from the form alone, which calls no model', async () => {
		const actor = person();
		const form = { skill_keys: ['go'], nice_skill_keys: [] };
		const before = resolved;
		for (let hit = 1; hit <= limit + 1; hit++) {
			const page = hit % 2 === 0;
			const response = await send(page ? '/company/needs?/create' : '/api/v1/needs', {
				actor,
				method: 'POST',
				body: page ? { form: { text: '', grade: 'middle' } } : { json: { form } }
			});
			expect(response.status, `hit ${String(hit)}`).toBe(200);
			expect(response.headers.get('ratelimit-limit'), `hit ${String(hit)}`).not.toBe(String(limit));
		}
		expect(resolved - before).toBe(limit + 1);

		// The same account still has its whole budget of parses: the text is refused on the hit past it.
		for (let hit = 1; hit <= limit; hit++) {
			const response = await send('/api/v1/needs', { actor, method: 'POST', body: { json: { text, form } } });
			expect(response.status, `parse ${String(hit)}`).toBe(200);
		}
		const refused = await send('/api/v1/needs', { actor, method: 'POST', body: { json: { text, form } } });
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited', message } });
	});
});

describe('the paid parses of an address', () => {
	const rule = paidParseRule(PAID_BUDGET);
	const text = 'Ищем бэкенд-разработчика на Go в команду платежей';
	/** Posts that start a paid parse: texts of the API and of the forms, uploads of a resume. */
	const posts: { path: string; body?: Body }[] = [
		{ path: '/api/v1/needs', body: { json: { text } } },
		{ path: '/company/needs?/create', body: { form: { text } } },
		{ path: '/api/v1/vacancies/drafts/from-text', body: { json: { text } } },
		{ path: '/company/vacancies/new?/parse', body: { form: { text } } },
		{ path: '/api/v1/me/resumes' },
		{ path: '/me/resume?/upload' },
		{ path: '/demo/resume' }
	];

	it('share one budget across accounts, API keys, texts and resumes, refused past it in words', async () => {
		const from = address();
		const before = resolved;
		for (let hit = 1; hit <= PAID_BUDGET; hit++) {
			const post = posts[hit % posts.length] ?? { path: '/api/v1/needs' };
			// A fresh account or key on every post: the budget of an account never runs out.
			const actor = hit % 2 === 0 ? apiKey(randomUUID()) : person();
			const response = await send(post.path, { from, actor, method: 'POST', body: post.body, through: paidHooks });
			expect(response.status, `hit ${String(hit)} ${post.path}`).toBe(200);
			expect(response.headers.get('ratelimit-remaining'), `hit ${String(hit)}`).toBe(String(PAID_BUDGET - hit));
		}
		expect(resolved - before).toBe(PAID_BUDGET);

		// The API refuses with the JSON error, a text and a resume alike.
		for (const post of [posts[0], posts[4]]) {
			if (!post) throw new Error('no post');
			const api = await send(post.path, { from, actor: person(), method: 'POST', body: post.body, through: paidHooks });
			expect(api.status, post.path).toBe(429);
			expect(api.headers.get('retry-after')).toMatch(/^\d+$/u);
			expect(api.headers.get('ratelimit-limit')).toBe(String(PAID_BUDGET));
			expect(await api.json()).toMatchObject({ error: { code: 'rate_limited', message: rule.message } });
		}

		// The forms are let through, marked, and answer in their own words before reading the session or the file.
		const refusedBefore = refusedByRoute.length;
		for (const path of ['/company/needs?/create', '/me/resume?/upload', '/demo/resume']) {
			const post = posts.find((candidate) => candidate.path === path);
			expectRefusedByRoute(
				await send(path, { from, actor: person(), method: 'POST', body: post?.body, through: paidHooks }),
				PAID_BUDGET
			);
		}
		const [need, upload, demo] = refusedByRoute.slice(refusedBefore);
		if (!need || !upload || !demo) throw new Error('the forms were not marked');
		const problem = { code: 'rate_limited', message: rule.message };
		expect(await createNeedAction(need)).toMatchObject({ status: 429, data: { problem } });
		const uploadAction = resumeActions.upload;
		const demoAction = demoResumeActions.default;
		if (!uploadAction || !demoAction) throw new Error('the resume pages have no upload action');
		expect(await uploadAction(upload as Parameters<typeof uploadAction>[0])).toMatchObject({
			status: 429,
			data: { problem, target: 'upload' }
		});
		expect(await demoAction(demo as Parameters<typeof demoAction>[0])).toMatchObject({
			status: 429,
			data: { problem }
		});
		expect(resolved - before).toBe(PAID_BUDGET);

		// Another address keeps its own budget; posts of this address that parse nothing are not counted.
		const elsewhere = await send('/api/v1/needs', {
			actor: person(),
			method: 'POST',
			body: { json: { text } },
			through: paidHooks
		});
		expect(elsewhere.status).toBe(200);
		const formOnly = await send('/api/v1/needs', {
			from,
			actor: person(),
			method: 'POST',
			body: { json: { form: { skill_keys: ['go'], nice_skill_keys: [] } } },
			through: paidHooks
		});
		expect(formOnly.status).toBe(200);
		expect(
			(await send('/me/resume?/delete', { from, actor: person(), method: 'POST', through: paidHooks })).status
		).toBe(200);
	});
});

describe('a path spelled with percent-escapes', () => {
	it('is counted by the rules of the route it reaches', async () => {
		const actor = person();
		const { limit } = RATE_LIMIT_RULES.textParse;
		for (let hit = 1; hit <= limit; hit++) {
			const path = hit % 2 === 0 ? '/api/v1/n%65eds' : '/api/v1/vacancies/drafts/fr%6Fm-text';
			const response = await send(path, { actor, method: 'POST', body: { json: { text: 'Ищем Go-разработчика' } } });
			expect(response.status, `hit ${String(hit)} ${path}`).toBe(200);
			expect(response.headers.get('ratelimit-remaining'), `hit ${String(hit)}`).toBe(String(limit - hit));
		}
		const refused = await send('/api/v1/%6Eeeds', { actor, method: 'POST', body: { json: { text: 'Ищем QA' } } });
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({
			error: { code: 'rate_limited', message: RATE_LIMIT_RULES.textParse.message }
		});

		// A receipt: the page and the API spelled with escapes share the budget of verification, not the wider ones.
		const from = address();
		for (const path of ['/v%65rify/abcdefghijklmnopqrstuvwxyz', '/api/v1/v%65rify/abcdefghijklmnopqrstuvwxyz']) {
			const response = await send(path, { from });
			expect(response.headers.get('ratelimit-limit'), path).toBe(String(RATE_LIMIT_RULES.receiptVerify.limit));
		}
		// The catalog of the API per account.
		const reader = person();
		const catalog = await send('/api/v1/c%61talog/candidates', { actor: reader });
		expect(catalog.headers.get('ratelimit-limit')).toBe(String(RATE_LIMIT_RULES.catalog.limit));
	});

	it('is refused with 400 when its escapes do not decode, before any route', async () => {
		const before = resolved;
		const response = await send('/api/v1/n%E0%A4%A', {
			actor: person(),
			method: 'POST',
			body: { json: { text: 'x' } }
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 'validation_failed' } });
		expect(resolved).toBe(before);
	});
});

describe('the sign-in through FSP ID', () => {
	const { limit } = RATE_LIMIT_RULES.fspSignIn;

	it('is limited per address across its start and its callback', async () => {
		const from = address();
		for (let hit = 1; hit <= limit; hit++) {
			const path = hit % 2 === 0 ? '/auth/fsp' : '/auth/fsp/callback';
			const response = await send(path, { from });
			expect(response.status, `hit ${String(hit)}`).toBe(200);
			expect(response.headers.get('ratelimit-remaining')).toBe(String(limit - hit));
		}
		const before = resolved;
		const refusedBefore = refusedByRoute.length;
		expectRefusedByRoute(await send('/auth/fsp', { from }), limit);
		expectRefusedByRoute(await send('/auth/fsp/callback', { from }), limit);
		expect(resolved).toBe(before);
		// The routes send the browser to the sign-in page, which explains the refusal, without calling the provider.
		for (const marked of refusedByRoute.slice(refusedBefore)) {
			const refusal = await thrown(() =>
				marked.url.pathname === '/auth/fsp'
					? startFspSignIn(marked as Parameters<typeof startFspSignIn>[0])
					: fspCallback(marked as Parameters<typeof fspCallback>[0])
			);
			if (!isRedirect(refusal)) throw new Error('the sign-in was expected to redirect');
			expect(refusal).toMatchObject({ status: 303, location: '/login?error=fsp_rate_limited' });
		}
		expect((await send('/auth/fsp', { from: address() })).status).toBe(200);
	});
});

describe('the counter of a window', () => {
	it('counts a hit in the last half second of its window instead of failing the request', async () => {
		const key = `ratelimit:test:${randomUUID()}`;
		await redis.set(key, '3', { PX: 400 });
		const hit = await redisRateLimitStore(redis).hit(key, 60);
		expect(hit).toEqual({ count: 4, resetSeconds: 1 });
	});
});
