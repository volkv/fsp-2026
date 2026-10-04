// Control endpoints `/mock/...` for demos and tests: change the dataset, send webhooks, inject source failures.
// They exist only in the simulator and only when FSP_MOCK_CONTROL_TOKEN is set; every call carries that token.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError, bearerToken, isRecord, readJson, sendJson } from '../http.ts';
import type { AthleteRecord } from '../store.ts';
import {
	DISCIPLINE_CODES,
	WEBHOOK_EVENT_TYPES,
	type DisciplineCode,
	type Qualification,
	type QualificationRank,
	type Result,
	type WebhookEventType
} from '../types.ts';
import type { ApiContext } from './achievements.ts';
import { FAULT_MODES, type FaultMode } from './faults.ts';

const RESULT_STATUSES = ['official', 'preliminary', 'annulled'] as const;
const AWARDS = ['winner', 'prize', 'finalist', 'participant'] as const;
const EVSK = ['MS', 'KMS', 'I', 'II', 'III', 'Y1', 'Y2', 'Y3'] as const;
const RANKS: readonly QualificationRank[] = ['ZMS', 'MSMK', ...EVSK];

function body(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new HttpError(400, 'invalid_request', 'body must be an object');
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
	if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
		throw new HttpError(400, 'invalid_request', `${name} must be one of ${allowed.join(', ')}`);
	}
	return value as T;
}

function placeValue(value: unknown, name: string): number | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new HttpError(400, 'invalid_request', `${name} must be a positive integer or null`);
	}
	return value;
}

function dateValue(value: unknown, name: string): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new HttpError(400, 'invalid_request', `${name} must be a date YYYY-MM-DD`);
	}
	return value;
}

function nonEmptyStrings(value: unknown, name: string): string[] {
	const items: unknown[] = Array.isArray(value) ? value : [];
	const strings = items.filter((item): item is string => typeof item === 'string' && item !== '');
	if (strings.length === 0 || strings.length !== items.length) {
		throw new HttpError(400, 'invalid_request', `${name} must be a non-empty array of strings`);
	}
	return strings;
}

function athleteOr404(ctx: ApiContext, fspId: string): AthleteRecord {
	const record = ctx.store.athlete(fspId);
	if (!record) throw new HttpError(404, 'not_found', 'athlete not found');
	return record;
}

/** Applies allowed fields of a result patch; unknown fields are an error, not ignored. */
function patchResult(result: Result, patch: Record<string, unknown>): Result {
	const next: Result = { ...result };
	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case 'place':
				next.place = placeValue(value, 'place');
				break;
			case 'placeOf': {
				const placeOf = placeValue(value, 'placeOf');
				if (placeOf === null) delete next.placeOf;
				else next.placeOf = placeOf;
				break;
			}
			case 'score':
				if (value !== null && typeof value !== 'number')
					throw new HttpError(400, 'invalid_request', 'score must be a number or null');
				next.score = value;
				break;
			case 'status':
				next.status = oneOf(value, RESULT_STATUSES, 'status');
				break;
			case 'award':
				next.award = oneOf(value, AWARDS, 'award');
				break;
			case 'evskFulfilled':
				next.evskFulfilled = value === null ? null : oneOf(value, EVSK, 'evskFulfilled');
				break;
			default:
				throw new HttpError(400, 'invalid_request', `field ${key} cannot be changed`);
		}
	}
	return next;
}

function authorize(req: IncomingMessage, token: string): void {
	const presented = Buffer.from(bearerToken(req) ?? '', 'utf8');
	const expected = Buffer.from(token, 'utf8');
	if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
		throw new HttpError(401, 'unauthorized', 'control token is required');
	}
}

async function notify(
	ctx: ApiContext,
	enabled: boolean,
	type: WebhookEventType,
	athleteId: string,
	competitionId?: string
) {
	if (!enabled) return null;
	return ctx.webhooks.dispatch({ type, athleteIds: [athleteId], ...(competitionId ? { competitionId } : {}) });
}

/** Routes `/mock/...`; returns false for other paths. */
export async function handleControl(
	ctx: ApiContext,
	controlToken: string | null,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL
): Promise<boolean> {
	const segments = url.pathname
		.split('/')
		.filter((s) => s !== '')
		.map(decodeURIComponent);
	if (segments[0] !== 'mock') return false;
	if (controlToken === null) throw new HttpError(404, 'not_found', 'control endpoints are disabled');
	authorize(req, controlToken);
	const [, resource, id, sub, ...rest] = segments;
	if (rest.length > 0) throw new HttpError(404, 'not_found', 'unknown path');
	const send = url.searchParams.get('notify') !== 'false';
	// Only results and athletes carry an id in the path; other paths are literal.
	const withId = (resource === 'results' || resource === 'athletes') && id !== undefined;
	const path = withId ? [resource, ':id', ...(sub === undefined ? [] : [sub])].join('/') : segments.slice(1).join('/');
	const route = `${req.method ?? ''} ${path}`;

	switch (route) {
		case 'GET accounts': {
			const items = ctx.store.demo().map((d) => {
				const record = ctx.store.athlete(d.sub);
				return {
					...d,
					account: ctx.store.get(d.sub),
					athlete: record
						? {
								results: record.results.length,
								qualifications: record.qualifications.length,
								sourceVersion: ctx.store.sourceVersion(record)
							}
						: null
				};
			});
			sendJson(res, 200, { items });
			return true;
		}
		case 'PATCH results/:id': {
			const found = id === undefined ? undefined : ctx.store.findResult(id);
			if (!found) throw new HttpError(404, 'not_found', 'result not found');
			const next = patchResult(found.result, body(await readJson(req)));
			ctx.store.replaceResult(found.record, next);
			const type = next.status === 'annulled' ? 'result.annulled' : 'result.published';
			const webhook = await notify(ctx, send, type, found.record.athlete.fspId, next.competitionId);
			sendJson(res, 200, { result: next, sourceVersion: ctx.store.sourceVersion(found.record), webhook });
			return true;
		}
		case 'DELETE results/:id': {
			const found = id === undefined ? undefined : ctx.store.findResult(id);
			if (!found) throw new HttpError(404, 'not_found', 'result not found');
			ctx.store.removeResult(found.record, found.result.id);
			const webhook = await notify(ctx, send, 'athlete.updated', found.record.athlete.fspId);
			sendJson(res, 200, { removed: found.result.id, sourceVersion: ctx.store.sourceVersion(found.record), webhook });
			return true;
		}
		case 'POST athletes/:id/results': {
			const record = athleteOr404(ctx, id ?? '');
			const input = body(await readJson(req));
			const competitionId = typeof input.competitionId === 'string' ? input.competitionId : '';
			const competition = ctx.store.competition(competitionId);
			if (!competition) throw new HttpError(400, 'invalid_request', 'competitionId must name an existing competition');
			const result: Result = patchResult(
				{ id: randomUUID(), competitionId, place: null, status: 'official', publishedAt: new Date().toISOString() },
				Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'competitionId'))
			);
			ctx.store.addResult(record, result);
			const webhook = await notify(ctx, send, 'result.published', record.athlete.fspId, competitionId);
			sendJson(res, 201, { result, sourceVersion: ctx.store.sourceVersion(record), webhook });
			return true;
		}
		case 'POST athletes/:id/qualifications': {
			const record = athleteOr404(ctx, id ?? '');
			const input = body(await readJson(req));
			const basis = input.basisCompetitionId;
			if (basis !== undefined && basis !== null && (typeof basis !== 'string' || !ctx.store.competition(basis))) {
				throw new HttpError(400, 'invalid_request', 'basisCompetitionId must name an existing competition');
			}
			const qualification: Qualification = {
				id: randomUUID(),
				rank: oneOf(input.rank, RANKS, 'rank'),
				discipline: oneOf<DisciplineCode>(input.discipline, DISCIPLINE_CODES, 'discipline'),
				assignedAt: dateValue(input.assignedAt, 'assignedAt'),
				validUntil: null,
				orderNumber: typeof input.orderNumber === 'string' ? input.orderNumber : null,
				assignedBy: typeof input.assignedBy === 'string' ? input.assignedBy : 'Минспорт России',
				basisCompetitionId: typeof basis === 'string' ? basis : null
			};
			ctx.store.addQualification(record, qualification);
			const webhook = await notify(
				ctx,
				send,
				'qualification.assigned',
				record.athlete.fspId,
				qualification.basisCompetitionId ?? undefined
			);
			sendJson(res, 201, { qualification, sourceVersion: ctx.store.sourceVersion(record), webhook });
			return true;
		}
		case 'POST webhooks/dispatch': {
			const input = body(await readJson(req));
			const athleteIds = nonEmptyStrings(input.athleteIds, 'athleteIds');
			const competitionId = input.competitionId;
			if (competitionId !== undefined && typeof competitionId !== 'string') {
				throw new HttpError(400, 'invalid_request', 'competitionId must be a string');
			}
			const result = await ctx.webhooks.dispatch({
				type: oneOf(input.type, WEBHOOK_EVENT_TYPES, 'type'),
				athleteIds,
				...(competitionId === undefined ? {} : { competitionId })
			});
			sendJson(res, 200, result);
			return true;
		}
		case 'GET webhooks/deliveries':
			sendJson(res, 200, { items: ctx.webhooks.deliveries() });
			return true;
		case 'GET faults':
			sendJson(res, 200, { items: ctx.faults.list() });
			return true;
		case 'PUT faults': {
			const input = body(await readJson(req));
			const remaining = input.remaining;
			if (
				remaining !== undefined &&
				remaining !== null &&
				(typeof remaining !== 'number' || !Number.isInteger(remaining) || remaining < 1)
			) {
				throw new HttpError(400, 'invalid_request', 'remaining must be a positive integer or null');
			}
			const athleteId = input.athleteId;
			if (athleteId !== undefined && athleteId !== null && typeof athleteId !== 'string') {
				throw new HttpError(400, 'invalid_request', 'athleteId must be a string or null');
			}
			ctx.faults.set({
				mode: oneOf<FaultMode>(input.mode, FAULT_MODES, 'mode'),
				athleteId: athleteId ?? null,
				remaining: remaining ?? null
			});
			sendJson(res, 200, { items: ctx.faults.list() });
			return true;
		}
		case 'DELETE faults':
			ctx.faults.clear();
			res.writeHead(204).end();
			return true;
		case 'POST reset':
			ctx.store.reset();
			ctx.faults.clear();
			res.writeHead(204).end();
			return true;
		default:
			throw new HttpError(404, 'not_found', 'unknown control path');
	}
}
