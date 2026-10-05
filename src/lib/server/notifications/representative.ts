// Letters to the legal representative of a candidate aged 14–17 (docs/domain.md, sections 3.7, 6.4). The representative
// has no account: a letter is the whole channel, and its link is a one-time token of one purpose. A letter names the
// candidate and, for a disclosure, the company, the vacancy, the offered range and the contacts to be handed over —
// the data of the representative's own ward, which the answer is about. Every consents letter leads to the page where
// the representative signs what is missing and revokes what was given; after each change a new letter says what is in
// force and carries a new link. The one letter to the candidate here tells that the representative revoked the
// processing consent and the profile is being deleted: it leaves straight through the mailer, as the deletion letter.
import { formatDateTime, SALARY_PERIODS, TAX_BASES } from '$lib/components/product/model.js';
import type { DisclosureField } from '$lib/server/consent/kinds';
import type { OfferedSalary } from '$lib/server/invitations/terms';
import type { MailMessage } from '$lib/server/mail/mailer';
import { render } from '$lib/server/mail/templates';

export const DISCLOSURE_FIELD_NAMES: Record<DisclosureField, string> = {
	full_name: 'фамилия, имя и отчество',
	email: 'адрес почты',
	phone: 'телефон',
	telegram: 'имя в Telegram',
	resume: 'файл резюме'
};

export function representativeConsentLink(appOrigin: string, token: string): string {
	return `${appOrigin}/representative/consent?token=${encodeURIComponent(token)}`;
}

/** The page where the representative asks for a new consents letter by the address. */
export function representativeLetterRequestLink(appOrigin: string): string {
	return `${appOrigin}/representative/letter`;
}

export function representativeDisclosureLink(appOrigin: string, token: string): string {
	return `${appOrigin}/representative/disclosure?token=${encodeURIComponent(token)}`;
}

/** The offered range in words: «от 60 000 до 80 000 RUB в месяц, до вычета НДФЛ». */
export function salaryWords(salary: OfferedSalary): string {
	const amount = new Intl.NumberFormat('ru-RU');
	return `от ${amount.format(salary.min)} до ${amount.format(salary.max)} ${salary.currency} ${SALARY_PERIODS[salary.period]}, ${TAX_BASES[salary.taxBase]}`;
}

/** The consents the representative signs by the letter, as a letter and the page name them. */
export const REPRESENTATIVE_CONSENT_NAMES = {
	pd_processing: 'обработка персональных данных',
	catalog_visibility: 'показ профиля работодателям платформы',
	fsp_import: 'получение достижений из систем ФСП'
} as const;

type ConsentName = keyof typeof REPRESENTATIVE_CONSENT_NAMES;

/**
 * The consents letter: after the operator verified the authority, at the candidate's request or at the representative's
 * own. The same link signs what is missing and revokes what was given.
 */
export function representativeConsentLetter(
	to: string,
	input: { representativeName: string; candidateName: string; link: string; requestLink: string; expiresAt: Date }
): MailMessage {
	return render(to, {
		subject: 'Согласие законного представителя',
		paragraphs: [
			`Здравствуйте, ${input.representativeName}!`,
			`Оператор ФСП подтвердил ваши полномочия законного представителя кандидата ${input.candidateName} на платформе ИТ-найма Федерации спортивного программирования.`,
			'До 18 лет профиль кандидата ведётся только с согласия представителя. По ссылке — тексты согласий: на обработку персональных данных (без него профиль не ведётся), на показ профиля работодателям платформы в контексте подходящей вакансии и, по желанию, на получение достижений из систем ФСП. Каждое согласие подписывается отдельно и отзывается в любой момент — по этой же ссылке.'
		],
		action: { label: 'Прочитать и подписать согласия', href: input.link },
		footnote: `Ссылка действует до ${formatDateTime(input.expiresAt)} и срабатывает один раз. Новое письмо может запросить кандидат в своём профиле или вы сами: ${input.requestLink}. Если вы не знаете, о ком речь, удалите письмо — без вашей подписи профиль остаётся закрытым.`
	});
}

/**
 * After the representative signed or revoked by the link: what is now in force on the representative's side, and a new
 * link to change it.
 */
export function representativeConsentsChangedLetter(
	to: string,
	input: {
		representativeName: string;
		candidateName: string;
		change: 'signed' | 'revoked';
		/** By consent: whether the representative's signature is in force now. */
		inForce: Record<ConsentName, boolean>;
		link: string;
		requestLink: string;
		expiresAt: Date;
	}
): MailMessage {
	const state = (Object.keys(REPRESENTATIVE_CONSENT_NAMES) as ConsentName[])
		.map((kind) => `${REPRESENTATIVE_CONSENT_NAMES[kind]} — ${input.inForce[kind] ? 'подписано' : 'не подписано'}`)
		.join('; ');
	return render(to, {
		subject: 'Согласия законного представителя изменены',
		paragraphs: [
			`Здравствуйте, ${input.representativeName}!`,
			input.change === 'signed'
				? `Вы подписали согласия как законный представитель кандидата ${input.candidateName} на платформе ИТ-найма Федерации спортивного программирования.`
				: `Вы отозвали согласия как законный представитель кандидата ${input.candidateName} на платформе ИТ-найма Федерации спортивного программирования. Кандидат получил уведомление.`,
			`Сейчас с вашей стороны: ${state}. Согласие действует, когда его дали и кандидат, и вы.`,
			'Подписать недостающее или отозвать данное можно по ссылке.'
		],
		action: { label: 'Управлять согласиями', href: input.link },
		footnote: `Ссылка действует до ${formatDateTime(input.expiresAt)} и срабатывает один раз; после каждого действия приходит новое письмо. Новую ссылку можно запросить в любой момент: ${input.requestLink}.`
	});
}

/**
 * To the candidate: the representative revoked the processing consent, so the profile is being deleted (domain 19.1).
 * Sent straight through the mailer after the commit, as the deletion letter: the purge leaves nobody to notify.
 */
export function processingRevokedByRepresentativeLetter(to: string): MailMessage {
	return render(to, {
		subject: 'Представитель отозвал согласие: профиль удаляется',
		paragraphs: [
			'Здравствуйте!',
			'Ваш законный представитель отозвал согласие на обработку персональных данных. До 18 лет профиль без этого согласия не ведётся, поэтому учётная запись удаляется: вход закрыт, профиль скрыт от работодателей, неотвеченные приглашения отозваны.',
			'Данные учётной записи стираются в течение 30 дней. Остаются только записи журнала действий и сведения о переданных компаниям контактах — без имени и адреса, на срок, установленный правилами хранения.'
		],
		footnote:
			'Контакты, которые раньше были переданы компаниям по приглашениям, остаются у этих компаний. Если это ошибка, поговорите с представителем: зарегистрироваться снова можно в любой момент.'
	});
}

/** The ward accepted an invitation: the contacts reach the company only with the representative's consent. */
export function representativeDisclosureLetter(
	to: string,
	input: {
		representativeName: string;
		candidateName: string;
		companyName: string;
		offerTitle: string;
		salary: OfferedSalary;
		fields: readonly DisclosureField[];
		dueAt: Date;
		link: string;
	}
): MailMessage {
	return render(to, {
		subject: `Согласие на раскрытие контактов компании «${input.companyName}»`,
		paragraphs: [
			`Здравствуйте, ${input.representativeName}!`,
			`${input.candidateName} принимает приглашение компании «${input.companyName}» — «${input.offerTitle}»: ${salaryWords(input.salary)}.`,
			`Компания получит: ${input.fields.map((field) => DISCLOSURE_FIELD_NAMES[field]).join(', ')}. До 18 лет контакты передаются только с согласия законного представителя; без него приглашение не будет принято.`,
			`Ответить нужно до ${formatDateTime(input.dueAt)} — это срок ответа на приглашение, после него оно закроется.`
		],
		action: { label: 'Посмотреть приглашение и ответить', href: input.link },
		footnote:
			'Ссылка срабатывает один раз. Если вы не знаете, о ком речь, удалите письмо — без вашего ответа контакты не передаются.'
	});
}
