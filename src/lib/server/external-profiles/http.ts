// HTTP access to the public APIs of Codeforces and GitHub: only the server calls them, each request has a deadline,
// and every failure is a stated reason, never a substitute answer (docs/domain.md, section 9.4).

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PlatformHttp {
	fetch: FetchLike;
	/** The platform introduces itself to the source. */
	userAgent: string;
	timeoutMs: number;
}

/** Why a source gave no usable answer; stored in `external_profiles.sync_error` and shown to the candidate. */
export type SourceFailure = 'timeout' | 'network' | 'rate_limited' | 'server_error' | 'protocol_error';

export class SourceUnavailable extends Error {
	override name = 'SourceUnavailable';
	readonly reason: SourceFailure;
	/** When the source asks to come back (rate limit), in seconds. */
	readonly retryAfterSeconds: number | undefined;

	constructor(reason: SourceFailure, message: string, retryAfterSeconds?: number) {
		super(message);
		this.reason = reason;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export interface SourceAnswer {
	status: number;
	headers: Headers;
	body: string;
}

/** The answer of a GET, whatever its status; a transport failure or a timeout is `SourceUnavailable`. */
export async function sourceGet(
	http: PlatformHttp,
	url: string,
	accept: string,
	headers: Record<string, string> = {}
): Promise<SourceAnswer> {
	const signal = AbortSignal.timeout(http.timeoutMs);
	try {
		const response = await http.fetch(url, {
			method: 'GET',
			headers: { ...headers, accept, 'user-agent': http.userAgent },
			redirect: 'follow',
			signal
		});
		return { status: response.status, headers: response.headers, body: await response.text() };
	} catch (cause) {
		if (signal.aborted) throw new SourceUnavailable('timeout', `request timed out after ${http.timeoutMs} ms`);
		throw new SourceUnavailable('network', `request failed: ${cause instanceof Error ? cause.message : 'unknown'}`);
	}
}

/** Parses a JSON body; a body that is not JSON is a protocol error of the source. */
export function jsonOf(answer: SourceAnswer): unknown {
	try {
		return JSON.parse(answer.body);
	} catch {
		throw new SourceUnavailable('protocol_error', `answer with status ${answer.status} is not JSON`);
	}
}

const MAX_RETRY_AFTER_SECONDS = 3600;

/** `Retry-After` (seconds) or the reset moment of a GitHub rate limit (`x-ratelimit-reset`, epoch seconds). */
export function retryAfterOf(headers: Headers, now: Date): number | undefined {
	const retryAfter = headers.get('retry-after');
	if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
		return Math.min(Number(retryAfter.trim()), MAX_RETRY_AFTER_SECONDS);
	}
	const reset = headers.get('x-ratelimit-reset');
	if (reset !== null && /^\d+$/.test(reset.trim())) {
		const seconds = Math.ceil(Number(reset.trim()) - now.getTime() / 1000);
		return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS);
	}
	return undefined;
}
