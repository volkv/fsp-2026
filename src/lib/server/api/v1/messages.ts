// The conversation of an accepted offer (domain 13.15): the candidate and the company of the offer read and write it
// with the rights they have on the offer — reading by `invitation.read`, writing by `invitation.message`.
import { z } from 'zod';
import { MESSAGE_SIDES, MESSAGE_TEXT_MAX } from '$lib/server/db/schema';
import {
	getConversation,
	markConversationRead,
	sendMessage,
	type ConversationClosure,
	type MessageView
} from '$lib/server/messages/conversation';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull } from '../schemas';
import { invitationDeps } from '../services';
import { invitationMeta } from './context';

const TAG = 'Приглашения';

const invitationParams = z.strictObject({ invitation_id: id('Предложение') });

const CLOSURES = {
	not_accepted: 'кандидат ещё не принял предложение — переписка не открыта',
	consent_revoked: 'кандидат отозвал согласие на раскрытие контактов по этому предложению',
	candidate_left: 'профиль кандидата удаляется или удалён',
	candidate_unavailable:
		'кандидат закрыл компании доступ к профилю (блок-лист): компания не читает и не пишет, кандидат читает',
	company_closed: 'политика допуска останавливает компанию (`suspended`, `rejected`)'
} as const satisfies Record<ConversationClosure, string>;

const side = z.enum(MESSAGE_SIDES);

const messageSchema = z
	.object({
		id: z.uuid(),
		from: side.describe('Чья сторона написала: `candidate` — кандидат, `company` — сотрудник компании'),
		own: z.boolean().describe('Написано стороной того, кто читает'),
		author_name: z.string().nullable().describe('Имя сотрудника компании; у кандидата — `null`'),
		text: z.string().describe('Текст как есть: без разметки, ссылки — текстом'),
		sent_at: dateTime,
		read_at: dateTime.nullable().describe('Когда другая сторона открыла переписку после сообщения')
	})
	.meta({ id: 'OfferMessage', description: 'Сообщение переписки по предложению' });

const messageView = (message: MessageView) => ({
	id: message.id,
	from: message.side,
	own: message.own,
	author_name: message.authorName,
	text: message.text,
	sent_at: iso(message.sentAt),
	read_at: isoOrNull(message.readAt)
});

export const listOfferMessages = defineOperation({
	id: 'listOfferMessages',
	method: 'GET',
	path: '/invitations/{invitation_id}/messages',
	tag: TAG,
	summary: 'Переписка по предложению',
	description:
		'Стороне предложения — все сообщения, старые первыми, и открыта ли переписка для записи. Переписка открывается, ' +
		'когда кандидат принимает предложение: это согласие общаться, а не принятие трудового оффера. Чтение ничего не ' +
		'отмечает прочитанным. Компании, которую кандидат заблокировал, — ни одного сообщения ' +
		'(`closure: candidate_unavailable`). Чужое предложение — `404`.',
	auth: 'account',
	permission: 'invitation.read',
	params: invitationParams,
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Переписка',
		schema: z.object({
			invitation_id: z.uuid(),
			viewer: side.describe('Сторона того, кто читает'),
			closure: z
				.enum(Object.keys(CLOSURES) as [ConversationClosure, ...ConversationClosure[]])
				.nullable()
				.describe(
					`Почему писать нельзя; \`null\` — переписка открыта. ${Object.entries(CLOSURES)
						.map(([key, meaning]) => `\`${key}\` — ${meaning}`)
						.join('; ')}`
				),
			unread: z.int().nonnegative().describe('Непрочитанные сообщения другой стороны'),
			messages: z.array(messageSchema)
		})
	},
	async handle(ctx) {
		const conversation = await getConversation(
			invitationDeps(ctx.services),
			await ctx.subject(),
			ctx.params.invitation_id
		);
		return {
			invitation_id: conversation.invitationId,
			viewer: conversation.viewer,
			closure: conversation.closure,
			unread: conversation.unread,
			messages: conversation.messages.map(messageView)
		};
	}
});

export const sendOfferMessage = defineOperation({
	id: 'sendOfferMessage',
	method: 'POST',
	path: '/invitations/{invitation_id}/messages',
	tag: TAG,
	summary: 'Написать в переписку',
	description:
		`Сообщение стороне предложения: текст до ${MESSAGE_TEXT_MAX} символов, без вложений; разметка не исполняется, ` +
		'ссылки остаются текстом. Только в принятом предложении, пока действует согласие кандидата на раскрытие, профиль ' +
		'кандидата не удаляется и политика допуска пускает компанию; иначе — `409` с деталью `conversation_closed`. ' +
		'Другая сторона получает уведомление без текста сообщения — одно на серию непрочитанных. Каждое сообщение ' +
		'пишется в журнал без текста.',
	auth: 'account',
	permission: 'invitation.message',
	idempotent: true,
	params: invitationParams,
	body: z.strictObject({
		text: z.string().describe(`Текст сообщения, 1–${MESSAGE_TEXT_MAX} символов`)
	}),
	errors: ['not_found', 'forbidden', 'conflict'],
	response: { status: 201, description: 'Сообщение отправлено', schema: messageSchema },
	async handle(ctx) {
		return messageView(
			await sendMessage(
				invitationDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.invitation_id,
				ctx.body.text
			)
		);
	}
});

export const readOfferMessages = defineOperation({
	id: 'markOfferMessagesRead',
	method: 'POST',
	path: '/invitations/{invitation_id}/messages/read',
	tag: TAG,
	summary: 'Отметить переписку прочитанной',
	description: 'Сообщения другой стороны, которые читающий ещё не открывал, отмечаются прочитанными.',
	auth: 'account',
	permission: 'invitation.read',
	params: invitationParams,
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Сколько сообщений отмечено',
		schema: z.object({ marked: z.int().nonnegative() })
	},
	async handle(ctx) {
		return {
			marked: await markConversationRead(invitationDeps(ctx.services), await ctx.subject(), ctx.params.invitation_id)
		};
	}
});
