// `event.deliver` (docs/domain.md, section 5.7; contracts 12.2): one delivery of an event to one subscription. A webhook
// gets the signed body; the Huntflow adapter turns the event into its API calls. A `2xx` delivers; a network failure,
// a timeout, `429` and `5xx` go back to the queue on the schedule below until the attempts run out; any other answer
// and a refused private address fail at once. Each attempt is recorded on the delivery at once — the request has
// left, a lost lease must not hide it — so the owner reads the journal of deliveries as it happens.
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { companyAdmission } from '$lib/server/access/permissions';
import { config } from '$lib/server/config';
import { fieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import { companies, eventDeliveries, eventSubscriptions, invitations } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { postJson, type PostResult } from './http';
import { deliverToHuntflow, huntflowSettingsSchema } from './huntflow';

/** Pauses before the attempts after the first one, in seconds: a receiver down for hours still gets the event. */
export const RETRY_SECONDS = [60, 300, 900, 3_600, 7_200, 14_400, 21_600] as const;

const TIMEOUT_MS = 10_000;

export interface EventDeliverDeps {
	crypto: FieldCrypto;
	/** Base of the Huntflow API; `null` — the adapter is off and its deliveries are skipped. */
	huntflowApiUrl: string | null;
	/** Webhooks to private networks: tests and a local stand only. */
	allowPrivateNetwork: boolean;
	now: () => Date;
}

/** `sha256=<hex>` of `{timestamp}.{body}`: the value of `X-Signature`, one per secret in force. */
export function signature(secret: string, timestamp: number, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

/** The body a webhook receives. */
export function webhookBody(delivery: {
	eventId: string;
	eventType: string;
	companyId: string;
	occurredAt: Date;
	payload: unknown;
}): string {
	return JSON.stringify({
		id: delivery.eventId,
		type: delivery.eventType,
		occurred_at: delivery.occurredAt.toISOString(),
		company_id: delivery.companyId,
		data: delivery.payload
	});
}

type Outcome = 'delivered' | 'failed' | 'retry' | `skipped_${string}` | 'gone' | 'already_done';

function failureText(result: PostResult): { status: number | null; error: string } {
	return result.kind === 'answered'
		? { status: result.status, error: `http_${result.status}` }
		: { status: null, error: `${result.code}: ${result.message}` };
}

const retryable = (result: PostResult) =>
	result.kind === 'answered' ? result.status === 429 || result.status >= 500 : result.code !== 'blocked_address';

async function load(db: Database, deliveryId: string) {
	const [row] = await db
		.select({ delivery: eventDeliveries, subscription: eventSubscriptions, companyStatus: companies.status })
		.from(eventDeliveries)
		.innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
		.innerJoin(companies, eq(companies.id, eventDeliveries.companyId))
		.where(eq(eventDeliveries.id, deliveryId));
	return row;
}

async function deliver(
	deps: EventDeliverDeps,
	db: Database,
	deliveryId: string,
	attempt: number,
	maxAttempts: number,
	signal: AbortSignal
): Promise<Outcome> {
	const row = await load(db, deliveryId);
	// The subscription was deleted, or the offer's candidate purged: nothing is left to deliver.
	if (!row) return 'gone';
	const { delivery, subscription } = row;
	if (delivery.status !== 'queued') return 'already_done';
	const skip = async (reason: string): Promise<Outcome> => {
		await db
			.update(eventDeliveries)
			.set({ status: 'skipped', lastError: reason })
			.where(eq(eventDeliveries.id, delivery.id));
		return `skipped_${reason}`;
	};
	// A closed company sends nothing: the admission policy is asked at the moment of sending (domain 5.1).
	if (!companyAdmission(row.companyStatus).admitted) return skip('company_not_admitted');
	if (subscription.status !== 'active') return skip('subscription_paused');
	const now = deps.now();
	const secret = deps.crypto.decrypt(subscription.secretEnc, 'event_subscriptions.secret');

	let result: PostResult;
	if (subscription.target === 'webhook') {
		if (subscription.url === null) throw new Error(`webhook subscription ${subscription.id} has no address`);
		const body = webhookBody({ ...delivery, payload: await withPseudonym(db, deps.crypto, delivery) });
		const timestamp = Math.floor(now.getTime() / 1000);
		const signatures = [signature(secret, timestamp, body)];
		if (
			subscription.previousSecretEnc !== null &&
			subscription.previousSecretUntil !== null &&
			subscription.previousSecretUntil > now
		) {
			const previous = deps.crypto.decrypt(subscription.previousSecretEnc, 'event_subscriptions.previous_secret');
			signatures.push(signature(previous, timestamp, body));
		}
		result = await postJson(subscription.url, body, {
			headers: {
				'x-event-id': delivery.eventId,
				'x-event-type': delivery.eventType,
				'x-timestamp': String(timestamp),
				'x-signature': signatures.join(', '),
				'user-agent': 'fsp-career-webhooks/1'
			},
			timeoutMs: TIMEOUT_MS,
			signal,
			allowPrivateNetwork: deps.allowPrivateNetwork
		});
		if (result.kind === 'answered' && result.status >= 200 && result.status < 300) {
			await markDelivered(db, delivery.id, result.status, now);
			return 'delivered';
		}
	} else {
		if (deps.huntflowApiUrl === null) return skip('huntflow_disabled');
		const outcome = await deliverToHuntflow(
			{ db, crypto: deps.crypto, apiUrl: deps.huntflowApiUrl, signal, timeoutMs: TIMEOUT_MS, now: deps.now },
			{
				subscriptionId: subscription.id,
				companyId: subscription.companyId,
				createdByMemberId: subscription.createdByMemberId,
				token: secret,
				settings: huntflowSettingsSchema.parse(subscription.settings),
				eventType: delivery.eventType,
				invitationId: delivery.invitationId,
				payload: delivery.payload as Record<string, unknown>
			}
		);
		if (outcome.kind === 'skipped') return skip(outcome.reason);
		if (outcome.kind === 'done') {
			await markDelivered(db, delivery.id, outcome.status, now);
			return 'delivered';
		}
		result = outcome.result;
	}

	const failed = failureText(result);
	const again = retryable(result) && attempt < maxAttempts;
	await db
		.update(eventDeliveries)
		.set({
			...(again ? {} : { status: 'failed' as const }),
			attempts: sql`${eventDeliveries.attempts} + 1`,
			lastStatus: failed.status,
			lastError: failed.error
		})
		.where(eq(eventDeliveries.id, delivery.id));
	if (!again) return 'failed';
	throw new JobFailure('delivery_failed', failed.error, {
		retryable: true,
		retryAfterSeconds: RETRY_SECONDS[Math.min(attempt - 1, RETRY_SECONDS.length - 1)] ?? 60
	});
}

/**
 * The data of the event with the candidate as the company knows them — the pseudonym for this company (domain 14),
 * derived when sent, so the stored delivery never holds it.
 */
async function withPseudonym(
	db: Database,
	crypto: FieldCrypto,
	delivery: { invitationId: string | null; companyId: string; payload: unknown }
): Promise<unknown> {
	if (delivery.invitationId === null) return delivery.payload;
	const [invitation] = await db
		.select({ candidateId: invitations.candidateId })
		.from(invitations)
		.where(eq(invitations.id, delivery.invitationId));
	if (!invitation) throw new Error(`invitation ${delivery.invitationId} of a delivery does not exist`);
	return {
		...(delivery.payload as Record<string, unknown>),
		candidate_pseudonym: crypto.pseudonym(invitation.candidateId, delivery.companyId)
	};
}

async function markDelivered(db: Database, deliveryId: string, status: number, at: Date): Promise<void> {
	await db
		.update(eventDeliveries)
		.set({
			status: 'delivered',
			attempts: sql`${eventDeliveries.attempts} + 1`,
			lastStatus: status,
			lastError: null,
			deliveredAt: at
		})
		.where(eq(eventDeliveries.id, deliveryId));
}

export function createEventDeliverHandler(resolveDeps: () => EventDeliverDeps): JobHandler<'event.deliver'> {
	return defineHandler({
		type: 'event.deliver',
		concurrency: 8,
		async run({ job, db, signal }): Promise<JobResult> {
			const outcome = await deliver(resolveDeps(), db, job.payload.delivery_id, job.attempt, job.maxAttempts, signal);
			return {
				// The outcome is recorded on the delivery already.
				isCurrent: () => Promise.resolve(true),
				write: () => Promise.resolve(),
				describe: () => ({ delivery_id: job.payload.delivery_id, outcome })
			};
		}
	});
}

/** The handler over the configured crypto and Huntflow address. */
export const eventDeliver = createEventDeliverHandler(() => ({
	crypto: fieldCrypto(),
	huntflowApiUrl: config().huntflowApiUrl,
	allowPrivateNetwork: false,
	now: () => new Date()
}));
