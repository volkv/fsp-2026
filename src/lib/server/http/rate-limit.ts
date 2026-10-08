import type { Handle, RequestEvent } from '@sveltejs/kit';
import type { Actor } from '$lib/server/access/actor';
import { withTimeout } from '$lib/server/async/timeout';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import type { Redis } from '$lib/server/redis';

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
	 * kept parse without the model, but it is still counted: the budget is of requests, not of the model's calls.
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
 * Picks the rule of the client address for a request, or `null` for requests that are not limited by the address
 * (other pages, static files, health).
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

/** Posts that parse a pasted text in the API (contracts 3.2, 5.5): a new need, a vacancy draft from text. */
const TEXT_PARSE_API = new Set(['/api/v1/needs', '/api/v1/vacancies/drafts/from-text']);

/** Form actions of the cabinet that parse a pasted text: the page path and the action. */
const TEXT_PARSE_ACTIONS: ReadonlyMap<string, string> = new Map([
	['/company/needs', 'create'],
	['/company/vacancies/new', 'parse']
]);

/** A form action of a page that parses a pasted text: it refuses over the limit itself, in the layout of the site. */
function isTextParseAction(method: string, url: URL): boolean {
	const action = TEXT_PARSE_ACTIONS.get(url.pathname);
	return method === 'POST' && action !== undefined && url.searchParams.has(`/${action}`);
}

/**
 * Picks the rule counted per account for a request (`accountSubject`), or `null`. It applies after authentication,
 * besides the rule of the address.
 */
export function accountRuleFor(method: string, url: URL): RateLimitRule | null {
	const { pathname } = url;
	if (!isRead(method)) {
		const parses = (method === 'POST' && TEXT_PARSE_API.has(pathname)) || isTextParseAction(method, url);
		return parses ? RATE_LIMIT_RULES.textParse : null;
	}
	if (DATA_EXPORT_PATHS.has(pathname)) return RATE_LIMIT_RULES.dataExport;
	return CATALOG_PAGE.test(pathname) || CATALOG_API.test(pathname) ? RATE_LIMIT_RULES.catalog : null;
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
 * through FSP ID, and — over the limit of parses only — the form actions that parse a pasted text. Such a route must
 * refuse when `locals.rateLimited` is set — a page with `429`, the sign-in with a redirect to the sign-in page, a
 * parse with the form failure `429` saying the limit: the hook has already let the request through.
 */
export function refusedByPage(method: string, url: URL, rule: RateLimitRule): boolean {
	const { pathname } = url;
	if (rule === RATE_LIMIT_RULES.textParse) return isTextParseAction(method, url);
	return (
		isRead(method) && (RECEIPT_PAGE.test(pathname) || CATALOG_PAGE.test(pathname) || FSP_SIGN_IN_PATHS.has(pathname))
	);
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
	 * in the layout of the site.
	 */
	byAddress: Handle;
	/**
	 * Limits of the account (`accountRuleFor`), after authentication: counted besides the limit of the address, refused
	 * the same way.
	 */
	byAccount: Handle;
}

/**
 * The hooks of the limits over a counter store. Without the store the limit cannot be enforced, so the request is
 * refused with `503 degraded`; `waitMs` bounds the wait for one counter.
 */
export function rateLimitHandles(deps: { store: () => Promise<RateLimitStore>; waitMs: number }): RateLimitHandles {
	async function count(
		event: RequestEvent,
		rule: RateLimitRule,
		subject: string
	): Promise<{ decision: RateLimitDecision } | { refused: Response }> {
		try {
			const store = await deps.store();
			return { decision: await withTimeout(consume(store, rule, subject), deps.waitMs, 'rate limit counter') };
		} catch (cause) {
			console.error(`[rate-limit] request ${event.locals.requestId}: counter unavailable`, cause);
			return {
				refused: errorResponse(new ApiError('degraded', { cause, retryAfterSeconds: 5 }), event.locals.requestId)
			};
		}
	}

	/** The request counted against `rule` for `subject`: let through, refused by its route, or refused here. */
	async function limit(
		event: RequestEvent,
		resolve: Parameters<Handle>[0]['resolve'],
		rule: RateLimitRule,
		subject: string
	): Promise<Response> {
		const counted = await count(event, rule, subject);
		if ('refused' in counted) return counted.refused;
		const { decision } = counted;
		if (decision.allowed) return withLimitHeaders(await resolve(event), decision);
		if (!refusedByPage(event.request.method, event.url, rule)) return refuseOverLimit(event, rule, decision);
		event.locals.rateLimited = true;
		const response = await resolve(event);
		response.headers.set('cache-control', 'no-store');
		response.headers.set('retry-after', String(decision.resetSeconds));
		for (const [name, value] of Object.entries(rateLimitHeaders(decision))) response.headers.set(name, value);
		return response;
	}

	return {
		byAddress: async ({ event, resolve }) => {
			event.locals.rateLimited = false;
			const rule = ruleFor(event.request.method, event.url.pathname);
			if (!rule) return resolve(event);
			return limit(event, resolve, rule, event.getClientAddress());
		},
		byAccount: async ({ event, resolve }) => {
			const rule = accountRuleFor(event.request.method, event.url);
			if (!rule) return resolve(event);
			return limit(event, resolve, rule, accountSubject(event.locals.actor, event.getClientAddress()));
		}
	};
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

/** A request over the limit that no route refuses itself: the JSON error of the API, in the words of the rule. */
function refuseOverLimit(event: RequestEvent, rule: RateLimitRule, decision: RateLimitDecision): Response {
	const response = errorResponse(
		new ApiError('rate_limited', {
			retryAfterSeconds: decision.resetSeconds,
			...(rule.message === undefined ? {} : { message: rule.message })
		}),
		event.locals.requestId
	);
	return withLimitHeaders(response, decision);
}
