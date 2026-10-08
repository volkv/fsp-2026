<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { DISCLOSURE_FIELDS } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import OfferForm from '$lib/components/employer/offer-form.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { APPLICATION_STATUS } from '$lib/components/product/application-status.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const application = $derived(data.application);
	const contacts = $derived(data.contacts);
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const open = $derived(application.status === 'submitted' || application.status === 'viewed');
	const COMPONENTS: Record<string, string> = {
		required: 'Обязательные навыки',
		nice: 'Желательные навыки',
		role: 'Роль',
		trust: 'Доверие к оценке',
		grade: 'Грейд',
		salary: 'Зарплата',
		semantic: 'Смысловая близость',
		reranker: 'Уточняющая модель'
	};
</script>

<PageHeader
	title={`Отклик кандидата ${application.candidatePseudonym ?? ''}`}
	description={`${application.vacancy.title} · ${formatDateTime(application.submittedAt)}`}
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/company/applications')}>Отклики</a
		>{/snippet}
	{#snippet actions()}
		<StatusPill
			label={APPLICATION_STATUS[application.status].label}
			tone={APPLICATION_STATUS[application.status].tone}
		/>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'rejected' in form}
	<FormMessage tone="success" text="Отказ отправлен кандидату." />
{/if}

{#if application.message}
	<SectionCard title="Сообщение кандидата">
		<p class="whitespace-pre-line">{application.message}</p>
	</SectionCard>
{/if}

<SectionCard
	title={`Соответствие на момент отклика — ${percent.format(application.match.score)}`}
	description={`Набор правил соответствия, версия ${application.match.ruleset_version}; покрытие ${percent.format(application.match.coverage)}.`}
	testId="application-match"
>
	<dl class="grid gap-2 text-sm sm:grid-cols-2">
		{#each Object.entries(application.match.components) as [key, component] (key)}
			<div class="flex justify-between gap-2 rounded-md border px-3 py-1.5">
				<dt>{COMPONENTS[key] ?? key}</dt>
				<dd class="numeric">{component.value === null ? 'нет данных' : percent.format(component.value)}</dd>
			</div>
		{/each}
	</dl>
</SectionCard>

<SectionCard
	title="Контакты по отклику"
	description="Кандидат раскрыл их вашей компании своим откликом. Отзыв отклика закрывает дальнейший доступ; чтение записывается в журнал."
	testId="application-contacts"
>
	{#if contacts}
		<dl class="grid gap-2 text-sm">
			{#if contacts.fullName}
				<div>
					<dt class="text-muted-foreground">{DISCLOSURE_FIELDS.full_name}</dt>
					<dd>
						{[contacts.fullName.last, contacts.fullName.first, contacts.fullName.middle].filter(Boolean).join(' ') ||
							'не указано'}
					</dd>
				</div>
			{/if}
			{#if contacts.email}
				<div>
					<dt class="text-muted-foreground">{DISCLOSURE_FIELDS.email}</dt>
					<dd>{contacts.email}</dd>
				</div>
			{/if}
			{#if contacts.phone !== undefined}
				<div>
					<dt class="text-muted-foreground">{DISCLOSURE_FIELDS.phone}</dt>
					<dd>{contacts.phone ?? 'не указан'}</dd>
				</div>
			{/if}
			{#if contacts.telegram !== undefined}
				<div>
					<dt class="text-muted-foreground">{DISCLOSURE_FIELDS.telegram}</dt>
					<dd>{contacts.telegram ?? 'не указан'}</dd>
				</div>
			{/if}
			{#if contacts.resumeFileId !== undefined}
				<div>
					<dt class="text-muted-foreground">{DISCLOSURE_FIELDS.resume}</dt>
					<dd>
						{#if contacts.resumeFileId}
							<a
								class="text-link underline"
								href="{resolve('/(app)/company/(member)/applications/[id]/resume', {
									id: application.id
								})}?file={contacts.resumeFileId}"
								data-testid="disclosed-resume">Скачать</a
							>
						{:else}
							не загружено
						{/if}
					</dd>
				</div>
			{/if}
		</dl>
	{:else}
		<p class="text-sm text-muted-foreground">Кандидат отозвал отклик: контакты больше не передаются.</p>
	{/if}
</SectionCard>

{#if open}
	<SectionCard
		title="Пригласить по отклику"
		description="Отклик — согласие кандидата на контакт с вашей компанией: предложение уходит ему, даже если профиль скрыт из каталога. Описание, вилка в рублях, способ связи и «почему вы»."
		testId="application-offer"
	>
		{#if data.invitation}
			<a
				class={buttonVariants({ variant: 'outline' })}
				href={resolve('/(app)/company/(member)/invitations/[id]', { id: data.invitation.id })}
				>Предложение этому кандидату уже есть</a
			>
		{:else if !data.offer.profileComplete}
			<p class="text-sm text-muted-foreground">
				Заполните описание и направление деятельности в
				<a class="text-link underline" href={resolve('/company/profile')}>профиле компании</a>.
			</p>
		{:else}
			<OfferForm
				action="?/offer"
				vacancies={data.offer.vacancies}
				workFormats={data.offer.workFormats}
				whyYouOptions={data.whyYouOptions}
				preselected={data.whyYouOptions.slice(0, 3).map((option) => option.key)}
				needId={null}
				responseWindowHours={data.offer.responseWindowHours}
				problems={problem?.fields ?? {}}
			/>
		{/if}
	</SectionCard>
	<form method="POST" action="?/reject" use:enhance>
		<CsrfInput />
		<Button type="submit" variant="outline">Отказать</Button>
	</form>
{:else if application.invitationId}
	<a
		class={buttonVariants({ variant: 'outline' })}
		href={resolve('/(app)/company/(member)/invitations/[id]', { id: application.invitationId })}>Предложение</a
	>
{/if}
