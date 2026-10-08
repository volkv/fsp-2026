// The conversation of an accepted offer (docs/domain.md, section 13.15): the candidate and the members of the company
// of the offer write to each other on the platform instead of only trading contacts. It opens when the candidate
// accepts the offer — an agreement to talk, not to the job — and closes for writing when the candidate revokes the
// disclosure consent of the offer, leaves the platform, or the admission policy stops the company; what was written
// stays readable to both sides until the purge of the candidate's account removes it with the terms of the offer. A
// company on the candidate's block list does not see the candidate anywhere (`canShow`), so for it the conversation is
// closed for writing and for reading alike; the candidate still reads it.
// Nobody else reads it: another company, another candidate and the FSP staff get `404`. Across demo sessions the
// candidate reaches the conversations of the companies within their reach only (domain 19.3).
import { and, asc, eq, isNull, ne, type SQL } from 'drizzle-orm';
import { can, companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor, Transaction } from '$lib/server/db';
import {
	candidateCompanyBlocks,
	candidates,
	companies,
	companyMembers,
	invitationMessages,
	invitations,
	MESSAGE_TEXT_MAX,
	users
} from '$lib/server/db/schema';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { effectiveDisclosure } from '$lib/server/invitations/consent';
import { auditActor, type InvitationDeps, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { companyRecipients } from '$lib/server/invitations/notifications';
import { journalRefusal, lockInvitation, type InvitationRow } from '$lib/server/invitations/records';
import { notify } from '$lib/server/notifications/notify';

export type MessageSide = 'candidate' | 'company';

/**
 * Why nobody writes in the conversation now: the offer is not accepted (the conversation has not opened), the candidate
 * revoked the disclosure consent of the offer, the candidate's profile is being deleted or is gone, the candidate put the
 * company on their block list (the company reads nothing either), or the admission policy stops the company
 * (`suspended`, `rejected`).
 */
export type ConversationClosure =
	'not_accepted' | 'consent_revoked' | 'candidate_left' | 'candidate_unavailable' | 'company_closed';

export interface MessageView {
	id: string;
	side: MessageSide;
	/** Written by the viewer's own side. */
	own: boolean;
	/** The member of the company who wrote it, by the name of their account; `null` — the candidate, or no name. */
	authorName: string | null;
	text: string;
	sentAt: Date;
	/** When the other side first opened the conversation after it; `null` — not read yet. */
	readAt: Date | null;
}

export interface ConversationView {
	invitationId: string;
	viewer: MessageSide;
	/** `null` — the sides write to each other. */
	closure: ConversationClosure | null;
	messages: MessageView[];
	/** Messages of the other side the viewer has not read. */
	unread: number;
}

/**
 * The side of the subject in the offer, or `404`: the candidate it is addressed to (within their reach across demo
 * sessions) or a member of its company. Reading needs `invitation.read` only: a suspended company still reads.
 */
async function sideOf(executor: Executor, subject: AccessSubject, invitation: InvitationRow): Promise<MessageSide> {
	const access = can(subject, 'invitation.read', {
		companyId: invitation.companyId,
		candidateId: invitation.candidateId
	});
	if (!access.allowed) throw refuse('not_found', 'not_party');
	if (subject.candidate?.id !== invitation.candidateId) return 'company';
	const [company] = await executor
		.select({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
		.from(companies)
		.where(eq(companies.id, invitation.companyId));
	if (!company) throw new Error(`company ${invitation.companyId} does not exist`);
	if (!inDemoScope(company, await demoSessionOfUser(executor, subject.userId))) {
		throw refuse('not_found', 'not_in_demo_scope');
	}
	return 'candidate';
}

async function readableInvitation(executor: Executor, invitationId: string): Promise<InvitationRow> {
	const [invitation] = await executor.select().from(invitations).where(eq(invitations.id, invitationId));
	if (!invitation || invitation.purgedAt !== null) throw refuse('not_found', 'no_invitation');
	return invitation;
}

/** The candidate of the offer put its company on their block list. */
async function blockedByCandidate(executor: Executor, invitation: InvitationRow): Promise<boolean> {
	const [row] = await executor
		.select({ companyId: candidateCompanyBlocks.companyId })
		.from(candidateCompanyBlocks)
		.where(
			and(
				eq(candidateCompanyBlocks.candidateId, invitation.candidateId),
				eq(candidateCompanyBlocks.companyId, invitation.companyId)
			)
		);
	return row !== undefined;
}

/** Why the conversation of the offer is closed for writing at `now`; `null` — it is open. */
export async function conversationClosure(
	executor: Executor,
	invitation: InvitationRow,
	now: Date
): Promise<ConversationClosure | null> {
	if (invitation.status !== 'accepted') return 'not_accepted';
	const [candidate] = await executor
		.select({ status: candidates.status })
		.from(candidates)
		.where(eq(candidates.id, invitation.candidateId));
	if (candidate?.status !== 'active') return 'candidate_left';
	if (await blockedByCandidate(executor, invitation)) return 'candidate_unavailable';
	const [company] = await executor
		.select({ status: companies.status })
		.from(companies)
		.where(eq(companies.id, invitation.companyId));
	if (!company) throw new Error(`company ${invitation.companyId} does not exist`);
	if (!companyAdmission(company.status).admitted) return 'company_closed';
	if (!(await effectiveDisclosure(executor, invitation.candidateId, { invitationId: invitation.id }, now))) {
		return 'consent_revoked';
	}
	return null;
}

function otherSide(side: MessageSide): MessageSide {
	return side === 'candidate' ? 'company' : 'candidate';
}

async function messagesOf(
	executor: Executor,
	invitationId: string,
	viewer: MessageSide,
	only?: string
): Promise<MessageView[]> {
	const conditions: SQL[] = [eq(invitationMessages.invitationId, invitationId)];
	if (only !== undefined) conditions.push(eq(invitationMessages.id, only));
	const rows = await executor
		.select({
			id: invitationMessages.id,
			side: invitationMessages.authorSide,
			authorName: users.displayName,
			text: invitationMessages.text,
			sentAt: invitationMessages.createdAt,
			readAt: invitationMessages.readAt
		})
		.from(invitationMessages)
		.leftJoin(companyMembers, eq(companyMembers.id, invitationMessages.authorMemberId))
		.leftJoin(users, eq(users.id, companyMembers.userId))
		.where(and(...conditions))
		.orderBy(asc(invitationMessages.createdAt), asc(invitationMessages.id));
	return rows.map((row) => ({
		id: row.id,
		side: row.side,
		own: row.side === viewer,
		authorName: row.side === 'company' ? row.authorName : null,
		text: row.text,
		sentAt: row.sentAt,
		readAt: row.readAt
	}));
}

/** The company of the offer reads nothing while the candidate blocks it, as it sees nothing else of them. */
async function hiddenFrom(executor: Executor, invitation: InvitationRow, viewer: MessageSide): Promise<boolean> {
	return viewer === 'company' && (await blockedByCandidate(executor, invitation));
}

/**
 * The conversation of an offer for one of its sides; anyone else gets `404`. Reading marks nothing read. A company the
 * candidate blocked gets the closure without a single message.
 */
export async function getConversation(
	deps: InvitationDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<ConversationView> {
	const invitation = await readableInvitation(deps.db, invitationId);
	const viewer = await sideOf(deps.db, subject, invitation);
	const messages = (await hiddenFrom(deps.db, invitation, viewer))
		? []
		: await messagesOf(deps.db, invitation.id, viewer);
	return {
		invitationId: invitation.id,
		viewer,
		closure: await conversationClosure(deps.db, invitation, deps.now()),
		messages,
		unread: messages.filter((message) => !message.own && message.readAt === null).length
	};
}

/**
 * The side of the subject opened the conversation: the other side's messages it had not read are read now. Returns how
 * many were marked; a company the candidate blocked reads nothing and marks nothing.
 */
export async function markConversationRead(
	deps: InvitationDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<number> {
	const invitation = await readableInvitation(deps.db, invitationId);
	const viewer = await sideOf(deps.db, subject, invitation);
	if (await hiddenFrom(deps.db, invitation, viewer)) return 0;
	const marked = await deps.db
		.update(invitationMessages)
		.set({ readAt: deps.now() })
		.where(
			and(
				eq(invitationMessages.invitationId, invitation.id),
				eq(invitationMessages.authorSide, otherSide(viewer)),
				isNull(invitationMessages.readAt)
			)
		)
		.returning({ id: invitationMessages.id });
	return marked.length;
}

/** A control character other than a line break or a tab. */
const CONTROL = /(?![\n\t])\p{Cc}/u;

/** The text as it is stored: line breaks unified, the ends trimmed; plain text only, shown as text. */
export function messageText(raw: string): string {
	const text = raw.replace(/\r\n?/gu, '\n').trim();
	if (text.length === 0) throw invalid('text', 'Напишите сообщение');
	if (text.length > MESSAGE_TEXT_MAX) throw invalid('text', `Сообщение длиннее ${MESSAGE_TEXT_MAX} символов`);
	if (CONTROL.test(text)) throw invalid('text', 'В сообщении есть служебные символы');
	return text;
}

const CLOSURE_MESSAGES: Record<ConversationClosure, string> = {
	not_accepted: 'Переписка откроется, когда кандидат примет приглашение.',
	consent_revoked: 'Кандидат отозвал согласие на раскрытие контактов: переписка закрыта.',
	candidate_left: 'Профиль кандидата удаляется или удалён: переписка закрыта.',
	candidate_unavailable: 'Кандидат недоступен компании: переписка закрыта.',
	company_closed: 'Работа компании на платформе приостановлена: переписка закрыта.'
};

/**
 * The recipients of the notice about a new message: the candidate, or on the company side the member who sent the
 * offer while active, otherwise the active owners. One notice per run of unread messages: while the other side has
 * not opened the conversation since the previous message of this side, a new one adds no notice.
 */
async function noticeRecipients(tx: Transaction, invitation: InvitationRow, author: MessageSide): Promise<string[]> {
	if (author === 'company') {
		const [candidate] = await tx
			.select({ userId: candidates.userId })
			.from(candidates)
			.where(eq(candidates.id, invitation.candidateId));
		if (!candidate) throw new Error(`candidate ${invitation.candidateId} does not exist`);
		return [candidate.userId];
	}
	return companyRecipients(tx, invitation);
}

export async function sendMessage(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	raw: string
): Promise<MessageView> {
	const side: MessageSide = subject.candidate !== null && subject.membership === null ? 'candidate' : 'company';
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'invitation.message_sent', object: { type: 'invitation', id: invitationId }, side },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const invitation = await lockInvitation(tx, invitationId);
				if (!invitation) throw refuse('not_found', 'no_invitation');
				const author = await sideOf(tx, subject, invitation);
				const closure = await conversationClosure(tx, invitation, now);
				if (closure !== null) {
					throw refuse('conflict', `conversation_${closure}`, [
						{ code: 'conversation_closed', message: CLOSURE_MESSAGES[closure] }
					]);
				}
				const access = can(subject, 'invitation.message', {
					companyId: invitation.companyId,
					candidateId: invitation.candidateId
				});
				if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
				const text = messageText(raw);
				const memberId = author === 'company' ? subject.membership?.memberId : undefined;
				if (author === 'company' && memberId === undefined) throw new Error('a company message has its member');

				const [message] = await tx
					.insert(invitationMessages)
					.values({
						invitationId: invitation.id,
						authorSide: author,
						authorMemberId: memberId ?? null,
						text,
						createdAt: now
					})
					.returning({ id: invitationMessages.id });
				if (!message) throw new Error('message not inserted');

				const [unreadBefore] = await tx
					.select({ id: invitationMessages.id })
					.from(invitationMessages)
					.where(
						and(
							eq(invitationMessages.invitationId, invitation.id),
							eq(invitationMessages.authorSide, author),
							isNull(invitationMessages.readAt),
							ne(invitationMessages.id, message.id)
						)
					)
					.limit(1);
				if (!unreadBefore) {
					for (const userId of await noticeRecipients(tx, invitation, author)) {
						await notify(tx, {
							userId,
							type: 'invitation.message',
							objectId: invitation.id,
							stage: message.id,
							payload: { invitation_id: invitation.id, message_id: message.id, side: author }
						});
					}
				}
				await recordAuditEvent(tx, {
					action: 'invitation.message_sent',
					outcome: 'success',
					actor: auditActor(subject, meta, author),
					object: { type: 'invitation', id: invitation.id },
					subjectCandidateId: invitation.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: { side: author, message_id: message.id },
					occurredAt: now
				});
				const [view] = await messagesOf(tx, invitation.id, author, message.id);
				if (!view) throw new Error(`message ${message.id} disappeared`);
				return view;
			})
	);
}
