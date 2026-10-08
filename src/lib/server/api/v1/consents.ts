// The candidate's own consents (docs/domain.md, sections 6.2, 6.3, 7.3, 19.1): the texts in force and the candidate's
// side of each kind, the grant of a kind by the exact version of its text and its revocation. The same services serve
// the pages «Согласия», «Видимость» and the notification settings. Browser session only.
import { z } from 'zod';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import {
	consentOverview,
	fspImportConsentState,
	grantCatalogVisibility,
	grantPartnerPoolConsent,
	grantTelegramConsent,
	partnerPoolOverview,
	processingConsentState,
	revokeCatalogVisibility,
	revokeFspImportConsent,
	revokePartnerPoolConsent,
	revokeTelegramConsent,
	type ConsentText
} from '$lib/server/candidates/consents';
import { currentDocument } from '$lib/server/auth/documents';
import { CATALOG_SCOPE_FIELDS, DISCLOSURE_FIELDS } from '$lib/server/consent/kinds';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { authDepsOf } from '../services';
import { dateTime, iso, isoOrNull } from '../schemas';
import { invitationMeta, ownCandidate, requestMetaOf, sessionOf } from './context';

const TAG = 'Согласия';

const consentDocument = z
	.object({
		document_id: z.uuid().describe('Версия текста, которую называет согласие'),
		title: z.string(),
		version: z.int(),
		body: z.string()
	})
	.meta({ id: 'ConsentDocument', description: 'Действующая редакция текста согласия' });

const documentBody = (text: ConsentText | null) =>
	text === null ? null : { document_id: text.id, title: text.title, version: text.version, body: text.body };

const HIDDEN_REASONS = [
	'hidden_by_candidate',
	'not_looking',
	'no_catalog_consent',
	'representative_consent_missing',
	'minor_vacancy_context',
	'minors_disabled',
	'age_unknown'
] as const;

const consentsSchema = z
	.object({
		age_regime: z
			.enum(['adult', 'minor', 'unknown'])
			.describe('`minor` — 14–17: согласия действуют с подписью подтверждённого законного представителя'),
		representative_verified: z.boolean(),
		pd_processing: z.object({
			own_signed: z
				.boolean()
				.describe(
					'Своя сторона действует: не подписана в несовершеннолетии и не заменена текстом, требующим повторного согласия'
				),
			effective: z.boolean().describe('Обработка профиля разрешена сейчас'),
			document: consentDocument
				.nullable()
				.describe('Текст для подписи, когда своя сторона не действует; `null` — подписывать нечего')
		}),
		catalog_visibility: z.object({
			subject_granted: z.boolean(),
			effective: z.boolean(),
			scope_fields: z.array(z.enum(CATALOG_SCOPE_FIELDS)).describe('Что взрослый добавил к карточке каталога'),
			granted_at: dateTime.nullable(),
			hidden_reason: z
				.enum(HIDDEN_REASONS)
				.nullable()
				.describe('Почему каталог сейчас не показывает профиль; `null` — проверенные компании его находят'),
			document: consentDocument.nullable()
		}),
		telegram_notifications: z.object({
			subject_granted: z.boolean(),
			effective: z.boolean(),
			document: consentDocument.nullable()
		}),
		fsp_import: z.object({
			subject_granted: z.boolean(),
			effective: z.boolean().describe('Импорт достижений идёт сейчас'),
			granted_at: dateTime.nullable(),
			revoked_at: dateTime.nullable(),
			facts: z.int().describe('Фактов ФСП в профиле сейчас'),
			document: consentDocument
				.nullable()
				.describe('Даётся в браузере после привязки ФСП ID: экран «Подтвердить достижения из ФСП»')
		}),
		partner_pool: z.object({
			adult: z.boolean().describe('Пул партнёров соревнований — только с 18 лет'),
			offers: z.array(
				z.object({
					competition_ref: z.string(),
					competition: z
						.object({ title: z.string(), stage: z.string().nullable(), start_date: z.string() })
						.nullable()
						.describe('`null` — результата соревнования в профиле больше нет; согласие можно отозвать'),
					result: z.object({ place: z.int().nullable(), award: z.string().nullable() }).nullable(),
					partners: z
						.array(z.object({ company_id: z.uuid(), name: z.string() }))
						.describe('Партнёры, открытые сейчас, в чей пул входит результат'),
					consent: z.object({ granted_at: dateTime, partners: z.array(z.string()), effective: z.boolean() }).nullable(),
					new_partners: z
						.array(z.string())
						.describe('Партнёры, которых согласие не называет: им не видно до нового согласия')
				})
			),
			document: consentDocument.nullable()
		}),
		contact_disclosure: z
			.array(
				z.object({
					invitation_id: z.uuid(),
					company_name: z.string(),
					vacancy_title: z.string(),
					fields: z.array(z.enum(DISCLOSURE_FIELDS)).describe('Что компания может получить сейчас; пусто — отозвано'),
					disclosed: z.array(z.object({ fields: z.array(z.string()), at: dateTime }))
				})
			)
			.describe('Раскрытие контактов: даётся и отзывается по приглашению (`/invitations/{invitation_id}/response`)')
	})
	.meta({ id: 'OwnConsents', description: 'Согласия кандидата по видам с действующими текстами' });

export const getMyConsents = defineOperation({
	id: 'getMyConsents',
	method: 'GET',
	path: '/me/consents',
	tag: TAG,
	summary: 'Мои согласия',
	description:
		'Каждый вид согласия: своя сторона, действует ли согласие сейчас (для 14–17 — вместе со стороной ' +
		'представителя) и действующая редакция текста, которую называет новое согласие. Отзыв согласия на обработку — ' +
		'это удаление профиля: `POST /me/account/deletion` с `cause = processing_revoked`.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Согласия', schema: consentsSchema },
	async handle(ctx) {
		const { candidateId } = await ownCandidate(ctx, 'candidate.self.read');
		const { db } = ctx.services;
		const now = ctx.services.now();
		const processing = await processingConsentState(db, candidateId, now);
		const overview = await consentOverview(db, candidateId, now);
		const fsp = await fspImportConsentState(db, candidateId, now);
		const fspDocument = await currentDocument(db, 'fsp_import', now);
		const pool = await partnerPoolOverview(db, candidateId, now);
		return {
			age_regime: overview.ageRegime,
			representative_verified: overview.representativeVerified,
			pd_processing: {
				own_signed: processing.ownSigned,
				effective: processing.effective,
				document: documentBody(processing.document)
			},
			catalog_visibility: {
				subject_granted: overview.catalog.subjectGranted,
				effective: overview.catalog.effective,
				scope_fields: overview.catalog.scopeFields,
				granted_at: isoOrNull(overview.catalog.grantedAt),
				hidden_reason: overview.hiddenReason,
				document: documentBody(overview.texts.catalog)
			},
			telegram_notifications: {
				subject_granted: overview.telegram.subjectGranted,
				effective: overview.telegram.effective,
				document: documentBody(overview.texts.telegram)
			},
			fsp_import: {
				subject_granted: fsp.subjectGranted,
				effective: fsp.effective,
				granted_at: isoOrNull(fsp.grantedAt),
				revoked_at: isoOrNull(fsp.revokedAt),
				facts: fsp.facts,
				document: fspDocument?.available === true ? documentBody(fspDocument) : null
			},
			partner_pool: {
				adult: pool.adult,
				offers: pool.offers.map((offer) => ({
					competition_ref: offer.competitionRef,
					competition:
						offer.competition === null
							? null
							: {
									title: offer.competition.title,
									stage: offer.competition.stage,
									start_date: offer.competition.startDate
								},
					result: offer.result === null ? null : { place: offer.result.place, award: offer.result.award ?? null },
					partners: offer.partners.map((partner) => ({ company_id: partner.companyId, name: partner.name })),
					consent:
						offer.consent === null
							? null
							: {
									granted_at: iso(offer.consent.grantedAt),
									partners: offer.consent.partners,
									effective: offer.consent.effective
								},
					new_partners: offer.newPartners
				})),
				document: documentBody(pool.text)
			},
			contact_disclosure: overview.disclosures.map((item) => ({
				invitation_id: item.invitationId,
				company_name: item.companyName,
				vacancy_title: item.vacancyTitle,
				fields: item.fields,
				disclosed: item.disclosed.map((entry) => ({ fields: entry.fields, at: iso(entry.at) }))
			}))
		};
	}
});

const GRANTABLE = ['pd_processing', 'catalog_visibility', 'telegram_notifications', 'partner_pool'] as const;

export const grantMyConsent = defineOperation({
	id: 'grantMyConsent',
	method: 'POST',
	path: '/me/consents/{kind}',
	tag: TAG,
	summary: 'Дать согласие',
	description:
		'Согласие называет точную версию текста (`document_id` из `GET /me/consents`); вышла новая редакция — `409`, ' +
		'текст читается заново. `pd_processing` — повторное согласие, когда своя сторона не действует (после 18 лет или ' +
		'по новой редакции), иначе `409`. `catalog_visibility` включает показ в каталоге проверенных компаний; ' +
		'`scope_fields` — что взрослый добавляет к карточке (14–17 — `422 scope_fields_minor`; без подтверждённого ' +
		'представителя — `409`). `partner_pool` — по соревнованию `competition_ref`, только с 18 лет (`403`). ' +
		'`telegram_notifications` — основание привязать бота. Согласие на импорт достижений ФСП даётся в браузере ' +
		'вместе с привязкой ФСП ID.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ kind: z.enum(GRANTABLE) }),
	body: z.strictObject({
		document_id: z.uuid(),
		scope_fields: z
			.array(z.enum(CATALOG_SCOPE_FIELDS))
			.max(CATALOG_SCOPE_FIELDS.length)
			.optional()
			.describe('Только `catalog_visibility`: блоки, которые взрослый добавляет к карточке каталога'),
		competition_ref: z.string().min(1).max(200).optional().describe('Только `partner_pool`: соревнование')
	}),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 204, description: 'Согласие записано' },
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		const { kind } = ctx.params;
		const { document_id: documentId, scope_fields: scopeFields, competition_ref: competitionRef } = ctx.body;
		const misplaced = (field: string) =>
			new ApiError('validation_failed', {
				details: [{ path: field, code: 'not_applicable', message: `Поле не относится к согласию ${kind}` }]
			});
		if (scopeFields !== undefined && kind !== 'catalog_visibility') throw misplaced('scope_fields');
		if (competitionRef !== undefined && kind !== 'partner_pool') throw misplaced('competition_ref');
		const { db } = ctx.services;
		const meta = invitationMeta(ctx);
		switch (kind) {
			case 'pd_processing': {
				// Signed through the sign-in module: the session evidences the consent.
				const result = await grantProfileConsent(
					await authDepsOf(ctx.services),
					requestMetaOf(ctx),
					sessionOf(ctx),
					documentId
				);
				if (!result.ok) {
					throw new ApiError('conflict', {
						message:
							result.reason === 'document_changed'
								? 'Текст согласия обновился — прочитайте новую редакцию'
								: 'Ваше согласие уже действует',
						details: [{ code: result.reason, message: 'Согласие не записано' }]
					});
				}
				return;
			}
			case 'catalog_visibility':
				return grantCatalogVisibility(db, subject, meta, { documentId, scopeFields: scopeFields ?? [] });
			case 'telegram_notifications':
				return grantTelegramConsent(db, subject, meta, documentId);
			case 'partner_pool': {
				if (competitionRef === undefined) {
					throw new ApiError('validation_failed', {
						details: [{ path: 'competition_ref', code: 'required', message: 'Укажите соревнование' }]
					});
				}
				await grantPartnerPoolConsent(db, subject, meta, { documentId, competitionRef });
				return;
			}
		}
	}
});

const REVOCABLE = ['catalog_visibility', 'telegram_notifications', 'fsp_import', 'partner_pool'] as const;

export const revokeMyConsent = defineOperation({
	id: 'revokeMyConsent',
	method: 'POST',
	path: '/me/consents/{kind}/revocation',
	tag: TAG,
	summary: 'Отозвать согласие',
	description:
		'Отзыв действует сразу. `catalog_visibility` — профиль уходит из каталога, поиска и счётчиков; уже переданные ' +
		'контакты остаются у компаний. `telegram_notifications` — канал отвязывается, идентификатор чата стирается. ' +
		'`fsp_import` — импорт останавливается, факты ФСП уходят из профиля, их квитанции перестают подтверждаться. ' +
		'`partner_pool` — по соревнованию `competition_ref`. Не дано или уже отозвано — `409`. Согласие на обработку ' +
		'отзывается удалением профиля (`POST /me/account/deletion`, `cause = processing_revoked`).',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ kind: z.enum(REVOCABLE) }),
	body: z.strictObject({
		reason: z.string().max(500).optional().describe('Своими словами, по желанию; кроме `telegram_notifications`'),
		competition_ref: z.string().min(1).max(200).optional().describe('Только `partner_pool`: соревнование')
	}),
	errors: ['forbidden', 'not_found', 'conflict'],
	response: {
		status: 200,
		description: 'Согласие отозвано',
		schema: z.object({
			withdrawn_facts: z.int().nullable().describe('`fsp_import`: сколько фактов ушло из профиля; иначе `null`')
		})
	},
	async handle(ctx) {
		const { subject } = await ownCandidate(ctx, 'candidate.self.write');
		const { kind } = ctx.params;
		const { reason, competition_ref: competitionRef } = ctx.body;
		const misplaced = (field: string) =>
			new ApiError('validation_failed', {
				details: [{ path: field, code: 'not_applicable', message: `Поле не относится к согласию ${kind}` }]
			});
		if (competitionRef !== undefined && kind !== 'partner_pool') throw misplaced('competition_ref');
		if (reason !== undefined && kind === 'telegram_notifications') throw misplaced('reason');
		const { db } = ctx.services;
		const meta = invitationMeta(ctx);
		switch (kind) {
			case 'catalog_visibility':
				await revokeCatalogVisibility(db, subject, meta, reason);
				return { withdrawn_facts: null };
			case 'telegram_notifications':
				await revokeTelegramConsent(db, subject, meta);
				return { withdrawn_facts: null };
			case 'fsp_import':
				return { withdrawn_facts: await revokeFspImportConsent(db, subject, meta, reason) };
			case 'partner_pool':
				if (competitionRef === undefined) {
					throw new ApiError('validation_failed', {
						details: [{ path: 'competition_ref', code: 'required', message: 'Укажите соревнование' }]
					});
				}
				await revokePartnerPoolConsent(db, subject, meta, competitionRef, reason);
				return { withdrawn_facts: null };
		}
	}
});
