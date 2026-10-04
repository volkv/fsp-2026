// HTTP client of the achievements API `fsp-achievements/v1` (docs/contracts.md, sections 1.1–1.3, 1.6, 1.8).
// The simulator serves exactly this protocol (`FSP_ACHIEVEMENTS_ADAPTER=mock`); `fsp-api` talks the same protocol
// to the FSP base URL until the federation's own specification replaces the mapping inside this module.
// Exceptions do not cross the boundary: every call returns a result or a classified error.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import {
	achievementsPageSchema,
	athleteSchema,
	competitionSchema,
	disciplineListSchema,
	errorBodySchema,
	webhookEventSchema,
	type AchievementsPage
} from './schema';
import { parseJson } from './json';
import type {
	AccessGrant,
	AchievementsSnapshot,
	AchievementsSource,
	AdapterError,
	AdapterResult,
	Competition,
	Discipline,
	FetchErrorCode,
	IncompleteReason,
	ResolvedAthlete,
	Result,
	WebhookErrorCode,
	WebhookEvent
} from './types';

const ASSERTION_HEADER = 'x-fsp-consent-assertion';
/** Largest page the source serves: fewer requests per snapshot. */
const MAX_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;
/** Allowed difference between the webhook timestamp and our clock (contracts 1.5). */
const WEBHOOK_SKEW_SECONDS = 5 * 60;
/** A webhook body carries ids only; anything larger is not a webhook of this contract. */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

interface HttpSourceOptions {
	/** Root without `/v1`. */
	baseUrl: string;
	webhookSecret: string;
	/** Results per page, 1–100. */
	pageSize?: number;
	fetch?: typeof fetch;
	now?: () => Date;
}

function failure<C extends string>(
	code: C,
	retryable: boolean,
	message: string,
	details?: Record<string, unknown>
): { ok: false; error: AdapterError<C> } {
	return { ok: false, error: { code, retryable, message, ...(details === undefined ? {} : { details }) } };
}

/** Classifies a non-2xx answer by the table of contracts 1.8. */
function classify(response: Response, text: string): AdapterError<FetchErrorCode> {
	// The status classifies the answer; the source's own code, when its body follows the contract, goes to details.
	const body = errorBodySchema.safeParse(parseJson(text));
	const sourceCode = body.success ? body.data.error.code : undefined;
	const details = { status: response.status, ...(sourceCode === undefined ? {} : { source_code: sourceCode }) };
	switch (response.status) {
		case 401:
			return { code: 'grant_invalid', retryable: false, message: 'source rejected the grant', details };
		case 403:
			return { code: 'grant_mismatch', retryable: false, message: 'grant does not cover the athlete', details };
		case 404:
			return { code: 'not_found', retryable: false, message: 'source has no such record', details };
		case 429: {
			const header = response.headers.get('retry-after');
			const retryAfter = header !== null && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) : undefined;
			return {
				code: 'rate_limited',
				retryable: true,
				message: 'source rate limit',
				details: { ...details, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) }
			};
		}
		default:
			if (response.status >= 500) {
				return { code: 'unavailable', retryable: true, message: 'source is unavailable', details };
			}
			return { code: 'protocol_error', retryable: false, message: `unexpected status ${response.status}`, details };
	}
}

function grantHeaders(grant: AccessGrant): Record<string, string> {
	if (grant.kind === 'delegated_user_token') return { authorization: `Bearer ${grant.accessToken}` };
	const assertion = Buffer.from(JSON.stringify(grant.assertion), 'utf8').toString('base64url');
	return { authorization: `Bearer ${grant.serviceToken}`, [ASSERTION_HEADER]: assertion };
}

/** `"v"` or `W/"v"` → `v`. */
function etagValue(header: string | null): string | null {
	if (header === null) return null;
	const match = /^(?:W\/)?"(.*)"$/.exec(header.trim());
	return match?.[1] ?? header.trim();
}

function lowerCaseHeaders(headers: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

export class HttpAchievementsSource implements AchievementsSource {
	readonly source = 'fsp';
	readonly contractVersion = 'v1';
	readonly #baseUrl: string;
	readonly #webhookSecret: Buffer;
	readonly #pageSize: number;
	readonly #fetch: typeof fetch;
	readonly #now: () => Date;

	constructor(options: HttpSourceOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.#webhookSecret = Buffer.from(options.webhookSecret, 'utf8');
		this.#pageSize = options.pageSize ?? MAX_PAGE_SIZE;
		if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > MAX_PAGE_SIZE) {
			throw new RangeError(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
		}
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? (() => new Date());
	}

	/** GET of a JSON document validated by `schema`; the validated value and the response headers. */
	async #get<S extends z.ZodType>(
		path: string,
		schema: S,
		headers: Record<string, string> = {}
	): Promise<AdapterResult<{ body: z.output<S>; headers: Headers }, FetchErrorCode>> {
		let response: Response;
		let text: string;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				headers: { accept: 'application/json', ...headers },
				redirect: 'error',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			text = await response.text();
		} catch (cause) {
			const reason = cause instanceof Error ? cause.name : 'error';
			return failure('unavailable', true, `source request failed: ${reason}`);
		}
		if (!response.ok) return { ok: false, error: classify(response, text) };
		const json = parseJson(text);
		if (json === undefined) return failure('protocol_error', false, 'source answered with a body that is not JSON');
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.code}`);
			return failure('protocol_error', false, 'source answer violates fsp-achievements/v1', { issues });
		}
		return { ok: true, value: { body: parsed.data, headers: response.headers } };
	}

	async resolveAthlete(input: {
		identity: { issuer: string; subject: string };
		grant: AccessGrant;
	}): Promise<AdapterResult<ResolvedAthlete, Exclude<FetchErrorCode, 'grant_mismatch'>>> {
		// In fsp-achievements/v1 the FSP ID subject is the athlete key (contracts 1.8, «resolveAthlete»).
		const subject = input.identity.subject;
		const answer = await this.#get(
			`/v1/athletes/${encodeURIComponent(subject)}`,
			athleteSchema,
			grantHeaders(input.grant)
		);
		if (!answer.ok) {
			// A grant for this very subject that the source refuses as foreign is a broken grant, not a mismatch.
			if (answer.error.code === 'grant_mismatch') return failure('grant_invalid', false, answer.error.message);
			return narrow(answer.error, ['not_found', 'grant_invalid', 'unavailable', 'rate_limited']);
		}
		if (answer.value.body.fspId !== subject) {
			return failure('protocol_error', false, 'source answered with another athlete');
		}
		return { ok: true, value: { sourceAthleteId: subject, method: 'subject_equals_athlete_id' } };
	}

	async getAchievements(input: {
		sourceAthleteId: string;
		grant: AccessGrant;
	}): Promise<AdapterResult<AchievementsSnapshot, FetchErrorCode>> {
		const headers = grantHeaders(input.grant);
		const athletePath = `/v1/athletes/${encodeURIComponent(input.sourceAthleteId)}/achievements`;
		const pages: AchievementsPage[] = [];
		let total: number | null = null;
		let interrupted = false;
		for (let number = 1; total === null || number <= total; number++) {
			const answer = await this.#get(
				`${athletePath}?page=${number}&pageSize=${this.#pageSize}`,
				achievementsPageSchema,
				headers
			);
			if (!answer.ok) {
				// A transient failure after the first page leaves a usable but incomplete snapshot (contracts 1.8).
				if (pages.length > 0 && answer.error.retryable) {
					interrupted = true;
					break;
				}
				return answer;
			}
			const page = answer.value.body;
			if (page.athlete.fspId !== input.sourceAthleteId) {
				return failure('protocol_error', false, 'source answered with another athlete');
			}
			if (page.page.number !== number) return failure('protocol_error', false, 'source answered with another page');
			const etag = etagValue(answer.value.headers.get('etag'));
			if (etag !== null && etag !== page.sourceVersion) {
				return failure('protocol_error', false, 'ETag differs from sourceVersion');
			}
			pages.push(page);
			total = page.page.totalPages;
		}
		return { ok: true, value: assembleSnapshot(pages, interrupted) };
	}

	async listDisciplines(): Promise<AdapterResult<Discipline[], 'unavailable' | 'protocol_error'>> {
		const answer = await this.#get('/v1/disciplines', disciplineListSchema);
		if (!answer.ok) return narrow(answer.error, ['unavailable']);
		return { ok: true, value: answer.value.body.items };
	}

	async getCompetition(
		id: string
	): Promise<AdapterResult<Competition, 'not_found' | 'unavailable' | 'protocol_error'>> {
		const answer = await this.#get(`/v1/competitions/${encodeURIComponent(id)}`, competitionSchema);
		if (!answer.ok) return narrow(answer.error, ['not_found', 'unavailable']);
		return { ok: true, value: answer.value.body };
	}

	verifyWebhook(input: {
		headers: Record<string, string>;
		rawBody: Uint8Array;
	}): AdapterResult<WebhookEvent, WebhookErrorCode> {
		const headers = lowerCaseHeaders(input.headers);
		const timestamp = headers.get('x-fsp-timestamp') ?? '';
		const signature = headers.get('x-fsp-signature') ?? '';
		if (!/^\d{1,12}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
			return failure('signature_invalid', false, 'webhook signature headers are missing or malformed');
		}
		if (input.rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
			return failure('payload_invalid', false, 'webhook body is too large');
		}
		const expected = createHmac('sha256', this.#webhookSecret).update(`${timestamp}.`).update(input.rawBody).digest();
		const presented = Buffer.from(signature.slice('sha256='.length), 'hex');
		if (!timingSafeEqual(presented, expected))
			return failure('signature_invalid', false, 'webhook signature is invalid');
		const skew = Math.abs(Math.floor(this.#now().getTime() / 1000) - Number(timestamp));
		if (skew > WEBHOOK_SKEW_SECONDS) {
			return failure('timestamp_skew', false, 'webhook timestamp is outside the allowed window');
		}
		const json = parseJson(Buffer.from(input.rawBody).toString('utf8'));
		if (json === undefined) return failure('payload_invalid', false, 'webhook body is not JSON');
		const event = webhookEventSchema.safeParse(json);
		if (!event.success) return failure('payload_invalid', false, 'webhook body violates fsp-achievements/v1');
		if (headers.get('x-fsp-event-id') !== event.data.eventId) {
			return failure('payload_invalid', false, 'X-FSP-Event-Id differs from the body');
		}
		return { ok: true, value: event.data };
	}
}

/** Narrows a fetch error to the codes an operation declares; any other code is a contract violation. */
function narrow<C extends FetchErrorCode>(
	error: AdapterError<FetchErrorCode>,
	allowed: readonly C[]
): { ok: false; error: AdapterError<C | 'protocol_error'> } {
	if ((allowed as readonly FetchErrorCode[]).includes(error.code)) {
		return { ok: false, error: error as AdapterError<C> };
	}
	if (error.code === 'protocol_error') return { ok: false, error: { ...error, code: 'protocol_error' } };
	return failure('protocol_error', false, `unexpected ${error.code} for an open endpoint`, error.details);
}

/**
 * Builds the snapshot of contracts 1.3 from the fetched pages: complete only when every page was fetched, all share
 * one `sourceVersion` and each declares `complete: true`.
 */
function assembleSnapshot(pages: readonly AchievementsPage[], interrupted: boolean): AchievementsSnapshot {
	const last = pages.at(-1);
	if (!last) throw new Error('a snapshot needs at least one page');
	const versions = new Set(pages.map((p) => p.sourceVersion));
	let incompleteReason: IncompleteReason | undefined;
	if (interrupted) incompleteReason = 'pagination_interrupted';
	else if (versions.size > 1) incompleteReason = 'version_changed';
	else if (pages.some((p) => p.complete === false)) incompleteReason = 'source_declared_partial';
	else if (pages.some((p) => p.complete === undefined)) incompleteReason = 'no_completeness_signal';

	// Pages of different versions may repeat a record: the later page wins.
	const results = new Map<string, Result>();
	const competitions = new Map<string, Competition>();
	for (const page of pages) {
		for (const result of page.results) results.set(result.id, result);
		for (const competition of page.competitions) competitions.set(competition.id, competition);
	}
	return {
		athlete: last.athlete,
		qualifications: last.qualifications,
		results: [...results.values()],
		competitions: [...competitions.values()],
		generatedAt: last.generatedAt,
		completeness: {
			complete: incompleteReason === undefined,
			sourceVersion: last.sourceVersion,
			pages: { fetched: pages.length, total: last.page.totalPages },
			...(incompleteReason === undefined ? {} : { incompleteReason })
		}
	};
}
