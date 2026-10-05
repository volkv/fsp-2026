// The one HTTP call of an outgoing delivery: a JSON `POST` with a deadline, no redirects followed, the answer body read
// only up to a small limit. The address a company registers is outside the platform's control, so by default the
// call refuses every address of a private, loopback or link-local network — checked on the address the name resolves
// to at connection time, so a name that later resolves elsewhere is refused as well.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const BLOCKED = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4]
] as const) {
	BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8]
] as const) {
	BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** Whether an address belongs to a network a delivery never reaches. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return BLOCKED.check(address, 'ipv4');
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
		return mapped?.[1] !== undefined ? BLOCKED.check(mapped[1], 'ipv4') : BLOCKED.check(address, 'ipv6');
	}
	return true;
}

export class BlockedAddressError extends Error {
	override name = 'BlockedAddressError';
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
	dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
		if (error) {
			callback(error, '', 0);
			return;
		}
		const allowed = addresses.filter((entry) => !isBlockedAddress(entry.address));
		const first = allowed[0];
		if (!first || allowed.length !== addresses.length) {
			callback(new BlockedAddressError(`${hostname} resolves to a private address`), '', 0);
			return;
		}
		if (options.all) callback(null, allowed);
		else callback(null, first.address, first.family);
	});
};

export interface PostOptions {
	headers: Record<string, string>;
	timeoutMs: number;
	signal: AbortSignal;
	/** Tests and a local stand reach their own receiver; the deployed stand never does. */
	allowPrivateNetwork: boolean;
}

export type PostResult =
	| { kind: 'answered'; status: number; body: string }
	| { kind: 'failed'; code: 'blocked_address' | 'timeout' | 'network'; message: string };

const BODY_LIMIT = 64 * 1024;

/** `POST` of a JSON body; resolves with the answer or the failure, never throws for the network. */
export function postJson(url: string, body: string, options: PostOptions): Promise<PostResult> {
	return sendJson('POST', url, body, options);
}

/** A JSON request of the given method, as `postJson`. */
export function sendJson(method: 'POST' | 'PUT', url: string, body: string, options: PostOptions): Promise<PostResult> {
	const target = new URL(url);
	const literal = target.hostname.replace(/^\[|\]$/g, '');
	if (!options.allowPrivateNetwork && isIP(literal) !== 0 && isBlockedAddress(literal)) {
		return Promise.resolve({ kind: 'failed', code: 'blocked_address', message: 'the address is private' });
	}
	const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
	return new Promise((resolve) => {
		const request = send(
			target,
			{
				method,
				headers: { 'content-type': 'application/json', ...options.headers },
				timeout: options.timeoutMs,
				signal: options.signal,
				...(options.allowPrivateNetwork ? {} : { lookup: guardedLookup })
			},
			(response: IncomingMessage) => {
				let received = '';
				response.setEncoding('utf8');
				response.on('data', (chunk: string) => {
					if (received.length < BODY_LIMIT) received += chunk;
				});
				response.on('end', () => {
					resolve({ kind: 'answered', status: response.statusCode ?? 0, body: received });
				});
				response.on('error', (error) => {
					resolve({ kind: 'failed', code: 'network', message: error.name });
				});
			}
		);
		request.on('timeout', () => request.destroy(new Error('timeout')));
		request.on('error', (error) => {
			if (error instanceof BlockedAddressError) {
				resolve({ kind: 'failed', code: 'blocked_address', message: 'the address is private' });
			} else if (error.message === 'timeout') {
				resolve({ kind: 'failed', code: 'timeout', message: `no answer in ${options.timeoutMs} ms` });
			} else {
				resolve({ kind: 'failed', code: 'network', message: error.name });
			}
		});
		request.end(body);
	});
}
