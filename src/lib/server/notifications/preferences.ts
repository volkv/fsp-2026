// Notification settings of a user (docs/domain.md, section 3.7): which channels each category goes to, and the state
// of the channels. Without a row a category goes to every active channel; `account` always goes to email.
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { NOTIFICATION_CATEGORIES, notificationChannels, notificationPreferences } from '$lib/server/db/schema';
import type { ChannelKind } from './channels';
import type { NotificationCategory } from './types';

const CHANNEL_KINDS = ['email', 'telegram'] as const satisfies readonly ChannelKind[];

export interface CategorySetting {
	category: NotificationCategory;
	channels: ChannelKind[];
	/** Channels the category cannot be switched off from. */
	required: ChannelKind[];
}

export interface NotificationSettings {
	channels: {
		email: 'active' | 'not_linked';
		telegram: 'active' | 'not_linked' | 'unlinked' | 'blocked_by_user';
		/** Whether Telegram can be linked on this installation (contracts 7.2). */
		telegramAvailable: boolean;
	};
	categories: CategorySetting[];
}

const requiredOf = (category: NotificationCategory): ChannelKind[] => (category === 'account' ? ['email'] : []);

/** The latest channel of the kind: an active one, otherwise how the last one ended. */
async function channelState(db: Database, userId: string, kind: ChannelKind) {
	const [channel] = await db
		.select({ status: notificationChannels.status })
		.from(notificationChannels)
		.where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, kind)))
		.orderBy(desc(notificationChannels.linkedAt), desc(notificationChannels.id))
		.limit(1);
	return channel?.status ?? 'not_linked';
}

export async function notificationSettings(
	db: Database,
	userId: string,
	options: { telegramAvailable: boolean }
): Promise<NotificationSettings> {
	const rows = await db
		.select({ category: notificationPreferences.category, channels: notificationPreferences.channels })
		.from(notificationPreferences)
		.where(eq(notificationPreferences.userId, userId));
	const chosen = new Map(rows.map((row) => [row.category, row.channels]));
	const email = await channelState(db, userId, 'email');
	return {
		channels: {
			email: email === 'active' ? 'active' : 'not_linked',
			telegram: await channelState(db, userId, 'telegram'),
			telegramAvailable: options.telegramAvailable
		},
		categories: NOTIFICATION_CATEGORIES.map((category) => ({
			category,
			channels: CHANNEL_KINDS.filter((kind) => chosen.get(category)?.includes(kind) ?? true),
			required: requiredOf(category)
		}))
	};
}

export type PreferenceResult = { ok: true } | { ok: false; reason: 'channel_required' };

/**
 * Sets the channels of one category. A change applies to deliveries not yet sent as well: the delivery job reads the
 * setting when it sends.
 */
export async function setCategoryChannels(
	db: Database,
	userId: string,
	category: NotificationCategory,
	channels: readonly ChannelKind[],
	now: Date
): Promise<PreferenceResult> {
	if (requiredOf(category).some((kind) => !channels.includes(kind))) return { ok: false, reason: 'channel_required' };
	const chosen = CHANNEL_KINDS.filter((kind) => channels.includes(kind));
	await db
		.insert(notificationPreferences)
		.values({ userId, category, channels: chosen, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: [notificationPreferences.userId, notificationPreferences.category],
			set: { channels: chosen, updatedAt: now }
		});
	return { ok: true };
}
