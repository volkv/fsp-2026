// Achievements API `/v1` (docs/contracts.md, section 1; schema contracts/fsp-achievements/v1.schema.json).

import type { IncomingMessage, ServerResponse } from 'node:http';

import type Provider from 'oidc-provider';

import { HttpError, isRecord, readJson, sendJson } from '../http.ts';
import { DISCIPLINES } from '../seed/disciplines.ts';
import type { AthleteRecord, Store } from '../store.ts';
import {
	WEBHOOK_EVENT_TYPES,
	type AchievementsPage,
	type Competition,
	type Result,
	type WebhookEventType
} from '../types.ts';
import type { WebhookDispatcher } from '../webhooks.ts';
import type { Faults } from './faults.ts';
import { verifyGrant, verifyServiceToken } from './grants.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ApiContext {
	provider: Provider;
	store: Store;
	webhooks: WebhookDispatcher;
	faults: Faults;
	assertionSecret: string;
}

function positiveInt(params: URLSearchParams, name: string, fallback: number, max: number): number {
	const raw = params.get(name);
	if (raw === null) return fallback;
	if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_request', `${name} must be a positive integer`);
	const value = Number(raw);
	if (value < 1 || value > max) throw new HttpError(400, 'invalid_request', `${name} must be between 1 and ${max}`);
	return value;
}

/** Newest competitions first; ties by record id, so pages are stable. */
function orderResults(store: Store, results: readonly Result[]): Result[] {
	const date = (r: Result) => store.competition(r.competitionId)?.startDate ?? '';
	return [...results].sort((a, b) => date(b).localeCompare(date(a)) || a.id.localeCompare(b.id));
}

function competitionsOf(store: Store, results: readonly Result[]): Competition[] {
	const ids = [...new Set(results.map((r) => r.competitionId))];
	return ids.map((id) => {
		const competition = store.competition(id);
		if (!competition) throw new Error(`result references unknown competition ${id}`);
		return competition;
	});
}

function achievementsPage(
	ctx: ApiContext,
	record: AthleteRecord,
	pageNumber: number,
	pageSize: number
): AchievementsPage {
	const ordered = orderResults(ctx.store, record.results);
	const totalPages = Math.max(1, Math.ceil(ordered.length / pageSize));
	if (pageNumber > totalPages) {
		throw new HttpError(400, 'invalid_request', `page ${pageNumber} is beyond the last page ${totalPages}`);
	}
	const results = ordered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
	return {
		athlete: record.athlete,
		qualifications: record.qualifications,
		results,
		competitions: competitionsOf(ctx.store, results),
		generatedAt: new Date().toISOString(),
		sourceVersion: ctx.store.sourceVersion(record),
		page: { number: pageNumber, size: pageSize, totalPages, totalResults: ordered.length },
		complete: true
	};
}

async function athleteRoute(
	ctx: ApiContext,
	req: IncomingMessage,
	res: ServerResponse,
	fspId: string,
	sub: string | undefined,
	params: URLSearchParams
): Promise<void> {
	// The grant is checked before existence: a caller without a grant learns nothing about the athlete.
	await verifyGrant(ctx.provider, ctx.assertionSecret, req, fspId);
	ctx.faults.failIfActive(fspId);
	const record = ctx.store.athlete(fspId);
	if (!record) throw new HttpError(404, 'not_found', 'athlete not found');

	if (sub === undefined) {
		sendJson(res, 200, record.athlete, { etag: `"${ctx.store.sourceVersion(record)}"` });
		return;
	}
	const pageNumber = positiveInt(params, 'page', 1, 10_000);
	const pageSize = positiveInt(params, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const page = achievementsPage(ctx, record, pageNumber, pageSize);
	sendJson(res, 200, ctx.faults.shape(fspId, page), { etag: `"${page.sourceVersion}"` });
	ctx.faults.afterPage(fspId, record, ctx.store);
}

function listCompetitions(
	ctx: ApiContext,
	params: URLSearchParams
): { items: Competition[]; page: AchievementsPage['page'] } {
	const discipline = params.get('discipline');
	const level = params.get('level');
	const season = params.get('season');
	const filtered = [...ctx.store.world.competitions.values()]
		.filter((c) => discipline === null || c.discipline === discipline)
		.filter((c) => level === null || c.level === level)
		.filter((c) => season === null || c.startDate.startsWith(`${season}-`))
		.sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id));
	const pageNumber = positiveInt(params, 'page', 1, 10_000);
	const pageSize = positiveInt(params, 'pageSize', 50, MAX_PAGE_SIZE);
	const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
	if (pageNumber > totalPages) {
		throw new HttpError(400, 'invalid_request', `page ${pageNumber} is beyond the last page ${totalPages}`);
	}
	return {
		items: filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
		page: { number: pageNumber, size: pageSize, totalPages, totalResults: filtered.length }
	};
}

function parseSubscription(body: unknown): { url: string; events: WebhookEventType[]; secret: string } {
	if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'body must be an object');
	const { url, events, secret } = body;
	if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
		throw new HttpError(400, 'invalid_request', 'url must be an http(s) URL');
	}
	if (typeof secret !== 'string' || secret.length < 32) {
		throw new HttpError(400, 'invalid_request', 'secret must be at least 32 characters');
	}
	if (!Array.isArray(events) || events.length === 0) {
		throw new HttpError(400, 'invalid_request', 'events must be a non-empty array');
	}
	const known = new Set<string>(WEBHOOK_EVENT_TYPES);
	const parsed: WebhookEventType[] = [];
	for (const event of events) {
		if (typeof event !== 'string' || !known.has(event)) {
			throw new HttpError(400, 'invalid_request', `unknown event type ${String(event)}`);
		}
		parsed.push(event as WebhookEventType);
	}
	return { url, events: parsed, secret };
}

/** Routes `/v1/...`; returns false when the path is not an API path. */
export async function handleApi(
	ctx: ApiContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL
): Promise<boolean> {
	const segments = url.pathname.split('/').filter((s) => s !== '');
	if (segments[0] !== 'v1') return false;
	const [, resource, id, sub, ...rest] = segments.map(decodeURIComponent);
	if (rest.length > 0) throw new HttpError(404, 'not_found', 'unknown path');

	if (req.method === 'GET' && resource === 'disciplines' && id === undefined) {
		sendJson(res, 200, { items: DISCIPLINES });
		return true;
	}
	if (req.method === 'GET' && resource === 'competitions' && id === undefined) {
		sendJson(res, 200, listCompetitions(ctx, url.searchParams));
		return true;
	}
	if (req.method === 'GET' && resource === 'competitions' && id !== undefined && sub === undefined) {
		const competition = ctx.store.competition(id);
		if (!competition) throw new HttpError(404, 'not_found', 'competition not found');
		sendJson(res, 200, competition);
		return true;
	}
	if (
		req.method === 'GET' &&
		resource === 'athletes' &&
		id !== undefined &&
		(sub === undefined || sub === 'achievements')
	) {
		await athleteRoute(ctx, req, res, id, sub, url.searchParams);
		return true;
	}
	if (resource === 'webhooks' && sub === undefined) {
		await verifyServiceToken(ctx.provider, req);
		if (req.method === 'POST' && id === undefined) {
			const subscription = ctx.webhooks.subscribe(parseSubscription(await readJson(req)));
			sendJson(res, 201, {
				id: subscription.id,
				url: subscription.url,
				events: subscription.events,
				createdAt: subscription.createdAt
			});
			return true;
		}
		if (req.method === 'GET' && id === undefined) {
			sendJson(res, 200, {
				items: ctx.webhooks.subscriptions().map(({ id: subId, url: subUrl, events, createdAt }) => ({
					id: subId,
					url: subUrl,
					events,
					createdAt
				}))
			});
			return true;
		}
		if (req.method === 'DELETE' && id !== undefined) {
			if (!ctx.webhooks.unsubscribe(id)) throw new HttpError(404, 'not_found', 'subscription not found');
			res.writeHead(204).end();
			return true;
		}
	}
	throw new HttpError(404, 'not_found', 'unknown path');
}
