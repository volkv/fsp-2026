// HTTP access of the vacancy source adapters: the platform's own User-Agent, a deadline per request, cancellation, and
// the mapping of transport failures onto the adapter error codes (docs/contracts.md, section 7.2).
import { createHash } from 'node:crypto';
import { sourceFail, sourceOk, type SourceResult } from './types';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SourceHttpOptions {
	fetch: FetchLike;
	/** The platform introduces itself to the source. */
	userAgent: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface SourceResponse {
	status: number;
	body: string;
}

const MAX_RETRY_AFTER_SECONDS = 3600;

/** `Retry-After` in seconds (delta or HTTP date); `null` when absent or unreadable. */
export function retryAfterSeconds(header: string | null, now: Date): number | null {
	if (header === null) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return Math.min(Math.max(0, Math.ceil((at - now.getTime()) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

/**
 * GET with the adapter conventions. 2xx and 404/410 are answers the adapter interprets; 429 is `rate_limited` with
 * `retry_after_seconds`; 401/403 — `forbidden`; 5xx, network failures and timeouts — `unavailable`; other statuses —
 * `protocol_error`.
 */
export async function sourceGet(
	url: string,
	accept: string,
	options: SourceHttpOptions
): Promise<SourceResult<SourceResponse>> {
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	let body: string;
	try {
		response = await options.fetch(url, {
			method: 'GET',
			headers: { accept, 'user-agent': options.userAgent },
			redirect: 'follow',
			signal
		});
		body = await response.text();
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const reason = timeout.aborted ? 'timeout' : 'network';
		return sourceFail('unavailable', `source request failed: ${reason}`, { reason });
	}
	const { status } = response;
	if ((status >= 200 && status < 300) || status === 404 || status === 410) return sourceOk({ status, body });
	if (status === 429) {
		const seconds = retryAfterSeconds(response.headers.get('retry-after'), new Date());
		return sourceFail('rate_limited', 'source rate limit reached', {
			status,
			...(seconds === null ? {} : { retry_after_seconds: seconds })
		});
	}
	if (status === 401 || status === 403) return sourceFail('forbidden', 'source refused access', { status });
	if (status >= 500) return sourceFail('unavailable', 'source answered with a server error', { status });
	return sourceFail('protocol_error', 'source answered with an unexpected status', { status });
}

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}
