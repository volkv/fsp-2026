// Account messages (notification category `account`, domain 3.7): always by email, never switched off.
// Each template yields the subject, a plain-text body and the same content as simple HTML.
import { MAIL_LOGO, MAIL_LOGO_CID } from './logo';
import type { MailMessage } from './mailer';

const PRODUCT = 'ФСП | Карьера';

/** The FSP brandbook palette of the letters: text #1B1C21, a grey of its scale (6.3:1), the logo blue for the button. */
const MAIL_COLORS = { text: '#1b1c21', muted: '#5f5f66', bar: '#9b9c9e', button: '#402fff' } as const;

/** The head of every letter: the FSP logo, inline (`logo.ts`), and the product name beside it. */
const LETTERHEAD =
	`<p style="margin:0 0 24px"><img src="cid:${MAIL_LOGO_CID}" width="${MAIL_LOGO.width}" height="${MAIL_LOGO.height}" alt="ФСП" style="vertical-align:middle;border:0">` +
	` <span style="vertical-align:middle;font-size:18px;font-weight:600;color:${MAIL_COLORS.text}"><span style="color:${MAIL_COLORS.bar}">|</span> Карьера</span></p>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export interface Letter {
	subject: string;
	paragraphs: string[];
	action?: { label: string; href: string };
	footnote: string;
}

export function render(to: string, letter: Letter): MailMessage {
	const text = [
		...letter.paragraphs,
		...(letter.action ? [`${letter.action.label}: ${letter.action.href}`] : []),
		letter.footnote,
		`— ${PRODUCT}`
	].join('\n\n');
	const html = [
		`<!doctype html><html lang="ru"><body style="background:#ffffff;font-family:Inter,Arial,sans-serif;color:${MAIL_COLORS.text};line-height:1.5">`,
		LETTERHEAD,
		...letter.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
		...(letter.action
			? [
					`<p><a href="${escapeHtml(letter.action.href)}" style="display:inline-block;padding:10px 18px;background:${MAIL_COLORS.button};color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(letter.action.label)}</a></p>`,
					`<p style="font-size:13px;color:${MAIL_COLORS.muted}">Если кнопка не работает, откройте ссылку: ${escapeHtml(letter.action.href)}</p>`
				]
			: []),
		`<p style="font-size:13px;color:${MAIL_COLORS.muted}">${escapeHtml(letter.footnote)}</p>`,
		`<p style="font-size:13px;color:${MAIL_COLORS.muted}">— ${PRODUCT}</p>`,
		'</body></html>'
	].join('');
	return { to, subject: `${letter.subject} — ${PRODUCT}`, text, html };
}

export function verifyEmailLetter(to: string, link: string): MailMessage {
	return render(to, {
		subject: 'Подтвердите почту',
		paragraphs: [
			'Здравствуйте!',
			'Этот адрес указали при регистрации на платформе ИТ-найма Федерации спортивного программирования. Подтвердите, что он ваш: пока адрес не подтверждён, профиль не виден работодателям, а компания не может подать заявку на проверку.'
		],
		action: { label: 'Подтвердить почту', href: link },
		footnote:
			'Ссылка действует 24 часа. Если вы не регистрировались, просто удалите письмо — без подтверждения учётная запись не активируется.'
	});
}

export function resetPasswordLetter(to: string, link: string): MailMessage {
	return render(to, {
		subject: 'Сброс пароля',
		paragraphs: [
			'Здравствуйте!',
			'Кто-то запросил сброс пароля для вашей учётной записи. Если это были вы, задайте новый пароль по ссылке: после смены все открытые сеансы будут завершены.'
		],
		action: { label: 'Задать новый пароль', href: link },
		footnote:
			'Ссылка действует 1 час и срабатывает один раз. Если вы не запрашивали сброс, ничего не делайте: пароль останется прежним.'
	});
}

export function passwordChangedLetter(to: string, loginLink: string): MailMessage {
	return render(to, {
		subject: 'Пароль изменён',
		paragraphs: [
			'Здравствуйте!',
			'Пароль вашей учётной записи только что изменён, все остальные сеансы завершены.',
			'Если это сделали не вы, сразу восстановите доступ через «Забыли пароль?» на странице входа.'
		],
		action: { label: 'Открыть страницу входа', href: loginLink },
		footnote: 'Это письмо о безопасности учётной записи: такие письма приходят всегда.'
	});
}

export function representativeInviteLetter(
	to: string,
	input: { representativeName: string; candidateName: string; link: string }
): MailMessage {
	return render(to, {
		subject: 'Подтвердите контакт законного представителя',
		paragraphs: [
			`Здравствуйте, ${input.representativeName}!`,
			`${input.candidateName} регистрируется на платформе ИТ-найма Федерации спортивного программирования и указал(а) вас как законного представителя. Кандидатам от 14 до 17 лет профиль открывается только с согласия представителя.`,
			'Подтвердите, что этот адрес ваш. После этого оператор ФСП свяжется с вами и проверит полномочия по документу — письмо само по себе проверкой не является.'
		],
		action: { label: 'Подтвердить контакт', href: input.link },
		footnote:
			'Ссылка действует 24 часа. Если вы не знаете, о ком речь, просто удалите письмо: без подтверждения профиль останется закрытым.'
	});
}

const MEMBER_ROLE_NAMES = { owner: 'владелец', recruiter: 'рекрутер' } as const;

export function memberInviteLetter(
	to: string,
	input: { companyName: string; role: 'owner' | 'recruiter'; link: string }
): MailMessage {
	return render(to, {
		subject: `Приглашение в команду «${input.companyName}»`,
		paragraphs: [
			'Здравствуйте!',
			`Вас пригласили в команду компании «${input.companyName}» на платформе ИТ-найма Федерации спортивного программирования. Роль в команде — ${MEMBER_ROLE_NAMES[input.role]}.`,
			'Примите приглашение, войдя под этим адресом почты или зарегистрировавшись с ним. Учётная запись кандидата не может представлять работодателя.'
		],
		action: { label: 'Принять приглашение', href: input.link },
		footnote: 'Ссылка действует 24 часа. Если вы не ждали приглашения, просто удалите письмо.'
	});
}
