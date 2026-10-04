// The letter that confirms a deletion of the account (docs/domain.md, sections 3.7, 19). It leaves right after the
// request, straight through the mailer: the purge erases the address, the notifications and the channels, so a
// notification queued for later delivery would find nobody to write to.
import type { MailMessage } from '$lib/server/mail/mailer';
import { render } from '$lib/server/mail/templates';

export function accountDeletionLetter(to: string, input: { candidate: boolean }): MailMessage {
	return render(to, {
		subject: 'Учётная запись удалена',
		paragraphs: [
			'Здравствуйте!',
			input.candidate
				? 'Вы удалили учётную запись на платформе ИТ-найма Федерации спортивного программирования и отозвали согласие на обработку персональных данных. Профиль уже скрыт от работодателей, вход закрыт, неотвеченные приглашения отозваны.'
				: 'Вы удалили учётную запись на платформе ИТ-найма Федерации спортивного программирования. Вход закрыт, ваше участие в команде компании завершено, созданные вами ключи API отозваны.',
			'Данные учётной записи стираются в течение 30 дней: анкета, резюме и файлы, достижения, результаты тестов, категории и соответствия вакансиям, уведомления. Остаются только записи журнала действий и сведения о переданных компаниям контактах — без имени и адреса, на срок, установленный правилами хранения.'
		],
		footnote:
			'Контакты, которые вы раньше передали компаниям по приглашениям, остаются у этих компаний: они обрабатывают их самостоятельно. Если вы не удаляли учётную запись, напишите оператору платформы.'
	});
}
