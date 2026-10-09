// An operation of the public API (docs/contracts.md, section 5): one declaration gives the route handler and its part
// of the OpenAPI document. The actor established by the hooks (a session or an API key) is checked against the
// operation, the request is parsed by the Zod schemas of the operation, optionally deduplicated by `Idempotency-Key`,
// answered with the response schema applied to the result, and every failure becomes the error envelope of section 5.3.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '$lib/server/access/actor';
import type { AccessSubject, Permission } from '$lib/server/access/permissions';
import { withTimeout } from '$lib/server/async/timeout';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { ApiError, errorResponse, type ErrorDetail } from '$lib/server/errors/api-error';
import type { ApiErrorCode } from '$lib/server/errors/codes';
import { canonicalJson } from '$lib/server/json/canonical';
import type { Redis } from '$lib/server/redis';
import type { ApiServices } from './services';
import { loggedError } from '$lib/server/db/errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type BodyEncoding = 'json' | 'multipart';

/**
 * Who may call an operation. `public` — anyone, including anonymous callers; `session` — a signed-in browser only
 * (operations of candidates, staff and key management, contracts 5.2); `account` — a session or an API key of a
 * company whose scope holds the permission of the operation.
 */
export type AuthMode = 'public' | 'session' | 'account';

/** Base path of the version (contracts 5.1). */
export const API_BASE = '/api/v1';

/** A stored answer to a repeated `Idempotency-Key` lives 24 hours (contracts 5.4). */
const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
/** How long a request in progress holds its key; a crashed request frees it after this. */
const IDEMPOTENCY_PENDING_SECONDS = 120;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
/** How long a request waits for Redis before it is answered with `503 degraded`. */
const REDIS_WAIT_MS = 1_000;

/** Journal and consent metadata of the request. */
export interface ApiRequestMeta {
	requestId: string;
	ip: string | null;
	userAgent: string | null;
	/** SHA-256 of the session id of a browser request (consent evidence, domain 6.3). */
	sessionHash: string | null;
	/** The key of a request authenticated by an API key. */
	apiKeyId: string | null;
}

export interface OperationContext<P, Q, B> {
	params: P;
	query: Q;
	body: B;
	services: ApiServices;
	actor: Actor;
	/** Roles and memberships read from the database on this request (never cached). */
	subject: () => Promise<AccessSubject>;
	meta: ApiRequestMeta;
	signal: AbortSignal;
}

type AnyObject = z.ZodObject;
const EMPTY = z.strictObject({});
type Empty = typeof EMPTY;

/** The answer of a success: a JSON body described by its schema, or `204` without a body. */
export type SuccessResponse =
	| { status: 200 | 201 | 202; description: string; schema: z.ZodType }
	| { status: 204; description: string; schema?: undefined };

interface OperationBase<P extends AnyObject, Q extends AnyObject, B extends z.ZodType> {
	/** `operationId` of the document. */
	id: string;
	method: HttpMethod;
	/** Path under `/api/v1` with `{name}` parameters, as in the document. */
	path: string;
	tag: string;
	summary: string;
	description?: string;
	auth: AuthMode;
	/** The permission of the registry the operation acts under (domain 4.2); an API key must hold it. */
	permission?: Permission;
	params?: P;
	query?: Q;
	body?: B;
	/**
	 * How the body is sent: JSON (the default), or `multipart/form-data` for an upload — each part is a member of the
	 * object the body schema parses, a file part a `File` (`z.file()`).
	 */
	bodyEncoding?: BodyEncoding;
	/** The operation creates a resource: a repeated `Idempotency-Key` gets the stored answer (contracts 5.4). */
	idempotent?: boolean;
	/** Error codes the operation answers with besides the common ones (validation, authentication, limits). */
	errors: readonly ApiErrorCode[];
}

type Handler<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, Out> = (
	ctx: OperationContext<z.output<P>, z.output<Q>, z.output<B>>
) => Promise<Out>;

export interface ContentOperationSpec<
	P extends AnyObject,
	Q extends AnyObject,
	B extends z.ZodType,
	R extends z.ZodType
> extends OperationBase<P, Q, B> {
	response: { status: 200 | 201 | 202; description: string; schema: R };
	handle: Handler<P, Q, B, z.input<R>>;
}

export interface NoContentOperationSpec<
	P extends AnyObject,
	Q extends AnyObject,
	B extends z.ZodType
> extends OperationBase<P, Q, B> {
	response: { status: 204; description: string };
	handle: Handler<P, Q, B, void>;
}

/** An operation with its types erased: what the route table and the document work with. */
export interface Operation {
	id: string;
	method: HttpMethod;
	path: string;
	tag: string;
	summary: string;
	description: string | undefined;
	auth: AuthMode;
	permission: Permission | undefined;
	params: AnyObject;
	query: AnyObject;
	body: z.ZodType | undefined;
	bodyEncoding: BodyEncoding;
	idempotent: boolean;
	response: SuccessResponse;
	errors: readonly ApiErrorCode[];
	handle: (ctx: OperationContext<unknown, unknown, unknown>) => Promise<unknown>;
}

export function defineOperation<
	R extends z.ZodType,
	P extends AnyObject = Empty,
	Q extends AnyObject = Empty,
	B extends z.ZodType = Empty
>(spec: ContentOperationSpec<P, Q, B, R>): Operation;
export function defineOperation<P extends AnyObject = Empty, Q extends AnyObject = Empty, B extends z.ZodType = Empty>(
	spec: NoContentOperationSpec<P, Q, B>
): Operation;
export function defineOperation(
	spec: OperationBase<AnyObject, AnyObject, z.ZodType> & {
		response: SuccessResponse;
		handle: (ctx: never) => Promise<unknown>;
	}
): Operation {
	if (spec.auth === 'account' && spec.permission === undefined) {
		throw new Error(`operation ${spec.id}: an operation open to API keys names its permission`);
	}
	if (spec.body !== undefined && spec.method === 'GET') throw new Error(`operation ${spec.id}: GET has no body`);
	if (spec.bodyEncoding === 'multipart' && spec.body === undefined) {
		throw new Error(`operation ${spec.id}: a multipart operation declares its body`);
	}
	// The fingerprint of an idempotent request is its canonical JSON; a file part has none.
	if (spec.bodyEncoding === 'multipart' && spec.idempotent === true) {
		throw new Error(`operation ${spec.id}: a multipart body is not deduplicated by Idempotency-Key`);
	}
	return {
		id: spec.id,
		method: spec.method,
		path: spec.path,
		tag: spec.tag,
		summary: spec.summary,
		description: spec.description,
		auth: spec.auth,
		permission: spec.permission,
		params: spec.params ?? EMPTY,
		query: spec.query ?? EMPTY,
		body: spec.body,
		bodyEncoding: spec.bodyEncoding ?? 'json',
		idempotent: spec.idempotent ?? false,
		response: spec.response,
		errors: spec.errors,
		// The input is parsed by these very schemas before the call, so the context has the declared types.
		handle: (ctx) => spec.handle(ctx as never)
	};
}

/** The part of a SvelteKit request event an operation reads. */
export interface ApiEvent {
	request: Request;
	url: URL;
	params: Partial<Record<string, string>>;
	locals: { requestId: string; actor: Actor };
	getClientAddress(): string;
}

async function connectedRedis(services: ApiServices, requestId: string): Promise<Redis> {
	try {
		return await withTimeout(services.redis(), REDIS_WAIT_MS, 'redis');
	} catch (cause) {
		console.error(`[api] request ${requestId}: redis unavailable`, loggedError(cause));
		throw new ApiError('degraded', { cause, retryAfterSeconds: 5 });
	}
}

function authorize(operation: Operation, actor: Actor): void {
	if (operation.auth === 'public') {
		if (actor.kind === 'api_key' && operation.permission !== undefined) requireKeyScope(operation, actor);
		return;
	}
	if (actor.kind === 'anonymous') throw new ApiError('unauthenticated');
	if (actor.kind === 'api_key') {
		if (operation.auth === 'session') {
			throw new ApiError('forbidden', { message: 'Операция доступна только во вошедшей сессии, не по ключу API' });
		}
		requireKeyScope(operation, actor);
	}
}

function requireKeyScope(operation: Operation, actor: Extract<Actor, { kind: 'api_key' }>): void {
	if (operation.permission !== undefined && !actor.permissions.includes(operation.permission)) {
		throw new ApiError('forbidden', {
			details: [{ code: 'api_key_scope', message: `У ключа нет права ${operation.permission}` }]
		});
	}
}

const ru = z.locales.ru();

function issuesOf(error: z.ZodError): ErrorDetail[] {
	return error.issues.map((issue) => ({
		...(issue.path.length > 0 ? { path: issue.path.map(String).join('.') } : {}),
		code: issue.code,
		message: issue.message
	}));
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
	const parsed = schema.safeParse(value, { error: ru.localeError });
	if (!parsed.success) throw new ApiError('validation_failed', { details: issuesOf(parsed.error) });
	return parsed.data;
}

/** Whether a query field takes repeated values: an array, possibly optional or with a default. */
function isArrayField(field: z.ZodType): boolean {
	let current: z.core.$ZodType = field;
	for (;;) {
		const def = current._zod.def;
		if (def.type === 'array') return true;
		if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
			current = (def as z.core.$ZodOptionalDef).innerType;
			continue;
		}
		return false;
	}
}

function queryObject(schema: AnyObject, search: URLSearchParams): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const name of new Set(search.keys())) {
		const values = search.getAll(name);
		const field = schema.shape[name] as z.ZodType | undefined;
		if (field !== undefined && isArrayField(field)) result[name] = values;
		else if (values.length > 1) {
			throw new ApiError('validation_failed', {
				details: [{ path: name, code: 'repeated', message: 'Параметр указан несколько раз' }]
			});
		} else result[name] = values[0];
	}
	return result;
}

const mediaType = (request: Request) => request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

/** The parts of a `multipart/form-data` body as an object: a file part is a `File`, a field its text. */
async function readMultipart(request: Request): Promise<Record<string, unknown>> {
	if (mediaType(request) !== 'multipart/form-data') {
		throw new ApiError('validation_failed', {
			details: [{ code: 'unsupported_media_type', message: 'Тело запроса — multipart/form-data' }]
		});
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch (error) {
		// The body does not parse as the form its header names.
		if (!(error instanceof TypeError)) throw error;
		throw new ApiError('validation_failed', {
			details: [{ code: 'invalid_multipart', message: 'Тело запроса — не multipart/form-data' }]
		});
	}
	const result: Record<string, unknown> = {};
	for (const name of new Set(form.keys())) {
		const values = form.getAll(name);
		if (values.length > 1) {
			throw new ApiError('validation_failed', {
				details: [{ path: name, code: 'repeated', message: 'Часть указана несколько раз' }]
			});
		}
		result[name] = values[0];
	}
	return result;
}

async function readBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.trim().length === 0) return {};
	if (mediaType(request) !== 'application/json') {
		throw new ApiError('validation_failed', {
			details: [{ code: 'unsupported_media_type', message: 'Тело запроса — JSON с Content-Type: application/json' }]
		});
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ApiError('validation_failed', {
			details: [{ code: 'invalid_json', message: 'Тело запроса — не JSON' }]
		});
	}
}

/** `salaryMax` → `salary_max`, per segment of a dotted path. */
const snakePath = (path: string) =>
	path
		.split('.')
		.map((segment) => segment.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`))
		.join('.');

/**
 * Domain modules name fields as the code does (`salaryMax`); the API names them as its JSON (`salary_max`). Paths of
 * the details of a refusal are renamed, everything else of the error is kept.
 */
async function inApiNames<T>(action: Promise<T>): Promise<T> {
	try {
		return await action;
	} catch (error) {
		if (!(error instanceof ApiError) || error.details === undefined) throw error;
		throw new ApiError(error.code, {
			message: error.message,
			details: error.details.map((detail) =>
				detail.path === undefined ? detail : { ...detail, path: snakePath(detail.path) }
			),
			...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
			cause: error
		});
	}
}

interface StoredAnswer {
	state: 'done';
	fingerprint: string;
	status: number;
	body: string | null;
}
type IdempotencyRecord = { state: 'pending'; fingerprint: string } | StoredAnswer;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function idempotencyScope(actor: Actor): string {
	switch (actor.kind) {
		case 'api_key':
			return `key:${actor.apiKeyId}`;
		case 'session':
			return `user:${actor.userId}`;
		case 'anonymous':
			throw new Error('an idempotent operation is never anonymous');
	}
}

/**
 * The stored answer of a repeated key, or the reservation of a new one. The same key with another request is
 * `idempotency_conflict`; while the first request is still running the repeat is `conflict`.
 */
async function reserveIdempotency(redis: Redis, storageKey: string, fingerprint: string): Promise<StoredAnswer | null> {
	const pending: IdempotencyRecord = { state: 'pending', fingerprint };
	const reserved = await redis.set(storageKey, JSON.stringify(pending), {
		condition: 'NX',
		expiration: { type: 'EX', value: IDEMPOTENCY_PENDING_SECONDS }
	});
	if (reserved !== null) return null;
	const stored = await redis.get(storageKey);
	if (stored === null) {
		throw new ApiError('conflict', {
			details: [{ code: 'idempotency_retry', message: 'Повторите запрос с тем же ключом' }]
		});
	}
	const record = JSON.parse(stored) as IdempotencyRecord;
	if (record.fingerprint !== fingerprint) throw new ApiError('idempotency_conflict');
	if (record.state === 'pending') {
		throw new ApiError('conflict', {
			details: [{ code: 'idempotency_in_progress', message: 'Запрос с этим ключом ещё выполняется' }]
		});
	}
	return record;
}

function jsonResponse(status: number, body: string | null, requestId: string): Response {
	const headers = new Headers({ 'cache-control': 'no-store', 'x-request-id': requestId });
	if (body !== null) headers.set('content-type', 'application/json');
	return new Response(body, { status, headers });
}

interface Idempotency {
	redis: Redis;
	storageKey: string;
	fingerprint: string;
}

/** Runs one operation for one request. Never throws: every failure is the error envelope. */
export async function runOperation(operation: Operation, services: ApiServices, event: ApiEvent): Promise<Response> {
	const requestId = event.locals.requestId;
	let idempotency: Idempotency | null = null;
	const finish = async (response: Response): Promise<Response> => {
		if (!idempotency) return response;
		const { redis, storageKey, fingerprint } = idempotency;
		// The action has already happened or failed: a Redis failure here must not replace its answer. It is logged, and
		// the key stays reserved until the reservation expires.
		try {
			// A server failure or a refusal that may pass later is not an outcome: the key is freed for a retry.
			if (response.status >= 500 || response.status === 429) {
				await redis.del(storageKey);
				return response;
			}
			const answer: StoredAnswer = {
				state: 'done',
				fingerprint,
				status: response.status,
				body: response.body === null ? null : await response.clone().text()
			};
			await redis.set(storageKey, JSON.stringify(answer), {
				expiration: { type: 'EX', value: IDEMPOTENCY_TTL_SECONDS }
			});
		} catch (cause) {
			console.error(`[api] request ${requestId}: idempotent answer of ${operation.id} not stored`, loggedError(cause));
		}
		return response;
	};

	try {
		const actor = event.locals.actor;
		authorize(operation, actor);

		const params = parseInput(operation.params, event.params);
		const query = parseInput(operation.query, queryObject(operation.query, event.url.searchParams));
		const rawBody =
			operation.body === undefined
				? undefined
				: operation.bodyEncoding === 'multipart'
					? await readMultipart(event.request)
					: await readBody(event.request);
		const body = operation.body === undefined ? undefined : parseInput(operation.body, rawBody);

		const idempotencyKey = operation.idempotent ? event.request.headers.get('idempotency-key') : null;
		if (idempotencyKey !== null) {
			if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
				throw new ApiError('validation_failed', {
					details: [{ path: 'Idempotency-Key', code: 'invalid', message: 'Ключ — от 1 до 255 печатных символов ASCII' }]
				});
			}
			const redis = await connectedRedis(services, requestId);
			const storageKey = `idempotency:${idempotencyScope(actor)}:${operation.id}:${sha256(idempotencyKey)}`;
			const fingerprint = sha256(
				canonicalJson({ path: event.url.pathname, query: event.url.search, body: rawBody ?? null })
			);
			const stored = await reserveIdempotency(redis, storageKey, fingerprint);
			if (stored) {
				const replay = jsonResponse(stored.status, stored.body, requestId);
				replay.headers.set('idempotent-replayed', 'true');
				return replay;
			}
			idempotency = { redis, storageKey, fingerprint };
		}

		let subject: Promise<AccessSubject> | undefined;
		const result = await inApiNames(
			operation.handle({
				params,
				query,
				body,
				services,
				actor,
				subject: () => (subject ??= loadAccessSubject(services.db, actor)),
				meta: {
					requestId,
					ip: event.getClientAddress(),
					userAgent: event.request.headers.get('user-agent'),
					sessionHash: actor.kind === 'session' ? actor.sessionHash : null,
					apiKeyId: actor.kind === 'api_key' ? actor.apiKeyId : null
				},
				signal: event.request.signal
			})
		);
		const { schema, status } = operation.response;
		const payload = schema === undefined ? null : JSON.stringify(schema.parse(result));
		return await finish(jsonResponse(status, payload, requestId));
	} catch (error) {
		return finish(errorResponse(error, requestId));
	}
}
