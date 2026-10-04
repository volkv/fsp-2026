import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiErrorCode } from './types.ts';

export class HttpError extends Error {
	readonly status: number;
	readonly code: ApiErrorCode;
	readonly headers: Record<string, string>;

	constructor(status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}) {
		super(message);
		this.status = status;
		this.code = code;
		this.headers = headers;
	}
}

const MAX_BODY_BYTES = 256 * 1024;

export async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid_request', 'request body is too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
	const raw = await readBody(req);
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw.toString('utf8')) as unknown;
	} catch {
		throw new HttpError(400, 'invalid_request', 'request body is not valid JSON');
	}
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	return new URLSearchParams((await readBody(req)).toString('utf8'));
}

export function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {}
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload).toString(),
		...headers
	});
	res.end(payload);
}

export function sendError(res: ServerResponse, error: HttpError): void {
	sendJson(res, error.status, { error: { code: error.code, message: error.message } }, error.headers);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
		'x-frame-options': 'DENY'
	});
	res.end(html);
}

export function bearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header);
	return match?.[1] ?? null;
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
