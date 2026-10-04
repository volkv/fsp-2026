// Linking Telegram, the bot webhook and the notification settings (docs/domain.md 3.7, contracts 8.2).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '$lib/server/auth/secrets';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { auditEvents, consentEvents, notificationChannels, telegramLinkTokens } from '$lib/server/db/schema';
import { ensureEmailChannel } from '$lib/server/notifications/notify';
import { notificationSettings, setCategoryChannels } from '$lib/server/notifications/preferences';
import {
	BOT_REPLIES,
	createTelegramLink,
	receiveTelegramUpdate,
	TELEGRAM_LINK_TTL_MS,
	TELEGRAM_SECRET_HEADER,
	unlinkTelegram,
	type TelegramDeps
} from '$lib/server/notifications/telegram';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createPublishedDocument, createUser } from '../helpers/factories';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 4)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});
const SECRET = 'webhook-secret-0123456789';
const EPOCH = new Date(Date.now() - 30 * 86_400_000);

let database: TestDatabase;
let deps: TelegramDeps;
let clock = new Date();
let telegramDocumentId: string;
let updateSeq = 1;
let chatSeq = 500_000_000;

beforeAll(async () => {
	database = await createTestDatabase();
	deps = {
		db: database.db,
		crypto,
		now: () => clock,
		telegram: { botUsername: 'fsp_career_bot', webhookSecret: SECRET }
	};
	telegramDocumentId = (await createPublishedDocument(database.db, 'telegram_notifications', { publishedAt: EPOCH }))
		.id;
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function consent(candidateId: string, userId: string, action: 'grant' | 'revoke', at: Date) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind: 'telegram_notifications',
		documentId: telegramDocumentId,
		action,
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: at
	});
}

async function candidateUser(options: { consent?: boolean } = {}) {
	const candidate = await createCandidate(database.db);
	if (options.consent ?? true) await consent(candidate.id, candidate.userId, 'grant', EPOCH);
	return { userId: candidate.userId, candidateId: candidate.id };
}

function tokenOf(url: string): string {
	const match = /^https:\/\/t\.me\/fsp_career_bot\?start=([A-Za-z0-9_-]{43})$/.exec(url);
	if (!match?.[1]) throw new Error(`unexpected link ${url}`);
	return match[1];
}

async function linkToken(userId: string): Promise<string> {
	const link = await createTelegramLink(deps, userId);
	if (!link.ok) throw new Error(`link refused: ${link.reason}`);
	return tokenOf(link.url);
}

const newChat = () => ++chatSeq;

function webhook(update: Record<string, unknown>, secret: string | null = SECRET, over: Partial<TelegramDeps> = {}) {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (secret !== null) headers.set(TELEGRAM_SECRET_HEADER, secret);
	return receiveTelegramUpdate(
		{ ...deps, ...over },
		{ headers, body: JSON.stringify({ update_id: updateSeq++, ...update }), meta: { requestId: 'req-test' } }
	);
}

const message = (chatId: number, text: string, type = 'private') => ({
	message: { message_id: 1, date: 0, chat: { id: chatId, type }, from: { id: chatId, first_name: 'Имя' }, text }
});

async function replyOf(response: Response): Promise<{ method: string; chat_id: number; text: string }> {
	expect(response.status).toBe(200);
	return (await response.json()) as { method: string; chat_id: number; text: string };
}

async function channelsOf(userId: string) {
	return database.db
		.select()
		.from(notificationChannels)
		.where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, 'telegram')));
}

async function activeChannel(userId: string) {
	return (await channelsOf(userId)).find((c) => c.status === 'active');
}

// --- Link -----------------------------------------------------------------------------------------------------------

describe('link', () => {
	it('issues a one-time deeplink with a stored hash only', async () => {
		const user = await candidateUser();
		const link = await createTelegramLink(deps, user.userId);
		expect(link.ok).toBe(true);
		if (!link.ok) return;
		const token = tokenOf(link.url);
		expect(link.expiresAt.getTime() - clock.getTime()).toBe(TELEGRAM_LINK_TTL_MS);
		const [row] = await database.db.select().from(telegramLinkTokens).where(eq(telegramLinkTokens.userId, user.userId));
		expect(row?.tokenHash).toBe(sha256Hex(token));
		expect(row?.tokenHash).not.toContain(token);
	});

	it('refuses without the consent and when the bot is not configured', async () => {
		const user = await candidateUser({ consent: false });
		expect(await createTelegramLink(deps, user.userId)).toEqual({ ok: false, reason: 'no_consent' });
		const employer = await createUser(database.db);
		expect(await createTelegramLink(deps, employer.id)).toEqual({ ok: false, reason: 'no_consent' });
		const withConsent = await candidateUser();
		expect(await createTelegramLink({ ...deps, telegram: null }, withConsent.userId)).toEqual({
			ok: false,
			reason: 'channel_disabled'
		});
	});
});

// --- Webhook --------------------------------------------------------------------------------------------------------

describe('webhook', () => {
	it('answers 401 to a wrong or missing secret and changes nothing', async () => {
		const user = await candidateUser();
		const token = await linkToken(user.userId);
		const chat = newChat();
		for (const secret of ['wrong-secret-0123456789', SECRET.slice(0, -1), null]) {
			const response = await webhook(message(chat, `/start ${token}`), secret);
			expect(response.status).toBe(401);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
		}
		expect(await channelsOf(user.userId)).toEqual([]);
		const rejected = await database.db
			.select({ outcome: auditEvents.outcome, actorKind: auditEvents.actorKind, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'telegram.webhook_rejected'));
		expect(rejected.every((e) => e.outcome === 'denied' && e.actorKind === 'anonymous')).toBe(true);
		expect(rejected.map((e) => (e.details as { reason: string }).reason).sort()).toEqual([
			'secret_mismatch',
			'secret_mismatch',
			'secret_missing'
		]);
	});

	it('answers 404 while the channel is disabled', async () => {
		const response = await webhook(message(newChat(), '/start'), SECRET, { telegram: null });
		expect(response.status).toBe(404);
	});

	it('links the chat by /start with a valid token, keeping the chat id encrypted', async () => {
		const user = await candidateUser();
		const token = await linkToken(user.userId);
		const chat = newChat();
		const reply = await replyOf(await webhook(message(chat, `/start ${token}`)));
		expect(reply).toEqual({ method: 'sendMessage', chat_id: chat, text: BOT_REPLIES.linked });

		const channel = await activeChannel(user.userId);
		expect(channel?.telegramChatIdEnc).toBeTruthy();
		expect(
			crypto.decrypt(channel?.telegramChatIdEnc ?? new Uint8Array(), 'notification_channels.telegram_chat_id')
		).toBe(String(chat));
		expect(channel?.telegramChatHmac).toBe(crypto.lookupHmac('telegram_chat', String(chat)));
		expect(channel?.consentEventId).toBeTruthy();
		const [used] = await database.db
			.select()
			.from(telegramLinkTokens)
			.where(eq(telegramLinkTokens.tokenHash, sha256Hex(token)));
		expect(used?.usedAt).toBeInstanceOf(Date);
		const journal = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'notification.channel_linked'), eq(auditEvents.objectId, channel?.id ?? '')));
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({ actorUserId: user.userId, subjectCandidateId: user.candidateId });

		// A repeated delivery of the same update finds the chat linked.
		expect((await replyOf(await webhook(message(chat, `/start ${token}`)))).text).toBe(BOT_REPLIES.alreadyLinked);
		expect(await channelsOf(user.userId)).toHaveLength(1);
	});

	it('refuses an unknown, expired or used token', async () => {
		const user = await candidateUser();
		const chat = newChat();
		const unknown = 'A'.repeat(43);
		expect((await replyOf(await webhook(message(chat, `/start ${unknown}`)))).text).toBe(BOT_REPLIES.invalidLink);
		expect((await replyOf(await webhook(message(chat, '/start not-a-token')))).text).toBe(BOT_REPLIES.invalidLink);

		const expired = await linkToken(user.userId);
		clock = new Date(clock.getTime() + TELEGRAM_LINK_TTL_MS + 1_000);
		try {
			expect((await replyOf(await webhook(message(chat, `/start ${expired}`)))).text).toBe(BOT_REPLIES.invalidLink);
		} finally {
			clock = new Date();
		}
		expect(await channelsOf(user.userId)).toEqual([]);

		const token = await linkToken(user.userId);
		await replyOf(await webhook(message(chat, `/start ${token}`)));
		const other = newChat();
		expect((await replyOf(await webhook(message(other, `/start ${token}`)))).text).toBe(BOT_REPLIES.invalidLink);
		const channels = await channelsOf(user.userId);
		expect(channels).toHaveLength(1);
		expect(channels[0]?.telegramChatHmac).toBe(crypto.lookupHmac('telegram_chat', String(chat)));
	});

	it('refuses when the consent was revoked after the link was issued', async () => {
		const user = await candidateUser();
		const token = await linkToken(user.userId);
		await consent(user.candidateId, user.userId, 'revoke', new Date(clock.getTime() - 1_000));
		expect((await replyOf(await webhook(message(newChat(), `/start ${token}`)))).text).toBe(BOT_REPLIES.noConsent);
		expect(await channelsOf(user.userId)).toEqual([]);
	});

	it('does not link a chat that belongs to another user', async () => {
		const first = await candidateUser();
		const second = await candidateUser();
		const chat = newChat();
		await replyOf(await webhook(message(chat, `/start ${await linkToken(first.userId)}`)));
		const reply = await replyOf(await webhook(message(chat, `/start ${await linkToken(second.userId)}`)));
		expect(reply.text).toBe(BOT_REPLIES.chatTaken);
		expect(await channelsOf(second.userId)).toEqual([]);
		expect(await activeChannel(first.userId)).toBeDefined();
	});

	it('links only in a private chat', async () => {
		const user = await candidateUser();
		const token = await linkToken(user.userId);
		const reply = await replyOf(await webhook(message(-newChat(), `/start ${token}`, 'group')));
		expect(reply.text).toBe(BOT_REPLIES.privateOnly);
		expect(await channelsOf(user.userId)).toEqual([]);
	});

	it('replaces the previous chat of the user', async () => {
		const user = await candidateUser();
		const first = newChat();
		const second = newChat();
		await replyOf(await webhook(message(first, `/start ${await linkToken(user.userId)}`)));
		await replyOf(await webhook(message(second, `/start ${await linkToken(user.userId)}`)));
		const channels = await channelsOf(user.userId);
		expect(channels.map((c) => c.status).sort()).toEqual(['active', 'unlinked']);
		expect((await activeChannel(user.userId))?.telegramChatHmac).toBe(
			crypto.lookupHmac('telegram_chat', String(second))
		);
		const ended = channels.find((c) => c.status === 'unlinked');
		expect(ended).toMatchObject({ telegramChatIdEnc: null, telegramChatHmac: null });
	});

	it('unlinks by /stop and erases the chat id', async () => {
		const user = await candidateUser();
		const chat = newChat();
		await replyOf(await webhook(message(chat, `/start ${await linkToken(user.userId)}`)));
		expect((await replyOf(await webhook(message(chat, '/stop')))).text).toBe(BOT_REPLIES.stopped);
		const [channel] = await channelsOf(user.userId);
		expect(channel).toMatchObject({ status: 'unlinked', telegramChatIdEnc: null, telegramChatHmac: null });
		const journal = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'notification.channel_unlinked'), eq(auditEvents.objectId, channel?.id ?? '')));
		expect(journal[0]?.details).toEqual({ kind: 'telegram', reason: 'bot_stop' });
		expect((await replyOf(await webhook(message(chat, '/stop')))).text).toBe(BOT_REPLIES.notLinked);
	});

	it('marks the channel blocked when the user blocks the bot', async () => {
		const user = await candidateUser();
		const chat = newChat();
		await replyOf(await webhook(message(chat, `/start ${await linkToken(user.userId)}`)));
		const response = await webhook({
			my_chat_member: {
				chat: { id: chat, type: 'private' },
				from: { id: chat },
				date: 0,
				old_chat_member: { status: 'member' },
				new_chat_member: { status: 'kicked' }
			}
		});
		expect(response.status).toBe(200);
		const [channel] = await channelsOf(user.userId);
		expect(channel).toMatchObject({ status: 'blocked_by_user', telegramChatIdEnc: null, telegramChatHmac: null });
	});

	it('answers other messages with help and rejects a malformed update', async () => {
		expect((await replyOf(await webhook(message(newChat(), 'привет')))).text).toBe(BOT_REPLIES.help);
		const headers = new Headers({ [TELEGRAM_SECRET_HEADER]: SECRET });
		const malformed = await receiveTelegramUpdate(deps, { headers, body: '{', meta: { requestId: 'req-test' } });
		expect(malformed.status).toBe(400);
	});

	it('replies without personal data', () => {
		for (const text of Object.values(BOT_REPLIES)) {
			expect(text).toMatch(/^[А-ЯЁа-яёA-Za-z :—|.,/]+$/u);
		}
	});
});

// --- Unlink and settings --------------------------------------------------------------------------------------------

describe('settings', () => {
	it('unlinks Telegram at the user’s request', async () => {
		const user = await candidateUser();
		await replyOf(await webhook(message(newChat(), `/start ${await linkToken(user.userId)}`)));
		expect(await unlinkTelegram(deps, user.userId, { requestId: 'req-test' })).toBe(true);
		expect(await activeChannel(user.userId)).toBeUndefined();
		expect(await unlinkTelegram(deps, user.userId, { requestId: 'req-test' })).toBe(false);
	});

	it('shows every category on every channel by default and keeps account on email', async () => {
		const user = await candidateUser();
		await database.db.transaction((tx) => ensureEmailChannel(tx, user.userId, EPOCH));
		await database.db.transaction((tx) => ensureEmailChannel(tx, user.userId, EPOCH));
		const settings = await notificationSettings(database.db, user.userId, { telegramAvailable: true });
		expect(settings.channels).toEqual({ email: 'active', telegram: 'not_linked', telegramAvailable: true });
		expect(settings.categories).toContainEqual({
			category: 'account',
			channels: ['email', 'telegram'],
			required: ['email']
		});

		expect(await setCategoryChannels(database.db, user.userId, 'account', ['telegram'], new Date())).toEqual({
			ok: false,
			reason: 'channel_required'
		});
		expect(await setCategoryChannels(database.db, user.userId, 'hiring', ['telegram'], new Date())).toEqual({
			ok: true
		});
		expect(await setCategoryChannels(database.db, user.userId, 'hiring', [], new Date())).toEqual({ ok: true });
		const after = await notificationSettings(database.db, user.userId, { telegramAvailable: false });
		expect(after.categories).toContainEqual({ category: 'hiring', channels: [], required: [] });
		const emails = await database.db
			.select()
			.from(notificationChannels)
			.where(and(eq(notificationChannels.userId, user.userId), eq(notificationChannels.kind, 'email')));
		expect(emails).toHaveLength(1);
	});
});
