// Texts of notifications by type (docs/domain.md, section 3.7; contracts 7.1): a letter may name the recipient's own
// data — the company and the title of the candidate's offer, the vacancy of the company's one — but the other
// side only by the short code of its pseudonym («Кандидат CRYUVD»). A Telegram message carries the kind of the event
// and the link, nothing else. A letter about an operator's decision names the decision only; its reasons are read in
// the product. A candidate aged 14–17 learns whether the representative's authority is confirmed, never the
// operator's notes or the details of the document; the candidate whose birth date the operator checked learns the
// regime of age, never the date or the document; the annulment of an attempt names the test and whether the attempt
// still counts by the grade policy, never the operator's grounds. The staff learn that an objection's answer is due,
// never who objected or why.
import { z } from 'zod';
import { GRADE_POLICY } from '$lib/server/assessments/contract/policy';
import { ANNUL_REASONS, COMPLAINT_DECISIONS, COMPLAINT_REASONS } from '$lib/server/db/schema';
import type { MailMessage } from '$lib/server/mail/mailer';
import { render, type Letter } from '$lib/server/mail/templates';
import { candidateCode } from '$lib/text/candidate-label';
import type { InvitationFacts, NotificationFacts } from './content';
import { NOTIFICATION_TYPES, type NotificationType } from './types';

export interface NotificationLinks {
	/** The notification in the product: it leads to its object. */
	open: string;
	/** Notification settings: every letter outside the `account` category links to them (contracts 7.1). */
	settings: string;
}

type Payload = Record<string, unknown>;

interface Body {
	subject: string;
	paragraphs: string[];
	action: string;
}

const decision = z.enum(['accept', 'decline']);
const flag = z.boolean().optional();
const hoursLeft = z.int().positive();
const verificationDecision = z.enum(['approved', 'rejected', 'needs_info']);
const objectionOutcome = z.enum(['upheld', 'annulled', 'rescored']);
const revokeReason = z.enum(['decision_annulled', 'objection_annulled', 'objection_rescored']);
const authorityResult = z.enum(['verified', 'rejected']);
const moderationOutcome = z.enum(['published', 'returned', 'rejected']);
const moderatedStatus = z.enum(['published', 'paused', 'draft', 'closed']);
const ageRegime = z.enum(['adult', 'minor']);
const annulReason = z.enum(ANNUL_REASONS);
const blockVerdict = z.enum(['confirmed', 'not_confirmed']);
const applicationDecision = z.enum(['invited', 'rejected']);
const complaintDecision = z.enum(COMPLAINT_DECISIONS);
const upheldDecision = z.enum(['warning', 'suspension']);
const complaintReason = z.enum(COMPLAINT_REASONS);

/** What the company reads about the ground of an upheld complaint: the reason only, never the candidate's words. */
const COMPLAINT_REASON_TEXT: Record<z.infer<typeof complaintReason>, string> = {
	terms_mismatch: 'условия на деле не совпали с условиями предложения',
	no_real_job: 'работы, которую описывает предложение, нет',
	contact_harvesting: 'предложение использовали, чтобы получить контакты',
	payment_demanded: 'от кандидата требовали оплату',
	discrimination: 'дискриминирующие требования или вопросы',
	other: 'иное нарушение условий платформы'
};

type DecisionType =
	| 'company.verification_decided'
	| 'vacancy.moderation_decided'
	| 'objection.decided'
	| 'objection.due_soon'
	| 'objection.overdue'
	| 'category.assigned'
	| 'category.revoked'
	| 'representation.decided'
	| 'representation.consents_signed'
	| 'representation.consents_revoked'
	| 'candidate.age_verified'
	| 'assessment.annulled'
	| 'candidate.majority_reached'
	| 'candidate.inactive_purge_scheduled'
	| 'confirmation.requested'
	| 'confirmation.completed'
	| 'challenge.delivered'
	| 'challenge.reminder'
	| 'application.received'
	| 'application.decided'
	| 'complaint.decided'
	| 'company.complaint_upheld';
type InvitationType = Exclude<NotificationType, DecisionType>;

function unsupported(type: NotificationType, facts: NotificationFacts): never {
	throw new Error(`notification ${type} has no text for the ${facts.side} side of a ${facts.object}`);
}

function verificationBody(company: string, decided: z.infer<typeof verificationDecision>): Body {
	switch (decided) {
		case 'approved':
			return {
				subject: 'Компания подтверждена',
				paragraphs: [
					`Оператор ФСП подтвердил компанию ${company}.`,
					'В предложениях кандидатам у компании теперь метка «проверена» вместо «не проверена».'
				],
				action: 'Открыть профиль компании'
			};
		case 'rejected':
			return {
				subject: 'Заявка на проверку компании отклонена',
				paragraphs: [
					`Оператор ФСП отклонил заявку на проверку компании ${company}.`,
					'Пока заявка отклонена, каталог кандидатов, вакансии и предложения компании закрыты, а неотвеченные предложения отозваны.',
					'Причина отказа — в профиле компании. Исправьте данные там же и подайте заявку снова: с новой заявкой компания снова работает с кандидатами.'
				],
				action: 'Посмотреть причину'
			};
		case 'needs_info':
			return {
				subject: 'Заявка на проверку компании возвращена на уточнение',
				paragraphs: [
					`Оператор ФСП вернул заявку на проверку компании ${company} на уточнение.`,
					'Что нужно поправить, написано в профиле компании; после правки заявку можно подать снова.'
				],
				action: 'Открыть профиль компании'
			};
	}
}

function moderationBody(vacancy: string, payload: Payload): Body {
	switch (moderationOutcome.parse(payload.decision)) {
		case 'published': {
			const paused = moderatedStatus.parse(payload.status) === 'paused';
			return {
				subject: 'Вакансия прошла модерацию',
				paragraphs: [
					paused
						? `Оператор ФСП допустил требования вакансии ${vacancy}. Она была приостановлена и остаётся на паузе — вернуть её в каталог можно на странице вакансии.`
						: `Оператор ФСП допустил требования вакансии ${vacancy}, она опубликована в каталоге.`,
					'Пока найденные формулировки не меняются, повторная модерация не нужна.'
				],
				action: 'Открыть вакансию'
			};
		}
		case 'returned':
			return {
				subject: 'Вакансия возвращена на правку',
				paragraphs: [
					`Оператор ФСП вернул вакансию ${vacancy} на правку, она сохранена черновиком.`,
					'Что исправить, оператор написал на странице вакансии. После правки опубликуйте её снова.'
				],
				action: 'Посмотреть, что исправить'
			};
		case 'rejected':
			return {
				subject: 'Вакансия отклонена модерацией',
				paragraphs: [
					`Оператор ФСП отклонил вакансию ${vacancy}, она закрыта. Неотвеченные приглашения по ней отозваны.`,
					'Причина отказа — на странице вакансии.'
				],
				action: 'Посмотреть причину'
			};
	}
}

function bodyOf(type: NotificationType, facts: NotificationFacts, payload: Payload): Body {
	switch (type) {
		case 'company.verification_decided':
			if (facts.object !== 'company') unsupported(type, facts);
			return verificationBody(`«${facts.companyName}»`, verificationDecision.parse(payload.decision));
		case 'vacancy.moderation_decided':
			if (facts.object !== 'vacancy') unsupported(type, facts);
			return moderationBody(`«${facts.vacancyTitle}»`, payload);
		case 'objection.decided': {
			if (facts.object !== 'assessment_objection' || facts.side !== 'candidate') unsupported(type, facts);
			const outcome = objectionOutcome.parse(payload.outcome);
			return {
				subject: {
					upheld: 'Возражение рассмотрено: результат теста оставлен',
					annulled: 'Возражение рассмотрено: попытка аннулирована',
					rescored: 'Возражение рассмотрено: результат теста пересчитан'
				}[outcome],
				paragraphs: [
					{
						upheld: 'Оператор ФСП рассмотрел ваше возражение и оставил решение теста без изменений.',
						annulled:
							'Оператор ФСП рассмотрел ваше возражение и аннулировал попытку: она не засчитывается, тест можно пройти снова.',
						rescored: 'Оператор ФСП рассмотрел ваше возражение, исправил оценку заданий и пересчитал решение теста.'
					}[outcome],
					'Объяснение оператора — на странице категории и грейда.'
				],
				action: 'Открыть категорию и грейд'
			};
		}
		case 'category.assigned':
			if (facts.object !== 'candidate_category') unsupported(type, facts);
			return {
				subject: 'Категория подтверждена тестом',
				paragraphs: [
					'Тест подтвердил вашу категорию: теперь работодатели находят вас в выдаче этой категории.',
					'Что подтверждено и что тест не проверяет — на странице категории и грейда.'
				],
				action: 'Открыть категорию и грейд'
			};
		case 'category.revoked': {
			if (facts.object !== 'candidate_category') unsupported(type, facts);
			const reason = revokeReason.parse(payload.reason);
			return {
				subject: 'Категория отозвана',
				paragraphs: [
					reason === 'decision_annulled'
						? 'Решение теста, которым была назначена категория, аннулировано, и категория отозвана.'
						: 'По итогам рассмотрения возражения решение теста изменено, и назначенная им категория отозвана.',
					payload.restored === true
						? 'Действует прежняя категория этой специализации: провал или аннулирование теста выше не понижает подтверждённый грейд.'
						: 'Подробности и доступные тесты — на странице категории и грейда.'
				],
				action: 'Открыть категорию и грейд'
			};
		}
		case 'objection.due_soon':
		case 'objection.overdue': {
			if (facts.object !== 'assessment_objection' || facts.side !== 'staff') unsupported(type, facts);
			const due = facts.dueOn.split('-').reverse().join('.');
			const overdue = type === 'objection.overdue';
			return {
				subject: overdue
					? 'Просрочен ответ на возражение по результату теста'
					: 'Скоро истекает срок ответа на возражение',
				paragraphs: [
					overdue
						? `Срок ответа на возражение кандидата по результату теста истёк ${due}, ответа ещё нет.`
						: `Срок ответа на возражение кандидата по результату теста истекает ${due}, ответа ещё нет.`,
					facts.role === 'operator'
						? 'Возражение ждёт ответа в очереди возражений кабинета оператора.'
						: 'Проверьте, что возражением занимается оператор ФСП: при необходимости выдайте роль оператора.'
				],
				action: facts.role === 'operator' ? 'Открыть очередь возражений' : 'Открыть управление персоналом'
			};
		}
		case 'representation.decided': {
			if (facts.object !== 'representation') unsupported(type, facts);
			const verified = authorityResult.parse(payload.result) === 'verified';
			return verified
				? {
						subject: 'Полномочия представителя подтверждены',
						paragraphs: [
							'Оператор ФСП подтвердил полномочия вашего законного представителя.',
							'Что видят работодатели и какие согласия нужны, показано на странице видимости профиля.'
						],
						action: 'Открыть видимость профиля'
					}
				: {
						subject: 'Полномочия представителя не подтверждены',
						paragraphs: [
							'Оператор ФСП не подтвердил полномочия указанного вами законного представителя, профиль остаётся закрытым.',
							'Укажите законного представителя снова — это можно сделать на платформе.'
						],
						action: 'Указать представителя'
					};
		}
		case 'representation.consents_signed':
			if (facts.object !== 'representation') unsupported(type, facts);
			return {
				subject: 'Законный представитель подписал согласия',
				paragraphs: [
					'Ваш законный представитель подписал согласия по ссылке из письма.',
					'Какие согласия действуют и что видят работодатели, показано на странице согласий профиля.'
				],
				action: 'Открыть согласия'
			};
		case 'representation.consents_revoked': {
			if (facts.object !== 'representation') unsupported(type, facts);
			const catalog = flag.parse(payload.catalog_visibility) === true;
			const fsp = flag.parse(payload.fsp_import) === true;
			return {
				subject: 'Законный представитель отозвал согласия',
				paragraphs: [
					`Ваш законный представитель отозвал согласие ${[
						...(catalog ? ['на показ профиля работодателям'] : []),
						...(fsp ? ['на получение достижений из систем ФСП'] : [])
					].join(' и ')}.`,
					...(catalog ? ['Профиль больше не показывается работодателям в каталоге.'] : []),
					...(fsp ? ['Достижения из систем ФСП убраны из профиля, привязка ФСП ID прекращена.'] : []),
					'Согласие снова начнёт действовать, когда его дадите и вы, и представитель. Что действует сейчас, показано на странице согласий.'
				],
				action: 'Открыть согласия'
			};
		}
		case 'candidate.age_verified': {
			if (facts.object !== 'candidate') unsupported(type, facts);
			const minor = ageRegime.parse(payload.regime) === 'minor';
			const hidden = flag.parse(payload.hidden) === true;
			return {
				subject: 'Дата рождения проверена',
				paragraphs: minor
					? [
							'Оператор ФСП проверил дату рождения по документу. До 18 лет профиль ведётся в защищённом режиме: согласия действуют вместе с согласием законного представителя.',
							...(hidden
								? ['Пока полномочия представителя не подтверждены, профиль не показывается работодателям.']
								: []),
							'Какие согласия нужны и от кого, показано на странице согласий.'
						]
					: [
							'Оператор ФСП проверил дату рождения по документу, профиль ведётся как профиль совершеннолетнего.',
							'Какие согласия действуют, показано на странице согласий.'
						],
				action: 'Открыть согласия'
			};
		}
		case 'assessment.annulled': {
			if (facts.object !== 'assessment_attempt') unsupported(type, facts);
			const retake = GRADE_POLICY.freeRetakeAnnulReasons.includes(annulReason.parse(payload.reason));
			return {
				subject: 'Результат теста аннулирован',
				paragraphs: [
					`Попытка теста «${facts.title}» аннулирована: её результат больше не учитывается в профиле.`,
					retake
						? 'Попытка не засчитывается — тест можно пройти снова сразу.'
						: 'Попытка засчитывается в число попыток по правилам грейда.'
				],
				action: 'Открыть попытку'
			};
		}
		case 'candidate.majority_reached':
			if (facts.object !== 'candidate') unsupported(type, facts);
			return {
				subject: 'Вам исполнилось 18: подтвердите согласия сами',
				paragraphs: [
					'Согласия, которые вы и ваш законный представитель подписали до совершеннолетия, утратили силу, полномочия представителя завершены. Пока вы не подпишете согласие на обработку персональных данных сами, профиль не ведётся и работодатели его не видят.',
					'Подписать согласие можно на странице согласий, показ в каталоге включается заново на странице видимости профиля.'
				],
				action: 'Подписать согласие'
			};
		case 'candidate.inactive_purge_scheduled': {
			if (facts.object !== 'candidate') unsupported(type, facts);
			const purgeOn = z.iso.date().parse(payload.purge_on);
			return {
				subject: 'Профиль будет удалён за неактивность',
				paragraphs: [
					`Вы давно не входили на платформу. По правилам хранения данных профиль неактивного кандидата удаляется: ${purgeOn.split('-').reverse().join('.')} учётная запись, анкета, резюме и достижения будут стёрты.`,
					'Чтобы сохранить профиль, просто войдите на платформу до этой даты.'
				],
				action: 'Войти и сохранить профиль'
			};
		}
		case 'confirmation.requested':
			if (facts.object !== 'confirmation_request' || facts.side !== 'candidate') unsupported(type, facts);
			return {
				subject: 'Компания просит подтвердить навык',
				paragraphs: [
					`Компания «${facts.companyName}» просит подтвердить блок «${facts.blockTitle}» коротким блок-тестом из четырёх заданий.`,
					'Пройти его или отказаться — решаете вы: отказ ни на что не влияет, категория не меняется ни при каком исходе.'
				],
				action: 'Открыть запрос'
			};
		case 'confirmation.completed': {
			if (facts.object !== 'confirmation_request' || facts.side !== 'company') unsupported(type, facts);
			const confirmed = blockVerdict.parse(payload.verdict) === 'confirmed';
			return {
				subject: confirmed ? 'Кандидат подтвердил блок' : 'Блок-тест не подтвердил блок',
				paragraphs: [
					confirmed
						? `Кандидат ${candidateCode(facts.candidatePseudonym)} подтвердил блок «${facts.blockTitle}»: результат можно назвать в «почему вы» нового предложения.`
						: `Блок-тест кандидата ${candidateCode(facts.candidatePseudonym)} по блоку «${facts.blockTitle}» завершён без подтверждения.`
				],
				action: 'Открыть запросы подтверждения'
			};
		}
		case 'challenge.delivered':
		case 'challenge.reminder':
			if (facts.object !== 'challenge_delivery') unsupported(type, facts);
			return {
				subject: type === 'challenge.delivered' ? 'Новый вызов компании' : 'Напоминание о вызове компании',
				paragraphs: [
					`Компания «${facts.companyName}» предлагает короткую задачу «${facts.challengeTitle}» кандидатам вашей категории.`,
					'Вилка и цель видны сразу; решение или подход видит компания без вашего имени и может пригласить по нему.'
				],
				action: 'Открыть вызов'
			};
		case 'application.received':
			if (facts.object !== 'application' || facts.side !== 'company') unsupported(type, facts);
			return {
				subject: 'Новый отклик на вакансию',
				paragraphs: [
					`Кандидат ${candidateCode(facts.candidatePseudonym)} откликнулся на вакансию «${facts.vacancyTitle}».`,
					'Соответствие и контакты, которые кандидат раскрыл с откликом, — в карточке отклика.'
				],
				action: 'Открыть отклик'
			};
		case 'application.decided': {
			if (facts.object !== 'application' || facts.side !== 'candidate') unsupported(type, facts);
			const invited = applicationDecision.parse(payload.decision) === 'invited';
			return {
				subject: invited ? 'Компания пригласила вас по отклику' : 'Компания ответила на отклик',
				paragraphs: [
					invited
						? `Компания «${facts.companyName}» отправила вам предложение по отклику на вакансию «${facts.vacancyTitle}».`
						: `Компания «${facts.companyName}» не готова продолжить по отклику на вакансию «${facts.vacancyTitle}».`
				],
				action: invited ? 'Открыть предложение' : 'Открыть мои отклики'
			};
		}
		case 'complaint.decided': {
			if (facts.object !== 'invitation_complaint') unsupported(type, facts);
			const decided = complaintDecision.parse(payload.decision);
			return {
				subject: 'Жалоба на предложение рассмотрена',
				paragraphs: [
					{
						no_action: `Оператор ФСП рассмотрел вашу жалобу на предложение компании «${facts.companyName}» и не нашёл оснований для мер.`,
						warning: `Оператор ФСП рассмотрел вашу жалобу на предложение компании «${facts.companyName}» и вынес компании предупреждение.`,
						suspension: `Оператор ФСП рассмотрел вашу жалобу на предложение компании «${facts.companyName}» и приостановил работу компании на платформе.`
					}[decided],
					'Объяснение оператора — на странице предложения. Компания не узнаёт, кто пожаловался, и не видит текст жалобы.'
				],
				action: 'Открыть предложение'
			};
		}
		case 'company.complaint_upheld': {
			if (facts.object !== 'company') unsupported(type, facts);
			const decided = upheldDecision.parse(payload.decision);
			const reason = COMPLAINT_REASON_TEXT[complaintReason.parse(payload.reason_code)];
			return {
				subject:
					decided === 'suspension'
						? 'Работа компании приостановлена по жалобе кандидата'
						: 'Предупреждение по жалобе кандидата',
				paragraphs: [
					`Оператор ФСП признал обоснованной жалобу кандидата на предложение компании «${facts.companyName}»: ${reason}.`,
					decided === 'suspension'
						? 'Действия компании на платформе приостановлены, неотвеченные предложения отозваны. Вопросы — оператору ФСП.'
						: 'Это предупреждение: обоснованные жалобы видны кандидатам в фактах о компании, повторное нарушение ведёт к приостановке.'
				],
				action: 'Открыть профиль компании'
			};
		}
		default:
			if (facts.object !== 'invitation') unsupported(type, facts);
			return invitationBody(type, facts, payload);
	}
}

function invitationBody(type: InvitationType, facts: InvitationFacts, payload: Payload): Body {
	const company = `«${facts.companyName}»`;
	const offer = `«${facts.offerTitle}»`;
	const candidateSide = facts.side === 'candidate';
	switch (type) {
		case 'invitation.received':
			if (!candidateSide) unsupported(type, facts);
			return {
				subject: 'Новое приглашение',
				paragraphs: [
					`Компания ${company} предлагает вам работу: ${offer}.`,
					'Посмотрите условия и ответьте до окончания срока: принять или отклонить приглашение можно на платформе.'
				],
				action: 'Открыть приглашение'
			};
		case 'invitation.terms_revised': {
			if (!candidateSide) unsupported(type, facts);
			const lowered = flag.parse(payload.salary_lowered) === true;
			const reopened = flag.parse(payload.reopened) === true;
			return {
				subject: reopened ? 'Приглашение предложено снова' : 'Изменились условия приглашения',
				paragraphs: [
					reopened
						? `Компания ${company} снова предлагает вам работу на новых условиях: ${offer}.`
						: `Компания ${company} изменила условия приглашения ${offer}.`,
					...(lowered ? ['Предложенная зарплата ниже, чем в прошлой версии условий.'] : []),
					'Сравнить версии и ответить можно на платформе.'
				],
				action: 'Посмотреть условия'
			};
		}
		case 'invitation.answered': {
			if (candidateSide) unsupported(type, facts);
			const accepted = decision.parse(payload.decision) === 'accept';
			const byRepresentative = flag.parse(payload.by_representative) === true;
			if (byRepresentative && !accepted) {
				return {
					subject: 'Законный представитель не дал согласия',
					paragraphs: [
						`Законный представитель кандидата ${candidateCode(facts.candidatePseudonym)} не дал согласия на раскрытие контактов по приглашению ${offer}. Приглашение отклонено.`
					],
					action: 'Открыть приглашение'
				};
			}
			return {
				subject: accepted ? 'Кандидат принял приглашение' : 'Кандидат отклонил приглашение',
				paragraphs: [
					accepted
						? `Кандидат ${candidateCode(facts.candidatePseudonym)} принял приглашение ${offer}${byRepresentative ? ' с согласия законного представителя' : ''}. Контакты, которые он раскрыл, доступны в карточке приглашения.`
						: `Кандидат ${candidateCode(facts.candidatePseudonym)} отклонил приглашение ${offer}. Причина — в карточке приглашения.`
				],
				action: 'Открыть приглашение'
			};
		}
		case 'invitation.representative_answered': {
			if (!candidateSide) unsupported(type, facts);
			const accepted = decision.parse(payload.decision) === 'accept';
			return accepted
				? {
						subject: 'Представитель согласен: приглашение принято',
						paragraphs: [
							`Законный представитель согласился на раскрытие контактов компании ${company} по приглашению ${offer}. Приглашение принято, компания получила выбранные контакты.`
						],
						action: 'Открыть приглашение'
					}
				: {
						subject: 'Представитель не дал согласия',
						paragraphs: [
							`Законный представитель не согласился на раскрытие контактов компании ${company} по приглашению ${offer}. Приглашение отклонено, контакты компании не переданы.`
						],
						action: 'Открыть приглашение'
					};
		}
		case 'invitation.expired':
			return candidateSide
				? {
						subject: 'Срок приглашения истёк',
						paragraphs: [`Срок ответа на приглашение компании ${company} ${offer} истёк, приглашение закрыто.`],
						action: 'Открыть приглашение'
					}
				: {
						subject: 'Кандидат не ответил в срок',
						paragraphs: [
							`Кандидат ${candidateCode(facts.candidatePseudonym)} не ответил на приглашение ${offer}, срок истёк.`
						],
						action: 'Открыть приглашение'
					};
		case 'invitation.withdrawn':
			if (!candidateSide) unsupported(type, facts);
			return {
				subject: 'Приглашение отозвано',
				paragraphs: [`Приглашение компании ${company} ${offer} отозвано. Отвечать на него не нужно.`],
				action: 'Открыть приглашение'
			};
		case 'invitation.message':
			// The letter never carries the text: it may hold anything the sides tell each other (domain 13.15).
			return candidateSide
				? {
						subject: 'Новое сообщение от компании',
						paragraphs: [
							`Компания ${company} написала вам в переписке по приглашению ${offer}.`,
							'Прочитать и ответить можно на платформе.'
						],
						action: 'Открыть переписку'
					}
				: {
						subject: 'Новое сообщение от кандидата',
						paragraphs: [
							`Кандидат ${candidateCode(facts.candidatePseudonym)} написал в переписке по приглашению ${offer}.`,
							'Прочитать и ответить можно на платформе.'
						],
						action: 'Открыть переписку'
					};
		case 'invitation.response_due_soon': {
			if (!candidateSide) unsupported(type, facts);
			const hours = hoursLeft.parse(payload.hours_left);
			return {
				subject: 'Скоро истекает срок ответа',
				paragraphs: [
					`До окончания срока ответа на приглашение компании ${company} ${offer} осталось около ${hours} ч.`,
					'Без ответа приглашение закроется.'
				],
				action: 'Ответить на приглашение'
			};
		}
		case 'hiring.outcome_requested':
		case 'hiring.outcome_reminder':
			return {
				subject: type === 'hiring.outcome_requested' ? 'Сообщите исход найма' : 'Напоминание: сообщите исход найма',
				paragraphs: [
					candidateSide
						? `Расскажите, чем закончился найм по приглашению компании ${company} ${offer}.`
						: `Сообщите, чем закончился найм кандидата ${candidateCode(facts.candidatePseudonym)} ${offer}.`,
					'Исход найма нужен, чтобы платформа честно показывала, как работают приглашения. Это займёт минуту.'
				],
				action: 'Сообщить исход'
			};
		case 'hiring.reports_diverged':
			return {
				subject: 'Сообщения об исходе найма расходятся',
				paragraphs: [
					candidateSide
						? `Компания ${company} сообщила об исходе найма по приглашению ${offer} иначе, чем вы.`
						: `Кандидат ${candidateCode(facts.candidatePseudonym)} сообщил об исходе найма по приглашению ${offer} иначе, чем ваша компания.`,
					'Проверьте своё сообщение и при необходимости уточните его.'
				],
				action: 'Открыть процесс найма'
			};
	}
}

/** The letter of a notification to its recipient's address. */
export function notificationLetter(
	to: string,
	type: NotificationType,
	facts: NotificationFacts,
	payload: Payload,
	links: NotificationLinks
): MailMessage {
	const body = bodyOf(type, facts, payload);
	const letter: Letter = {
		subject: body.subject,
		paragraphs: ['Здравствуйте!', ...body.paragraphs],
		action: { label: body.action, href: links.open },
		footnote: `Какие уведомления приходят на почту и в Telegram, можно выбрать в настройках: ${links.settings}`
	};
	return render(to, letter);
}

/** The Telegram text of a notification: the kind of the event only; the link is added by the channel. */
export function telegramText(type: NotificationType): string {
	return `${NOTIFICATION_TYPES[type].title} — ФСП | Карьера`;
}
