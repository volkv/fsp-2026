<script lang="ts">
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { resolve } from '$app/paths';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
</script>

<PageHeader
	title="Мои данные"
	description="Всё, что платформа хранит о вас, одним файлом JSON: его можно сохранить, прочитать или перенести в другой сервис."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
	{#snippet actions()}
		<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/consents')}>Согласия</a>
	{/snippet}
</PageHeader>

<SectionCard
	title="Что в выгрузке"
	description="Каждая выгрузка записывается в журнал действий: кто, когда и откуда скачал данные."
	testId="data-export"
>
	<ul class="grid list-disc gap-1 pl-5 text-sm">
		<li>
			учётная запись: почта, способы входа, привязанный ФСП ID, даты регистрации и последнего входа, каналы и настройки
			уведомлений;
		</li>
		<li>анкета: имя, телефон, дата рождения, желаемые роли, ожидания по работе, компании, от которых вы скрыты;</li>
		<li>
			загруженные резюме с распознанным текстом, факты профиля с найденными в них навыками и опытом, квитанции проверки;
		</li>
		<li>все расчёты категории с объяснением, навыками и уровнями ФСП, ваши возражения и ответы на них;</li>
		<li>соответствие вакансиям, которые вы видите в подборке;</li>
		<li>
			согласия: кто, когда и какую редакцию подписал или отозвал; принятые соглашения; законный представитель и проверка
			его полномочий;
		</li>
		<li>приглашения с версиями условий и вашими ответами, кому и какие контакты переданы, процессы найма;</li>
		<li>попытки тестов с ответами, решениями и оценками;</li>
		<li>уведомления и то, куда они были доставлены;</li>
		<li>
			журнал действий с вашими данными: просмотры карточки компаниями, раскрытия, изменения. Сотрудники компаний и
			платформы названы компанией или ролью.
		</li>
	</ul>
	<a
		class="{buttonVariants()} justify-self-start"
		href={resolve('/me/export/download')}
		data-sveltekit-reload
		data-testid="data-export-download"
	>
		<DownloadIcon aria-hidden="true" />
		Скачать мои данные
	</a>
	<p class="text-sm text-muted-foreground">
		Удалить профиль и учётную запись можно на странице <a
			class="text-link underline underline-offset-4"
			href={resolve('/account/delete')}>удаления учётной записи</a
		>.
	</p>
</SectionCard>
