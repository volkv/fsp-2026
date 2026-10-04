// The Telegram channel of a user (docs/domain.md, section 3.7; contracts 8.2): a one-time link from the signed-in
// account, confirmation by the bot webhook, unlinking by the user, by the `/stop` command or when the bot is blocked.
// The chat id is kept encrypted with a keyed hash for lookup, and only while the channel is active.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { newSecret, secretsEqual, sha256Hex } from '$lib/server/auth/secrets';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Transaction } from '$lib/server/db';
import { candidates, notificationChannels, telegramLinkTokens } from '$lib/server/db/schema';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import { effectiveTelegramConsent } from './consent';

/** The link lives 10 minutes (domain 3.7). */
export const TELEGRAM_LINK_TTL_MS = 10 * 60_000;

export interface TelegramDeps {
	db: Database;
	crypto: FieldCrypto;
	now: () => Date;
	/** `null` — the channel is disabled (contracts 8.2). */
	telegram: { botUsername: string; webhookSecret: string } | null;
}

export interface TelegramRequestMeta {
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
}

export type UnlinkReason = 'user' | 'bot_stop' | 'bot_blocked' | 'no_consent' | 'replaced';

async function subjectCandidateOf(tx: Transaction, userId: string): Promise<string | undefined> {
	const [candidate] = await tx.select({ id: candidates.id }).from(candidates).where(eq(candidates.userId, userId));
	return candidate?.id;
}

/**
 * Ends an active Telegram channel in the caller's transaction: `unlinked`, or `blocked_by_user` when the bot was
 * blocked; the chat id and its hash are erased together with the status change. Notifications keep coming to the
 * interface and by email. Returns whether the channel was active.
 */
export async function unlinkTelegramChannel(
	tx: Transaction,
	channelId: string,
	change: { reason: UnlinkReason; now: Date; actor: AuditActor; meta: TelegramRequestMeta }
): Promise<boolean> {
	const [ended] = await tx
		.update(notificationChannels)
		.set({
			status: change.reason === 'bot_blocked' ? 'blocked_by_user' : 'unlinked',
			telegramChatIdEnc: null,
			telegramChatHmac: null,
			unlinkedAt: change.now
		})
		.where(
			and(
				eq(notificationChannels.id, channelId),
				eq(notificationChannels.kind, 'telegram'),
				eq(notificationChannels.status, 'active')
			)
		)
		.returning({ id: notificationChannels.id, userId: notificationChannels.userId });
	if (!ended) return false;
	const subjectCandidateId = await subjectCandidateOf(tx, ended.userId);
	await recordAuditEvent(tx, {
		action: 'notification.channel_unlinked',
		outcome: 'success',
		actor: change.actor,
		object: { type: 'notification_channel', id: ended.id },
		...(subjectCandidateId === undefined ? {} : { subjectCandidateId }),
		requestId: change.meta.requestId,
		ip: change.meta.ip ?? null,
		userAgent: change.meta.userAgent ?? null,
		details: { kind: 'telegram', reason: change.reason },
		occurredAt: change.now
	});
	return true;
}

export type TelegramLinkResult =
	{ ok: true; url: string; expiresAt: Date } | { ok: false; reason: 'channel_disabled' | 'no_consent' };

/**
 * Issues the one-time link `https://t.me/{bot}?start={token}` for the signed-in user. The token is 32 random bytes;
 * only its hash is stored. Without an effective `telegram_notifications` consent no link is issued.
 */
export async function createTelegramLink(deps: TelegramDeps, userId: string): Promise<TelegramLinkResult> {
	if (!deps.telegram) return { ok: false, reason: 'channel_disabled' };
	const now = deps.now();
	if ((await effectiveTelegramConsent(deps.db, userId, now)) === null) return { ok: false, reason: 'no_consent' };
	const token = newSecret();
	const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS);
	await deps.db.insert(telegramLinkTokens).values({ tokenHash: sha256Hex(token), userId, expiresAt, createdAt: now });
	return { ok: true, url: `https://t.me/${deps.telegram.botUsername}?start=${token}`, expiresAt };
}

/** The user turns the channel off in the settings. Returns whether a channel was active. */
export async function unlinkTelegram(deps: TelegramDeps, userId: string, meta: TelegramRequestMeta): Promise<boolean> {
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		const [channel] = await tx
			.select({ id: notificationChannels.id })
			.from(notificationChannels)
			.where(
				and(
					eq(notificationChannels.userId, userId),
					eq(notificationChannels.kind, 'telegram'),
					eq(notificationChannels.status, 'active')
				)
			);
		if (!channel) return false;
		return unlinkTelegramChannel(tx, channel.id, { reason: 'user', now, actor: { kind: 'user', userId }, meta });
	});
}

// --- Webhook ------------------------------------------------------------------------------------------------------

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const chat = z.looseObject({ id: z.int(), type: z.string() });
const update = z.looseObject({
	update_id: z.int(),
	message: z.looseObject({ chat, text: z.string().optional() }).optional(),
	my_chat_member: z.looseObject({ chat, new_chat_member: z.looseObject({ status: z.string() }) }).optional()
});

const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;
const STOP = /^\/stop(?:@\w+)?\s*$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Replies of the bot: no personal data, no names, only what happened and where to go. */
export const BOT_REPLIES = {
	linked: 'Готово: уведомления ФСП | Карьера будут приходить в этот чат. Отключить их можно командой /stop.',
	alreadyLinked: 'Этот чат уже получает уведомления ФСП | Карьера. Отключить их можно командой /stop.',
	invalidLink: 'Ссылка недействительна или устарела. Получите новую в настройках уведомлений на платформе.',
	noConsent:
		'Сначала дайте согласие на уведомления в Telegram в настройках уведомлений на платформе, затем получите новую ссылку.',
	chatTaken: 'Этот чат уже подключён к другой учётной записи. Отключите его там командой /stop и повторите.',
	privateOnly: 'Подключить уведомления можно только в личном чате с ботом.',
	stopped: 'Уведомления ФСП | Карьера в этот чат отключены. Подключить их снова можно в настройках на платформе.',
	notLinked: 'Этот чат не получает уведомлений. Подключить его можно в настройках уведомлений на платформе.',
	help: 'Этот бот присылает уведомления ФСП | Карьера. Подключить его можно в настройках уведомлений на платформе.'
} as const;

export interface TelegramWebhookRequest {
	headers: Headers;
	body: string;
	meta: TelegramRequestMeta;
}

/** An answer to the webhook that is a Bot API call: Telegram performs it, no outgoing request is needed. */
function reply(chatId: number, text: string, requestId: string): Response {
	return new Response(JSON.stringify({ method: 'sendMessage', chat_id: chatId, text }), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId }
	});
}

function accepted(requestId: string): Response {
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
}

async function activeChannelOfChat(tx: Transaction, chatHmac: string) {
	const [channel] = await tx
		.select({ id: notificationChannels.id, userId: notificationChannels.userId })
		.from(notificationChannels)
		.where(and(eq(notificationChannels.telegramChatHmac, chatHmac), eq(notificationChannels.status, 'active')))
		.for('update');
	return channel;
}

type LinkOutcome = keyof Pick<
	typeof BOT_REPLIES,
	'linked' | 'alreadyLinked' | 'invalidLink' | 'noConsent' | 'chatTaken'
>;

async function linkChat(deps: TelegramDeps, token: string, chatId: string, meta: TelegramRequestMeta) {
	const now = deps.now();
	const chatHmac = deps.crypto.lookupHmac('telegram_chat', chatId);
	return deps.db.transaction(async (tx): Promise<LinkOutcome> => {
		const [link] = await tx
			.select()
			.from(telegramLinkTokens)
			.where(eq(telegramLinkTokens.tokenHash, sha256Hex(token)))
			.for('update');
		if (!link) return 'invalidLink';
		const linked = await activeChannelOfChat(tx, chatHmac);
		// A repeated delivery of the same `/start` finds its own chat already linked.
		if (link.usedAt !== null) return linked?.userId === link.userId ? 'alreadyLinked' : 'invalidLink';
		if (link.expiresAt <= now) return 'invalidLink';
		if (linked && linked.userId !== link.userId) return 'chatTaken';
		const consentEventId = await effectiveTelegramConsent(tx, link.userId, now);
		if (consentEventId === null) return 'noConsent';
		await tx.update(telegramLinkTokens).set({ usedAt: now }).where(eq(telegramLinkTokens.id, link.id));
		if (linked) return 'alreadyLinked';

		const actor: AuditActor = { kind: 'user', userId: link.userId };
		const [previous] = await tx
			.select({ id: notificationChannels.id })
			.from(notificationChannels)
			.where(
				and(
					eq(notificationChannels.userId, link.userId),
					eq(notificationChannels.kind, 'telegram'),
					eq(notificationChannels.status, 'active')
				)
			)
			.for('update');
		if (previous) await unlinkTelegramChannel(tx, previous.id, { reason: 'replaced', now, actor, meta });

		const [channel] = await tx
			.insert(notificationChannels)
			.values({
				userId: link.userId,
				kind: 'telegram',
				telegramChatIdEnc: deps.crypto.encrypt(chatId, 'notification_channels.telegram_chat_id'),
				telegramChatHmac: chatHmac,
				status: 'active',
				consentEventId,
				linkedAt: now
			})
			.returning({ id: notificationChannels.id });
		if (!channel) throw new Error('telegram channel not inserted');
		const subjectCandidateId = await subjectCandidateOf(tx, link.userId);
		await recordAuditEvent(tx, {
			action: 'notification.channel_linked',
			outcome: 'success',
			actor,
			object: { type: 'notification_channel', id: channel.id },
			...(subjectCandidateId === undefined ? {} : { subjectCandidateId }),
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'telegram', consent_event_id: consentEventId },
			occurredAt: now
		});
		return 'linked';
	});
}

/** `/stop` from the chat or the bot blocked by the user: the channel of the chat ends. */
async function endChat(
	deps: TelegramDeps,
	chatId: string,
	reason: 'bot_stop' | 'bot_blocked',
	meta: TelegramRequestMeta
): Promise<boolean> {
	const now = deps.now();
	const chatHmac = deps.crypto.lookupHmac('telegram_chat', chatId);
	return deps.db.transaction(async (tx) => {
		const channel = await activeChannelOfChat(tx, chatHmac);
		if (!channel) return false;
		return unlinkTelegramChannel(tx, channel.id, {
			reason,
			now,
			actor: { kind: 'user', userId: channel.userId },
			meta
		});
	});
}

/**
 * `POST /api/v1/integrations/telegram/webhook` (contracts 8.2). The secret header is checked first (`401` otherwise;
 * `404` while the channel is disabled). A valid update is always answered `200`, so Telegram does not repeat it; the
 * bot's reply goes back in the answer itself.
 */
export async function receiveTelegramUpdate(deps: TelegramDeps, request: TelegramWebhookRequest): Promise<Response> {
	const { requestId } = request.meta;
	if (!deps.telegram) return errorResponse(new ApiError('not_found'), requestId);
	const secret = request.headers.get(TELEGRAM_SECRET_HEADER);
	if (secret === null || !secretsEqual(secret, deps.telegram.webhookSecret)) {
		await recordAuditEvent(deps.db, {
			action: 'telegram.webhook_rejected',
			outcome: 'denied',
			actor: { kind: 'anonymous' },
			requestId,
			ip: request.meta.ip ?? null,
			userAgent: request.meta.userAgent ?? null,
			details: { reason: secret === null ? 'secret_missing' : 'secret_mismatch' }
		});
		return errorResponse(new ApiError('unauthenticated', { message: 'Секрет вебхука не принят' }), requestId);
	}
	let json: unknown;
	try {
		json = JSON.parse(request.body);
	} catch (cause) {
		if (!(cause instanceof SyntaxError)) throw cause;
		return errorResponse(new ApiError('validation_failed', { cause }), requestId);
	}
	const parsed = update.safeParse(json);
	if (!parsed.success) return errorResponse(new ApiError('validation_failed'), requestId);
	const { message, my_chat_member: membership } = parsed.data;

	if (membership) {
		if (membership.chat.type === 'private' && membership.new_chat_member.status === 'kicked') {
			await endChat(deps, String(membership.chat.id), 'bot_blocked', request.meta);
		}
		return accepted(requestId);
	}
	if (message?.text === undefined) return accepted(requestId);
	const chatId = message.chat.id;
	const text = message.text.trim();
	const start = START.exec(text);
	if (start) {
		if (message.chat.type !== 'private') return reply(chatId, BOT_REPLIES.privateOnly, requestId);
		const token = start[1];
		if (token === undefined) return reply(chatId, BOT_REPLIES.help, requestId);
		if (!TOKEN.test(token)) return reply(chatId, BOT_REPLIES.invalidLink, requestId);
		const outcome = await linkChat(deps, token, String(chatId), request.meta);
		return reply(chatId, BOT_REPLIES[outcome], requestId);
	}
	if (STOP.test(text)) {
		const ended = await endChat(deps, String(chatId), 'bot_stop', request.meta);
		return reply(chatId, ended ? BOT_REPLIES.stopped : BOT_REPLIES.notLinked, requestId);
	}
	return message.chat.type === 'private' ? reply(chatId, BOT_REPLIES.help, requestId) : accepted(requestId);
}
