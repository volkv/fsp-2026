// Delivery channels (docs/contracts.md, section 7): adapters of one interface. Errors never cross the adapter as
// exceptions; the delivery job decides from the code and `retryable` whether to try again.
import { z } from 'zod';
import type { AdapterResult } from '$lib/server/fsp/types';
import type { Mailer } from '$lib/server/mail/mailer';

export type ChannelKind = 'email' | 'telegram';
export type ChannelErrorCode = 'disabled' | 'unavailable' | 'rate_limited' | 'recipient_blocked' | 'rejected';
export type ChannelResult = AdapterResult<{ providerMessageId: string }, ChannelErrorCode>;

interface Addressing {
	email: { email: string };
	telegram: { telegramChatId: string };
}

interface Content {
	/** A letter: the recipient's own data may appear in it (domain 3.7). */
	email: { subject: string; text: string; html: string; link: string };
	/** Only the kind of the event and the link into the product: Telegram is a foreign service. */
	telegram: { text: string; link: string };
}

export interface SendInput<K extends ChannelKind> {
	/** `notification_deliveries.id`: the idempotency key of the send. */
	deliveryId: string;
	to: Addressing[K];
	message: Content[K];
	/** Aborted when the delivery job must stop. */
	signal: AbortSignal;
}

export interface NotificationChannel<K extends ChannelKind> {
	readonly kind: K;
	send(input: SendInput<K>): Promise<ChannelResult>;
}

export interface NotificationChannels {
	email: NotificationChannel<'email'>;
	telegram: NotificationChannel<'telegram'>;
}

/** Mail over the SMTP mailer: a temporary SMTP failure (4xx) is `unavailable`, a permanent one (5xx) `rejected`. */
export function createEmailChannel(mailer: Mailer): NotificationChannel<'email'> {
	return {
		kind: 'email',
		async send({ to, message }) {
			const sent = await mailer.send({
				to: to.email,
				subject: message.subject,
				text: message.text,
				html: message.html
			});
			return sent.ok ? { ok: true, value: { providerMessageId: sent.value.messageId } } : sent;
		}
	};
}

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_TIMEOUT_MS = 10_000;

export interface TelegramSettings {
	botToken: string;
	/** Origin of the Bot API; a test server in tests. */
	apiBase: string;
}

const sendMessageAnswer = z.union([
	z.looseObject({ ok: z.literal(true), result: z.looseObject({ message_id: z.int() }) }),
	z.looseObject({
		ok: z.literal(false),
		error_code: z.int().optional(),
		parameters: z.looseObject({ retry_after: z.int().nonnegative().optional() }).optional()
	})
]);

/**
 * The body as JSON; a body that is not JSON (an error page of a proxy) is `null` and the answer is classified by its
 * status alone.
 */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		if (!(error instanceof SyntaxError) || signal.aborted) throw error;
		return null;
	}
}

const failure = (code: ChannelErrorCode, retryable: boolean, message: string, details?: Record<string, unknown>) =>
	({ ok: false, error: { code, retryable, message, ...(details === undefined ? {} : { details }) } }) as const;

/**
 * `sendMessage` of the Bot API (contracts 7.2). Without settings the channel is `disabled`. `403` — the user blocked
 * the bot; `429` — `rate_limited` with `retry_after`; `5xx`, network errors and timeouts — `unavailable`; a refused
 * bot token is `unavailable` too: the deliveries wait for the configuration to be fixed. Messages carry no chat id.
 */
export function createTelegramChannel(settings: TelegramSettings | null): NotificationChannel<'telegram'> {
	return {
		kind: 'telegram',
		async send({ to, message, signal }) {
			if (!settings) return failure('disabled', false, 'the Telegram channel is not configured');
			const url = `${settings.apiBase}/bot${settings.botToken}/sendMessage`;
			let response: Response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						chat_id: to.telegramChatId,
						text: `${message.text}\n\n${message.link}`,
						link_preview_options: { is_disabled: true }
					}),
					signal: AbortSignal.any([signal, AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)])
				});
			} catch (error) {
				// The job itself is stopping: not a channel failure.
				if (signal.aborted) throw error;
				const name = error instanceof Error ? error.name : 'NonErrorThrown';
				return failure('unavailable', true, `Bot API is unreachable (${name})`);
			}
			const status = response.status;
			const answer = sendMessageAnswer.safeParse(await readJson(response, signal));
			if (response.ok) {
				if (answer.success && answer.data.ok) {
					return { ok: true, value: { providerMessageId: String(answer.data.result.message_id) } };
				}
				return failure('unavailable', true, `Bot API answered ${status} without a message id`);
			}
			if (status === 403) return failure('recipient_blocked', false, 'Bot API answered 403: the bot is blocked');
			if (status === 429) {
				const retryAfter = answer.success && !answer.data.ok ? answer.data.parameters?.retry_after : undefined;
				return failure(
					'rate_limited',
					true,
					'Bot API answered 429',
					retryAfter === undefined ? undefined : { retry_after: retryAfter }
				);
			}
			if (status >= 500 || status === 401 || status === 404) {
				return failure('unavailable', true, `Bot API answered ${status}`);
			}
			return failure('rejected', false, `Bot API answered ${status}`);
		}
	};
}
