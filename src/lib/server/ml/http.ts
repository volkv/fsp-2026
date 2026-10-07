// One HTTP exchange with an OpenAI-compatible runtime: deadline, caller cancellation, bounded body, and the mapping
// of transport failures onto adapter error codes (docs/contracts.md, section 3.5). No retries here: the caller decides.
import { fail, ok, type ModelError, type ModelResult } from './result';

/** Responses of the three operations are small; a larger body is not a valid answer. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface Endpoint {
	baseUrl: string;
	apiKey: string | null;
}

export interface CallControl {
	/** Absolute deadline, `Date.now()` scale. */
	deadline: number;
	signal?: AbortSignal;
}

/** Signals of the runtime that the input exceeds the model context (vLLM, llama.cpp, TEI, OpenAI). */
const CONTEXT_TOO_LONG =
	/context[_ ]length|maximum context|context window|too many tokens|input (is )?too long|exceeds? the (model'?s? )?(maximum|max)/i;

/**
 * `{baseUrl}/{path}`: the base URL is the base of the OpenAI-compatible API with its version path, as providers publish
 * it (`http://gpu-host:8000/v1`, `https://llmgate.volkv.com/v1`, `https://openrouter.ai/api/v1`).
 */
export function endpointUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
	const body = response.body;
	if (!body) return '';
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		signal.throwIfAborted();
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new ResponseTooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

class ResponseTooLarge extends Error {
	override name = 'ResponseTooLarge';
}

class DeadlineExceeded extends Error {
	override name = 'DeadlineExceeded';
}

/**
 * POSTs `payload` as JSON and returns the parsed JSON body of a 2xx response. The deadline covers connecting,
 * waiting for headers and reading the whole body, so a runtime that hangs mid-response still times out.
 */
export async function postJson(
	operation: string,
	endpoint: Endpoint,
	path: string,
	payload: unknown,
	control: CallControl
): Promise<ModelResult<unknown>> {
	if (control.signal?.aborted) return fail('cancelled', `${operation}: cancelled by the caller`);
	const remaining = control.deadline - Date.now();
	if (remaining <= 0) return fail('timeout', `${operation}: deadline passed before the request`);

	const deadline = new AbortController();
	const timer = setTimeout(() => {
		deadline.abort(new DeadlineExceeded());
	}, remaining);
	const signal = control.signal ? AbortSignal.any([control.signal, deadline.signal]) : deadline.signal;
	const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
	if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

	try {
		const response = await fetch(endpointUrl(endpoint.baseUrl, path), {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal,
			redirect: 'error'
		});
		const text = await readBounded(response, signal);
		if (!response.ok) return classifyStatus(operation, response.status, text);
		try {
			return ok(JSON.parse(text) as unknown);
		} catch {
			return fail('invalid_output', `${operation}: response body is not JSON`, { status: response.status });
		}
	} catch (error) {
		if (deadline.signal.aborted) return fail('timeout', `${operation}: no complete response in time`);
		if (control.signal?.aborted) return fail('cancelled', `${operation}: cancelled by the caller`);
		if (error instanceof ResponseTooLarge) {
			return fail('invalid_output', `${operation}: response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
		}
		return fail('unavailable', `${operation}: runtime unreachable or connection dropped`, {
			cause: transportCause(error)
		});
	} finally {
		clearTimeout(timer);
	}
}

/** The `error.code` of an OpenAI-style error body, or `null` when the body is not one. */
function errorCode(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return null;
	const { error } = parsed;
	if (typeof error !== 'object' || error === null || !('code' in error)) return null;
	return typeof error.code === 'string' ? error.code : null;
}

/**
 * A gateway that checks structured output itself answers `json_validation_failed` after its own retries: the model
 * did answer, its answer failed the schema. That is `invalid_output`, not a runtime that is down.
 */
const SCHEMA_FAILURE_CODES: ReadonlySet<string> = new Set(['json_validation_failed']);

function classifyStatus(operation: string, status: number, body: string): { ok: false; error: ModelError } {
	const code = status >= 400 ? errorCode(body) : null;
	if (code !== null && SCHEMA_FAILURE_CODES.has(code)) {
		return fail('invalid_output', `${operation}: the runtime found the answer failing the schema`, { status, code });
	}
	if (status === 429) return fail('rate_limited', `${operation}: runtime is rate limiting`, { status });
	if (status >= 500) return fail('unavailable', `${operation}: runtime answered ${status}`, { status });
	if ((status === 400 || status === 413 || status === 422) && CONTEXT_TOO_LONG.test(body)) {
		return fail('context_too_long', `${operation}: input exceeds the model context`, { status });
	}
	return fail('request_rejected', `${operation}: runtime refused the request with ${status}`, { status });
}

/** A code for the log without the error message, which may echo the request. */
function transportCause(error: unknown): string {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		const code = (current as Error & { code?: unknown }).code;
		if (typeof code === 'string') return code;
		current = current.cause;
	}
	return error instanceof Error ? error.name : 'unknown';
}
