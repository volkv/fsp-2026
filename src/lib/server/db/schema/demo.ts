// Demo sessions of the demonstration stand (docs/domain.md, section 19.3): the sandbox of one visitor with the clones of
// the scenario cast. Accounts, profiles and companies of a sandbox carry its id, and so do the letters it sent; everything
// else of it is found from them through the owner references of the clone plan (src/lib/server/demo/clone-plan.ts).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, enumCheck, id, sha256Check, timestamps, ts } from './_columns';

export const demoSessions = pgTable(
	'demo_sessions',
	{
		id: id(),
		/** SHA-256 of the join token; the token itself lives only in the visitors' browsers. */
		joinTokenSha256: text().notNull().unique('demo_sessions_join_token'),
		/** The seed batch whose cast was cloned. */
		seedBatchId: text().notNull(),
		/** The whole sandbox is removed after this moment (`demo.purge`). */
		expiresAt: ts().notNull(),
		/** First upload of the visitor's own resume: the sandbox then lives no longer than the resume may. */
		ownResumeAt: ts(),
		/**
		 * The shift of the session's clock for the regular jobs of its rows (domain 13.12): «промотать неделю» moves it on,
		 * and the delivery of calls of the session's companies runs at `now + clock_offset_seconds`.
		 */
		clockOffsetSeconds: integer().notNull().default(0),
		...timestamps()
	},
	(t) => [
		sha256Check('demo_sessions', 'join_token_sha256', t.joinTokenSha256),
		check('demo_sessions_clock_offset', sql`${t.clockOffsetSeconds} >= 0`),
		check('demo_sessions_expiry', sql`${t.expiresAt} > ${t.createdAt}`)
	]
);

export const DEMO_LETTER_KINDS = ['consents', 'disclosure', 'password_reset'] as const;

/**
 * Letters a demo session sent to the mailbox of the stand, which is not the visitor's to open: those to the legal
 * representative of a candidate of the session, and the password reset of an account registered within it. The visitor
 * reads them on the letters page of the session. The body carries the one-time link of the letter and is encrypted.
 * Letters outside demo sessions are never kept here.
 */
export const demoLetters = pgTable(
	'demo_letters',
	{
		id: id(),
		demoSessionId: uuid()
			.notNull()
			.references(() => demoSessions.id, { onDelete: 'cascade' }),
		kind: text({ enum: DEMO_LETTER_KINDS }).notNull(),
		/** The object the letter is about, as the journal names it (`representation`, `invitation`, `user`). */
		objectType: text().notNull(),
		objectId: uuid().notNull(),
		/** The address with most of it hidden: the visitor sees where the letter went, not the address itself. */
		recipientMasked: text().notNull(),
		subject: text().notNull(),
		/** The plain text of the letter (`demo_letters.body`). */
		bodyEnc: bytea().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('demo_letters', 'kind', t.kind, DEMO_LETTER_KINDS),
		index('demo_letters_session').on(t.demoSessionId, t.createdAt)
	]
);
