// The test on a declared grade (contracts 10.1, 10.3; domain 10): the candidate starts a test the grade policy lets them
// take, reads the attempt — statements of the served clusters, never keys — answers the current cluster and reads the
// decision with its explanation by blocks. The administrator reads the releases of the bank with their admission and
// capacity reports. Candidate operations are the browser session only.
import { z } from 'zod';
import { bankReleasesOverview } from '$lib/server/assessments/bank-store';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { answerItem, startAttempt, type AdvanceOutcome, type AnswerPayload } from '$lib/server/assessments/engine';
import { clientSignalsSchema } from '$lib/server/assessments/signals';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { attemptState, decisionView, type AttemptState, type ItemView } from '$lib/server/assessments/views';
import { DECISION_OUTCOMES } from '$lib/server/db/schema';
import { defineOperation } from '../operation';
import { dateTime, iso, isoOrNull } from '../schemas';

const TAG = 'Тест на грейд';
const DEPS = { standing: OWNER_STANDING };

const specialization = z.enum(SPECIALIZATION_KEYS);
const grade = z.enum(GRADE_KEYS);
const json = z.record(z.string(), z.unknown());

const itemSchema = z
	.object({
		seq: z.int().describe('Номер слота плана теста, с 1'),
		block: z.string(),
		block_title: z.string(),
		format: z.string(),
		practice: z.boolean(),
		status: z.enum(['served', 'answered', 'scored', 'awaiting_sandbox']),
		statement: z.object({
			markdown: z.string(),
			code: z.object({ language: z.string(), source: z.string() }).nullable()
		}),
		answer_kind: z
			.string()
			.describe('`exact`, `tokens`, `float_eps`, `set`, `sequence`, `line_no`, `code`, `test_cases`'),
		languages: z.array(z.string()).describe('Языки практики'),
		qa: z
			.object({ budget: z.object({ min: z.int(), max: z.int() }), specification: z.string() })
			.nullable()
			.describe('Практика QA: бюджет тест-кейсов и спецификация'),
		change_step: z
			.object({ markdown: z.string(), kind: z.enum(['code', 'cases']), specification: z.string().nullable() })
			.nullable()
			.describe('Шаг «измени своё решение»: открывается после оценки задачи; у QA — изменённая спецификация'),
		time_norm_sec: z.int(),
		answers: z.array(z.object({ kind: z.string(), stage: z.string(), content: json.nullable(), created_at: dateTime })),
		practice_result: z
			.array(z.object({ stage: z.string(), passed_groups: z.int(), total_groups: z.int() }))
			.describe('Пройдено групп скрытых тестов; входы тестов не раскрываются')
	})
	.meta({ id: 'TestItem', description: 'Поданный кластер: условие без ключа и скрытых тестов' });

const itemOut = (item: ItemView) => ({
	seq: item.seq,
	block: item.block,
	block_title: item.blockTitle,
	format: item.format,
	practice: item.practice,
	status: item.status,
	statement: item.statement,
	answer_kind: item.answerKind,
	languages: [...item.languages],
	qa: item.qa,
	change_step: item.changeStep,
	time_norm_sec: item.timeNormSec,
	answers: item.answers.map((a) => ({
		kind: a.kind,
		stage: a.stage,
		content: a.content,
		created_at: iso(a.createdAt)
	})),
	practice_result: item.practiceResult.map((r) => ({
		stage: r.stage,
		passed_groups: r.passedGroups,
		total_groups: r.totalGroups
	}))
});

const attemptSchema = z
	.object({
		id: z.uuid(),
		specialization,
		grade,
		form: z.enum(['A', 'B']).nullable().describe('Форма попытки на грейд; у блок-теста и перепроверки — `null`'),
		status: z.enum(['in_progress', 'decided', 'expired', 'annulled']),
		started_at: dateTime,
		deadline_at: dateTime,
		ended_at: dateTime.nullable(),
		seeded: z.boolean().describe('Синтетика засева: решения без песочницы'),
		annul_reason: z.string().nullable(),
		decision_id: z.uuid().nullable(),
		current: z.int().nullable().describe('Номер кластера, на который кандидат отвечает сейчас'),
		waiting_sandbox: z.boolean().describe('Практика проверяется в песочнице'),
		items: z.array(itemSchema)
	})
	.meta({ id: 'TestAttempt' });

const attemptOut = (state: AttemptState) => ({
	id: state.id,
	specialization: state.specialization,
	grade: state.grade,
	form: state.form,
	status: state.status,
	started_at: iso(state.startedAt),
	deadline_at: iso(state.deadlineAt),
	ended_at: isoOrNull(state.endedAt),
	seeded: state.seeded,
	annul_reason: state.annulReason,
	decision_id: state.decision?.id ?? null,
	current: state.current,
	waiting_sandbox: state.waitingSandbox,
	items: state.items.map(itemOut)
});

const stepSchema = z
	.object({
		kind: z
			.enum(['continue', 'awaiting_sandbox', 'decided', 'expired'])
			.describe(
				'`continue` — следующий кластер (или открытый шаг «измени своё решение») ждёт ответа; `awaiting_sandbox` — ' +
					'практика проверяется, следующий кластер появится после проверки; `decided` — решение принято; ' +
					'`expired` — срок попытки истёк'
			),
		decision_id: z.uuid().nullable(),
		confirmation_id: z
			.uuid()
			.nullable()
			.describe('Результат блок-теста по запросу работодателя (`decided` попытки `vacancy_block`)'),
		attempt: attemptSchema
	})
	.meta({ id: 'TestStep' });

function stepKind(outcome: AdvanceOutcome): 'continue' | 'awaiting_sandbox' | 'decided' | 'expired' {
	switch (outcome.kind) {
		case 'next':
		case 'waiting_candidate':
			return 'continue';
		case 'waiting_sandbox':
			return 'awaiting_sandbox';
		case 'decided':
		case 'block_decided':
			return 'decided';
		case 'expired':
			return 'expired';
	}
}

export const startTest = defineOperation({
	id: 'startTest',
	method: 'POST',
	path: '/me/tests',
	tag: TAG,
	summary: 'Начать тест на грейд',
	description:
		'Попытка начинается, только если политика грейда отвечает `available` для этого грейда (domain 12.3); иначе ' +
		'`409 conflict` с кодом причины (`retake_interval`, `grade_change_interval`, `attempt_limit`, ' +
		'`attempt_in_progress`, `lower_requires_failure`, `above_declared`, `above_next_grade`, `already_confirmed`, ' +
		'`below_confirmed`, `not_declared`) и датой, когда тест откроется. Закрытая специализация — `422 ' +
		'specialization_closed`. Форма попытки — по сиду, повтор на тот же грейд — на другой форме; первый кластер ' +
		'подаётся сразу.',
	auth: 'session',
	permission: 'candidate.self.write',
	body: z.strictObject({ specialization, grade }),
	errors: ['conflict', 'policy_violation', 'forbidden'],
	response: { status: 201, description: 'Попытка начата', schema: attemptSchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const now = ctx.services.now();
		const { attempt } = await startAttempt(ctx.services.db, DEPS, subject, ctx.body, {
			now,
			requestId: ctx.meta.requestId
		});
		return attemptOut(await attemptState(ctx.services.db, subject, attempt.id, now));
	}
});

export const getTest = defineOperation({
	id: 'getTest',
	method: 'GET',
	path: '/me/tests/{attempt_id}',
	tag: TAG,
	summary: 'Состояние попытки',
	description:
		'Поданные кластеры с условиями (без ключей, скрытых тестов и мутантов), свои ответы, текущий кластер и срок. ' +
		'Чужая попытка — `404`.',
	auth: 'session',
	permission: 'candidate.self.read',
	params: z.strictObject({ attempt_id: z.uuid() }),
	errors: ['not_found', 'forbidden'],
	response: { status: 200, description: 'Попытка', schema: attemptSchema },
	async handle(ctx) {
		const state = await attemptState(ctx.services.db, await ctx.subject(), ctx.params.attempt_id, ctx.services.now());
		return attemptOut(state);
	}
});

const candidateAnswer = z.union([z.string().max(10_000), z.array(z.string().max(1_000)).max(100)]);

const answerBody = z
	.strictObject({
		answer: candidateAnswer.optional().describe('Вычисляемый ответ; для множества и последовательности — массив'),
		language: z.string().max(64).optional().describe('Язык программы практики'),
		source: z.string().optional().describe('Программа практики, до 64 КБ'),
		cases: z
			.array(z.strictObject({ input: z.string().max(10_000), expected: z.string().max(10_000) }))
			.max(50)
			.optional()
			.describe('Тест-кейсы QA'),
		change_step: z
			.union([
				z.strictObject({ language: z.string().max(64), source: z.string() }),
				z.strictObject({
					cases: z.array(z.strictObject({ input: z.string().max(10_000), expected: z.string().max(10_000) })).max(50)
				})
			])
			.optional()
			.describe('Ответ на шаг «измени своё решение»: программа или тест-кейсы QA для изменённой спецификации'),
		signals: clientSignalsSchema
			.optional()
			.describe('Сигналы страницы: время, вставки, уходы — для человека, не для решения')
	})
	.refine(
		(body) =>
			[
				body.answer !== undefined,
				body.source !== undefined,
				body.cases !== undefined,
				body.change_step !== undefined
			].filter(Boolean).length === 1,
		{ message: 'Нужен ровно один вид ответа: answer, source, cases или change_step' }
	);

function payloadOf(body: z.output<typeof answerBody>): AnswerPayload {
	if (body.answer !== undefined) return { kind: 'answer', answer: body.answer };
	if (body.source !== undefined) return { kind: 'code', language: body.language ?? '', source: body.source };
	if (body.cases !== undefined) return { kind: 'cases', cases: body.cases };
	const step = body.change_step;
	if (step === undefined) throw new Error('the body schema admits one kind of answer');
	return 'cases' in step
		? { kind: 'change_step_cases', cases: step.cases }
		: { kind: 'change_step_code', language: step.language, source: step.source };
}

export const answerTestItem = defineOperation({
	id: 'answerTestItem',
	method: 'POST',
	path: '/me/tests/{attempt_id}/items/{seq}/answer',
	tag: TAG,
	summary: 'Ответить на кластер',
	description:
		'`answer` — вычисляемый ответ; `language` и `source` — программа практики; `cases` — тест-кейсы QA (бюджет ' +
		'задания, иначе `422 qa_budget_too_small` / `qa_budget_exceeded`); `change_step` — шаг «измени своё решение». ' +
		'Ответ — следующий шаг процедуры: `continue` со следующим кластером, `awaiting_sandbox` (практика проверяется, ' +
		'состояние попытки — `GET /me/tests/{attempt_id}`), `decided` с решением, `expired`. Кластер уже отвечен или не ' +
		'текущий — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ attempt_id: z.uuid(), seq: z.coerce.number().int().min(1).max(64) }),
	body: answerBody,
	errors: ['not_found', 'conflict', 'policy_violation', 'forbidden'],
	response: { status: 200, description: 'Следующий шаг', schema: stepSchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const now = ctx.services.now();
		const result = await answerItem(
			ctx.services.db,
			DEPS,
			subject,
			{
				attemptId: ctx.params.attempt_id,
				seq: ctx.params.seq,
				payload: payloadOf(ctx.body),
				signals: ctx.body.signals ?? null
			},
			{ now, requestId: ctx.meta.requestId }
		);
		const outcome = result.outcome.kind === 'pending' ? result.outcome.next : result.outcome;
		return {
			kind: stepKind(outcome),
			decision_id: outcome.kind === 'decided' ? outcome.decisionId : null,
			confirmation_id: outcome.kind === 'block_decided' ? outcome.confirmationId : null,
			attempt: attemptOut(await attemptState(ctx.services.db, subject, result.attemptId, now))
		};
	}
});

const blockSchema = z.object({
	code: z.string(),
	title: z.string(),
	checks: z.string(),
	items: z.int(),
	score: z.number(),
	cut: z.number(),
	verdict: z.string().describe('«выше порога», «на уровне порога», «ниже порога»'),
	defining: z.boolean().describe('Определяющий блок грейда'),
	passed: z
		.boolean()
		.describe('Определяющий блок пройден: решение подтверждено, заданий не меньше трёх, блок не провален')
});

export const getGradeDecision = defineOperation({
	id: 'getGradeDecision',
	method: 'GET',
	path: '/me/tests/decisions/{decision_id}',
	tag: TAG,
	summary: 'Решение о грейде и объяснение',
	description:
		'Из сохранённого решения, без пересчёта (ч. 3 ст. 16 152-ФЗ): итог и причина словами, набрано `S` при пороге ' +
		'`C` по поданным заданиям, блоки с баллом, порогом и вердиктом, практика и её ворота, что тест не проверяет, ' +
		'как проверены задания (`judgement`: рубрики только моделями, пороги предварительные), что дальше по политике ' +
		'грейда. Ответы и ключи заданий не входят. Чужое решение — `404`.',
	auth: 'session',
	permission: 'candidate.self.read',
	params: z.strictObject({ decision_id: z.uuid() }),
	errors: ['not_found', 'forbidden'],
	response: {
		status: 200,
		description: 'Решение',
		schema: z
			.object({
				id: z.uuid(),
				attempt_id: z.uuid(),
				specialization,
				grade,
				status: z.enum(['valid', 'annulled', 'superseded']),
				outcome: z.enum(DECISION_OUTCOMES),
				decided_at: dateTime,
				bank_release_id: z.string(),
				procedure_version: z.string(),
				seeded: z.boolean(),
				explanation: z.object({
					title: z.string(),
					reason: z.string(),
					summary: z.string(),
					confident: z.boolean().describe('Уверенный результат: тест следующего грейда доступен сразу'),
					blocks: z.array(blockSchema),
					practice: z
						.object({ title: z.string(), score: z.number(), gate_min_score: z.number(), passed: z.boolean() })
						.nullable()
						.describe('Ворота практики; `null` — попытка закончилась до практики'),
					does_not_check: z.array(z.string())
				}),
				judgement: z
					.object({
						rubric_by_models_only: z
							.boolean()
							.describe('Рубрика хотя бы одного задания попытки одобрена только независимыми моделями'),
						angoff_provisional: z
							.boolean()
							.describe('Порог хотя бы одного задания попытки — по оценкам моделей: предварительный'),
						same_vendor_reviewer: z
							.boolean()
							.describe('Одна из моделей-рецензентов — того же поставщика, что модель-автор заданий')
					})
					.describe('Как проверены задания попытки (domain 10.8); интерфейс показывает подпись'),
				next: z.array(
					z.object({
						grade,
						available: z.boolean(),
						kind: z.string().nullable(),
						reason: z.string().nullable(),
						available_from: dateTime.nullable()
					})
				)
			})
			.meta({ id: 'GradeDecision' })
	},
	async handle(ctx) {
		const view = await decisionView(ctx.services.db, await ctx.subject(), ctx.params.decision_id, ctx.services.now());
		const { explanation } = view;
		return {
			id: view.id,
			attempt_id: view.attemptId,
			specialization: view.specialization,
			grade: view.grade,
			status: view.status,
			outcome: view.outcome,
			decided_at: iso(view.decidedAt),
			bank_release_id: view.bankReleaseId,
			procedure_version: view.procedureVersion,
			seeded: view.seeded,
			explanation: {
				title: explanation.title,
				reason: explanation.reason,
				summary: explanation.summary,
				confident: explanation.confident,
				blocks: explanation.blocks,
				practice: explanation.practice && {
					title: explanation.practice.title,
					score: explanation.practice.score,
					gate_min_score: explanation.practice.gateMinScore,
					passed: explanation.practice.passed
				},
				does_not_check: explanation.doesNotCheck
			},
			judgement: {
				rubric_by_models_only: view.judgement.rubricByModelsOnly,
				angoff_provisional: view.judgement.angoffProvisional,
				same_vendor_reviewer: view.judgement.sameVendorReviewer
			},
			next: view.next.map((option) => ({
				grade: option.grade,
				available: option.available,
				kind: option.available ? option.kind : null,
				reason: option.available ? null : option.reason,
				available_from: option.available ? null : (option.availableFrom?.toISOString() ?? null)
			}))
		};
	}
});

const reviewerSchema = z
	.discriminatedUnion('kind', [
		z.object({ kind: z.literal('model'), model: z.string(), lineage: z.string() }),
		z.object({ kind: z.literal('person'), name: z.string() })
	])
	.describe('Рецензент: независимая модель с её линейкой или человек команды');

export const listBankReleases = defineOperation({
	id: 'listBankReleases',
	method: 'GET',
	path: '/admin/bank-releases',
	tag: 'Администрирование',
	summary: 'Выпуски банка заданий',
	description:
		'Выпуски по специализациям, новые первыми: статус, хэш содержимого, семейства-уровни по грейдам и блокам, ' +
		'опорные, отчёт вместимости по предельным траекториям, итоги симуляции траекторий (машинные испытуемые, ' +
		'предположения названы в коде движка), ревью рубрик и Angoff-оценки семейств с рецензентами (модель и её ' +
		'линейка или человек), хэш исходников семейства и сводка: сколько семейств-уровней грейда проверено только ' +
		'моделями и на предварительном пороге.',
	auth: 'session',
	permission: 'policy.manage',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Выпуски',
		schema: z.object({
			items: z.array(
				z
					.object({
						id: z.string(),
						specialization,
						status: z.enum(['released', 'retired']),
						catalog_version: z.string(),
						procedure_version: z.string(),
						content_sha256: z.string(),
						shared_sha256: z.string().describe('Хэш общего кода генераторов'),
						released_at: dateTime,
						retired_at: dateTime.nullable(),
						families: z.int(),
						levels_by_block: z.record(z.string(), z.record(z.string(), z.int())),
						anchors: z.record(z.string(), z.array(z.string())),
						capacity: z.array(
							z.object({
								grade,
								scenario: z
									.string()
									.describe('История кандидата: попытки (форма и слотов), блок-тесты и перепроверки через `→`'),
								ok: z.boolean(),
								shortages: z.array(z.object({ step: z.string(), position: z.int(), block: z.string() }))
							})
						),
						trajectories: z
							.object({
								model: z.object({ rho: z.number(), practice_groups: z.int() }),
								grades: z.array(
									z.object({
										grade,
										points: z.array(
											z.object({
												shift: z.number(),
												runs: z.int(),
												confirmed: z.number(),
												undetermined: z.number(),
												not_confirmed: z.number()
											})
										),
										consistency: z.array(z.object({ shift: z.number(), value: z.number() }))
									})
								)
							})
							.nullable()
							.describe('Отчёт траекторий: машинные испытуемые, предположения названы'),
						judgement: z
							.array(
								z.object({
									grade,
									levels: z.int(),
									rubric_by_models_only: z.int(),
									angoff_provisional: z.int(),
									same_vendor_reviewer: z.int()
								})
							)
							.describe(
								'Семейства-уровни грейда: всего, с рубрикой только от моделей, с предварительным порогом, ' +
									'с рецензентом того же поставщика, что модель-автор'
							),
						reviews: z.array(
							z.object({
								family: z.string(),
								source_sha256: z.string().describe('Хэш исходников семейства в выпуске'),
								authors: z.array(z.string()).describe('Авторы семейства; модель — `<модель> (<поставщик>)`'),
								rubric_reviews: z.array(
									z.object({
										reviewer: reviewerSchema,
										reviewed_at: z.string(),
										verdict: z.enum(['approved', 'changes_requested']),
										remarks: z.array(z.string()),
										on_current_sources: z.boolean()
									})
								),
								levels: z.array(
									z.object({
										grade,
										round: z.int(),
										mean: z.number(),
										same_vendor_reviewer: z.boolean(),
										ratings: z.array(
											z.object({
												rater: reviewerSchema,
												p: z.number(),
												rated_at: z.string(),
												on_current_sources: z.boolean()
											})
										)
									})
								)
							})
						)
					})
					.meta({ id: 'BankRelease' })
			)
		})
	},
	async handle(ctx) {
		const releases = await bankReleasesOverview(ctx.services.db);
		return {
			items: releases.map((r) => ({
				id: r.id,
				specialization: r.specialization,
				status: r.status,
				catalog_version: r.catalogVersion,
				procedure_version: r.procedureVersion,
				content_sha256: r.contentSha256,
				shared_sha256: r.sharedSha256,
				released_at: iso(r.releasedAt),
				retired_at: isoOrNull(r.retiredAt),
				families: r.families,
				levels_by_block: r.levelsByBlock,
				anchors: r.anchors,
				capacity: r.capacity,
				trajectories: r.trajectories && {
					model: { rho: r.trajectories.model.rho, practice_groups: r.trajectories.model.practiceGroups },
					grades: r.trajectories.grades.map((g) => ({
						grade: g.grade,
						points: g.points.map((p) => ({
							shift: p.shift,
							runs: p.runs,
							confirmed: p.confirmed,
							undetermined: p.undetermined,
							not_confirmed: p.notConfirmed
						})),
						consistency: [...g.consistency]
					}))
				},
				judgement: GRADE_KEYS.map((g) => ({
					grade: g,
					levels: r.judgement[g].levels,
					rubric_by_models_only: r.judgement[g].rubricByModelsOnly,
					angoff_provisional: r.judgement[g].angoffProvisional,
					same_vendor_reviewer: r.judgement[g].sameVendorReviewer
				})),
				reviews: r.reviews.map((family) => ({
					family: family.key,
					source_sha256: family.sourceSha256,
					authors: [...family.authors],
					rubric_reviews: family.rubricReviews.map((review) => ({
						reviewer: review.reviewer,
						reviewed_at: review.reviewedAt,
						verdict: review.verdict,
						remarks: [...review.remarks],
						on_current_sources: review.onCurrentSources
					})),
					levels: family.levels.map((level) => ({
						grade: level.grade,
						round: level.round,
						mean: level.mean,
						same_vendor_reviewer: level.sameVendorReviewer,
						ratings: level.ratings.map((rating) => ({
							rater: rating.rater,
							p: rating.p,
							rated_at: rating.ratedAt,
							on_current_sources: rating.onCurrentSources
						}))
					}))
				}))
			}))
		};
	}
});
