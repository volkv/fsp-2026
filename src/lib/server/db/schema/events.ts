// Outgoing events of a company to its own systems (docs/domain.md, section 5.7; contracts 12): subscriptions — a signed
// webhook or the Huntflow adapter — and the journal of deliveries. Events carry identifiers only.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, subsetOf, timestamps, ts } from './_columns';
import { companies, companyMembers } from './companies';
import { invitations } from './hiring';

/** Events a subscription may ask for: the life of offers, applications and vacancies of the company. */
export const COMPANY_EVENT_TYPES = [
	'invitation.sent',
	'invitation.viewed',
	'invitation.accepted',
	'invitation.declined',
	'invitation.expired',
	'invitation.withdrawn',
	'contacts.disclosed',
	'hiring.reported',
	'application.received',
	'application.status_changed',
	'vacancy.published',
	'vacancy.closed'
] as const;
/** A delivery is one of the events above or the check the owner asks for. */
export const DELIVERY_EVENT_TYPES = [...COMPANY_EVENT_TYPES, 'ping'] as const;

export const SUBSCRIPTION_TARGETS = ['webhook', 'huntflow'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'paused'] as const;
export const DELIVERY_STATUSES = ['queued', 'delivered', 'failed', 'skipped'] as const;

export const eventSubscriptions = pgTable(
	'event_subscriptions',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		target: text({ enum: SUBSCRIPTION_TARGETS }).notNull(),
		name: text().notNull(),
		/**
		 * The address of a webhook — `https://` outside private networks by the rule of the application, which also checks
		 * the resolved address when sending; `null` for the Huntflow adapter, whose address the platform configures.
		 */
		url: text(),
		events: text().array().notNull(),
		status: text({ enum: SUBSCRIPTION_STATUSES }).notNull(),
		/** A webhook's signing secret, or the Huntflow API token; encrypted (`crypto/fields.ts`). */
		secretEnc: bytea().notNull(),
		/** The last characters of the secret, to recognise it in the interface. */
		secretHint: text().notNull(),
		/** The secret before the last rotation: a webhook is signed with both until `previous_secret_until`. */
		previousSecretEnc: bytea(),
		previousSecretUntil: ts(),
		/** Huntflow: `{account_id, vacancy_id, statuses}`; `null` for a webhook. */
		settings: jsonb(),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		...timestamps()
	},
	(t) => [
		enumCheck('event_subscriptions', 'target', t.target, SUBSCRIPTION_TARGETS),
		enumCheck('event_subscriptions', 'status', t.status, SUBSCRIPTION_STATUSES),
		check('event_subscriptions_name_length', sql`char_length(${t.name}) between 1 and 100`),
		check(
			'event_subscriptions_target_fields',
			sql`case ${t.target}
				when 'webhook' then ${t.url} is not null and ${t.settings} is null
				else ${t.url} is null and jsonb_typeof(${t.settings}) = 'object' end`
		),
		check('event_subscriptions_events_values', subsetOf(t.events, COMPANY_EVENT_TYPES)),
		check('event_subscriptions_events_present', sql`cardinality(${t.events}) >= 1`),
		check(
			'event_subscriptions_previous_secret',
			sql`(${t.previousSecretEnc} is null) = (${t.previousSecretUntil} is null)`
		),
		index('event_subscriptions_company').on(t.companyId)
	]
);

export const eventDeliveries = pgTable(
	'event_deliveries',
	{
		id: id(),
		subscriptionId: uuid()
			.notNull()
			.references(() => eventSubscriptions.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		/** The event: the same id in every subscription it was delivered to (`X-Event-Id`). */
		eventId: uuid().notNull(),
		eventType: text({ enum: DELIVERY_EVENT_TYPES }).notNull(),
		/** The offer the event is about: the purge of the candidate's account removes its deliveries. */
		invitationId: uuid().references(() => invitations.id),
		/** `data` of the event body: identifiers and codes only. */
		payload: jsonb().notNull(),
		occurredAt: ts().notNull(),
		status: text({ enum: DELIVERY_STATUSES }).notNull(),
		attempts: integer().notNull().default(0),
		/** HTTP status of the last answer; `null` — no answer (network failure, refused address). */
		lastStatus: integer(),
		/** Code and short reason of the last failure, without personal data. */
		lastError: text(),
		/** When the last attempt left; `null` — not attempted yet. */
		lastAttemptAt: ts(),
		deliveredAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('event_deliveries', 'event_type', t.eventType, DELIVERY_EVENT_TYPES),
		enumCheck('event_deliveries', 'status', t.status, DELIVERY_STATUSES),
		check('event_deliveries_attempts', sql`${t.attempts} >= 0`),
		check('event_deliveries_delivered_at', sql`(${t.status} = 'delivered') = (${t.deliveredAt} is not null)`),
		unique('event_deliveries_subscription_event').on(t.subscriptionId, t.eventId),
		index('event_deliveries_subscription').on(t.subscriptionId, t.createdAt),
		index('event_deliveries_invitation')
			.on(t.invitationId)
			.where(sql`${t.invitationId} is not null`)
	]
);

/** The record an ATS adapter created for an offer (the Huntflow applicant), so later events update the same one. */
export const atsLinks = pgTable(
	'ats_links',
	{
		id: id(),
		subscriptionId: uuid()
			.notNull()
			.references(() => eventSubscriptions.id),
		invitationId: uuid()
			.notNull()
			.references(() => invitations.id),
		externalId: text().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		unique('ats_links_subscription_invitation').on(t.subscriptionId, t.invitationId),
		index('ats_links_invitation').on(t.invitationId)
	]
);
