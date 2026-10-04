// Outgoing webhook "achievements updated" (docs/contracts.md, section 1.5).
// X-FSP-Signature: sha256=<hex HMAC-SHA-256 of "{timestamp}.{rawBody}" with the subscription secret>.

import { createHmac, randomUUID } from 'node:crypto';

import type { WebhookEvent, WebhookEventType } from './types.ts';

export interface Subscription {
	id: string;
	url: string;
	events: WebhookEventType[];
	secret: string;
	createdAt: string;
}

export interface DeliveryAttempt {
	at: string;
	status: number | null;
	error: string | null;
}

export interface Delivery {
	id: string;
	subscriptionId: string;
	url: string;
	event: WebhookEvent;
	attempts: DeliveryAttempt[];
	delivered: boolean;
}

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/** Pauses between attempts; the receiver deduplicates by event id, so a retry after a lost answer is harmless. */
const RETRY_DELAYS_MS = [1000, 5000];
const ATTEMPT_TIMEOUT_MS = 5000;
const KEPT_DELIVERIES = 200;

export class WebhookDispatcher {
	readonly #subscriptions = new Map<string, Subscription>();
	readonly #deliveries: Delivery[] = [];
	readonly #log: (line: string) => void;

	constructor(log: (line: string) => void) {
		this.#log = log;
	}

	subscribe(input: { url: string; events: WebhookEventType[]; secret: string }): Subscription {
		const subscription: Subscription = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
		this.#subscriptions.set(subscription.id, subscription);
		return subscription;
	}

	unsubscribe(id: string): boolean {
		return this.#subscriptions.delete(id);
	}

	subscriptions(): Subscription[] {
		return [...this.#subscriptions.values()];
	}

	deliveries(): readonly Delivery[] {
		return this.#deliveries;
	}

	/** Sends the event to every matching subscription; resolves when the first attempt of each delivery finished. */
	async dispatch(
		input: Omit<WebhookEvent, 'eventId' | 'occurredAt'>
	): Promise<{ event: WebhookEvent; deliveries: Delivery[] }> {
		const event: WebhookEvent = { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...input };
		const targets = [...this.#subscriptions.values()].filter((s) => s.events.includes(event.type));
		const deliveries = targets.map((s) => this.#record(s, event));
		await Promise.all(
			deliveries.map(async (delivery, i) => {
				const subscription = targets[i];
				if (subscription) await this.#attempt(subscription, delivery, 0);
			})
		);
		return { event, deliveries };
	}

	#record(subscription: Subscription, event: WebhookEvent): Delivery {
		const delivery: Delivery = {
			id: randomUUID(),
			subscriptionId: subscription.id,
			url: subscription.url,
			event,
			attempts: [],
			delivered: false
		};
		this.#deliveries.unshift(delivery);
		this.#deliveries.length = Math.min(this.#deliveries.length, KEPT_DELIVERIES);
		return delivery;
	}

	async #attempt(subscription: Subscription, delivery: Delivery, index: number): Promise<void> {
		const rawBody = JSON.stringify(delivery.event);
		const timestamp = Math.floor(Date.now() / 1000);
		const attempt: DeliveryAttempt = { at: new Date().toISOString(), status: null, error: null };
		delivery.attempts.push(attempt);
		try {
			const response = await fetch(subscription.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-fsp-event-id': delivery.event.eventId,
					'x-fsp-timestamp': String(timestamp),
					'x-fsp-signature': signWebhook(subscription.secret, timestamp, rawBody)
				},
				body: rawBody,
				redirect: 'manual',
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
			});
			attempt.status = response.status;
			await response.body?.cancel();
			delivery.delivered = response.status >= 200 && response.status < 300;
		} catch (error) {
			attempt.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
		this.#log(
			`webhook ${delivery.event.type} ${delivery.event.eventId} -> ${subscription.url}: ${attempt.status ?? attempt.error ?? ''}`
		);
		const delay = RETRY_DELAYS_MS[index];
		// A rejection (4xx other than 429) will not change on retry; network errors and 5xx may.
		const retryable = attempt.status === null || attempt.status === 429 || attempt.status >= 500;
		if (!delivery.delivered && retryable && delay !== undefined) {
			setTimeout(() => void this.#attempt(subscription, delivery, index + 1), delay).unref();
		}
	}
}
