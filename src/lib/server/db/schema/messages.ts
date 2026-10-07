// Messages between a company and a candidate inside an accepted offer (docs/domain.md, section 13.15).
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, id, ts } from './_columns';
import { companyMembers } from './companies';
import { invitations } from './hiring';

export const MESSAGE_SIDES = ['candidate', 'company'] as const;

/** The longest message, in characters. */
export const MESSAGE_TEXT_MAX = 2000;

/**
 * One message of the conversation of an offer. The candidate's side is the addressee of the offer; the company's side
 * names the member who wrote it. `read_at` — when the other side first opened the conversation after it. The text is
 * plain: it is shown as text, never as markup. The purge of the candidate's account removes the conversation with the
 * terms of the offer (domain 19.2).
 */
export const invitationMessages = pgTable(
	'invitation_messages',
	{
		id: id(),
		invitationId: uuid()
			.notNull()
			.references(() => invitations.id),
		authorSide: text({ enum: MESSAGE_SIDES }).notNull(),
		authorMemberId: uuid().references(() => companyMembers.id),
		text: text().notNull(),
		readAt: ts(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('invitation_messages', 'author_side', t.authorSide, MESSAGE_SIDES),
		check('invitation_messages_author', sql`(${t.authorSide} = 'company') = (${t.authorMemberId} is not null)`),
		check(
			'invitation_messages_text_length',
			sql`char_length(${t.text}) between 1 and ${sql.raw(String(MESSAGE_TEXT_MAX))}`
		),
		check('invitation_messages_read_after_sent', sql`${t.readAt} is null or ${t.readAt} >= ${t.createdAt}`),
		index('invitation_messages_invitation').on(t.invitationId, t.createdAt)
	]
);
