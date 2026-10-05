// Complaints of candidates about offers (domain 13.14): the candidate files one per offer and reads its status; the FSP
// operator works the queue and decides — no consequence, a warning, or the suspension of the company.
import { z } from 'zod';
import {
	complaintCase,
	complaintOfOffer,
	complaintQueue,
	decideComplaint,
	fileComplaint,
	COMPLAINT_TEXT_MAX,
	COMPLAINT_TEXT_MIN,
	type CandidateComplaint,
	type ComplaintQueueItem
} from '$lib/server/complaints/service';
import { COMPLAINT_DECISIONS, COMPLAINT_REASONS } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { companyTrust, companyTrustView, dateTime, id, iso, isoOrNull, offeredSalary } from '../schemas';
import { actionContext, invitationMeta } from './context';

const REASONS = {
	terms_mismatch: 'условия на деле не совпали с условиями предложения (на собеседовании назвали другое)',
	no_real_job: 'работы, которую описывает предложение, нет',
	contact_harvesting: 'предложение использовали, чтобы получить контакты',
	payment_demanded: 'от кандидата требовали оплату (обучение, оформление, оборудование)',
	discrimination: 'дискриминирующие требования или вопросы',
	other: 'иное'
} as const satisfies Record<(typeof COMPLAINT_REASONS)[number], string>;

const DECISIONS = {
	no_action: 'оснований для мер нет',
	warning: 'предупреждение компании; жалоба считается обоснованной в фактах доверия',
	suspension:
		'приостановка компании с причиной `complaint`: закрываются все её действия, неотвеченные предложения отзываются'
} as const satisfies Record<(typeof COMPLAINT_DECISIONS)[number], string>;

const describe = (entries: Record<string, string>) =>
	Object.entries(entries)
		.map(([key, meaning]) => `\`${key}\` — ${meaning}`)
		.join('; ');

const reasonCode = z.enum(COMPLAINT_REASONS).describe(`Причина: ${describe(REASONS)}`);
const decision = z.enum(COMPLAINT_DECISIONS).describe(`Решение: ${describe(DECISIONS)}`);

const complaintSchema = z
	.object({
		id: z.uuid(),
		reason_code: reasonCode,
		text: z.string().describe('Что произошло, словами кандидата; компания этот текст не видит'),
		status: z.enum(['open', 'decided']),
		decision: decision.nullable(),
		resolution: z.string().nullable().describe('Объяснение оператора кандидату'),
		created_at: dateTime,
		decided_at: dateTime.nullable()
	})
	.meta({ id: 'Complaint', description: 'Жалоба кандидата на предложение' });

const complaintView = (complaint: CandidateComplaint) => ({
	id: complaint.id,
	reason_code: complaint.reasonCode,
	text: complaint.text,
	status: complaint.status,
	decision: complaint.decision,
	resolution: complaint.resolution,
	created_at: iso(complaint.createdAt),
	decided_at: isoOrNull(complaint.decidedAt)
});

const offerParams = z.strictObject({ invitation_id: id('Предложение') });

export const fileOfferComplaint = defineOperation({
	id: 'fileOfferComplaint',
	method: 'POST',
	path: '/invitations/{invitation_id}/complaint',
	tag: 'Приглашения',
	summary: 'Пожаловаться на предложение',
	description:
		'Кандидат, которому адресовано предложение, — в любом статусе, в том числе после принятия. Одна жалоба на ' +
		'предложение: повтор — `409` (`complaint_exists`). Жалобу рассматривает оператор ФСП; компания узнаёт только об ' +
		'обоснованной жалобе и только её причину — не кто пожаловался и не текст.',
	auth: 'session',
	permission: 'complaint.create',
	params: offerParams,
	body: z.strictObject({
		reason_code: reasonCode,
		text: z.string().describe(`Что произошло: от ${COMPLAINT_TEXT_MIN} до ${COMPLAINT_TEXT_MAX} символов`)
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 201, description: 'Жалоба подана', schema: complaintSchema },
	async handle(ctx) {
		return complaintView(
			await fileComplaint(
				{ db: ctx.services.db, now: ctx.services.now },
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.invitation_id,
				{ reasonCode: ctx.body.reason_code, text: ctx.body.text }
			)
		);
	}
});

export const getOfferComplaint = defineOperation({
	id: 'getOfferComplaint',
	method: 'GET',
	path: '/invitations/{invitation_id}/complaint',
	tag: 'Приглашения',
	summary: 'Моя жалоба на предложение',
	description: 'Статус жалобы и объяснение оператора. Жалобы нет — `404`.',
	auth: 'session',
	permission: 'complaint.create',
	params: offerParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Жалоба', schema: complaintSchema },
	async handle(ctx) {
		const complaint = await complaintOfOffer(
			{ db: ctx.services.db, now: ctx.services.now },
			await ctx.subject(),
			ctx.params.invitation_id
		);
		if (complaint === null) throw new ApiError('not_found');
		return complaintView(complaint);
	}
});

const queueItem = z
	.object({
		id: z.uuid(),
		company_id: z.uuid(),
		company_name: z.string(),
		reason_code: reasonCode,
		status: z.enum(['open', 'decided']),
		decision: decision.nullable(),
		created_at: dateTime,
		decided_at: dateTime.nullable()
	})
	.meta({ id: 'ComplaintQueueItem', description: 'Жалоба в очереди оператора' });

const queueView = (item: ComplaintQueueItem) => ({
	id: item.id,
	company_id: item.companyId,
	company_name: item.companyName,
	reason_code: item.reasonCode,
	status: item.status,
	decision: item.decision,
	created_at: iso(item.createdAt),
	decided_at: isoOrNull(item.decidedAt)
});

export const listComplaints = defineOperation({
	id: 'listComplaints',
	method: 'GET',
	path: '/operator/complaints',
	tag: 'ФСП',
	summary: 'Очередь жалоб кандидатов',
	description: 'Открытые жалобы — старые первыми; последние 20 рассмотренных.',
	auth: 'session',
	permission: 'complaint.review',
	errors: [],
	response: {
		status: 200,
		description: 'Очередь',
		schema: z.object({ open: z.array(queueItem), decided: z.array(queueItem) })
	},
	async handle(ctx) {
		const queue = await complaintQueue(ctx.services.db, await ctx.subject());
		return { open: queue.open.map(queueView), decided: queue.decided.map(queueView) };
	}
});

const complaintParams = z.strictObject({ complaint_id: id('Жалоба') });

export const getComplaintCase = defineOperation({
	id: 'getComplaintCase',
	method: 'GET',
	path: '/operator/complaints/{complaint_id}',
	tag: 'ФСП',
	summary: 'Дело по жалобе',
	description:
		'Жалоба с текстом кандидата, предложение со всеми версиями условий, компания с её статусом, другими жалобами и ' +
		'фактами доверия. Каждое открытие — `operator.case_access` в журнале.',
	auth: 'session',
	permission: 'complaint.review',
	params: complaintParams,
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Дело',
		schema: complaintSchema.extend({
			company: z.object({
				id: z.uuid(),
				display_name: z.string(),
				inn: z.string(),
				status: z.enum(['draft', 'submitted', 'verified', 'rejected', 'suspended']),
				suspendable: z.boolean().describe('Приостановка возможна: политика допуска пока пропускает компанию'),
				complaints: z.object({ open: z.int(), upheld: z.int(), dismissed: z.int() }),
				trust: companyTrust
			}),
			offer: z.object({
				invitation_id: z.uuid(),
				status: z.enum(['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn']),
				complained_terms_id: z.uuid().describe('Версия условий, действовавшая в момент жалобы'),
				versions: z.array(
					z.object({ id: z.uuid(), version: z.int(), title: z.string(), salary: offeredSalary, created_at: dateTime })
				)
			})
		})
	},
	async handle(ctx) {
		const found = await complaintCase(
			{ db: ctx.services.db, now: ctx.services.now },
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.complaint_id
		);
		return {
			...complaintView(found),
			company: {
				id: found.company.id,
				display_name: found.company.displayName,
				inn: found.company.inn,
				status: found.company.status,
				suspendable: found.company.suspendable,
				complaints: found.companyComplaints,
				trust: companyTrustView(found.trust)
			},
			offer: {
				invitation_id: found.offer.invitationId,
				status: found.offer.status,
				complained_terms_id: found.offer.complainedTermsId,
				versions: found.offer.versions.map((version) => ({
					id: version.id,
					version: version.version,
					title: version.title,
					salary: {
						min: version.salary.min,
						max: version.salary.max,
						currency: version.salary.currency,
						period: version.salary.period,
						tax_base: version.salary.taxBase
					},
					created_at: iso(version.createdAt)
				}))
			}
		};
	}
});

export const decideOfferComplaint = defineOperation({
	id: 'decideOfferComplaint',
	method: 'POST',
	path: '/operator/complaints/{complaint_id}/decision',
	tag: 'ФСП',
	summary: 'Решение по жалобе',
	description:
		'`resolution` — объяснение для кандидата. `suspension` приостанавливает компанию в той же транзакции; компания, ' +
		'которую политика допуска уже не пропускает, — `409` (`not_admitted`). Жалоба уже рассмотрена — `409` ' +
		'(`already_decided`). Кандидату и, при обоснованной жалобе, владельцам компании уходит уведомление.',
	auth: 'session',
	permission: 'complaint.review',
	params: complaintParams,
	body: z.strictObject({
		decision,
		resolution: z.string().describe(`Объяснение кандидату: от ${COMPLAINT_TEXT_MIN} до ${COMPLAINT_TEXT_MAX} символов`)
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 204, description: 'Решение принято' },
	async handle(ctx) {
		await decideComplaint(
			{ db: ctx.services.db, now: ctx.services.now },
			await actionContext(ctx),
			ctx.params.complaint_id,
			{ decision: ctx.body.decision, resolution: ctx.body.resolution }
		);
	}
});
