// Delivery of notifications over email and Telegram (docs/domain.md 3.7, contracts 7): a fake SMTP server and a fake
// Bot API stand in for the providers, the jobs go through the real queue.
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	consentEvents,
	invitations,
	invitationTerms,
	jobs,
	legalRepresentatives,
	notificationChannels,
	notificationDeliveries,
	notifications,
	representations,
	users
} from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { JobFailure, type JobContext } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { createSmtpMailer } from '$lib/server/mail/mailer';
import {
	createEmailChannel,
	createTelegramChannel,
	type NotificationChannels
} from '$lib/server/notifications/channels';
import { notificationFacts } from '$lib/server/notifications/content';
import { createNotificationDeliverHandler, notificationLinks } from '$lib/server/notifications/deliver';
import { openNotification } from '$lib/server/notifications/inbox';
import { ensureEmailChannel, notify, type NotificationInput } from '$lib/server/notifications/notify';
import { setCategoryChannels } from '$lib/server/notifications/preferences';
import { notificationLetter, telegramText } from '$lib/server/notifications/templates';
import { NOTIFICATION_TYPES, type NotificationType } from '$lib/server/notifications/types';
import { candidateCode, candidateLabel } from '$lib/text/candidate-label';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPolicy,
	createPublishedDocument,
	createUser,
	offerTermsRow
} from '../helpers/factories';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 5)
});
const APP_ORIGIN = 'https://career.test';
const COMPANY_NAME = 'Секретная Компания';
const VACANCY_TITLE = 'Тайная вакансия на Go';
const EPOCH = new Date(Date.now() - 30 * 86_400_000);

// --- Fake SMTP server -----------------------------------------------------------------------------------------------

interface FakeSmtp {
	port: number;
	/** Raw DATA of accepted messages. */
	received: string[];
	/** Replies to the next `RCPT TO` commands; `250 OK` when empty. */
	rcptReplies: string[];
	close(): Promise<void>;
}

async function startFakeSmtp(): Promise<FakeSmtp> {
	const received: string[] = [];
	const rcptReplies: string[] = [];
	const server: TcpServer = createTcpServer((socket) => {
		socket.setEncoding('utf8');
		let buffer = '';
		let data: string[] | null = null;
		socket.write('220 fake.test ESMTP\r\n');
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (data) {
					if (line === '.') {
						received.push(data.join('\r\n'));
						data = null;
						socket.write('250 2.0.0 queued\r\n');
					} else {
						data.push(line.startsWith('..') ? line.slice(1) : line);
					}
					continue;
				}
				const command = line.slice(0, 4).toUpperCase();
				if (command === 'EHLO' || command === 'HELO') socket.write('250-fake.test\r\n250 8BITMIME\r\n');
				else if (command === 'MAIL' || command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n');
				else if (command === 'RCPT') socket.write(`${rcptReplies.shift() ?? '250 OK'}\r\n`);
				else if (command === 'DATA') {
					data = [];
					socket.write('354 go ahead\r\n');
				} else if (command === 'QUIT') socket.end('221 bye\r\n');
				else socket.write('502 not implemented\r\n');
			}
		});
		socket.on('error', () => socket.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		received,
		rcptReplies,
		close: () =>
			new Promise((resolve) => {
				server.close(() => {
					resolve();
				});
			})
	};
}

/** The decoded `text/plain` part of a raw message. */
function plainText(raw: string): string {
	const part =
		/Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: (\S+)\r\n\r\n([\s\S]*?)\r\n--/i.exec(raw);
	if (!part?.[1] || part[2] === undefined) throw new Error('no text/plain part');
	const [, encoding, body] = part;
	if (encoding.toLowerCase() === 'base64') return Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8');
	if (encoding.toLowerCase() === 'quoted-printable') {
		const bytes = body.replaceAll('=\r\n', '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => `%${hex}`);
		return decodeURIComponent(bytes);
	}
	return body;
}

// --- Fake Bot API ---------------------------------------------------------------------------------------------------

interface FakeBotApi {
	apiBase: string;
	requests: { path: string; body: Record<string, unknown> }[];
	/** Answers to the next requests; a success with a message id when empty. */
	answers: { status: number; body: unknown }[];
	close(): Promise<void>;
}

async function startFakeBotApi(): Promise<FakeBotApi> {
	const requests: FakeBotApi['requests'] = [];
	const answers: FakeBotApi['answers'] = [];
	const server: HttpServer = createHttpServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on('end', () => {
			requests.push({
				path: request.url ?? '',
				body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
			});
			const answer = answers.shift() ?? { status: 200, body: { ok: true, result: { message_id: requests.length } } };
			response.writeHead(answer.status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		answers,
		close: () =>
			new Promise((resolve) => {
				server.close(() => {
					resolve();
				});
			})
	};
}

// --- Setup ----------------------------------------------------------------------------------------------------------

let database: TestDatabase;
let smtp: FakeSmtp;
let bot: FakeBotApi;
let channels: NotificationChannels;
let telegramDocumentId: string;
let invitationPolicyId: string;
const handler = createNotificationDeliverHandler(() => ({
	crypto,
	channels,
	appOrigin: APP_ORIGIN,
	now: () => new Date()
}));

beforeAll(async () => {
	database = await createTestDatabase();
	[smtp, bot] = await Promise.all([startFakeSmtp(), startFakeBotApi()]);
	channels = {
		email: createEmailChannel(
			createSmtpMailer({ smtpUrl: `smtp://127.0.0.1:${smtp.port}`, from: 'noreply@career.test' })
		),
		telegram: createTelegramChannel({ botToken: '123456:test-token', apiBase: bot.apiBase })
	};
	telegramDocumentId = (await createPublishedDocument(database.db, 'telegram_notifications', { publishedAt: EPOCH }))
		.id;
	invitationPolicyId = (await createPolicy(database.db, 'invitation_policy')).id;
});

afterAll(async () => {
	await Promise.all([smtp.close(), bot.close(), database.drop()]);
});

beforeEach(() => {
	smtp.received.length = 0;
	smtp.rcptReplies.length = 0;
	bot.requests.length = 0;
	bot.answers.length = 0;
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function userWithEmail(email: string) {
	return createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email),
		emailVerifiedAt: EPOCH
	});
}

let chatSeq = 700_000_000;

/** A candidate invited by a company; both sides have their email channel, the candidate optionally Telegram. */
async function world(options: { telegram?: boolean } = {}) {
	const { db } = database;
	const suffix = uuidv7().slice(-12);
	const candidateEmail = `candidate-${suffix}@example.org`;
	const memberEmail = `member-${suffix}@example.org`;
	const candidateUser = await userWithEmail(candidateEmail);
	const candidate = await createCandidate(db, { userId: candidateUser.id });
	const company = await createCompany(db, { displayName: COMPANY_NAME });
	const memberUser = await userWithEmail(memberEmail);
	const member = await createMember(db, company.id, { userId: memberUser.id });
	const invitationId = uuidv7();
	const termsId = uuidv7();
	await db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: company.id,
			candidateId: candidate.id,
			sentByMemberId: member.id,
			status: 'sent',
			currentTermsId: termsId,
			policyId: invitationPolicyId,
			sentAt: new Date()
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			...offerTermsRow(),
			title: VACANCY_TITLE,
			salaryMin: 250_000,
			salaryMax: 300_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(Date.now() + 72 * 3_600_000),
			createdByMemberId: member.id
		});
		await ensureEmailChannel(tx, candidateUser.id, EPOCH);
		await ensureEmailChannel(tx, memberUser.id, EPOCH);
	});
	let chatId: string | null = null;
	let telegramChannelId: string | null = null;
	if (options.telegram) {
		const [consent] = await db
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidate.id,
				kind: 'telegram_notifications',
				documentId: telegramDocumentId,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidateUser.id,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: EPOCH
			})
			.returning();
		chatId = String(++chatSeq);
		const [channel] = await db
			.insert(notificationChannels)
			.values({
				userId: candidateUser.id,
				kind: 'telegram',
				telegramChatIdEnc: crypto.encrypt(chatId, 'notification_channels.telegram_chat_id'),
				telegramChatHmac: crypto.lookupHmac('telegram_chat', chatId),
				status: 'active',
				consentEventId: consent?.id,
				linkedAt: EPOCH
			})
			.returning();
		telegramChannelId = channel?.id ?? null;
	}
	return {
		candidateUser,
		candidate,
		candidateEmail,
		company,
		memberUser,
		memberEmail,
		invitationId,
		chatId,
		telegramChannelId,
		pseudonym: crypto.pseudonym(candidate.id, company.id)
	};
}

type World = Awaited<ReturnType<typeof world>>;

async function send(input: NotificationInput): Promise<string> {
	await database.db.transaction(async (tx) => {
		await notify(tx, input);
	});
	const [row] = await database.db
		.select({ id: notifications.id })
		.from(notifications)
		.where(and(eq(notifications.userId, input.userId), eq(notifications.type, input.type)));
	if (!row) throw new Error('notification not created');
	return row.id;
}

const received = (w: World) =>
	send({
		userId: w.candidateUser.id,
		type: 'invitation.received',
		objectId: w.invitationId,
		payload: { invitation_id: w.invitationId }
	});

const isDeliver = (job: ClaimedJob): job is ClaimedJob<'notification.deliver'> => job.type === 'notification.deliver';

/** Captures and runs one due delivery job the way the worker does; `null` when none is due. */
async function runOne(): Promise<{ jobId: string; outcome: string } | null> {
	const { db } = database;
	const job = await claimJob(db, 'test-worker', ['notification.deliver']);
	if (!job) return null;
	if (!isDeliver(job)) throw new Error(`captured ${job.type}`);
	const context: JobContext<'notification.deliver'> = {
		job,
		db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	};
	try {
		const result = await handler.run(context);
		return { jobId: job.id, outcome: await completeJob(db, job, result) };
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		const outcome = await failJob(
			db,
			job,
			{ code: error.code, retryable: error.retryable, message: error.message },
			error.retryAfterSeconds
		);
		return { jobId: job.id, outcome };
	}
}

/** Runs every due delivery job; a job put back for a retry waits for its backoff. */
async function drain(): Promise<string[]> {
	const outcomes: string[] = [];
	for (let next = await runOne(); next; next = await runOne()) outcomes.push(next.outcome);
	return outcomes;
}

/** Makes the waiting delivery jobs due now, skipping their backoff. */
async function dueNow(): Promise<void> {
	await database.db
		.update(jobs)
		.set({ runAfter: sql`now()` })
		.where(and(eq(jobs.type, 'notification.deliver'), eq(jobs.status, 'queued')));
}

async function deliveriesOf(notificationId: string) {
	return database.db
		.select({
			status: notificationDeliveries.status,
			skipReason: notificationDeliveries.skipReason,
			attempts: notificationDeliveries.attempts,
			lastError: notificationDeliveries.lastError,
			providerMessageId: notificationDeliveries.providerMessageId,
			kind: notificationChannels.kind
		})
		.from(notificationDeliveries)
		.innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
		.where(eq(notificationDeliveries.notificationId, notificationId));
}

async function deliveryOf(notificationId: string, kind: 'email' | 'telegram') {
	const row = (await deliveriesOf(notificationId)).find((d) => d.kind === kind);
	if (!row) throw new Error(`no ${kind} delivery`);
	return row;
}

async function jobOf(notificationId: string, kind: 'email' | 'telegram') {
	const [row] = await database.db
		.select({ status: jobs.status, runAfter: jobs.runAfter, attempts: jobs.attempts, lastError: jobs.lastError })
		.from(jobs)
		.innerJoin(notificationChannels, sql`${notificationChannels.id}::text = ${jobs.payload} ->> 'channel_id'`)
		.where(
			and(
				eq(jobs.type, 'notification.deliver'),
				sql`${jobs.payload} ->> 'notification_id' = ${notificationId}`,
				eq(notificationChannels.kind, kind)
			)
		)
		.orderBy(sql`${jobs.createdAt} desc`)
		.limit(1);
	if (!row) throw new Error(`no ${kind} job`);
	return row;
}

// --- Email ----------------------------------------------------------------------------------------------------------

describe('email', () => {
	it('delivers the letter with the recipient’s own data, the link and the settings link', async () => {
		const w = await world();
		const id = await received(w);
		expect(await drain()).toEqual(['succeeded']);

		expect(smtp.received).toHaveLength(1);
		const raw = smtp.received[0] ?? '';
		expect(raw).toContain(`To: ${w.candidateEmail}`);
		const text = plainText(raw);
		expect(text).toContain(`Компания «${COMPANY_NAME}» предлагает вам работу: «${VACANCY_TITLE}»`);
		expect(text).toContain(`${APP_ORIGIN}/notifications/${id}`);
		expect(text).toContain(`${APP_ORIGIN}/account/notifications`);

		const delivery = await deliveryOf(id, 'email');
		expect(delivery).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
		expect(delivery.providerMessageId).toBeTruthy();
	});

	it('names the candidate to the company by the short code of the pseudonym only', async () => {
		const w = await world();
		await send({
			userId: w.memberUser.id,
			type: 'invitation.answered',
			objectId: w.invitationId,
			stage: 'v1',
			payload: { invitation_id: w.invitationId, decision: 'decline' }
		});
		expect(await drain()).toEqual(['succeeded']);
		const raw = smtp.received[0] ?? '';
		expect(raw).toContain(`To: ${w.memberEmail}`);
		const text = plainText(raw);
		expect(text).toContain(`${candidateLabel(w.pseudonym)} отклонил приглашение «${VACANCY_TITLE}»`);
		expect(raw).not.toContain(w.candidateEmail);
	});

	it('is idempotent by delivery: a repeated job sends nothing', async () => {
		const w = await world();
		const id = await received(w);
		expect(await drain()).toEqual(['succeeded']);
		const [channel] = await database.db
			.select({ id: notificationChannels.id })
			.from(notificationChannels)
			.where(and(eq(notificationChannels.userId, w.candidateUser.id), eq(notificationChannels.kind, 'email')));
		const result = await handler.run({
			job: {
				id: uuidv7(),
				type: 'notification.deliver',
				payload: { notification_id: id, channel_id: channel?.id ?? '' },
				inputVersion: 'repeat',
				attempt: 1,
				maxAttempts: 5,
				leaseOwner: 'test'
			},
			db: database.db,
			signal: new AbortController().signal,
			requestId: 'job:repeat',
			log: createLogger({}, () => undefined)
		});
		expect(result.describe?.()).toMatchObject({ outcome: 'already_done' });
		expect(smtp.received).toHaveLength(1);
	});

	it('retries a temporary SMTP failure (4xx) with backoff, then sends', async () => {
		const w = await world();
		const id = await received(w);
		smtp.rcptReplies.push('451 4.3.0 try again later');
		expect(await drain()).toEqual(['queued']);

		const waiting = await jobOf(id, 'email');
		expect(waiting.status).toBe('queued');
		expect(waiting.runAfter.getTime()).toBeGreaterThan(Date.now());
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'queued', attempts: 1 });
		expect((await deliveryOf(id, 'email')).lastError).toMatch(/^unavailable: SMTP .* 451$/);

		await dueNow();
		expect(await drain()).toEqual(['succeeded']);
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
		expect(smtp.received).toHaveLength(1);
	});

	it('fails for good on a permanent SMTP failure (5xx), without retries', async () => {
		const w = await world();
		const id = await received(w);
		smtp.rcptReplies.push('550 5.1.1 no such mailbox');
		expect(await drain()).toEqual(['failed']);
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'failed', attempts: 1 });
		expect(await jobOf(id, 'email')).toMatchObject({ status: 'failed', attempts: 1 });
		expect(smtp.received).toHaveLength(0);
	});

	it('fails for good once the attempts of the type are spent; the notification stays in the interface', async () => {
		const w = await world();
		const id = await received(w);
		smtp.rcptReplies.push(...Array.from({ length: 5 }, () => '421 4.7.0 busy'));
		const outcomes: string[] = [];
		for (let attempt = 1; attempt <= 5; attempt++) {
			outcomes.push(...(await drain()));
			await dueNow();
		}
		expect(outcomes).toEqual(['queued', 'queued', 'queued', 'queued', 'failed']);
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'failed', attempts: 5 });
		expect(await jobOf(id, 'email')).toMatchObject({ status: 'failed', attempts: 5 });
		const [notification] = await database.db.select().from(notifications).where(eq(notifications.id, id));
		expect(notification).toMatchObject({ type: 'invitation.received', readAt: null });
	});
});

// --- Telegram -------------------------------------------------------------------------------------------------------

describe('telegram', () => {
	it('sends only the kind of the event and the link, no personal data', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		expect((await drain()).sort()).toEqual(['succeeded', 'succeeded']);

		expect(bot.requests).toHaveLength(1);
		const request = bot.requests[0];
		expect(request?.path).toBe('/bot123456:test-token/sendMessage');
		expect(request?.body.chat_id).toBe(w.chatId);
		const text = String(request?.body.text);
		expect(text).toBe(`Новое приглашение — ФСП | Карьера\n\n${APP_ORIGIN}/notifications/${id}`);
		for (const personal of [
			COMPANY_NAME,
			VACANCY_TITLE,
			w.pseudonym,
			candidateCode(w.pseudonym),
			w.candidateEmail,
			w.memberEmail
		]) {
			expect(text).not.toContain(personal);
		}
		expect(request?.body).not.toHaveProperty('parse_mode');
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'sent', attempts: 1, providerMessageId: '1' });
	});

	it('keeps every type free of personal data', () => {
		for (const type of Object.keys(NOTIFICATION_TYPES) as NotificationType[]) {
			const text = telegramText(type);
			expect(text).toMatch(/^[А-ЯЁа-яё :—|]+$/u);
		}
	});

	it('retries a 5xx of the Bot API, then sends', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		bot.answers.push({ status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } });
		await drain();
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'queued', attempts: 1 });
		expect((await deliveryOf(id, 'telegram')).lastError).toBe('unavailable: Bot API answered 502');
		await dueNow();
		expect(await drain()).toEqual(['succeeded']);
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'sent', attempts: 2 });
	});

	it('honours retry_after of a 429', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		bot.answers.push({
			status: 429,
			body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } }
		});
		await drain();
		const waiting = await jobOf(id, 'telegram');
		expect(waiting.status).toBe('queued');
		expect(waiting.runAfter.getTime() - Date.now()).toBeGreaterThan(100_000);
		await dueNow();
		expect(await drain()).toEqual(['succeeded']);
	});

	it('treats an unreachable Bot API as unavailable', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		const unreachable = createTelegramChannel({ botToken: '123456:test-token', apiBase: 'http://127.0.0.1:9' });
		const saved = channels.telegram;
		channels.telegram = unreachable;
		try {
			await drain();
		} finally {
			channels.telegram = saved;
		}
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'queued', attempts: 1 });
		expect((await deliveryOf(id, 'telegram')).lastError).toMatch(/^unavailable: Bot API is unreachable/);
		await dueNow();
		expect(await drain()).toEqual(['succeeded']);
	});

	it('fails for good on a 4xx refusal', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		bot.answers.push({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
		await drain();
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'failed', attempts: 1 });
		expect(await jobOf(id, 'telegram')).toMatchObject({ status: 'failed' });
	});

	it('ends the channel when the user blocked the bot, erasing the chat id', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		bot.answers.push({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' } });
		await drain();
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'failed' });
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'sent' });
		const [channel] = await database.db
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.id, w.telegramChannelId ?? ''));
		expect(channel).toMatchObject({ status: 'blocked_by_user', telegramChatIdEnc: null, telegramChatHmac: null });
		expect(channel?.unlinkedAt).toBeInstanceOf(Date);
		const journal = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'notification.channel_unlinked'), eq(auditEvents.objectId, channel?.id ?? '')));
		expect(journal[0]?.details).toEqual({ kind: 'telegram', reason: 'bot_blocked' });
	});

	it('does not send without an effective telegram_notifications consent and ends the channel', async () => {
		const w = await world({ telegram: true });
		await database.db.insert(consentEvents).values({
			subjectCandidateId: w.candidate.id,
			kind: 'telegram_notifications',
			documentId: telegramDocumentId,
			action: 'revoke',
			signerKind: 'subject',
			signerUserId: w.candidateUser.id,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(EPOCH.getTime() + 60_000)
		});
		const id = await received(w);
		await drain();
		expect(bot.requests).toHaveLength(0);
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'skipped', skipReason: 'no_consent' });
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'sent' });
		const [channel] = await database.db
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.id, w.telegramChannelId ?? ''));
		expect(channel).toMatchObject({ status: 'unlinked', telegramChatIdEnc: null, telegramChatHmac: null });
	});

	it('skips the channel when the bot is not configured', async () => {
		const w = await world({ telegram: true });
		const id = await received(w);
		const saved = channels.telegram;
		channels.telegram = createTelegramChannel(null);
		try {
			await drain();
		} finally {
			channels.telegram = saved;
		}
		expect(bot.requests).toHaveLength(0);
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'skipped', skipReason: 'channel_inactive' });
	});
});

// --- Settings and checks at the time of sending ---------------------------------------------------------------------

describe('checks before sending', () => {
	it('records a channel switched off for the category as skipped and queues nothing for it', async () => {
		const w = await world({ telegram: true });
		const result = await setCategoryChannels(database.db, w.candidateUser.id, 'invitations', ['email'], new Date());
		expect(result).toEqual({ ok: true });
		const id = await received(w);
		expect(await deliveryOf(id, 'telegram')).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
		expect(await drain()).toEqual(['succeeded']);
		expect(bot.requests).toHaveLength(0);
		expect(smtp.received).toHaveLength(1);
	});

	it('applies a setting changed after the delivery was queued', async () => {
		const w = await world();
		const id = await received(w);
		await setCategoryChannels(database.db, w.candidateUser.id, 'invitations', [], new Date());
		await drain();
		expect(smtp.received).toHaveLength(0);
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
	});

	it('does not write about an invitation withdrawn before the letter left', async () => {
		const w = await world();
		const id = await received(w);
		await database.db
			.update(invitations)
			.set({ status: 'withdrawn', closedAt: new Date() })
			.where(eq(invitations.id, w.invitationId));
		await drain();
		expect(smtp.received).toHaveLength(0);
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'skipped', skipReason: 'object_not_visible' });
	});

	it('does not write to a suspended account', async () => {
		const w = await world();
		const id = await send({
			userId: w.memberUser.id,
			type: 'invitation.expired',
			objectId: w.invitationId,
			stage: 'v1',
			payload: { invitation_id: w.invitationId }
		});
		await database.db.update(users).set({ status: 'suspended' }).where(eq(users.id, w.memberUser.id));
		await drain();
		expect(await deliveryOf(id, 'email')).toMatchObject({ status: 'skipped', skipReason: 'recipient_inactive' });
	});

	it('keeps the notification in the interface when the recipient has no channel', async () => {
		const w = await world();
		const user = await createUser(database.db);
		const id = await send({
			userId: user.id,
			type: 'invitation.received',
			objectId: w.invitationId,
			payload: { invitation_id: w.invitationId }
		});
		expect(await deliveriesOf(id)).toEqual([]);
	});

	it('creates nothing for a repeated event of the same stage', async () => {
		const w = await world();
		await received(w);
		const again = await database.db.transaction((tx) =>
			notify(tx, {
				userId: w.candidateUser.id,
				type: 'invitation.received',
				objectId: w.invitationId,
				payload: { invitation_id: w.invitationId }
			})
		);
		expect(again).toBe(false);
		expect(await drain()).toEqual(['succeeded']);
	});
});

describe('letters', () => {
	it('has a text for every type and side it is sent to', async () => {
		const w = await world();
		// Types about an invitation or its hiring process; the operator's decisions have their own texts and tests
		// (operator-notifications.test.ts).
		type InvitationType = {
			[T in NotificationType]: (typeof NOTIFICATION_TYPES)[T]['objectType'] extends 'invitation' | 'hiring_process'
				? T
				: never;
		}[NotificationType];
		const sides: Record<InvitationType, ('candidate' | 'company')[]> = {
			'invitation.received': ['candidate'],
			'invitation.terms_revised': ['candidate'],
			'invitation.answered': ['company'],
			'invitation.representative_answered': ['candidate'],
			'invitation.expired': ['candidate', 'company'],
			'invitation.withdrawn': ['candidate'],
			'invitation.response_due_soon': ['candidate'],
			'invitation.message': ['candidate', 'company'],
			'hiring.outcome_requested': ['candidate', 'company'],
			'hiring.outcome_reminder': ['candidate', 'company'],
			'hiring.reports_diverged': ['candidate', 'company']
		};
		const payload = { decision: 'accept', hours_left: 24, salary_lowered: true, reopened: false };
		const links = notificationLinks(APP_ORIGIN, uuidv7());
		for (const [type, recipients] of Object.entries(sides) as [InvitationType, ('candidate' | 'company')[]][]) {
			for (const side of recipients) {
				const userId = side === 'candidate' ? w.candidateUser.id : w.memberUser.id;
				const facts = await notificationFacts(database.db, crypto, {
					type,
					objectType: 'invitation',
					objectId: w.invitationId,
					userId
				});
				expect(facts?.side).toBe(side);
				if (!facts) continue;
				const letter = notificationLetter('someone@example.org', type, facts, payload, links);
				expect(letter.text).toContain(links.open);
				expect(letter.text).toContain(links.settings);
				if (side === 'company') expect(letter.text).not.toContain(w.candidateEmail);
			}
		}
	});
});

describe('links', () => {
	it('leads the ward to the consents the representative signed, not to the visibility page', async () => {
		const { db } = database;
		const birth = new Date();
		birth.setUTCFullYear(birth.getUTCFullYear() - 16);
		const ward = await createCandidate(db, { birthDate: birth.toISOString().slice(0, 10) });
		const [representative] = await db
			.insert(legalRepresentatives)
			.values({
				fullNameEnc: crypto.encrypt('Петрова Анна Сергеевна', 'legal_representatives.full_name'),
				emailEnc: crypto.encrypt('parent@example.org', 'legal_representatives.email'),
				emailHmac: crypto.lookupHmac('email', 'parent@example.org')
			})
			.returning();
		if (!representative) throw new Error('representative not inserted');
		const [representation] = await db
			.insert(representations)
			.values({
				candidateId: ward.id,
				representativeId: representative.id,
				relation: 'parent',
				status: 'authority_verified',
				invitedAt: new Date(Date.now() - 86_400_000),
				contactConfirmedAt: new Date(Date.now() - 3_600_000)
			})
			.returning();
		if (!representation) throw new Error('representation not inserted');
		const created = await db.transaction((tx) =>
			notify(tx, {
				userId: ward.userId,
				type: 'representation.consents_signed',
				objectId: representation.id,
				payload: { representation_id: representation.id }
			})
		);
		expect(created).toBe(true);
		const [notification] = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(eq(notifications.objectId, representation.id));
		if (!notification) throw new Error('no notification');
		const opened = await openNotification(db, ward.userId, notification.id, new Date());
		expect(opened?.target).toEqual({ kind: 'candidate_consents' });
	});
});
