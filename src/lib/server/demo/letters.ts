// Letters of a demo session (docs/domain.md, section 19.3). On the demonstration stand the mail leaves for the mailbox of
// the stand, which the visitor does not open; the letters page of the session shows them what their session sent:
// - letters to the legal representative of a candidate of the session — the one-time links that sign the consents and
//   answer an acceptance — are kept with the session (`demo_letters`, the body encrypted, as it carries the link) when
//   they left, and so are the confirmation of the address and the password reset of an account registered within the
//   session; letters of the stand outside sessions are never kept;
// - notifications of the session's accounts are shown as the letters they would be: a clone has no channel of its own,
//   so nothing is delivered, and the letter is rendered from the notification on the page, as the delivery would.
// Who reads them: a signed-in account of the session reads every letter of it. A visitor who forgot the password of the
// account they registered, or signed out before confirming its address, is signed in to nothing, so the browser that
// holds the session's join token reads the letters of the accounts registered within that session — and nothing else
// of it: whoever holds the token may enter any role of the session and read the rest there, and no other session's
// letter is reached.
import { and, desc, eq, gte, inArray, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { demoActorOf } from '$lib/server/access/demo-actor';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { candidates, DEMO_LETTER_KINDS, demoLetters, demoSessions, notifications, users } from '$lib/server/db/schema';
import type { MailMessage } from '$lib/server/mail/mailer';
import { notificationFacts } from '$lib/server/notifications/content';
import { notificationLinks } from '$lib/server/notifications/deliver';
import { notificationLetter } from '$lib/server/notifications/templates';
import { isNotificationType, NOTIFICATION_TYPES } from '$lib/server/notifications/types';

export type DemoLetterKind = (typeof DEMO_LETTER_KINDS)[number];
const REPRESENTATIVE_KINDS = ['consents', 'disclosure'] as const satisfies readonly DemoLetterKind[];
type RepresentativeLetterKind = (typeof REPRESENTATIVE_KINDS)[number];
/** Letters to an account registered within the session: the object is the account. */
const ACCOUNT_KINDS = ['verify_email', 'password_reset'] as const satisfies readonly DemoLetterKind[];

/** `an***@example.org`: the first two characters of the local part and the domain. */
export function maskEmail(address: string): string {
	const at = address.lastIndexOf('@');
	if (at < 1) throw new Error('not an email address');
	return `${address.slice(0, Math.min(2, at))}***${address.slice(at)}`;
}

/** A letter the session sent, kept with it for its letters page. */
export async function keepSessionLetter(
	executor: Executor,
	crypto: FieldCrypto,
	letter: { demoSessionId: string; kind: DemoLetterKind; object: { type: string; id: string }; message: MailMessage }
): Promise<void> {
	await executor.insert(demoLetters).values({
		demoSessionId: letter.demoSessionId,
		kind: letter.kind,
		objectType: letter.object.type,
		objectId: letter.object.id,
		recipientMasked: maskEmail(letter.message.to),
		subject: letter.message.subject,
		bodyEnc: crypto.encrypt(letter.message.text, 'demo_letters.body')
	});
}

/**
 * Keeps a letter to a representative when the candidate it concerns is in a demo session; a candidate outside sessions
 * — a real person, an original of the cast — has nothing kept. `true` — the letter was kept.
 */
export async function keepDemoLetter(
	executor: Executor,
	crypto: FieldCrypto,
	letter: {
		candidateId: string;
		kind: RepresentativeLetterKind;
		object: { type: string; id: string };
		message: MailMessage;
	}
): Promise<boolean> {
	const [candidate] = await executor
		.select({ session: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, letter.candidateId));
	if (!candidate) throw new Error(`candidate ${letter.candidateId} not found`);
	if (candidate.session === null) return false;
	await keepSessionLetter(executor, crypto, { ...letter, demoSessionId: candidate.session });
	return true;
}

/**
 * Whose letters the browser reads: `all` — every letter of the session, for a signed-in account of it; `accounts` — the
 * letters to the accounts registered within the session whose join token the browser holds, for anybody else.
 */
export interface LettersReader {
	sessionId: string;
	scope: 'all' | 'accounts';
}

/**
 * The letters the browser reads: those of the signed-in account's own demo session, else the letters to the accounts
 * registered within the live demo session of the browser (`browserSessionId`, from its cookie); `null` — none.
 */
export async function lettersReaderOf(
	executor: Executor,
	userId: string | null,
	browserSessionId: string | null
): Promise<LettersReader | null> {
	const actor = await demoActorOf(executor, userId);
	if (actor.kind === 'clone') return { sessionId: actor.sessionId, scope: 'all' };
	return browserSessionId === null ? null : { sessionId: browserSessionId, scope: 'accounts' };
}

/** Who the letter was for, as the page names them. */
export type LetterRecipient =
	| { kind: 'representative'; address: string }
	/** An account of the session: the link of the letter opens in its cabinet. */
	| { kind: 'account'; address: string; name: string };

export interface SessionLetterHead {
	id: string;
	/** `sent` — the letter left for the mailbox of the stand; `not_delivered` — a notification the clone had no channel for. */
	status: 'sent' | 'not_delivered';
	title: string;
	subject: string;
	recipient: LetterRecipient;
	at: Date;
}

export interface SessionLetter extends SessionLetterHead {
	text: string;
}

const KEPT_TITLES: Record<DemoLetterKind, string> = {
	consents: 'Согласия на обработку данных подростка',
	disclosure: 'Согласие на передачу контактов подростка',
	password_reset: 'Сброс пароля',
	verify_email: 'Подтверждение почты'
};

const payloadSchema = z.record(z.string(), z.unknown());

const isRepresentativeKind = (kind: DemoLetterKind): kind is RepresentativeLetterKind =>
	(REPRESENTATIVE_KINDS as readonly DemoLetterKind[]).includes(kind);

interface Deps {
	crypto: FieldCrypto;
	appOrigin: string;
}

/**
 * The letters kept with the session. A letter to an account names the account it was for; the letter of an account
 * deleted since is not shown, as its link opens nothing.
 */
async function keptLetters(
	executor: Executor,
	crypto: FieldCrypto,
	sessionId: string,
	filter: { kinds?: readonly DemoLetterKind[]; id?: string }
): Promise<SessionLetter[]> {
	const conditions: (SQL | undefined)[] = [
		eq(demoLetters.demoSessionId, sessionId),
		filter.kinds === undefined ? undefined : inArray(demoLetters.kind, [...filter.kinds]),
		filter.id === undefined ? undefined : eq(demoLetters.id, filter.id),
		or(inArray(demoLetters.kind, [...REPRESENTATIVE_KINDS]), isNotNull(users.id))
	];
	const rows = await executor
		.select({ letter: demoLetters, accountName: users.displayName })
		.from(demoLetters)
		.leftJoin(
			users,
			and(
				inArray(demoLetters.kind, [...ACCOUNT_KINDS]),
				eq(demoLetters.objectType, 'user'),
				eq(users.id, demoLetters.objectId),
				eq(users.demoSessionId, sessionId),
				ne(users.status, 'deleted')
			)
		)
		.where(and(...conditions))
		.orderBy(desc(demoLetters.createdAt));
	return rows.map(({ letter: row, accountName }) => ({
		id: row.id,
		status: 'sent',
		title: KEPT_TITLES[row.kind],
		subject: row.subject,
		recipient: isRepresentativeKind(row.kind)
			? { kind: 'representative', address: row.recipientMasked }
			: { kind: 'account', address: row.recipientMasked, name: accountName ?? 'Участник' },
		at: row.createdAt,
		text: crypto.decrypt(row.bodyEnc, 'demo_letters.body')
	}));
}

/**
 * Notifications the session's accounts received since the session opened, as the letters the delivery would send: the
 * same checks of the recipient and the object as `notification.deliver`, the recipient without an address or without
 * access to the object has no letter. The notifications copied with the cast are older than the session and are not
 * shown: the originals received them.
 */
async function notificationLetters(
	executor: Executor,
	deps: Deps,
	sessionId: string,
	id?: string
): Promise<SessionLetter[]> {
	const rows = await executor
		.select({
			id: notifications.id,
			userId: notifications.userId,
			type: notifications.type,
			objectType: notifications.objectType,
			objectId: notifications.objectId,
			payload: notifications.payload,
			createdAt: notifications.createdAt,
			emailEnc: users.emailEnc,
			displayName: users.displayName
		})
		.from(notifications)
		.innerJoin(users, eq(users.id, notifications.userId))
		.innerJoin(demoSessions, eq(demoSessions.id, users.demoSessionId))
		.where(
			and(
				eq(users.demoSessionId, sessionId),
				eq(users.status, 'active'),
				isNotNull(users.emailEnc),
				gte(notifications.createdAt, demoSessions.createdAt),
				id === undefined ? undefined : eq(notifications.id, id)
			)
		)
		.orderBy(desc(notifications.createdAt));
	const letters: SessionLetter[] = [];
	for (const row of rows) {
		const { type, emailEnc } = row;
		if (!isNotificationType(type)) throw new Error(`notification ${row.id} has unknown type ${type}`);
		if (emailEnc === null) throw new Error(`account ${row.userId} has no email`);
		const facts = await notificationFacts(executor, deps.crypto, { ...row, type });
		if (!facts) continue;
		const address = deps.crypto.decrypt(emailEnc, 'users.email');
		const letter = notificationLetter(
			address,
			type,
			facts,
			payloadSchema.parse(row.payload),
			notificationLinks(deps.appOrigin, row.id)
		);
		letters.push({
			id: row.id,
			status: 'not_delivered',
			title: NOTIFICATION_TYPES[type].title,
			subject: letter.subject,
			recipient: { kind: 'account', address: maskEmail(address), name: row.displayName ?? 'Участник' },
			at: row.createdAt,
			text: letter.text
		});
	}
	return letters;
}

/** Every letter the reader reads, newest first, without the texts. */
export async function sessionLetters(
	executor: Executor,
	deps: Deps,
	reader: LettersReader
): Promise<SessionLetterHead[]> {
	const letters =
		reader.scope === 'all'
			? [
					...(await keptLetters(executor, deps.crypto, reader.sessionId, {})),
					...(await notificationLetters(executor, deps, reader.sessionId))
				]
			: await keptLetters(executor, deps.crypto, reader.sessionId, { kinds: ACCOUNT_KINDS });
	return letters
		.sort((a, b) => b.at.getTime() - a.at.getTime())
		.map((letter) => ({
			id: letter.id,
			status: letter.status,
			title: letter.title,
			subject: letter.subject,
			recipient: letter.recipient,
			at: letter.at
		}));
}

/** One letter the reader reads, with its text; `null` — no such letter for the reader (or `id` is not an id). */
export async function sessionLetter(
	executor: Executor,
	deps: Deps,
	reader: LettersReader,
	id: string
): Promise<SessionLetter | null> {
	if (!z.uuid().safeParse(id).success) return null;
	if (reader.scope === 'accounts') {
		const [letter] = await keptLetters(executor, deps.crypto, reader.sessionId, { kinds: ACCOUNT_KINDS, id });
		return letter ?? null;
	}
	const [kept] = await keptLetters(executor, deps.crypto, reader.sessionId, { id });
	if (kept) return kept;
	const [rendered] = await notificationLetters(executor, deps, reader.sessionId, id);
	return rendered ?? null;
}
