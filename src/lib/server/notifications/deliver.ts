// `notification.deliver` (docs/domain.md, sections 3.7, 17.2): one delivery of one notification over one channel.
// Right before sending the job checks the recipient, the channel, the setting, for Telegram the consent, and the
// recipient's access to the object; each failed check is a `skipped` delivery with its reason. The outcome of a send is
// recorded at once, not with the job result: the message has left, so a lost lease must not send it again.
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import {
	notificationChannels,
	notificationDeliveries,
	notificationPreferences,
	notifications,
	users
} from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobContext, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import type { ChannelResult, NotificationChannels } from './channels';
import { effectiveTelegramConsent } from './consent';
import { notificationFacts } from './content';
import { unlinkTelegramChannel } from './telegram';
import { notificationLetter, telegramText, type NotificationLinks } from './templates';
import { isNotificationType } from './types';

export interface DeliverDeps {
	crypto: FieldCrypto;
	channels: NotificationChannels;
	/** Public origin of the application for the links in messages. */
	appOrigin: string;
	now: () => Date;
}

type SkipReason = NonNullable<(typeof notificationDeliveries.$inferSelect)['skipReason']>;

type DeliveryOutcome = 'sent' | 'failed' | `skipped_${SkipReason}` | 'already_done' | 'gone';

export function notificationLinks(appOrigin: string, notificationId: string): NotificationLinks {
	return { open: `${appOrigin}/notifications/${notificationId}`, settings: `${appOrigin}/account/notifications` };
}

const payloadSchema = z.record(z.string(), z.unknown());

async function loadDelivery(db: Database, notificationId: string, channelId: string) {
	const [row] = await db
		.select({
			deliveryId: notificationDeliveries.id,
			status: notificationDeliveries.status,
			notification: {
				id: notifications.id,
				userId: notifications.userId,
				type: notifications.type,
				category: notifications.category,
				objectType: notifications.objectType,
				objectId: notifications.objectId,
				payload: notifications.payload
			},
			channel: {
				id: notificationChannels.id,
				kind: notificationChannels.kind,
				status: notificationChannels.status,
				chatIdEnc: notificationChannels.telegramChatIdEnc
			},
			user: { status: users.status, emailEnc: users.emailEnc }
		})
		.from(notificationDeliveries)
		.innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
		.innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
		.innerJoin(users, eq(users.id, notifications.userId))
		.where(
			and(eq(notificationDeliveries.notificationId, notificationId), eq(notificationDeliveries.channelId, channelId))
		);
	return row;
}

const stillQueued = (deliveryId: string) =>
	and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, 'queued'));

async function skip(db: Executor, deliveryId: string, reason: SkipReason): Promise<DeliveryOutcome> {
	await db.update(notificationDeliveries).set({ status: 'skipped', skipReason: reason }).where(stillQueued(deliveryId));
	return `skipped_${reason}`;
}

/** Records a failed attempt; the delivery fails for good when `final`. */
async function recordAttemptFailure(
	db: Database,
	deliveryId: string,
	error: { code: string; message: string },
	final: boolean
): Promise<void> {
	await db
		.update(notificationDeliveries)
		.set({
			...(final ? { status: 'failed' as const } : {}),
			attempts: sql`${notificationDeliveries.attempts} + 1`,
			lastError: `${error.code}: ${error.message}`
		})
		.where(stillQueued(deliveryId));
}

async function optedOut(
	db: Database,
	userId: string,
	category: (typeof notifications.$inferSelect)['category'],
	kind: 'email' | 'telegram'
): Promise<boolean> {
	if (category === 'account') return false;
	const [preference] = await db
		.select({ channels: notificationPreferences.channels })
		.from(notificationPreferences)
		.where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, category)));
	return preference !== undefined && !preference.channels.includes(kind);
}

async function deliver(
	deps: DeliverDeps,
	context: JobContext<'notification.deliver'>
): Promise<{ deliveryId: string | null; outcome: DeliveryOutcome }> {
	const { job, db, signal, requestId } = context;
	const now = deps.now();
	const row = await loadDelivery(db, job.payload.notification_id, job.payload.channel_id);
	// The notification was erased with its recipient's account (domain 19): nothing is left to deliver.
	if (!row) return { deliveryId: null, outcome: 'gone' };
	const { deliveryId, notification, channel, user } = row;
	if (row.status !== 'queued') return { deliveryId, outcome: 'already_done' };
	const type = notification.type;
	if (!isNotificationType(type)) throw new Error(`notification ${notification.id} has unknown type ${type}`);

	if (user.status !== 'active' || user.emailEnc === null) {
		return { deliveryId, outcome: await skip(db, deliveryId, 'recipient_inactive') };
	}
	if (channel.status !== 'active') return { deliveryId, outcome: await skip(db, deliveryId, 'channel_inactive') };
	if (await optedOut(db, notification.userId, notification.category, channel.kind)) {
		return { deliveryId, outcome: await skip(db, deliveryId, 'opted_out') };
	}
	if (channel.kind === 'telegram' && (await effectiveTelegramConsent(db, notification.userId, now)) === null) {
		// Without the consent the chat id has no ground to be kept: the channel ends with the skip.
		const outcome = await db.transaction(async (tx) => {
			await unlinkTelegramChannel(tx, channel.id, {
				reason: 'no_consent',
				now,
				actor: { kind: 'system' },
				meta: { requestId }
			});
			return skip(tx, deliveryId, 'no_consent');
		});
		return { deliveryId, outcome };
	}
	const facts = await notificationFacts(db, deps.crypto, { ...notification, type });
	if (!facts) return { deliveryId, outcome: await skip(db, deliveryId, 'object_not_visible') };

	const links = notificationLinks(deps.appOrigin, notification.id);
	const payload = payloadSchema.parse(notification.payload);
	let result: ChannelResult;
	if (channel.kind === 'email') {
		const letter = notificationLetter(deps.crypto.decrypt(user.emailEnc, 'users.email'), type, facts, payload, links);
		result = await deps.channels.email.send({
			deliveryId,
			to: { email: letter.to },
			message: { subject: letter.subject, text: letter.text, html: letter.html, link: links.open },
			signal
		});
	} else {
		if (channel.chatIdEnc === null) throw new Error(`active telegram channel ${channel.id} has no chat id`);
		result = await deps.channels.telegram.send({
			deliveryId,
			to: { telegramChatId: deps.crypto.decrypt(channel.chatIdEnc, 'notification_channels.telegram_chat_id') },
			message: { text: telegramText(type), link: links.open },
			signal
		});
	}

	if (result.ok) {
		await db
			.update(notificationDeliveries)
			.set({
				status: 'sent',
				sentAt: now,
				attempts: sql`${notificationDeliveries.attempts} + 1`,
				providerMessageId: result.value.providerMessageId,
				lastError: null
			})
			.where(stillQueued(deliveryId));
		return { deliveryId, outcome: 'sent' };
	}
	const { error } = result;
	switch (error.code) {
		case 'disabled':
			return { deliveryId, outcome: await skip(db, deliveryId, 'channel_inactive') };
		case 'recipient_blocked':
			// The user blocked the bot: the delivery fails and the channel ends; this is the user's choice, not a fault.
			await db.transaction(async (tx) => {
				await tx
					.update(notificationDeliveries)
					.set({
						status: 'failed',
						attempts: sql`${notificationDeliveries.attempts} + 1`,
						lastError: `${error.code}: ${error.message}`
					})
					.where(stillQueued(deliveryId));
				await unlinkTelegramChannel(tx, channel.id, {
					reason: 'bot_blocked',
					now,
					actor: { kind: 'system' },
					meta: { requestId }
				});
			});
			return { deliveryId, outcome: 'failed' };
		case 'rejected':
			await recordAttemptFailure(db, deliveryId, error, true);
			throw new JobFailure(`channel_${error.code}`, error.message, { retryable: false });
		case 'unavailable':
		case 'rate_limited': {
			await recordAttemptFailure(db, deliveryId, error, job.attempt >= job.maxAttempts);
			const retryAfter = error.details?.retry_after;
			throw new JobFailure(`channel_${error.code}`, error.message, {
				retryable: true,
				...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {})
			});
		}
	}
}

export function createNotificationDeliverHandler(resolveDeps: () => DeliverDeps): JobHandler<'notification.deliver'> {
	return defineHandler({
		type: 'notification.deliver',
		concurrency: 8,
		async run(context): Promise<JobResult> {
			const { job, db, signal } = context;
			let delivered: Awaited<ReturnType<typeof deliver>>;
			try {
				delivered = await deliver(resolveDeps(), context);
			} catch (error) {
				// An unexpected failure on the last attempt: the job fails, and the delivery must not stay `queued`.
				if (!(error instanceof JobFailure) && !signal.aborted && job.attempt >= job.maxAttempts) {
					const row = await loadDelivery(db, job.payload.notification_id, job.payload.channel_id);
					const name = error instanceof Error ? error.name : 'NonErrorThrown';
					if (row) await recordAttemptFailure(db, row.deliveryId, { code: 'unexpected_error', message: name }, true);
				}
				throw error;
			}
			return {
				// The outcome is already recorded; the job result has nothing left to check or write.
				isCurrent: () => Promise.resolve(true),
				write: () => Promise.resolve(),
				describe: () => ({ delivery_id: delivered.deliveryId, outcome: delivered.outcome })
			};
		}
	});
}
