import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { hero } from '../src/seed/heroes.ts';
import type { AchievementsPage, WebhookEvent } from '../src/types.ts';
import { control, login, serviceToken, startMock, type RunningMock } from './helpers.ts';

const SECRET = 'receiver-webhook-secret-0123456789abcdef';
const MAX_SKEW_SECONDS = 300;

interface Received {
	headers: IncomingHttpHeaders;
	rawBody: string;
}

/**
 * Receiver-side check written from the contract alone (docs/contracts.md, section 1.5):
 * X-FSP-Signature = "sha256=" + hex HMAC-SHA-256 of "{X-FSP-Timestamp}.{rawBody}".
 */
function verifies(received: Received, secret: string, now = Math.floor(Date.now() / 1000)): boolean {
	const timestamp = received.headers['x-fsp-timestamp'];
	const signature = received.headers['x-fsp-signature'];
	if (typeof timestamp !== 'string' || typeof signature !== 'string' || !/^\d+$/.test(timestamp)) return false;
	if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
	const expected = Buffer.from(
		`sha256=${createHmac('sha256', secret).update(`${timestamp}.${received.rawBody}`).digest('hex')}`
	);
	const actual = Buffer.from(signature);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

describe('webhook "achievements updated"', () => {
	let mock: RunningMock;
	let receiver: Server;
	let receiverUrl: string;
	const inbox: Received[] = [];
	const athlete = hero('team_no_spec');

	beforeAll(async () => {
		receiver = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				inbox.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
				res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');
			});
		});
		await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
		const address = receiver.address();
		assert.ok(address && typeof address === 'object');
		receiverUrl = `http://127.0.0.1:${address.port}/api/v1/integrations/fsp/webhooks`;
		mock = await startMock();
	});
	afterAll(async () => {
		await mock.close();
		receiver.closeAllConnections();
		await new Promise<void>((resolve) => {
			receiver.close(() => {
				resolve();
			});
		});
	});

	it('subscribes through the API with a service token only', async () => {
		const denied = await fetch(`${mock.origin}/v1/webhooks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url: receiverUrl, events: ['result.published'], secret: SECRET })
		});
		assert.equal(denied.status, 401);

		const token = await serviceToken(mock);
		const response = await fetch(`${mock.origin}/v1/webhooks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ url: receiverUrl, events: ['result.published', 'result.annulled'], secret: SECRET })
		});
		assert.equal(response.status, 201);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.url, receiverUrl);
		assert.equal(body.secret, undefined, 'the secret is never echoed');
	});

	it('delivers a signed event when a result is annulled, and the change is visible in the API', async () => {
		const own = (await login(mock, athlete.fspId)).access_token;
		const before = (await (
			await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements`, {
				headers: { authorization: `Bearer ${own}` }
			})
		).json()) as AchievementsPage;
		const target = before.results.find((r) => r.status === 'official');
		assert.ok(target);

		const response = await control(mock, `/mock/results/${target.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ status: 'annulled' })
		});
		assert.equal(response.status, 200);
		const received = inbox.at(-1);
		assert.ok(received, 'receiver got the event');
		assert.ok(verifies(received, SECRET), 'signature verifies with the shared secret');

		const event = JSON.parse(received.rawBody) as WebhookEvent;
		assert.equal(event.type, 'result.annulled');
		assert.deepEqual(event.athleteIds, [athlete.fspId]);
		assert.equal(event.competitionId, target.competitionId);
		assert.equal(received.headers['x-fsp-event-id'], event.eventId);
		assert.ok(!received.rawBody.includes(athlete.name.lastName), 'no personal data besides ids');

		const afterwards = (await (
			await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements`, {
				headers: { authorization: `Bearer ${own}` }
			})
		).json()) as AchievementsPage;
		assert.notEqual(afterwards.sourceVersion, before.sourceVersion);
		assert.equal(afterwards.results.find((r) => r.id === target.id)?.status, 'annulled');
	});

	it('produces a signature that fails for another secret, a changed body or a changed timestamp', async () => {
		inbox.length = 0;
		const response = await control(mock, '/mock/webhooks/dispatch', {
			method: 'POST',
			body: JSON.stringify({ type: 'result.published', athleteIds: [athlete.fspId] })
		});
		assert.equal(response.status, 200);
		const received = inbox.at(-1);
		assert.ok(received);
		assert.ok(verifies(received, SECRET));
		assert.ok(!verifies(received, `${SECRET}x`), 'another secret');
		assert.ok(
			!verifies({ ...received, rawBody: received.rawBody.replace(athlete.fspId, hero('annulled').fspId) }, SECRET),
			'body'
		);
		const shifted = String(Number(received.headers['x-fsp-timestamp']) + 1);
		assert.ok(
			!verifies({ ...received, headers: { ...received.headers, 'x-fsp-timestamp': shifted } }, SECRET),
			'timestamp'
		);
	});

	it('sends only subscribed event types', async () => {
		inbox.length = 0;
		await control(mock, '/mock/webhooks/dispatch', {
			method: 'POST',
			body: JSON.stringify({ type: 'qualification.assigned', athleteIds: [athlete.fspId] })
		});
		assert.equal(inbox.length, 0);
	});

	it('records deliveries for inspection', async () => {
		const response = await control(mock, '/mock/webhooks/deliveries');
		const body = (await response.json()) as { items: { delivered: boolean; attempts: { status: number }[] }[] };
		assert.ok(body.items.length >= 2);
		assert.ok(body.items.every((d) => d.delivered && d.attempts[0]?.status === 202));
	});
});
