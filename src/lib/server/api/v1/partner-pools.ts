// The pool of a competition partner (contracts 5.5; domain 5.5, 7.4): the finalists of the partnership's competition
// who consented to show the card to this company, each card in the catalog projection with the result of the
// competition exact. A partnership of another company is `404`; an own one that is not open is `403`.
import { z } from 'zod';
import { AWARDS } from '$lib/fsp/awards';
import type { AuditActor } from '$lib/server/audit/record';
import { loadCatalogCard } from '$lib/server/employer/card';
import { ApiError } from '$lib/server/errors/api-error';
import { journalPoolView, readPartnerPool } from '$lib/server/partner-pool/pool';
import { defineOperation } from '../operation';
import { cardSchema, cardView } from '../read/catalog-card';
import { date, id, key, pageOf, pageQuery, pseudonym } from '../schemas';
import { matchingDeps } from '../services';
import { activeMembership } from './context';

const TAG = 'Каталог';

const poolItem = z
	.object({
		pseudonym,
		result: z
			.object({
				stage: z.string().nullable(),
				place: z.int().nullable(),
				award: z.string().nullable()
			})
			.describe('Результат этого соревнования, по которому кандидат вошёл в пул'),
		card: cardSchema
	})
	.meta({ id: 'PartnerPoolItem' });

export const listPartnerPoolCandidates = defineOperation({
	id: 'listPartnerPoolCandidates',
	method: 'GET',
	path: '/partner-pools/{partnership_id}/candidates',
	tag: TAG,
	summary: 'Пул финалистов соревнования',
	description:
		'Для участника компании — партнёра соревнования (кейсодатель, спонсор): финалисты соревнования по правилу пула, ' +
		'давшие согласие показать карточку этой компании, только 18+. Карточка — в проекции каталога, результат ' +
		'соревнования партнёрства — точно. Партнёрство другой компании — `404`, закончившееся или вне срока — `403`. ' +
		'Ключу API нужны `partner_pool.read` и `candidate.card.read`. Приглашение — по общим правилам: ' +
		'`POST /invitations` на собственную вакансию.',
	auth: 'account',
	permission: 'partner_pool.read',
	params: z.strictObject({ partnership_id: id('Партнёрство компании') }),
	query: z.strictObject({
		role_key: z.array(key).max(20).optional().describe('Установленная роль любой категории (параметр повторяется)'),
		grade: z.array(key).max(10).optional().describe('Грейд внутри установленного диапазона (параметр повторяется)'),
		...pageQuery
	}),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Страница пула',
		schema: z.object({
			partnership: z.object({
				id: z.uuid(),
				competition_ref: z.string(),
				competition_title: z.string().nullable(),
				kind: z.enum(['case_provider', 'sponsor', 'organizer_partner']),
				pool_rule: z.object({
					min_award: z.enum(AWARDS),
					stages: z.array(z.enum(['qualifier', 'final', 'single']))
				}),
				valid_from: date,
				valid_to: date.nullable()
			}),
			items: z.array(poolItem),
			next_cursor: z.string().nullable()
		})
	},
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		if (membership === null || subject.userId === null) throw new ApiError('forbidden');
		const { cursor, limit, role_key: roleKeys, grade: gradeKeys } = ctx.query;
		const pool = await readPartnerPool(matchingDeps(ctx.services), subject, ctx.params.partnership_id, {
			...(roleKeys === undefined ? {} : { roleKeys }),
			...(gradeKeys === undefined ? {} : { gradeKeys })
		});
		const page = pageOf(
			pool.members,
			{ limit, ...(cursor === undefined ? {} : { cursor }) },
			{ partnership: pool.partnership.id, roleKeys, gradeKeys }
		);
		const now = ctx.services.now();
		const items = await Promise.all(
			page.items.map(async (member) => ({
				pseudonym: member.pseudonym,
				result: { stage: member.result.stage, place: member.result.place, award: member.result.award ?? null },
				card: cardView(
					await loadCatalogCard(ctx.services.db, {
						candidateId: member.candidateId,
						companyId: membership.companyId,
						pseudonym: member.pseudonym,
						extras: member.extras,
						partnerCompetitionRef: pool.partnership.competitionRef,
						now,
						signer: ctx.services.receiptSigner
					})
				)
			}))
		);
		const actor: AuditActor =
			ctx.actor.kind === 'api_key'
				? { kind: 'api_key', apiKeyId: ctx.actor.apiKeyId, userId: ctx.actor.userId, companyId: ctx.actor.companyId }
				: { kind: 'user', userId: subject.userId, companyId: membership.companyId };
		await journalPoolView(ctx.services.db, {
			actor,
			meta: { requestId: ctx.meta.requestId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent },
			partnershipId: pool.partnership.id,
			competitionRef: pool.partnership.competitionRef,
			cardCount: items.length
		});
		const { partnership } = pool;
		return {
			partnership: {
				id: partnership.id,
				competition_ref: partnership.competitionRef,
				competition_title: partnership.competitionTitle,
				kind: partnership.kind,
				pool_rule: partnership.poolRule,
				valid_from: partnership.validFrom,
				valid_to: partnership.validTo
			},
			items,
			next_cursor: page.next_cursor
		};
	}
});
