// Calls of companies (contracts 10.1, 10.2; domain 13.12): the company writes a short task with the range and the goal,
// the platform delivers it regularly to candidates of its categories, the company sees solutions by pseudonym and
// invites from a solution (an offer with a point of «why you» naming it); the candidate solves or withdraws. A demo
// session moves its clock a week on to show the next cycle of delivery at once.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import {
	dismissDelivery,
	myChallenges,
	openDelivery,
	submitSolution,
	withdrawSolution,
	type DeliveredChallenge
} from '$lib/server/challenges/candidate';
import {
	challengeSolutionsOf,
	createChallenge,
	dismissSolution,
	getChallenge,
	listChallenges,
	updateChallenge,
	type ChallengeView,
	type SolutionView
} from '$lib/server/challenges/company';
import { advanceDemoClock } from '$lib/server/challenges/deliver';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull, pseudonym } from '../schemas';
import { contactDeps } from '../services';
import { invitationMeta } from './context';

const TAG = 'Вызовы компаний';

const salary = z
	.object({
		min: z.int(),
		max: z.int(),
		currency: z.literal('RUB'),
		period: z.literal('month'),
		tax_base: z.enum(['gross', 'net'])
	})
	.describe('Видимая вилка: рубли в месяц');

const challengeSchema = z
	.object({
		id: z.uuid(),
		title: z.string(),
		statement: z.string(),
		answer_kind: z.enum(['solution', 'approach']).describe('`solution` — решение, `approach` — подход'),
		specialization: z.enum(SPECIALIZATION_KEYS),
		grades: z.array(z.enum(GRADE_KEYS)),
		salary,
		goal: z.string(),
		time_limit_minutes: z.int(),
		status: z.enum(['draft', 'active', 'closed']),
		starts_at: dateTime.nullable(),
		ends_at: dateTime,
		text_check: z.object({ result: z.enum(['clean', 'warnings', 'blocked']) }),
		created_at: dateTime,
		counts: z.object({ delivered: z.int(), opened: z.int(), solutions: z.int() })
	})
	.meta({ id: 'CompanyChallenge', description: 'Вызов компании' });

const challengeOut = (view: ChallengeView) => ({
	id: view.id,
	title: view.title,
	statement: view.statement,
	answer_kind: view.answerKind,
	specialization: view.specialization,
	grades: view.grades,
	salary: {
		min: view.salary.min,
		max: view.salary.max,
		currency: view.salary.currency,
		period: view.salary.period,
		tax_base: view.salary.taxBase
	},
	goal: view.goal,
	time_limit_minutes: view.timeLimitMinutes,
	status: view.status,
	starts_at: isoOrNull(view.startsAt),
	ends_at: iso(view.endsAt),
	text_check: { result: view.textCheck.result },
	created_at: iso(view.createdAt),
	counts: view.counts
});

const challengeBody = {
	title: z.string().describe('Название, до 120 символов'),
	statement: z.string().describe('Условие задачи, 50–5000 символов'),
	answer_kind: z.enum(['solution', 'approach']),
	specialization: z.enum(SPECIALIZATION_KEYS),
	grades: z.array(z.enum(GRADE_KEYS)).describe('Грейды категорий, которым доставляется вызов'),
	salary_min: z.int(),
	salary_max: z.int(),
	salary_currency: z.string().describe('Только `RUB`; другая валюта — `422 salary_not_rub`'),
	salary_tax_base: z.enum(['gross', 'net']),
	goal: z.string().describe('Цель вызова, до 500 символов'),
	time_limit_minutes: z.int().describe('Время на задачу, 5–30 минут'),
	ends_at: z.iso.datetime().describe('Окончание; не позже 60 дней от публикации')
};

const challengeParams = z.strictObject({ challenge_id: id('Вызов') });

export const createCompanyChallenge = defineOperation({
	id: 'createChallenge',
	method: 'POST',
	path: '/challenges',
	tag: TAG,
	summary: 'Создать вызов',
	description:
		'Черновик или сразу опубликованный (`publish: true`). Публикации нужен заполненный профиль компании ' +
		'(`422 company_profile_incomplete`) и открытая специализация; недопустимое требование в тексте — ' +
		'`422 text_blocked`; вилка не в рублях — `422 salary_not_rub`.',
	auth: 'account',
	permission: 'challenge.manage',
	idempotent: true,
	body: z.strictObject({ ...challengeBody, publish: z.boolean().default(false) }).meta({
		examples: [
			{
				title: 'Идемпотентный приём платежей',
				statement:
					'Сервис принимает платёж и иногда получает один и тот же запрос дважды. Как сделать приём идемпотентным?',
				answer_kind: 'approach',
				specialization: 'backend',
				grades: ['middle', 'senior'],
				salary_min: 250000,
				salary_max: 320000,
				salary_currency: 'RUB',
				salary_tax_base: 'gross',
				goal: 'Найти инженера в команду платежей',
				time_limit_minutes: 20,
				ends_at: '2026-11-01T00:00:00Z',
				publish: true
			}
		]
	}),
	errors: ['forbidden', 'policy_violation'],
	response: { status: 201, description: 'Вызов создан', schema: challengeSchema },
	async handle(ctx) {
		const body = ctx.body;
		return challengeOut(
			await createChallenge(contactDeps(ctx.services), await ctx.subject(), invitationMeta(ctx), {
				title: body.title,
				statement: body.statement,
				answerKind: body.answer_kind,
				specialization: body.specialization,
				grades: body.grades,
				salaryMin: body.salary_min,
				salaryMax: body.salary_max,
				salaryCurrency: body.salary_currency,
				salaryTaxBase: body.salary_tax_base,
				goal: body.goal,
				timeLimitMinutes: body.time_limit_minutes,
				endsAt: new Date(body.ends_at),
				publish: body.publish
			})
		);
	}
});

export const listCompanyChallenges = defineOperation({
	id: 'listChallenges',
	method: 'GET',
	path: '/challenges',
	tag: TAG,
	summary: 'Вызовы компании',
	description: 'Вызовы своей компании, новые первыми, с числом доставок, открытий и решений.',
	auth: 'account',
	permission: 'challenge.manage',
	errors: ['forbidden'],
	response: { status: 200, description: 'Вызовы', schema: z.object({ items: z.array(challengeSchema) }) },
	async handle(ctx) {
		return { items: (await listChallenges(contactDeps(ctx.services), await ctx.subject())).map(challengeOut) };
	}
});

export const getCompanyChallenge = defineOperation({
	id: 'getChallenge',
	method: 'GET',
	path: '/challenges/{challenge_id}',
	tag: TAG,
	summary: 'Вызов',
	description: 'Вызов своей компании; чужой — `404`.',
	auth: 'account',
	permission: 'challenge.manage',
	params: challengeParams,
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Вызов', schema: challengeSchema },
	async handle(ctx) {
		return challengeOut(await getChallenge(contactDeps(ctx.services), await ctx.subject(), ctx.params.challenge_id));
	}
});

const patchBody = z.strictObject({
	title: challengeBody.title.optional(),
	statement: challengeBody.statement.optional(),
	answer_kind: challengeBody.answer_kind.optional(),
	specialization: challengeBody.specialization.optional(),
	grades: challengeBody.grades.optional(),
	salary_min: challengeBody.salary_min.optional(),
	salary_max: challengeBody.salary_max.optional(),
	salary_currency: challengeBody.salary_currency.optional(),
	salary_tax_base: challengeBody.salary_tax_base.optional(),
	goal: challengeBody.goal.optional(),
	time_limit_minutes: challengeBody.time_limit_minutes.optional(),
	ends_at: challengeBody.ends_at.optional(),
	status: z.enum(['active', 'closed']).optional().describe('`active` — опубликовать черновик, `closed` — закрыть')
});

export const updateCompanyChallenge = defineOperation({
	id: 'updateChallenge',
	method: 'PATCH',
	path: '/challenges/{challenge_id}',
	tag: TAG,
	summary: 'Изменить, опубликовать или закрыть вызов',
	description:
		'Поля черновика меняются свободно; у опубликованного — только `ends_at` (кандидаты видели условия, иначе ' +
		'`409 challenge_published`). Закрытый — `409 challenge_closed`.',
	auth: 'account',
	permission: 'challenge.manage',
	params: challengeParams,
	body: patchBody,
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 200, description: 'Вызов', schema: challengeSchema },
	async handle(ctx) {
		const body = ctx.body;
		return challengeOut(
			await updateChallenge(
				contactDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.challenge_id,
				{
					...(body.title === undefined ? {} : { title: body.title }),
					...(body.statement === undefined ? {} : { statement: body.statement }),
					...(body.answer_kind === undefined ? {} : { answerKind: body.answer_kind }),
					...(body.specialization === undefined ? {} : { specialization: body.specialization }),
					...(body.grades === undefined ? {} : { grades: body.grades }),
					...(body.salary_min === undefined ? {} : { salaryMin: body.salary_min }),
					...(body.salary_max === undefined ? {} : { salaryMax: body.salary_max }),
					...(body.salary_currency === undefined ? {} : { salaryCurrency: body.salary_currency }),
					...(body.salary_tax_base === undefined ? {} : { salaryTaxBase: body.salary_tax_base }),
					...(body.goal === undefined ? {} : { goal: body.goal }),
					...(body.time_limit_minutes === undefined ? {} : { timeLimitMinutes: body.time_limit_minutes }),
					...(body.ends_at === undefined ? {} : { endsAt: new Date(body.ends_at) }),
					...(body.status === undefined ? {} : { status: body.status })
				}
			)
		);
	}
});

const solutionSchema = z
	.object({
		id: z.uuid(),
		candidate_pseudonym: pseudonym,
		category: z
			.object({ specialization: z.enum(SPECIALIZATION_KEYS), grade: z.enum(GRADE_KEYS) })
			.nullable()
			.describe('Категория кандидата в специализации вызова'),
		content: z.string(),
		submitted_at: dateTime,
		decision: z.enum(['invited', 'dismissed']).nullable(),
		decided_at: dateTime.nullable()
	})
	.meta({ id: 'ChallengeSolution', description: 'Решение или подход кандидата, псевдонимно' });

const solutionOut = (solution: SolutionView) => ({
	id: solution.id,
	candidate_pseudonym: solution.pseudonym,
	category: solution.category,
	content: solution.content,
	submitted_at: iso(solution.submittedAt),
	decision: solution.decision,
	decided_at: isoOrNull(solution.decidedAt)
});

export const listChallengeSolutions = defineOperation({
	id: 'listChallengeSolutions',
	method: 'GET',
	path: '/challenges/{challenge_id}/solutions',
	tag: TAG,
	summary: 'Решения вызова',
	description:
		'Решения и подходы по псевдонимам компании; отозванные и решения кандидатов, которых компания больше не видит, ' +
		'не показываются. Пригласить из решения — `POST /invitations` с пунктом «почему вы» ' +
		'`{source: {kind: challenge_solution, ref: <id решения>}}`.',
	auth: 'account',
	permission: 'challenge.manage',
	params: challengeParams,
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Решения',
		schema: z.object({ challenge: challengeSchema, solutions: z.array(solutionSchema) })
	},
	async handle(ctx) {
		const found = await challengeSolutionsOf(contactDeps(ctx.services), await ctx.subject(), ctx.params.challenge_id);
		return { challenge: challengeOut(found.challenge), solutions: found.solutions.map(solutionOut) };
	}
});

export const dismissChallengeSolution = defineOperation({
	id: 'dismissChallengeSolution',
	method: 'POST',
	path: '/challenges/{challenge_id}/solutions/{solution_id}/dismissal',
	tag: TAG,
	summary: 'Отложить решение',
	description: 'Компания не продолжает по решению; уже решённое — `409`.',
	auth: 'account',
	permission: 'challenge.manage',
	params: z.strictObject({ challenge_id: id('Вызов'), solution_id: id('Решение') }),
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 204, description: 'Решение отложено' },
	async handle(ctx) {
		await dismissSolution(
			contactDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.challenge_id,
			ctx.params.solution_id
		);
	}
});

const deliverySchema = z
	.object({
		delivery_id: z.uuid(),
		status: z.enum(['delivered', 'opened', 'solved', 'dismissed', 'expired']),
		delivered_at: dateTime,
		opened_at: dateTime.nullable(),
		reminded_at: dateTime.nullable(),
		challenge: z.object({
			id: z.uuid(),
			company: z.string(),
			title: z.string(),
			statement: z.string(),
			answer_kind: z.enum(['solution', 'approach']),
			specialization: z.enum(SPECIALIZATION_KEYS),
			grades: z.array(z.enum(GRADE_KEYS)),
			salary,
			goal: z.string(),
			time_limit_minutes: z.int(),
			ends_at: dateTime,
			open: z.boolean().describe('Решения принимаются')
		}),
		solution: z
			.object({
				id: z.uuid(),
				status: z.enum(['submitted', 'withdrawn']),
				content: z.string().nullable(),
				submitted_at: dateTime,
				decision: z.enum(['invited', 'dismissed']).nullable()
			})
			.nullable()
	})
	.meta({ id: 'DeliveredChallenge', description: 'Вызов, доставленный кандидату' });

const deliveryOut = (view: DeliveredChallenge) => ({
	delivery_id: view.deliveryId,
	status: view.status,
	delivered_at: iso(view.deliveredAt),
	opened_at: isoOrNull(view.openedAt),
	reminded_at: isoOrNull(view.remindedAt),
	challenge: {
		id: view.challenge.id,
		company: view.challenge.companyName,
		title: view.challenge.title,
		statement: view.challenge.statement,
		answer_kind: view.challenge.answerKind,
		specialization: view.challenge.specialization,
		grades: view.challenge.grades,
		salary: {
			min: view.challenge.salary.min,
			max: view.challenge.salary.max,
			currency: 'RUB' as const,
			period: 'month' as const,
			tax_base: view.challenge.salary.taxBase
		},
		goal: view.challenge.goal,
		time_limit_minutes: view.challenge.timeLimitMinutes,
		ends_at: iso(view.challenge.endsAt),
		open: view.challenge.open
	},
	solution: view.solution && {
		id: view.solution.id,
		status: view.solution.status,
		content: view.solution.content,
		submitted_at: iso(view.solution.submittedAt),
		decision: view.solution.decision
	}
});

const deliveryParams = z.strictObject({ delivery_id: id('Доставка вызова') });

export const listMyChallenges = defineOperation({
	id: 'listMyChallenges',
	method: 'GET',
	path: '/me/challenges',
	tag: TAG,
	summary: 'Мои вызовы',
	description: 'Вызовы, доставленные кандидату, новые первыми, с его решениями.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Вызовы', schema: z.object({ items: z.array(deliverySchema) }) },
	async handle(ctx) {
		return { items: (await myChallenges(contactDeps(ctx.services), await ctx.subject())).map(deliveryOut) };
	}
});

export const markChallengeViewed = defineOperation({
	id: 'markChallengeViewed',
	method: 'POST',
	path: '/me/challenges/{delivery_id}/viewed',
	tag: TAG,
	summary: 'Отметить вызов открытым',
	description: 'Открытие вызова свежесть профиля не меняет; чужая доставка — `404`.',
	auth: 'session',
	permission: 'candidate.self.read',
	params: deliveryParams,
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Вызов', schema: deliverySchema },
	async handle(ctx) {
		return deliveryOut(await openDelivery(contactDeps(ctx.services), await ctx.subject(), ctx.params.delivery_id));
	}
});

export const submitChallengeSolution = defineOperation({
	id: 'submitChallengeSolution',
	method: 'POST',
	path: '/me/challenges/{delivery_id}/solutions',
	tag: TAG,
	summary: 'Отправить решение или подход',
	description:
		'Одно решение на доставку; отозванное можно отправить снова. Вызов закрыт или срок прошёл — ' +
		'`409 challenge_closed`; решение уже отправлено — `409 already_submitted`. Отправленное решение освежает профиль.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: deliveryParams,
	body: z.strictObject({ content: z.string().describe('Текст или код, до 20 000 символов') }),
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 201, description: 'Решение отправлено', schema: deliverySchema },
	async handle(ctx) {
		return deliveryOut(
			await submitSolution(
				contactDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.delivery_id,
				ctx.body.content
			)
		);
	}
});

export const withdrawChallengeSolution = defineOperation({
	id: 'withdrawChallengeSolution',
	method: 'DELETE',
	path: '/me/challenges/{delivery_id}/solutions/{solution_id}',
	tag: TAG,
	summary: 'Отозвать решение',
	description: 'Решение принадлежит кандидату: отозванное компания больше не видит, его текст стирается.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ delivery_id: id('Доставка вызова'), solution_id: id('Решение') }),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Решение отозвано' },
	async handle(ctx) {
		await withdrawSolution(
			contactDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.delivery_id,
			ctx.params.solution_id
		);
	}
});

export const dismissMyChallenge = defineOperation({
	id: 'dismissMyChallenge',
	method: 'POST',
	path: '/me/challenges/{delivery_id}/dismissal',
	tag: TAG,
	summary: 'Не интересно',
	description: 'Вызов уходит из новых; решённый или закрытый — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: deliveryParams,
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 204, description: 'Вызов отклонён' },
	async handle(ctx) {
		await dismissDelivery(contactDeps(ctx.services), await ctx.subject(), ctx.params.delivery_id);
	}
});

export const advanceDemoSessionClock = defineOperation({
	id: 'advanceDemoClock',
	method: 'POST',
	path: '/demo/clock',
	tag: TAG,
	summary: 'Промотать неделю в демо-сессии',
	description:
		'Только учётке демо-сессии: часы сессии сдвигаются на неделю, и доставка вызовов компаний сессии сразу ' +
		'проходит на новых часах — повторный цикл без ожидания; другие сессии и строки вне сессий не меняются. ' +
		'Учётка вне демо-сессий — `403`.',
	auth: 'session',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Новый сдвиг часов и что сделала доставка',
		schema: z.object({
			clock_offset_seconds: z.int(),
			runs: z.array(
				z.object({
					challenge_id: z.uuid(),
					at: dateTime,
					delivered: z.int(),
					reminded: z.int(),
					expired: z.int(),
					closed: z.boolean()
				})
			)
		})
	},
	async handle(ctx) {
		const advanced = await advanceDemoClock(
			ctx.services.db,
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.services.now()
		);
		return {
			clock_offset_seconds: advanced.clockOffsetSeconds,
			runs: advanced.runs.map((run) => ({
				challenge_id: run.challengeId,
				at: iso(run.at),
				delivered: run.delivered,
				reminded: run.reminded,
				expired: run.expired,
				closed: run.closed
			}))
		};
	}
});
