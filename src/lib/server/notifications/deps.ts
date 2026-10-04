// Configured dependencies of the notification channels: routes and the worker take these, tests pass their own.
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { mailer } from '$lib/server/mail/mailer';
import { createEmailChannel, createTelegramChannel, TELEGRAM_API_BASE, type NotificationChannels } from './channels';
import { createNotificationDeliverHandler, type DeliverDeps } from './deliver';
import type { TelegramDeps } from './telegram';

let channels: NotificationChannels | undefined;

function configuredChannels(): NotificationChannels {
	if (!channels) {
		const telegram = config().telegram;
		channels = {
			email: createEmailChannel(mailer()),
			telegram: createTelegramChannel(telegram ? { botToken: telegram.botToken, apiBase: TELEGRAM_API_BASE } : null)
		};
	}
	return channels;
}

function deliverDeps(): DeliverDeps {
	return {
		crypto: fieldCrypto(),
		channels: configuredChannels(),
		appOrigin: config().appOrigin,
		now: () => new Date()
	};
}

export function telegramDeps(): TelegramDeps {
	const telegram = config().telegram;
	return {
		db: db(),
		crypto: fieldCrypto(),
		now: () => new Date(),
		telegram: telegram ? { botUsername: telegram.botUsername, webhookSecret: telegram.webhookSecret } : null
	};
}

/** The handler of `notification.deliver` over the configured channels, resolved when a job runs. */
export const notificationDeliver = createNotificationDeliverHandler(deliverDeps);
