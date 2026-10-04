// Outgoing mail over SMTP (docs/contracts.md, section 8.1): Mailpit in development and on the demo stand.
import nodemailer, { type NodemailerError } from 'nodemailer';
import { config } from '$lib/server/config';

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export type MailErrorCode = 'unavailable' | 'rejected';

export type MailResult =
	| { ok: true; value: { messageId: string } }
	| { ok: false; error: { code: MailErrorCode; retryable: boolean; message: string } };

export interface Mailer {
	send(message: MailMessage): Promise<MailResult>;
}

/** Connection errors of the transport: the server was not reached or dropped the connection. */
const CONNECTION_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EPROTOCOL']);

function classify(error: NodemailerError): { code: MailErrorCode; retryable: boolean } {
	const status = error.responseCode;
	// A temporary SMTP failure (4xx) is retried; a permanent one (5xx) fails the delivery (contracts 8.1).
	if (typeof status === 'number') {
		return status >= 500 ? { code: 'rejected', retryable: false } : { code: 'unavailable', retryable: true };
	}
	if (error.code !== undefined && CONNECTION_CODES.has(error.code)) return { code: 'unavailable', retryable: true };
	return { code: 'rejected', retryable: false };
}

function isNodemailerError(value: unknown): value is NodemailerError {
	return value instanceof Error;
}

/** SMTP settings from `smtp://[user:pass@]host[:port]` or `smtps://…`. */
function transportOptions(smtpUrl: string) {
	const url = new URL(smtpUrl);
	const secure = url.protocol === 'smtps:';
	return {
		host: url.hostname,
		port: url.port === '' ? (secure ? 465 : 25) : Number(url.port),
		secure,
		...(url.username === ''
			? {}
			: { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }),
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 20_000
	};
}

export function createSmtpMailer(settings: { smtpUrl: string; from: string }): Mailer {
	const transport = nodemailer.createTransport(transportOptions(settings.smtpUrl));
	return {
		async send(message) {
			try {
				const info = await transport.sendMail({ from: settings.from, ...message });
				return { ok: true, value: { messageId: info.messageId } };
			} catch (error) {
				if (!isNodemailerError(error)) throw error;
				const { code, retryable } = classify(error);
				// The message names the SMTP stage only: the recipient address stays out of logs.
				const stage = error.command ?? error.code ?? 'send';
				const reply = error.responseCode === undefined ? '' : ` with ${error.responseCode}`;
				return { ok: false, error: { code, retryable, message: `SMTP ${stage} failed${reply}` } };
			}
		}
	};
}

let instance: Mailer | undefined;

/** Mailer over the configured SMTP server, created on first use. */
export function mailer(): Mailer {
	instance ??= createSmtpMailer(config().mail);
	return instance;
}
