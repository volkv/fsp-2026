// Notifications, delivery channels and per-channel deliveries (domain 3.7).
import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, sha256Check, subsetOf, timestamps, ts } from './_columns';
import { consentEvents } from './consent';
import { users } from './identity';

const CHANNEL_KINDS = ['email', 'telegram'] as const;
const CHANNEL_STATUSES = ['active', 'unlinked', 'blocked_by_user'] as const;

export const notificationChannels = pgTable(
	'notification_channels',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		kind: text({ enum: CHANNEL_KINDS }).notNull(),
		telegramChatIdEnc: bytea(),
		telegramChatHmac: text(),
		status: text({ enum: CHANNEL_STATUSES }).notNull(),
		consentEventId: uuid().references(() => consentEvents.id),
		linkedAt: ts().notNull(),
		unlinkedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('notification_channels', 'kind', t.kind, CHANNEL_KINDS),
		enumCheck('notification_channels', 'status', t.status, CHANNEL_STATUSES),
		// The chat id is kept only while the channel is active and is erased with unlinking (domain 3.7).
		check(
			'notification_channels_telegram_fields',
			sql`case when ${t.kind} = 'telegram' and ${t.status} = 'active'
				then ${t.telegramChatIdEnc} is not null and ${t.telegramChatHmac} is not null and ${t.consentEventId} is not null
				else ${t.telegramChatIdEnc} is null and ${t.telegramChatHmac} is null end`
		),
		check('notification_channels_email_consent', sql`${t.kind} = 'telegram' or ${t.consentEventId} is null`),
		check('notification_channels_unlinked_at', sql`(${t.status} = 'active') = (${t.unlinkedAt} is null)`),
		uniqueIndex('notification_channels_active_chat')
			.on(t.telegramChatHmac)
			.where(sql`${t.status} = 'active'`),
		uniqueIndex('notification_channels_active_kind')
			.on(t.userId, t.kind)
			.where(sql`${t.status} = 'active'`)
	]
);

export const telegramLinkTokens = pgTable(
	'telegram_link_tokens',
	{
		id: id(),
		tokenHash: text().notNull().unique('telegram_link_tokens_token_hash'),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: ts().notNull(),
		usedAt: ts(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [sha256Check('telegram_link_tokens', 'token_hash', t.tokenHash)]
);

export const NOTIFICATION_CATEGORIES = ['invitations', 'hiring', 'deadlines', 'objections', 'account'] as const;

export const notificationPreferences = pgTable(
	'notification_preferences',
	{
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		category: text({ enum: NOTIFICATION_CATEGORIES }).notNull(),
		channels: text().array().notNull(),
		...timestamps()
	},
	(t) => [
		primaryKey({ name: 'notification_preferences_pk', columns: [t.userId, t.category] }),
		enumCheck('notification_preferences', 'category', t.category, NOTIFICATION_CATEGORIES),
		check('notification_preferences_channels', subsetOf(t.channels, CHANNEL_KINDS)),
		// Account notifications always go to email (domain 3.7).
		check(
			'notification_preferences_account_email',
			sql`${t.category} <> 'account' or ${t.channels} @> array['email']::text[]`
		)
	]
);

export const notifications = pgTable(
	'notifications',
	{
		id: id(),
		userId: uuid()
			.notNull()
			.references(() => users.id),
		type: text().notNull(),
		category: text({ enum: NOTIFICATION_CATEGORIES }).notNull(),
		objectType: text().notNull(),
		objectId: uuid().notNull(),
		dedupKey: text().notNull().unique('notifications_dedup_key'),
		payload: jsonb().notNull(),
		readAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('notifications', 'category', t.category, NOTIFICATION_CATEGORIES),
		index('notifications_user_unread')
			.on(t.userId, t.createdAt)
			.where(sql`${t.readAt} is null`)
	]
);

const DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
const DELIVERY_SKIP_REASONS = [
	'channel_inactive',
	'no_consent',
	'opted_out',
	'recipient_inactive',
	'object_not_visible'
] as const;

export const notificationDeliveries = pgTable(
	'notification_deliveries',
	{
		id: id(),
		notificationId: uuid()
			.notNull()
			.references(() => notifications.id, { onDelete: 'cascade' }),
		channelId: uuid()
			.notNull()
			.references(() => notificationChannels.id),
		status: text({ enum: DELIVERY_STATUSES }).notNull(),
		skipReason: text({ enum: DELIVERY_SKIP_REASONS }),
		attempts: integer().notNull().default(0),
		providerMessageId: text(),
		sentAt: ts(),
		lastError: text(),
		...timestamps()
	},
	(t) => [
		enumCheck('notification_deliveries', 'status', t.status, DELIVERY_STATUSES),
		enumCheck('notification_deliveries', 'skip_reason', t.skipReason, DELIVERY_SKIP_REASONS),
		check('notification_deliveries_skip_reason', sql`(${t.status} = 'skipped') = (${t.skipReason} is not null)`),
		check('notification_deliveries_sent', sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`),
		check('notification_deliveries_attempts', sql`${t.attempts} >= 0`),
		unique('notification_deliveries_notification_channel').on(t.notificationId, t.channelId)
	]
);
