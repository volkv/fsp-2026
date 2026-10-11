import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTGOING_WEBHOOKS } from '$lib/server/api/v1/event-webhooks';
import { ApiError } from '$lib/server/errors/api-error';
import { atsLinks, companies, eventDeliveries, eventSubscriptions, jobs } from '$lib/server/db/schema';
import { createEventDeliverHandler } from '$lib/server/events/deliver';
import { EVENT_DATA } from '$lib/server/events/payloads';
import { webhookSignature } from '$lib/server/events/signature';
import {
	connectHuntflow,
	createWebhook,
	redeliver,
	rotateSecret,
	type SubscriptionDeps
} from '$lib/server/events/subscriptions';
import { reportHiring } from '$lib/server/hiring/process';
import { markInvitationViewed } from '$lib/server/invitations/respond';
import { JobFailure } from '$lib/server/jobs/handler';
import { closeOwnVacancy, pauseOwnVacancy, resumeOwnVacancy } from '$lib/server/vacancies/own';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createOfferWorld, testCrypto, testMeta, type Employer, type OfferWorld } from '../helpers/offers';

interface Received {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: string;
}

/** A local HTTP receiver: records requests and answers with the status the test sets. */
class Stub {
	received: Received[] = [];
	status = 200;
	answer: (request: Received) => object = () => ({});
	private server: Server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
		request.on('end', () => {
			const entry = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body };
			this.received.push(entry);
			response.writeHead(this.status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(this.answer(entry)));
		});
	});

	async start(): Promise<string> {
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			this.server.close(() => {
				resolve();
			});
		});
	}
}

let database: TestDatabase;
let world: OfferWorld;
const stub = new Stub();
let base = '';

beforeAll(async () => {
	database = await createTestDatabase();
	world = await createOfferWorld(database);
	base = await stub.start();
});

afterAll(async () => {
	await stub.stop();
	await database.drop();
});

const subscriptionDeps = (huntflowApiUrl: string | null = null): SubscriptionDeps => ({
	db: database.db,
	crypto: testCrypto,
	now: () => world.clock.now,
	huntflowApiUrl
});

const handler = (options: { allowPrivateNetwork: boolean; huntflowApiUrl?: string | null }) =>
	createEventDeliverHandler(() => ({
		crypto: testCrypto,
		huntflowApiUrl: options.huntflowApiUrl ?? null,
		allowPrivateNetwork: options.allowPrivateNetwork,
		now: () => world.clock.now
	}));

const ctxOf = (company: Employer) => ({
	subject: company.subject,
	meta: { requestId: 'test', ip: null, userAgent: null }
});

async function deliveriesOf(subscriptionId: string) {
	return database.db.select().from(eventDeliveries).where(eq(eventDeliveries.subscriptionId, subscriptionId));
}

/** A webhook of the company pointed at the local receiver (an address the form refuses as private). */
async function webhookOf(company: Employer, events: string[]) {
	const created = await createWebhook(subscriptionDeps(), ctxOf(company), company.company.id, {
		name: 'ATS',
		url: 'https://ats.example.org/hooks/fsp',
		events
	});
	await database.db
		.update(eventSubscriptions)
		.set({ url: `${base}/hooks` })
		.where(eq(eventSubscriptions.id, created.subscription.id));
	return created;
}

describe('outgoing events of a company', () => {
	it('signs the webhook with HMAC and carries identifiers and the pseudonym only', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const person = await world.candidate();
		const { subscription, secret } = await webhookOf(company, ['invitation.accepted']);
		const offer = await world.acceptedOffer(company, person);

		const [delivery] = await deliveriesOf(subscription.id);
		expect(delivery).toMatchObject({
			eventType: 'invitation.accepted',
			status: 'queued',
			invitationId: offer.invitationId
		});
		if (!delivery) throw new Error('no delivery');
		stub.received = [];
		stub.status = 200;
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id });

		const [request] = stub.received;
		if (!request) throw new Error('nothing was sent');
		const timestamp = Number(request.headers['webhook-timestamp']);
		expect(request.headers['webhook-id']).toBe(delivery.eventId);
		expect(request.headers['webhook-signature']).toBe(
			webhookSignature(secret, delivery.eventId, timestamp, request.body)
		);
		// The body is what the API document describes for the event.
		const described = OUTGOING_WEBHOOKS.find((webhook) => webhook.name === 'invitation.accepted');
		expect(described?.body.safeParse(JSON.parse(request.body)).success).toBe(true);
		const body = JSON.parse(request.body) as { type: string; data: Record<string, unknown> };
		expect(body.type).toBe('invitation.accepted');
		expect(body.data).toMatchObject({
			invitation_id: offer.invitationId,
			terms_id: offer.termsId,
			candidate_pseudonym: testCrypto.pseudonym(person.id, company.company.id)
		});
		expect(request.body).not.toContain(person.email);
		expect(request.body).not.toContain(person.id);
		const [done] = await deliveriesOf(subscription.id);
		expect(done).toMatchObject({ status: 'delivered', attempts: 1, lastStatus: 200 });
	});

	it('retries on 5xx with a pause, fails for good after the last attempt, never reaches a private address', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const { subscription } = await webhookOf(company, ['invitation.declined', 'invitation.accepted']);
		await world.acceptedOffer(company, await world.candidate());
		const [delivery] = await deliveriesOf(subscription.id);
		if (!delivery) throw new Error('no delivery');

		stub.status = 503;
		const retry = await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id }).then(
			() => null,
			(error: unknown) => error
		);
		expect(retry).toBeInstanceOf(JobFailure);
		expect(retry).toMatchObject({ retryable: true, retryAfterSeconds: 60 });
		expect((await deliveriesOf(subscription.id))[0]).toMatchObject({
			status: 'queued',
			attempts: 1,
			lastStatus: 503,
			lastAttemptAt: world.clock.now
		});
		// The pause grows with the attempts.
		const third = await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id }, 3).then(
			() => null,
			(error: unknown) => error
		);
		expect(third).toMatchObject({ retryable: true, retryAfterSeconds: 900 });
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id }, 8);
		expect((await deliveriesOf(subscription.id))[0]).toMatchObject({ status: 'failed', attempts: 3 });

		// The deployed stand refuses the local address outright: no request leaves.
		await world.acceptedOffer(company, await world.candidate());
		const fresh = (await deliveriesOf(subscription.id)).find((row) => row.status === 'queued');
		if (!fresh) throw new Error('no second delivery');
		stub.received = [];
		await world.runJob(handler({ allowPrivateNetwork: false }), { delivery_id: fresh.id });
		expect(stub.received).toHaveLength(0);
		expect((await deliveriesOf(subscription.id)).find((row) => row.id === fresh.id)).toMatchObject({
			status: 'failed',
			lastError: 'blocked_address: the address is private'
		});
	});

	it('signs with both secrets during a rotation and sends nothing for a suspended company', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const { subscription, secret: old } = await webhookOf(company, ['invitation.accepted']);
		const rotated = await rotateSecret(subscriptionDeps(), ctxOf(company), company.company.id, subscription.id);
		if (rotated.secret === null) throw new Error('a webhook gets a new secret');
		await world.acceptedOffer(company, await world.candidate());
		const [delivery] = await deliveriesOf(subscription.id);
		if (!delivery) throw new Error('no delivery');
		stub.status = 200;
		stub.received = [];
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id });
		const [request] = stub.received;
		if (!request) throw new Error('nothing was sent');
		const sign = (key: string) =>
			webhookSignature(key, delivery.eventId, Number(request.headers['webhook-timestamp']), request.body);
		expect(request.headers['webhook-signature']).toBe(`${sign(rotated.secret)} ${sign(old)}`);

		await world.acceptedOffer(company, await world.candidate());
		await database.db.update(companies).set({ status: 'suspended' }).where(eq(companies.id, company.company.id));
		const queued = (await deliveriesOf(subscription.id)).find((row) => row.status === 'queued');
		if (!queued) throw new Error('no queued delivery');
		stub.received = [];
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: queued.id });
		expect(stub.received).toHaveLength(0);
		expect((await deliveriesOf(subscription.id)).find((row) => row.id === queued.id)?.status).toBe('skipped');
	});

	it('refuses an address outside https or inside a private network when registering', async () => {
		const company = await world.employer();
		for (const url of [
			'http://ats.example.org/hooks',
			'https://127.0.0.1/hooks',
			'https://localhost/hooks',
			'https://hooks.localhost/x',
			'https://[::1]/hooks',
			'https://169.254.169.254/latest/meta-data',
			'https://10.1.2.3/hooks',
			'https://[::ffff:192.168.0.1]/hooks',
			'https://user:pass@ats.example.org/hooks'
		]) {
			const refused = await createWebhook(subscriptionDeps(), ctxOf(company), company.company.id, {
				name: 'ATS',
				url,
				events: ['invitation.sent']
			}).then(
				() => null,
				(error: unknown) => error
			);
			expect(refused, url).toBeInstanceOf(ApiError);
			expect((refused as ApiError).details?.[0]).toMatchObject({ path: 'url', code: 'invalid_url' });
		}
	});

	it('emits the life of an offer and of a vacancy to the subscriptions asking for it, identifiers only', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const person = await world.candidate();
		const { subscription } = await webhookOf(company, [
			'invitation.sent',
			'invitation.viewed',
			'invitation.withdrawn',
			'vacancy.published',
			'vacancy.closed'
		]);
		const offer = await world.sentOffer(company, person);
		await markInvitationViewed(world.deps, person.subject, offer.invitationId);
		const author = {
			memberId: company.member.id,
			companyId: company.company.id,
			audit: { kind: 'system' as const },
			requestId: 'test'
		};
		const vacancyDeps = { db: database.db, now: () => world.clock.now };
		await pauseOwnVacancy(vacancyDeps, author, company.vacancy.id);
		await resumeOwnVacancy(vacancyDeps, author, company.vacancy.id);
		await closeOwnVacancy(vacancyDeps, author, company.vacancy.id);

		const rows = await deliveriesOf(subscription.id);
		const byType = (type: string) => rows.filter((row) => row.eventType === type);
		expect(rows.map((row) => row.eventType).sort()).toEqual([
			'invitation.sent',
			'invitation.viewed',
			'invitation.withdrawn',
			'vacancy.closed',
			'vacancy.published'
		]);
		expect(byType('invitation.sent')[0]?.payload).toMatchObject({
			invitation_id: offer.invitationId,
			terms_id: offer.termsId,
			terms_version: 1,
			vacancy_id: company.vacancy.id,
			reopened: false
		});
		expect(byType('invitation.viewed')[0]?.invitationId).toBe(offer.invitationId);
		expect(byType('invitation.withdrawn')[0]?.payload).toMatchObject({ cause: 'vacancy_closed' });
		expect(byType('vacancy.published')[0]?.payload).toMatchObject({
			vacancy_id: company.vacancy.id,
			previous_status: 'paused'
		});
		expect(byType('vacancy.closed')[0]?.payload).toMatchObject({ previous_status: 'published' });
		// Every stored event is what its schema in the API document allows, and every one has its job in the queue.
		for (const row of rows) {
			expect(EVENT_DATA[row.eventType as keyof typeof EVENT_DATA].safeParse(row.payload).success, row.eventType).toBe(
				true
			);
			expect(JSON.stringify(row.payload)).not.toContain(person.id);
			const [job] = await database.db
				.select({ status: jobs.status })
				.from(jobs)
				.where(and(eq(jobs.type, 'event.deliver'), eq(jobs.dedupKey, `event.deliver:${row.id}`)));
			expect(job?.status).toBe('queued');
		}
	});

	it('sends a failed delivery again on request with the same event id; a delivered one is not repeated', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const { subscription, secret } = await webhookOf(company, ['invitation.sent']);
		await world.sentOffer(company, await world.candidate());
		const [delivery] = await deliveriesOf(subscription.id);
		if (!delivery) throw new Error('no delivery');

		stub.received = [];
		stub.status = 400;
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id });
		expect((await deliveriesOf(subscription.id))[0]).toMatchObject({
			status: 'failed',
			attempts: 1,
			lastStatus: 400,
			lastError: 'http_400'
		});

		await redeliver(subscriptionDeps(), ctxOf(company), company.company.id, subscription.id, delivery.id);
		expect((await deliveriesOf(subscription.id))[0]?.status).toBe('queued');
		stub.status = 200;
		await world.runJob(handler({ allowPrivateNetwork: true }), { delivery_id: delivery.id });
		expect((await deliveriesOf(subscription.id))[0]).toMatchObject({
			status: 'delivered',
			attempts: 2,
			lastStatus: 200
		});
		const [first, second] = stub.received;
		expect(second?.headers['webhook-id']).toBe(first?.headers['webhook-id']);
		expect(second?.headers['webhook-signature']).toBe(
			webhookSignature(secret, delivery.eventId, Number(second?.headers['webhook-timestamp']), second?.body ?? '')
		);

		const again = await redeliver(
			subscriptionDeps(),
			ctxOf(company),
			company.company.id,
			subscription.id,
			delivery.id
		).then(
			() => null,
			(error: unknown) => error
		);
		expect(again).toMatchObject({ code: 'conflict' });
		// Another company's delivery is not found.
		const stranger = await world.employer();
		const foreign = await redeliver(
			subscriptionDeps(),
			ctxOf(stranger),
			stranger.company.id,
			subscription.id,
			delivery.id
		).then(
			() => null,
			(error: unknown) => error
		);
		expect(foreign).toMatchObject({ code: 'not_found' });
	});
});

// --- Huntflow ---------------------------------------------------------------------------------------------------------

interface SchemaNode {
	$ref?: string;
	allOf?: SchemaNode[];
	type?: string;
	required?: string[];
	properties?: Record<string, SchemaNode>;
}

const fragment = JSON.parse(
	readFileSync(new URL('../fixtures/huntflow/openapi-fragment.json', import.meta.url), 'utf8')
) as { components: { schemas: Record<string, SchemaNode> } };

/** The request body against a schema of the Huntflow document: required fields, known fields, their JSON types. */
function shapeProblems(name: string, body: Record<string, unknown>): string[] {
	const schema = fragment.components.schemas[name];
	if (!schema?.properties) throw new Error(`schema ${name} is not in the fragment`);
	const properties = schema.properties;
	const problems = (schema.required ?? []).filter((key) => !(key in body)).map((key) => `missing ${key}`);
	for (const [key, value] of Object.entries(body)) {
		const property = properties[key];
		if (!property) problems.push(`unknown ${key}`);
		else if (property.type === 'integer' && !Number.isInteger(value)) problems.push(`${key} is not an integer`);
		else if (property.type === 'string' && typeof value !== 'string') problems.push(`${key} is not a string`);
	}
	return problems;
}

describe('the Huntflow adapter', () => {
	it('creates the applicant, puts them on the vacancy and moves the status, in the shapes of the Huntflow API', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const person = await world.candidate();
		const subscription = await connectHuntflow(subscriptionDeps(base), ctxOf(company), company.company.id, {
			name: 'Хантфлоу',
			token: 'hf-token-0123456789abcdef',
			settings: { account_id: 7, vacancy_id: 11, statuses: { accepted: 101, interview_scheduled: 102 } }
		});
		const offer = await world.acceptedOffer(company, person);
		stub.status = 200;
		stub.received = [];
		stub.answer = (request) => (request.path.endsWith('/applicants') ? { id: 42 } : { id: 1, status: 101 });
		const [accepted] = await deliveriesOf(subscription.id);
		if (!accepted) throw new Error('no delivery');
		await world.runJob(handler({ allowPrivateNetwork: false, huntflowApiUrl: base }), { delivery_id: accepted.id });

		const [create, place] = stub.received;
		expect(create).toMatchObject({ method: 'POST', path: '/accounts/7/applicants' });
		expect(create?.headers.authorization).toBe('Bearer hf-token-0123456789abcdef');
		const applicant = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
		expect(applicant).toEqual({ last_name: 'Иванова', first_name: 'Анна', email: person.email });
		expect(shapeProblems('ApplicantCreateRequest', applicant)).toEqual([]);
		expect(place).toMatchObject({ method: 'POST', path: '/accounts/7/applicants/42/vacancy' });
		const placed = JSON.parse(place?.body ?? '{}') as Record<string, unknown>;
		expect(placed).toMatchObject({ vacancy: 11, status: 101 });
		expect(shapeProblems('AddApplicantToVacancyRequest', placed)).toEqual([]);
		const [link] = await database.db.select().from(atsLinks).where(eq(atsLinks.invitationId, offer.invitationId));
		expect(link?.externalId).toBe('42');

		await reportHiring(world.deps, company.subject, testMeta, offer.processId, {
			party: 'company',
			kind: 'stage',
			stage: 'interview_scheduled'
		});
		const reported = (await deliveriesOf(subscription.id)).find((row) => row.eventType === 'hiring.reported');
		if (!reported) throw new Error('no report delivery');
		stub.received = [];
		await world.runJob(handler({ allowPrivateNetwork: false, huntflowApiUrl: base }), { delivery_id: reported.id });
		const [move] = stub.received;
		expect(move).toMatchObject({ method: 'PUT', path: '/accounts/7/applicants/42/vacancy' });
		const moved = JSON.parse(move?.body ?? '{}') as Record<string, unknown>;
		expect(moved).toEqual({ vacancy: 11, status: 102 });
		expect(shapeProblems('ChangeVacancyApplicantStatusRequest', moved)).toEqual([]);
		expect((await deliveriesOf(subscription.id)).every((row) => row.status === 'delivered')).toBe(true);
	});
});
