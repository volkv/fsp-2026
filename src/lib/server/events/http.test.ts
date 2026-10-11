import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, postJson, type PostOptions } from './http';

describe('isBlockedAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'::1',
		'::',
		'fe80::1',
		'fd00::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'::ffff:c0a8:1',
		'not-an-address'
	])('refuses %s', (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34'])(
		'lets %s through',
		(address) => {
			expect(isBlockedAddress(address)).toBe(false);
		}
	);
});

describe('postJson to a private network', () => {
	const received: string[] = [];
	const server = createServer((request, response) => {
		received.push(request.url ?? '');
		response.writeHead(302, { location: 'http://127.0.0.1/elsewhere' });
		response.end();
	});
	let port = 0;
	const options = (allowPrivateNetwork: boolean): PostOptions => ({
		headers: {},
		timeoutMs: 2_000,
		signal: new AbortController().signal,
		allowPrivateNetwork
	});

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			})
	);

	it('refuses a literal private address without connecting', async () => {
		const result = await postJson(`http://127.0.0.1:${port}/hook`, '{}', options(false));
		expect(result).toMatchObject({ kind: 'failed', code: 'blocked_address' });
		expect(received).toHaveLength(0);
	});

	it('refuses a name by the address it resolves to at connection time', async () => {
		const result = await postJson(`http://localhost:${port}/hook`, '{}', options(false));
		expect(result).toMatchObject({ kind: 'failed', code: 'blocked_address' });
		expect(received).toHaveLength(0);
	});

	it('does not follow a redirect: the answer is the redirect itself', async () => {
		const result = await postJson(`http://127.0.0.1:${port}/hook`, '{}', options(true));
		expect(result).toMatchObject({ kind: 'answered', status: 302 });
		expect(received).toEqual(['/hook']);
	});
});
