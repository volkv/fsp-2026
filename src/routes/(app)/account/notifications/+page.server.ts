import { fail, type RequestEvent } from '@sveltejs/kit';
import { formText, requireSession } from '$lib/server/auth/http';
import { grantTelegramConsent, revokeTelegramConsent, telegramConsentState } from '$lib/server/candidates/consents';
import { formFailure } from '$lib/server/http/page';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { NOTIFICATION_CATEGORIES } from '$lib/server/db/schema';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { telegramDeps } from '$lib/server/notifications/deps';
import { notificationSettings, setCategoryChannels } from '$lib/server/notifications/preferences';
import { createTelegramLink, unlinkTelegram } from '$lib/server/notifications/telegram';
import type { Actions, PageServerLoad } from './$types';

/** The subject of the request with the metadata a consent records. */
async function settingsRequest(event: RequestEvent) {
	const session = requireSession(event);
	const { actor, requestId } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	const meta: RequestMeta = {
		requestId,
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent'),
		sessionHash: actor.sessionHash
	};
	return { userId: session.userId, subject, meta };
}

/** Channels of every notification category and the Telegram channel with its consent and one-time link. */
export const load: PageServerLoad = async (event) => {
	const { userId, subject } = await settingsRequest(event);
	event.setHeaders({ 'cache-control': 'private, no-store' });
	const now = new Date();
	const candidate = subject.candidate?.status === 'active' ? subject.candidate : null;
	return {
		settings: await notificationSettings(db(), userId, { telegramAvailable: config().telegram !== null }),
		telegramConsent: candidate ? await telegramConsentState(db(), candidate.id, userId, now) : null
	};
};

const CHANNELS = ['email', 'telegram'] as const;

export const actions: Actions = {
	channels: async (event) => {
		const { userId } = await settingsRequest(event);
		const form = await event.request.formData();
		const now = new Date();
		for (const category of NOTIFICATION_CATEGORIES) {
			const chosen = CHANNELS.filter((channel) => form.getAll(`channel_${category}`).includes(channel));
			const result = await setCategoryChannels(db(), userId, category, chosen, now);
			if (!result.ok) {
				return fail(400, {
					problem: {
						message: 'Уведомления об учётной записи всегда приходят на почту',
						fields: {},
						code: result.reason
					}
				});
			}
		}
		return { channelsSaved: true };
	},

	telegramConsent: async (event) => {
		const { subject, meta } = await settingsRequest(event);
		const form = await event.request.formData();
		try {
			await grantTelegramConsent(db(), subject, meta, formText(form, 'documentId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { consentGiven: true };
	},

	telegramRevoke: async (event) => {
		const { subject, meta } = await settingsRequest(event);
		try {
			await revokeTelegramConsent(db(), subject, meta);
		} catch (cause) {
			return formFailure(cause);
		}
		return { consentRevoked: true };
	},

	telegramLink: async (event) => {
		const { userId } = await settingsRequest(event);
		const result = await createTelegramLink(telegramDeps(), userId);
		if (!result.ok) {
			return fail(409, {
				problem: {
					message:
						result.reason === 'channel_disabled'
							? 'Telegram на этой установке не подключён'
							: 'Сначала дайте согласие на уведомления в Telegram',
					fields: {},
					code: result.reason
				}
			});
		}
		return { telegramLink: { url: result.url, expiresAt: result.expiresAt } };
	},

	telegramUnlink: async (event) => {
		const { userId, meta } = await settingsRequest(event);
		await unlinkTelegram(telegramDeps(), userId, meta);
		return { telegramUnlinked: true };
	}
};
