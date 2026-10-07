// Outgoing events of a company (docs/domain.md, section 5.7; contracts 12): a change that matters to the company's own
// systems emits an event in the transaction of the change. Every active subscription of the company asking for the
// type gets a delivery row and a `event.deliver` job — the change, its deliveries and their jobs commit together.
// The event carries identifiers and codes only: an ATS reads the data by the API with its own key, under the same
// rights and consents as the interface.
import { and, arrayContains, eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { COMPANY_EVENT_TYPES, eventDeliveries, eventSubscriptions } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { enqueueJob } from '$lib/server/jobs/queue';

export type CompanyEventType = (typeof COMPANY_EVENT_TYPES)[number];

export type EventData = Record<string, string | number | boolean | null | string[]>;

export interface CompanyEvent {
	companyId: string;
	type: CompanyEventType;
	/** The offer the event is about: the purge of the candidate's account removes the deliveries with it. */
	invitationId: string | null;
	data: EventData;
	occurredAt: Date;
}

/**
 * Emits the event to the subscriptions of the company in the caller's transaction; returns the event id, or `null` when
 * no subscription asks for it. The applications of candidates emit `application.received` through this function.
 */
export async function emitCompanyEvent(tx: Transaction, event: CompanyEvent): Promise<string | null> {
	const subscriptions = await tx
		.select({ id: eventSubscriptions.id })
		.from(eventSubscriptions)
		.where(
			and(
				eq(eventSubscriptions.companyId, event.companyId),
				eq(eventSubscriptions.status, 'active'),
				arrayContains(eventSubscriptions.events, [event.type])
			)
		);
	if (subscriptions.length === 0) return null;
	const eventId = uuidv7();
	for (const subscription of subscriptions) {
		await enqueueDelivery(tx, {
			subscriptionId: subscription.id,
			companyId: event.companyId,
			eventId,
			eventType: event.type,
			invitationId: event.invitationId,
			payload: event.data,
			occurredAt: event.occurredAt
		});
	}
	return eventId;
}

/** One delivery row and its job. */
export async function enqueueDelivery(
	tx: Transaction,
	delivery: Omit<typeof eventDeliveries.$inferInsert, 'status' | 'id'>
): Promise<string> {
	const [row] = await tx
		.insert(eventDeliveries)
		.values({ ...delivery, status: 'queued' })
		.returning({ id: eventDeliveries.id });
	if (!row) throw new Error('event delivery not inserted');
	await enqueueJob(
		tx,
		'event.deliver',
		{ delivery_id: row.id },
		{ inputVersion: row.id, createdBy: { kind: 'system' } }
	);
	return row.id;
}
