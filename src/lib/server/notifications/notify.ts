// Creating notifications (docs/domain.md, section 3.7; contracts 7). An event always creates the notification in the
// interface; delivery by channel is a `notification.deliver` job per notification and channel, decided and sent by
// the channel adapters. Payloads carry identifiers only: texts are built at delivery.
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import {
	notificationChannels,
	notificationDeliveries,
	notificationPreferences,
	notifications
} from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/queue';
import { NOTIFICATION_TYPES, type NotificationType } from './types';

export interface NotificationInput {
	userId: string;
	type: NotificationType;
	objectId: string;
	/**
	 * Stage of a repeated event of one object (`{type}:{object_id}[:{stage}]`): a terms version, a reminder slot, a
	 * recipient side. A repeated event of the same stage creates nothing.
	 */
	stage?: string;
	/** Identifiers and codes only. */
	payload: Record<string, string | number | boolean | null>;
}

/**
 * Creates the notification in the caller's transaction and queues one delivery per active channel of the recipient;
 * a channel the recipient switched off for the category is recorded as `skipped (opted_out)`. Without a preference
 * row every active channel is used. Returns `false` when the same stage was already notified.
 */
export async function notify(tx: Transaction, input: NotificationInput): Promise<boolean> {
	const { category, objectType } = NOTIFICATION_TYPES[input.type];
	const dedupKey = [input.type, input.objectId, ...(input.stage === undefined ? [] : [input.stage])].join(':');
	const [created] = await tx
		.insert(notifications)
		.values({
			userId: input.userId,
			type: input.type,
			category,
			objectType,
			objectId: input.objectId,
			dedupKey,
			payload: input.payload
		})
		.onConflictDoNothing({ target: notifications.dedupKey })
		.returning({ id: notifications.id });
	if (!created) return false;

	const channels = await tx
		.select({ id: notificationChannels.id, kind: notificationChannels.kind })
		.from(notificationChannels)
		.where(and(eq(notificationChannels.userId, input.userId), eq(notificationChannels.status, 'active')));
	if (channels.length === 0) return true;
	const [preference] = await tx
		.select({ channels: notificationPreferences.channels })
		.from(notificationPreferences)
		.where(and(eq(notificationPreferences.userId, input.userId), eq(notificationPreferences.category, category)));
	for (const channel of channels) {
		const optedOut = preference !== undefined && !preference.channels.includes(channel.kind);
		const [delivery] = await tx
			.insert(notificationDeliveries)
			.values({
				notificationId: created.id,
				channelId: channel.id,
				status: optedOut ? 'skipped' : 'queued',
				skipReason: optedOut ? 'opted_out' : null
			})
			.returning({ id: notificationDeliveries.id });
		if (!delivery) throw new Error(`delivery of notification ${created.id} not inserted`);
		if (!optedOut) {
			await enqueueJob(
				tx,
				'notification.deliver',
				{ notification_id: created.id, channel_id: channel.id },
				{ inputVersion: delivery.id, createdBy: { kind: 'system' } }
			);
		}
	}
	return true;
}

/**
 * Opens the email channel of a user whose address is confirmed; called in the transaction that confirms it. The
 * address itself is read from `users.email_enc` at delivery, so the channel only records that mail may be sent.
 * Idempotent: an active email channel is kept.
 */
export async function ensureEmailChannel(tx: Transaction, userId: string, now: Date): Promise<void> {
	await tx
		.insert(notificationChannels)
		.values({ userId, kind: 'email', status: 'active', linkedAt: now })
		.onConflictDoNothing({
			target: [notificationChannels.userId, notificationChannels.kind],
			where: sql`status = 'active'`
		});
}
