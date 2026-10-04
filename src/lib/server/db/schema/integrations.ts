// Inbound events of integrations, deduplicated by the source event id (contracts 1.5).
import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { id, sha256Check, ts } from './_columns';

/** Append-only; stores the event identity and type, never personal data of the payload. */
export const inboundEvents = pgTable(
	'inbound_events',
	{
		id: id(),
		source: text().notNull(),
		eventId: text().notNull(),
		eventType: text().notNull(),
		occurredAt: ts(),
		payloadSha256: text().notNull(),
		receivedAt: ts().notNull().defaultNow()
	},
	(t) => [
		unique('inbound_events_source_event').on(t.source, t.eventId),
		sha256Check('inbound_events', 'payload_sha256', t.payloadSha256),
		index('inbound_events_received').on(t.receivedAt)
	]
);
