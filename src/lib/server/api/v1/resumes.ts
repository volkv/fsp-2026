// The candidate's resume (docs/domain.md, sections 9, 15, 17.3, 19.1): the upload of a PDF or DOCX, every upload with
// the state of its parse, the reading of the current one — the text by blocks, each extracted field and experience
// entry with the quote it rests on, the values suggested for the profile — and the candidate's decisions about them.
// The same services serve the page «Резюме». Browser session only.
import { z } from 'zod';
import { resumeFields, type ResumeQuote } from '$lib/components/candidate/quotes';
import { processingRefusal } from '$lib/server/consent/processing';
import {
	CLAIM_EXTRACTORS,
	CLAIM_POLARITIES,
	CLAIM_REVIEWS,
	CLAIM_TYPES,
	DATE_PRECISIONS,
	EXPERIENCE_REVIEWS,
	PERIOD_STATUSES,
	PROFILE_SUGGESTION_FIELDS
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { LLM_RUNTIMES } from '$lib/server/ml/runtime';
import { readSuggestions } from '$lib/server/profile/suggestions';
import { deleteResume } from '$lib/server/resumes/delete';
import { RESUME_PARSE_ERRORS } from '$lib/server/resumes/parse-errors';
import { readingFlags, readOwnResumes, resumeInProgress, type ResumeUpload } from '$lib/server/resumes/read';
import {
	correctExperienceEntry,
	reviewExperienceEntry,
	reviewResumeClaim,
	type ExperienceCorrection
} from '$lib/server/resumes/review';
import { uploadResume } from '$lib/server/resumes/upload';
import { defineOperation } from '../operation';
import { dateTime, iso, key } from '../schemas';
import { resumeApiDeps } from '../services';
import { invitationMeta, ownCandidate } from './context';

const TAG = 'Резюме';

const PARSE_STATUSES = ['pending', 'parsed', 'partial', 'unsupported_format', 'failed'] as const;

const uploadSchema = z
	.object({
		resume_id: z.uuid(),
		seq: z.int().describe('Порядковый номер загрузки'),
		is_current: z.boolean().describe('Текущее резюме — то, что учитывается в профиле'),
		parse_status: z.enum(PARSE_STATUSES),
		parse_error: z.enum(RESUME_PARSE_ERRORS).nullable().describe('Почему разбор не дал текста'),
		failure_message: z.string().nullable().describe('Что сделать, когда разбор не дал текста'),
		declared_name: z.string(),
		size_bytes: z.int(),
		uploaded_at: dateTime
	})
	.meta({ id: 'ResumeUpload', description: 'Загруженный файл резюме и состояние его разбора' });

function uploadBody(upload: ResumeUpload): z.input<typeof uploadSchema> {
	return {
		resume_id: upload.resumeDocumentId,
		seq: upload.seq,
		is_current: upload.isCurrent,
		parse_status: upload.parseStatus,
		parse_error: upload.parseError,
		failure_message: upload.failureMessage,
		declared_name: upload.declaredName,
		size_bytes: upload.sizeBytes,
		uploaded_at: iso(upload.uploadedAt)
	};
}

const quoteSchema = z
	.object({
		extraction_id: z.uuid(),
		block_id: z.string(),
		start: z.int().describe('Начало цитаты в кодовых точках от начала текста блока'),
		end: z.int(),
		text: z.string()
	})
	.meta({ id: 'ResumeQuote', description: 'Цитата из распознанного текста резюме' });

const quoteBody = (quote: ResumeQuote) => ({
	extraction_id: quote.extractionId,
	block_id: quote.blockId,
	start: quote.start,
	end: quote.end,
	text: quote.text
});

export const listMyResumes = defineOperation({
	id: 'listMyResumes',
	method: 'GET',
	path: '/me/resumes',
	tag: TAG,
	summary: 'Мои загрузки резюме',
	description:
		'Все загрузки, новые первыми, со статусом разбора: `pending` — файл читается; `parsed`/`partial` — текст есть ' +
		'(разбор полей — `GET /me/resumes/current`); `unsupported_format`/`failed` — текста нет, причина в ' +
		'`failure_message`. `processing_refusal` — почему резюме сейчас не принимается (нет действующего согласия на ' +
		'обработку).',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Загрузки',
		schema: z.object({
			items: z.array(uploadSchema),
			processing_refusal: z.string().nullable()
		})
	},
	async handle(ctx) {
		const { subject, candidateId } = await ownCandidate(ctx, 'candidate.self.read');
		const own = await readOwnResumes(ctx.services.db, subject);
		const refusal = await processingRefusal(ctx.services.db, candidateId, ctx.services.now());
		return { items: own.uploads.map(uploadBody), processing_refusal: refusal?.message ?? null };
	}
});

export const uploadMyResume = defineOperation({
	id: 'uploadMyResume',
	method: 'POST',
	path: '/me/resumes',
	tag: TAG,
	summary: 'Загрузить резюме',
	description:
		'`multipart/form-data` с файлом в части `file`: PDF или DOCX (также DOC, RTF, ODT, TXT и скан PNG/JPEG), до ' +
		'10 МиБ. Формат определяется по содержимому, не по имени: другой — `400` (`details[].code = ' +
		'unsupported_format`), больше лимита — `400 too_large`. Новое резюме становится текущим, прежнее уходит из ' +
		'профиля, разбор идёт в фоне — статус в `GET /me/resumes`. Без действующего согласия на обработку — `422`.',
	auth: 'session',
	permission: 'candidate.self.write',
	bodyEncoding: 'multipart',
	body: z.strictObject({ file: z.file().describe('Файл резюме, до 10 МиБ') }),
	errors: ['forbidden', 'policy_violation'],
	response: {
		status: 202,
		description: 'Файл принят, разбор поставлен в очередь',
		schema: z.object({ resume_id: z.uuid(), seq: z.int(), parse_status: z.literal('pending') })
	},
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		const { file } = ctx.body;
		const uploaded = await uploadResume(
			resumeApiDeps(ctx.services),
			subject,
			{ bytes: new Uint8Array(await file.arrayBuffer()), declaredName: file.name },
			invitationMeta(ctx)
		);
		return { resume_id: uploaded.resumeDocumentId, seq: uploaded.seq, parse_status: 'pending' as const };
	}
});

const blockSchema = z.object({
	id: z.string(),
	page: z.int().nullable(),
	kind: z.enum(['heading', 'paragraph', 'list_item', 'table_cell', 'line']),
	text: z.string()
});

const currentSchema = z
	.object({
		upload: uploadSchema,
		in_progress: z.boolean().describe('Разбор или извлечение полей ещё идут — спросите позже'),
		reading: z
			.object({
				processing_mode: z.enum(['model', 'rules_only', 'partial', 'failed']),
				model: z
					.object({ model_id: z.string(), runtime: z.enum(LLM_RUNTIMES).nullable() })
					.nullable()
					.describe('Модель, прочитавшая резюме, и где она работала; `null` — модель не читала'),
				notice: z.string().nullable().describe('Разбор без модели: поля нужно проверить'),
				failure_code: z.string().nullable()
			})
			.nullable()
			.describe('Как прочитаны поля; `null` — ещё не прочитаны'),
		document: z
			.object({
				extraction_id: z.uuid(),
				status: z.enum(['complete', 'partial']),
				ocr_used: z.boolean(),
				incomplete: z.array(z.string()).describe('Что прочитано не полностью'),
				blocks: z.array(blockSchema).describe('Текст резюме по блокам; цитаты отсчитываются от начала блока')
			})
			.nullable()
			.describe('Распознанный текст; `null` — разбор не дал текста или ещё идёт'),
		claims: z.array(
			z.object({
				id: z.uuid(),
				claim_type: z.enum(CLAIM_TYPES),
				raw_text: z.string(),
				polarity: z.enum(CLAIM_POLARITIES),
				skill_key: key.nullable(),
				value: z.unknown().describe('Нормализованное значение по типу утверждения'),
				extractor: z.enum(CLAIM_EXTRACTORS),
				review: z.enum(CLAIM_REVIEWS).describe('Решение кандидата'),
				experience_entry_id: z.uuid().nullable(),
				quote: quoteSchema
			})
		),
		experience: z.array(
			z.object({
				id: z.uuid(),
				position_title: z.string().nullable(),
				role_key: key.nullable(),
				organization_name: z.string().nullable(),
				period_from: z.string().nullable().describe('Первый день месяца или года начала, YYYY-MM-DD'),
				period_to: z.string().nullable(),
				period_from_precision: z.enum(DATE_PRECISIONS).nullable(),
				period_to_precision: z.enum(DATE_PRECISIONS).nullable(),
				is_current: z.boolean(),
				period_status: z.enum(PERIOD_STATUSES).describe('`missing`/`invalid` — период не прочитан, стаж не считается'),
				applied_skill_keys: z.array(key),
				review: z.enum(EXPERIENCE_REVIEWS).describe('Решение кандидата; `edited` — место работы исправлено'),
				quotes: z.array(quoteSchema)
			})
		),
		suggestions: z
			.array(
				z.object({
					id: z.uuid(),
					field: z.enum(PROFILE_SUGGESTION_FIELDS),
					value: z.string().describe('Значение словами: ФИО, контакт, название мягкого навыка'),
					status: z.enum(['pending', 'accepted', 'rejected']),
					quote: quoteSchema
				})
			)
			.describe(
				'Значения для полей профиля; принимаются или отклоняются `POST /me/profile/suggestions/{suggestion_id}/decision`'
			)
	})
	.meta({ id: 'CurrentResume', description: 'Разбор текущего резюме с цитатами' });

export const getMyCurrentResume = defineOperation({
	id: 'getMyCurrentResume',
	method: 'GET',
	path: '/me/resumes/current',
	tag: TAG,
	summary: 'Разбор текущего резюме',
	description:
		'Распознанный текст по блокам и всё, что из него извлечено: утверждения (навыки, должности, компании, ' +
		'образование…), места работы с периодами и значения для полей профиля — каждое с цитатой из текста и решением ' +
		'кандидата. Пока идёт разбор — `in_progress = true`. Нет загруженного резюме — `404`.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Разбор', schema: currentSchema },
	async handle(ctx) {
		const { subject, candidateId } = await ownCandidate(ctx, 'candidate.self.read');
		const { db, crypto } = ctx.services;
		const own = await readOwnResumes(db, subject);
		const current = own.current;
		if (current === null) throw new ApiError('not_found', { message: 'Резюме не загружено' });
		const document = current.document;
		const suggestions = document === null ? [] : await readSuggestions(db, crypto, candidateId, document);
		const fields = resumeFields(
			current,
			suggestions.map((suggestion) => ({ key: suggestion.sourceKey, quotes: [suggestion.quote] }))
		);
		return {
			upload: uploadBody(current.upload),
			in_progress: resumeInProgress(current),
			reading:
				current.reading === null
					? null
					: {
							processing_mode: current.reading.processingMode,
							model:
								current.reading.model === null
									? null
									: { model_id: current.reading.model.modelId, runtime: current.reading.model.runtime },
							notice: current.reading.notice,
							failure_code: current.reading.failureCode
						},
			document:
				document === null || fields.document === null
					? null
					: {
							extraction_id: document.extractionId,
							status: document.status,
							...(({ ocrUsed, incomplete }) => ({ ocr_used: ocrUsed, incomplete }))(readingFlags(document.flags)),
							blocks: fields.document.blocks.map((block) => ({
								id: block.id,
								page: block.page,
								kind: block.kind,
								text: block.segments.map((segment) => segment.text).join('')
							}))
						},
			claims: fields.claims.map((claim) => ({
				id: claim.id,
				claim_type: claim.claimType,
				raw_text: claim.rawText,
				polarity: claim.polarity,
				skill_key: claim.skillKey,
				value: claim.value,
				extractor: claim.extractor,
				review: claim.candidateReview,
				experience_entry_id: claim.experienceEntryId,
				quote: quoteBody(claim.quote)
			})),
			experience: fields.experience.map((entry) => ({
				id: entry.id,
				position_title: entry.positionTitle,
				role_key: entry.roleKey,
				organization_name: entry.organizationName,
				period_from: entry.periodFrom,
				period_to: entry.periodTo,
				period_from_precision: entry.periodFromPrecision,
				period_to_precision: entry.periodToPrecision,
				is_current: entry.isCurrent,
				period_status: entry.periodStatus,
				applied_skill_keys: entry.appliedSkillKeys,
				review: entry.candidateReview,
				quotes: entry.quotes.map(quoteBody)
			})),
			suggestions: suggestions.map((suggestion) => ({
				id: suggestion.id,
				field: suggestion.field,
				value: suggestion.label,
				status: suggestion.status,
				quote: quoteBody(suggestion.quote)
			}))
		};
	}
});

export const deleteMyResume = defineOperation({
	id: 'deleteMyResume',
	method: 'DELETE',
	path: '/me/resumes/{resume_id}',
	tag: TAG,
	summary: 'Удалить резюме',
	description:
		'Файл и всё извлечённое из него удаляются физически: текст, утверждения, места работы, значения для профиля ' +
		'(принятые значения остаются в профиле). Текущее резюме уходит из профиля, категория пересчитывается. Чужое или ' +
		'уже удалённое — `404`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ resume_id: z.uuid() }),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Резюме удалено' },
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		await deleteResume(resumeApiDeps(ctx.services), subject, ctx.params.resume_id, invitationMeta(ctx));
	}
});

const decisionBody = z.strictObject({ decision: z.enum(['confirm', 'reject']) });

export const reviewMyResumeClaim = defineOperation({
	id: 'reviewMyResumeClaim',
	method: 'POST',
	path: '/me/resumes/claims/{claim_id}/review',
	tag: TAG,
	summary: 'Подтвердить или отклонить утверждение из резюме',
	description:
		'Текст и цитата утверждения остаются как извлечены; решение меняет вход категории: отклонённый навык не ' +
		'учитывается, категория пересчитывается.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ claim_id: z.uuid() }),
	body: decisionBody,
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Решение записано' },
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		await reviewResumeClaim(
			resumeApiDeps(ctx.services),
			subject,
			ctx.params.claim_id,
			ctx.body.decision,
			invitationMeta(ctx)
		);
	}
});

export const reviewMyResumeExperience = defineOperation({
	id: 'reviewMyResumeExperience',
	method: 'POST',
	path: '/me/resumes/experience/{entry_id}/review',
	tag: TAG,
	summary: 'Подтвердить или отклонить место работы из резюме',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ entry_id: z.uuid() }),
	body: decisionBody,
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Решение записано' },
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		await reviewExperienceEntry(
			resumeApiDeps(ctx.services),
			subject,
			ctx.params.entry_id,
			ctx.body.decision,
			invitationMeta(ctx)
		);
	}
});

const period = z
	.string()
	.regex(/^(19|20)\d{2}(-(0[1-9]|1[0-2]))?$/u)
	.nullable()
	.describe('YYYY или YYYY-MM');
const entryText = z.string().trim().min(1).max(200).nullable();

export const correctMyResumeExperience = defineOperation({
	id: 'correctMyResumeExperience',
	method: 'PUT',
	path: '/me/resumes/experience/{entry_id}',
	tag: TAG,
	summary: 'Исправить место работы из резюме',
	description:
		'Все поля сразу; место работы помечается `edited`, цитаты документа остаются. У текущей работы нет даты ' +
		'окончания. Роль — из справочника.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ entry_id: z.uuid() }),
	body: z.strictObject({
		position_title: entryText,
		role_key: key.nullable(),
		organization_name: entryText,
		period_from: period,
		period_to: period,
		is_current: z.boolean()
	}),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Исправлено' },
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		const correction: ExperienceCorrection = {
			positionTitle: ctx.body.position_title,
			roleKey: ctx.body.role_key,
			organizationName: ctx.body.organization_name,
			periodFrom: ctx.body.period_from,
			periodTo: ctx.body.period_to,
			isCurrent: ctx.body.is_current
		};
		await correctExperienceEntry(
			resumeApiDeps(ctx.services),
			subject,
			ctx.params.entry_id,
			correction,
			invitationMeta(ctx)
		);
	}
});
