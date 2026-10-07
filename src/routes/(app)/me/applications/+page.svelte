<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { DISCLOSURE_FIELDS } from '$lib/components/candidate/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { APPLICATION_STATUS } from '$lib/components/product/application-status.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const problem = $derived(form && 'problem' in form ? form.problem : null);
</script>

<PageHeader
	title="Мои отклики"
	description="Отклик — второй путь к работодателю: на вакансию компании платформы, с твоим соответствием и выбранными контактами. Отозвав отклик, ты закрываешь компании дальнейший доступ к контактам."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/vacancies')}>Вакансии</a>{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'withdrawn' in form}
	<FormMessage tone="success" text="Отклик отозван: компания больше не получает твои контакты через платформу." />
{:else if data.sent}
	<FormMessage tone="success" text="Отклик отправлен: компания получила соответствие и выбранные контакты." />
{/if}

{#if data.applications.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><SendIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Откликов пока нет</Empty.Title>
			<Empty.Description>Откликнуться можно на вакансию компании платформы со страницы вакансии.</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/vacancies')}
				>Вакансии компаний платформы</a
			>
		</Empty.Content>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-testid="application-list">
		{#each data.applications as item (item.id)}
			<li
				class="grid gap-3 rounded-xl border bg-card p-4 shadow-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
				data-application-status={item.status}
			>
				<div class="grid gap-1">
					<a
						class="font-heading text-lg underline-offset-4 hover:underline"
						href={resolve('/(app)/me/vacancies/[id]', { id: item.vacancy.id })}>{item.vacancy.title}</a
					>
					<span class="text-sm text-muted-foreground">
						{item.companyName} · отправлен {formatDate(item.submittedAt)} · соответствие {percent.format(
							item.match.score
						)}
					</span>
					<span class="text-xs text-muted-foreground">
						{item.disclosedFields.length > 0
							? `Компания получает: ${item.disclosedFields.map((field) => DISCLOSURE_FIELDS[field]).join(', ')}`
							: 'Контакты больше не передаются'}
					</span>
				</div>
				<div class="flex flex-wrap items-center gap-2 sm:justify-end">
					<StatusPill label={APPLICATION_STATUS[item.status].label} tone={APPLICATION_STATUS[item.status].tone} />
					{#if item.invitationId}
						<a
							class="text-sm text-link underline underline-offset-4"
							href={resolve('/(app)/me/invitations/[id]', { id: item.invitationId })}>Предложение</a
						>
					{/if}
					{#if item.status === 'submitted' || item.status === 'viewed' || item.status === 'invited'}
						<form method="POST" action="?/withdraw" use:enhance>
							<CsrfInput />
							<input type="hidden" name="applicationId" value={item.id} />
							<Button type="submit" variant="ghost" size="sm">Отозвать</Button>
						</form>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
{/if}
