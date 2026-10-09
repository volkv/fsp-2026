import type { Handle, RequestEvent } from '@sveltejs/kit';
import type { Actor } from '$lib/server/access/actor';
import { withTimeout } from '$lib/server/async/timeout';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import type { Redis } from '$lib/server/redis';
import { loggedError } from '$lib/server/db/errors';

export interface RateLimitRule {
	/** Part of the Redis key; one counter per rule and subject. */
	name: string;
	limit: number;
	windowSeconds: number;
	/** The words of the refusal, when the rule has its own; otherwise the message of `rate_limited`. */
	message?: string;
}

/** Limits by request class; per-account login lockouts are a separate mechanism of sign-in. */
export const RATE_LIMIT_RULES = {
	/**
	 * Receipt verification is anonymous and enumerable (domain 4.2 `receipt.verify`): the API and the public page share
	 * one budget per address, so switching between them does not double it.
	 */
	receiptVerify: { name: 'verify', limit: 30, windowSeconds: 60 },
	api: { name: 'api', limit: 600, windowSeconds: 60 },
	/**
	 * Webhooks of Telegram and FSP: callers with few shared addresses whose bursts must neither eat the budget of the
	 * API on those addresses nor be cut by it; a rejected signature costs a hit like an accepted one.
	 */
	webhook: { name: 'webhook', limit: 300, windowSeconds: 60 },
	/** State-changing form posts of pages: sign-in, registration, profile forms. */
	form: { name: 'form', limit: 60, windowSeconds: 60 },
	/**
	 * Posts of the demo screen (domain 19.3): entering a role of the browser's demo session and leaving it. A jury sits
	 * behind one address, so the budget lets a room of visitors switch roles freely; new sessions have a budget of their
	 * own (`demoSession`).
	 */
	demo: { name: 'demo', limit: 200, windowSeconds: 600 },
	/**
	 * Demo sessions opened from one address (domain 19.3), counted by the demo screen when it opens one — a copy of the
	 * whole cast — and not when a browser enters a role of the session it has. A jury works behind one office address,
	 * each juror opening a few sessions a day (another browser, a fresh start), so one address may open as many sessions
	 * a day as the stand holds at once (`MAX_LIVE_SESSIONS`): what the stand keeps is bounded by that limit, not by this
	 * budget, and a full stand gives the place of its quietest session to a new visitor. The budget stops a script that
	 * would keep the stand busy copying the cast: each session costs seconds of cloning and the recount of the pools of
	 * the copied vacancies.
	 */
	demoSession: { name: 'demo-session', limit: 60, windowSeconds: 86_400 },
	/**
	 * Reads of the catalog — the search, the candidates of a vacancy, a partner pool, a candidate card — on a page or in
	 * the API, counted per account (a key of the API counts on its own): each runs the search with its semantic part and
	 * the reranker, and a card issues receipts. One person reading the catalog stays far below the budget; a script
	 * walking it does not. Counted besides the budget of the address.
	 */
	catalog: { name: 'catalog', limit: 60, windowSeconds: 60 },
	/**
	 * The candidate's export of their own data (domain 18.2), the file of the page and the same document in the API,
	 * counted per account: each reads every table of the person, decrypts the fields and journals `data.exported`. A
	 * person downloads it a few times; a loop does not get to fill the journal or load the database.
	 */
	dataExport: { name: 'data-export', limit: 10, windowSeconds: 600 },
	/**
	 * Parses of a pasted text — a new hiring need with its text, a vacancy from text — on a page or in the API, counted
	 * per account: each may call the extraction model, whose gateway is paid by the request. An employer parses a few
	 * texts an hour; a loop does not get to spend the budget of the gateway. The same text again is answered from the
	 * kept parse without the model, but it is still counted: the budget is of requests, not of the model's calls. A need
	 * from the form alone parses nothing and is not counted.
	 */
	textParse: {
		name: 'text-parse',
		limit: 30,
		windowSeconds: 3_600,
		message: 'Лимит разборов текста — 30 в час на учётную запись. Повторите позже или заполните форму вручную'
	},
	/**
	 * The start of the sign-in through FSP ID and its callback, per address: each start keeps a flow in Redis and each
	 * callback calls the provider. A room of visitors behind one address signs in about thirty times in ten minutes.
	 */
	fspSignIn: { name: 'fsp-sign-in', limit: 60, windowSeconds: 600 }
} as const satisfies Record<string, RateLimitRule>;

/** Routes of incoming webhooks (contracts 1.5, 7.2). */
const WEBHOOK_PATHS = new Set(['/api/v1/integrations/telegram/webhook', '/api/v1/integrations/fsp/webhooks']);

/** The sign-in through FSP ID (contracts 2.3): its start and the return from the provider. */
const FSP_SIGN_IN_PATHS = new Set(['/auth/fsp', '/auth/fsp/callback']);

const isRead = (method: string) => method === 'GET' || method === 'HEAD';

/**
 * The path SvelteKit routes a request by: `url.pathname` decoded as its router decodes it — `decodeURI` of each part
 * between `%25`, so an escaped `%` stays escaped. The limits pick their rules by this path: a path that spells a route
 * with escapes (`/api/v1/n%65eds`) reaches the route and is counted as the route. A path escaped twice
 * (`/api/v1/n%2565eds`) stays escaped here as in the router, which finds no route for it. `null` — escapes that do
 * not decode: no route answers such a path, and the hook refuses it with `400`.
 */
export function routedPath(pathname: string): string | null {
	try {
		return pathname.split('%25').map(decodeURI).join('%25');
	} catch (error) {
		if (error instanceof URIError) return null;
		throw error;
	}
}

/** The routed path of a request the hook of the address has let through, which refuses one that does not decode. */
function pathOf(url: URL): string {
	const path = routedPath(url.pathname);
	if (path === null)
		throw new Error(`the path ${url.pathname} does not decode, yet it passed the limit of the address`);
	return path;
}

/**
 * Picks the rule of the client address for a request by its routed path (`routedPath`), or `null` for requests that
 * are not limited by the address (other pages, static files, health).
 */
export function ruleFor(method: string, pathname: string): RateLimitRule | null {
	if (pathname === '/api/health') return null;
	// The page of a receipt and its `__data.json` are the same lookup as the API.
	if (pathname.startsWith('/api/v1/verify/') || pathname.startsWith('/verify/')) return RATE_LIMIT_RULES.receiptVerify;
	if (WEBHOOK_PATHS.has(pathname)) return RATE_LIMIT_RULES.webhook;
	if (pathname.startsWith('/api/')) return RATE_LIMIT_RULES.api;
	if (!isRead(method)) return pathname === '/demo' ? RATE_LIMIT_RULES.demo : RATE_LIMIT_RULES.form;
	if (FSP_SIGN_IN_PATHS.has(pathname)) return RATE_LIMIT_RULES.fspSignIn;
	return null;
}

/** Catalog pages of the employer cabinet and their `__data.json`. */
const CATALOG_PAGE =
	/^\/company\/(?:candidates(?:\/[^/]+)?|vacancies\/[^/]+\/candidates(?:\/[^/]+)?|partner-pools\/[^/]+|shortlists\/[^/]+(?:\/evaluate)?)(?:\/__data\.json)?$/u;

/** Catalog reads of the API (contracts 5.5). */
const CATALOG_API =
	/^\/api\/v1\/(?:catalog\/[^/]+|candidates\/[^/]+|vacancies\/[^/]+\/matches(?:\/[^/]+)?|partner-pools\/[^/]+\/candidates|shortlists\/[^/]+(?:\/what-if)?)$/u;

/** The export of the candidate's own data: the file of the page and the same document in the API (contracts 5.5). */
const DATA_EXPORT_PATHS = new Set(['/me/export/download', '/api/v1/me/data']);

/** What a paid parse reads: a pasted text (a need, a vacancy) or an uploaded resume. */
export type PaidParse = 'text' | 'resume';

/**
 * Posts that start a parse the extraction model may be called for (contracts 3.2, 5.5), in the API and by the form
 * actions of the pages (`action`, the named action of the page; none — the default action, `page` — a page of the
 * site, which refuses over the limit in its own form):
 * - a pasted text: a vacancy draft always has its text; a new need is a text, the form, or both (domain 13.10), and
 *   only its text goes to the parse — `optionalText` names the body that carries it, so a need from the form alone is
 *   not counted;
 * - an uploaded resume: each upload queues its own reading (`resume.extract`).
 */
const PAID_PARSE_POSTS: readonly {
	kind: PaidParse;
	path: string;
	action?: string;
	page: boolean;
	optionalText?: 'json' | 'form';
}[] = [
	{ kind: 'text', path: '/api/v1/needs', page: false, optionalText: 'json' },
	{ kind: 'text', path: '/api/v1/vacancies/drafts/from-text', page: false },
	{ kind: 'text', path: '/company/needs', action: 'create', page: true, optionalText: 'form' },
	{ kind: 'text', path: '/company/vacancies/new', action: 'parse', page: true },
	{ kind: 'resume', path: '/api/v1/me/resumes', page: false },
	{ kind: 'resume', path: '/me/resume', action: 'upload', page: true },
	{ kind: 'resume', path: '/demo/resume', page: true }
];

function paidParsePost(method: string, url: URL) {
	if (method !== 'POST') return undefined;
	const path = pathOf(url);
	return PAID_PARSE_POSTS.find(
		(post) => post.path === path && (post.action === undefined || url.searchParams.has(`/${post.action}`))
	);
}

/** A form action of a page that starts a paid parse: it refuses over the limit itself, in the layout of the site. */
function isParsePage(method: string, url: URL): boolean {
	return paidParsePost(method, url)?.page === true;
}

/**
 * Whether the body of a post carries a text to parse — a `text` that is not blank, as the need reads it. A body that is
 * not JSON (or not a form) is refused by its route before any parse, so it carries none. Reads a copy of the body: the
 * route reads its own.
 */
async function carriesText(request: Request, body: 'json' | 'form'): Promise<boolean> {
	let text: unknown;
	if (body === 'json') {
		const raw = await request.clone().text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return false;
		}
		text = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).text : undefined;
	} else {
		let form: FormData;
		try {
			form = await request.clone().formData();
		} catch {
			return false;
		}
		text = form.get('text');
	}
	return typeof text === 'string' && text.trim().length > 0;
}

/**
 * The paid parse a request starts, or `null`. A post that may parse a text starts one only when it carries the text.
 * Reads a copy of the body of such a post.
 */
export async function paidParseOf(request: Request, url: URL): Promise<PaidParse | null> {
	const post = paidParsePost(request.method, url);
	if (post === undefined) return null;
	if (post.optionalText !== undefined && !(await carriesText(request, post.optionalText))) return null;
	return post.kind;
}

/** The rule counted per account for a request that starts the paid parse `parse` (or none). */
function accountRule(method: string, path: string, parse: PaidParse | null): RateLimitRule | null {
	if (!isRead(method)) return parse === 'text' ? RATE_LIMIT_RULES.textParse : null;
	if (DATA_EXPORT_PATHS.has(path)) return RATE_LIMIT_RULES.dataExport;
	return CATALOG_PAGE.test(path) || CATALOG_API.test(path) ? RATE_LIMIT_RULES.catalog : null;
}

/**
 * Picks the rule counted per account for a request (`accountSubject`), or `null`. It applies after authentication,
 * besides the rule of the address. A post that may parse a text is counted only when it carries one.
 */
export async function accountRuleFor(request: Request, url: URL): Promise<RateLimitRule | null> {
	return accountRule(request.method, pathOf(url), await paidParseOf(request, url));
}

/** The name of the rule of paid parses per address (`paidParseRule`). */
const PAID_PARSE = 'paid-parse';

/**
 * Paid parses from one client address (`paidParseOf`), whatever the account or the API key: the texts of needs and
 * vacancies and the uploaded resumes share one budget an hour. Accounts are cheap on the stand — every demo session
 * gives four employers, a company may issue keys — so the budget of an account alone does not bound what a script
 * behind one address spends of the gateway. A jury behind one office address parses a few texts and resumes each and
 * stays below it. Counted besides the rule of the account.
 */
export function paidParseRule(limit: number): RateLimitRule {
	return {
		name: PAID_PARSE,
		limit,
		windowSeconds: 3_600,
		message: `Лимит разборов текста и резюме — ${String(limit)} в час с одного адреса. Повторите позже`
	};
}

/**
 * Whom an account rule counts: the signed-in account, the API key (each key of a company on its own), or the address
 * of an anonymous request, which the route then refuses by itself.
 */
export function accountSubject(actor: Actor, address: string): string {
	switch (actor.kind) {
		case 'session':
			return `user:${actor.userId}`;
		case 'api_key':
			return `key:${actor.apiKeyId}`;
		case 'anonymous':
			return `address:${address}`;
	}
}

/** The public page of a receipt or of a confirmation of a category (domain 9.6, 12.9) and its `__data.json`. */
const RECEIPT_PAGE = /^\/verify\/(?:categories\/)?[^/]+(?:\/__data\.json)?$/u;

/**
 * Requests a browser makes that refuse a request over the limit themselves, so the refusal comes in the layout of the
 * site with the headers of every response rather than as a bare error page or the JSON error of the API: the public
 * pages of a receipt and of a confirmation of a category, the catalog pages (with their `__data.json`), the sign-in
 * through FSP ID, and — over the limits of parses only — the form actions that start a paid parse. Such a route must
 * refuse when `locals.rateLimited` is set — a page with `429`, the sign-in with a redirect to the sign-in page, a
 * parse with the form failure `429` in the words of the rule (`rateLimitedError`): the hook has already let the
 * request through.
 */
export function refusedByPage(method: string, url: URL, rule: RateLimitRule): boolean {
	if (rule === RATE_LIMIT_RULES.textParse || rule.name === PAID_PARSE) return isParsePage(method, url);
	const path = pathOf(url);
	return isRead(method) && (RECEIPT_PAGE.test(path) || CATALOG_PAGE.test(path) || FSP_SIGN_IN_PATHS.has(path));
}

/** The refusal of a request over the limit of `rule`, in the words of the rule when it has its own. */
export function rateLimitedError(rule: RateLimitRule, retryAfterSeconds?: number): ApiError {
	return new ApiError('rate_limited', {
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		...(rule.message === undefined ? {} : { message: rule.message })
	});
}

export interface RateLimitStore {
	/** Counts one hit in the current window of `key` and returns the count and the seconds until the window ends. */
	hit(key: string, windowSeconds: number): Promise<{ count: number; resetSeconds: number }>;
}

export interface RateLimitDecision {
	allowed: boolean;
	limit: number;
	remaining: number;
	resetSeconds: number;
}

/** Fixed-window counter: the first hit opens a window of `windowSeconds`. */
export async function consume(store: RateLimitStore, rule: RateLimitRule, subject: string): Promise<RateLimitDecision> {
	const { count, resetSeconds } = await store.hit(`ratelimit:${rule.name}:${subject}`, rule.windowSeconds);
	return {
		allowed: count <= rule.limit,
		limit: rule.limit,
		remaining: Math.max(0, rule.limit - count),
		resetSeconds
	};
}

/** `RateLimit-*` headers (contracts 5.4). */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
	return {
		'ratelimit-limit': String(decision.limit),
		'ratelimit-remaining': String(decision.remaining),
		'ratelimit-reset': String(decision.resetSeconds)
	};
}

export function redisRateLimitStore(client: Redis): RateLimitStore {
	return {
		async hit(key, windowSeconds) {
			// PTTL, not TTL: TTL rounds to whole seconds and answers 0 in the last half second of a window.
			const [count, , pttl] = await client.multi().incr(key).expire(key, windowSeconds, 'NX').pTTL(key).exec();
			if (typeof count !== 'number' || typeof pttl !== 'number') {
				throw new Error(`rate limit counter ${key}: unexpected replies`);
			}
			// The transaction sets the expiry before reading it, so a counter without one (-1) is a broken invariant.
			if (pttl < 0) throw new Error(`rate limit counter ${key} has no expiry`);
			return { count, resetSeconds: Math.ceil(pttl / 1000) };
		}
	};
}

// --- Request hooks ------------------------------------------------------------------------------------------------

export interface RateLimitHandles {
	/**
	 * Limits of the client address (`ruleFor`), first in the chain. A request over the limit is refused here, except on
	 * a route that refuses it itself (`refusedByPage`): there the route gets `locals.rateLimited` and renders the refusal
	 * in the layout of the site. A path that does not decode (`routedPath`) is refused with `400`.
	 */
	byAddress: Handle;
	/**
	 * Limits of the account (`accountRuleFor`), after authentication, and of the paid parses of the address
	 * (`paidParseRule`): counted besides the limit of the address, refused the same way.
	 */
	byAccount: Handle;
}

/** One counter a request is counted against: the rule and whom it counts. */
interface Count {
	rule: RateLimitRule;
	subject: string;
}

/**
 * The client address of a request, or `null` when the server takes it from the header `addressHeader`
 * (`ADDRESS_HEADER` of the server, lower case) and the request has none: it came past the proxy that sets it.
 */
function clientAddressOf(event: RequestEvent, addressHeader: string | null): string | null {
	if (addressHeader !== null && !event.request.headers.has(addressHeader)) return null;
	return event.getClientAddress();
}

/**
 * The refusal of a request a limit applies to whose client address is unknown (`clientAddressOf`). Every request from
 * outside comes through the proxy, which sets the address; one without it came from inside past the proxy. It is not
 * counted under a shared key — one counter for every such caller would hide the misrouting behind refusals of the
 * limit — nor let through uncounted, which would be a way around the limit.
 */
function unknownAddress(event: RequestEvent): Response {
	console.warn(
		`[rate-limit] request ${event.locals.requestId}: no header of the client address, ` +
			`${event.request.method} ${event.url.pathname} refused`
	);
	return errorResponse(
		new ApiError('validation_failed', { message: 'Адрес клиента не определён: запрос пришёл в обход прокси' }),
		event.locals.requestId
	);
}

/**
 * The hooks of the limits over a counter store. Without the store the limit cannot be enforced, so the request is
 * refused with `503 degraded`; `waitMs` bounds the wait for one counter. `paidParsesPerAddress` — the budget of paid
 * parses of one address an hour (`paidParseRule`), read on each request. `addressHeader` — the header the server
 * takes the client address from (`clientAddressOf`); the address is read only for a request a limit counts by it, so
 * a request no limit applies to (health, static files, other pages) needs none.
 */
export function rateLimitHandles(deps: {
	store: () => Promise<RateLimitStore>;
	waitMs: number;
	paidParsesPerAddress: () => number;
	addressHeader: () => string | null;
}): RateLimitHandles {
	async function count(
		event: RequestEvent,
		{ rule, subject }: Count
	): Promise<{ decision: RateLimitDecision } | { refused: Response }> {
		try {
			const store = await deps.store();
			return { decision: await withTimeout(consume(store, rule, subject), deps.waitMs, 'rate limit counter') };
		} catch (cause) {
			console.error(`[rate-limit] request ${event.locals.requestId}: counter unavailable`, loggedError(cause));
			return {
				refused: errorResponse(new ApiError('degraded', { cause, retryAfterSeconds: 5 }), event.locals.requestId)
			};
		}
	}

	/**
	 * The request counted against each of `counts` in turn: let through, or — at the first counter over its limit, the
	 * later ones not counted — refused by its route or here. A request let through gets the headers of the counter
	 * with the fewest requests left.
	 */
	async function limit(
		event: RequestEvent,
		resolve: Parameters<Handle>[0]['resolve'],
		counts: readonly Count[]
	): Promise<Response> {
		let tightest: RateLimitDecision | null = null;
		for (const next of counts) {
			const counted = await count(event, next);
			if ('refused' in counted) return counted.refused;
			const { decision } = counted;
			if (!decision.allowed) return overLimit(event, resolve, next.rule, decision);
			if (tightest === null || decision.remaining < tightest.remaining) tightest = decision;
		}
		const response = await resolve(event);
		return tightest === null ? response : withLimitHeaders(response, tightest);
	}

	return {
		byAddress: async ({ event, resolve }) => {
			event.locals.rateLimited = null;
			const path = routedPath(event.url.pathname);
			if (path === null) {
				return errorResponse(
					new ApiError('validation_failed', { message: 'Адрес запроса не читается' }),
					event.locals.requestId
				);
			}
			const rule = ruleFor(event.request.method, path);
			if (!rule) return resolve(event);
			const address = clientAddressOf(event, deps.addressHeader());
			if (address === null) return unknownAddress(event);
			return limit(event, resolve, [{ rule, subject: address }]);
		},
		byAccount: async ({ event, resolve }) => {
			const parse = await paidParseOf(event.request, event.url);
			const rule = accountRule(event.request.method, pathOf(event.url), parse);
			if (rule === null && parse === null) return resolve(event);
			const address = clientAddressOf(event, deps.addressHeader());
			if (address === null) return unknownAddress(event);
			const counts: Count[] = [];
			if (rule) counts.push({ rule, subject: accountSubject(event.locals.actor, address) });
			if (parse !== null) counts.push({ rule: paidParseRule(deps.paidParsesPerAddress()), subject: address });
			return limit(event, resolve, counts);
		}
	};
}

/** Over the limit of `rule`: the route refuses the request in the layout of the site, or the hook refuses it here. */
async function overLimit(
	event: RequestEvent,
	resolve: Parameters<Handle>[0]['resolve'],
	rule: RateLimitRule,
	decision: RateLimitDecision
): Promise<Response> {
	if (!refusedByPage(event.request.method, event.url, rule)) {
		const response = errorResponse(rateLimitedError(rule, decision.resetSeconds), event.locals.requestId);
		return withLimitHeaders(response, decision);
	}
	event.locals.rateLimited = rule;
	const response = await resolve(event);
	response.headers.set('cache-control', 'no-store');
	response.headers.set('retry-after', String(decision.resetSeconds));
	for (const [name, value] of Object.entries(rateLimitHeaders(decision))) response.headers.set(name, value);
	return response;
}

/**
 * `RateLimit-*` headers of the decision, unless a rule counted later in the chain — the account rule after the
 * address rule, the more specific one — has set its own.
 */
function withLimitHeaders(response: Response, decision: RateLimitDecision): Response {
	if (response.headers.has('ratelimit-limit')) return response;
	for (const [name, value] of Object.entries(rateLimitHeaders(decision))) response.headers.set(name, value);
	return response;
}
