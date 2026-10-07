<script lang="ts">
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { candidateMatchView } from '$lib/components/candidate/match.js';
	import { gradeName, SEARCH_STATUSES, skillName, type SearchStatus } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import {
		DegradedModeNotice,
		InvitationStatus,
		MatchBreakdown,
		RecommendationNotice,
		SalaryRange
	} from '$lib/components/product/index.js';
	import type { SalaryView } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const labels = $derived(data.labels);
	const statuses = Object.keys(SEARCH_STATUSES) as SearchStatus[];
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const problem = $derived(form && 'problem' in form ? form.problem : null);

	function salaryOf(salary: (typeof data.page.items)[number]['salary']): SalaryView {
		return {
			min: salary.min,
			max: salary.max,
			...(salary.currency === null ? {} : { currency: salary.currency }),
			...(salary.period === null ? {} : { period: salary.period }),
			...(salary.taxBase === null ? {} : { taxBase: salary.taxBase })
		};
	}

	const search = $derived(data.search);
	const filtered = $derived(search.text !== '' || search.roleKey !== null || search.workFormats.length > 0);
	const roleOptions = $derived(Object.entries(labels.roles).sort(([, a], [, b]) => a.localeCompare(b, 'ru')));
	const formatOptions = $derived(Object.entries(labels.workFormats));

	/** The address of the same search at `cursor` (the first page without it). */
	function searchQuery(cursor: string | null): string {
		const pairs: [string, string][] = [];
		if (search.text !== '') pairs.push(['q', search.text]);
		if (search.roleKey !== null) pairs.push(['role', search.roleKey]);
		for (const format of search.workFormats) pairs.push(['format', format]);
		if (cursor !== null) pairs.push(['cursor', cursor]);
		return pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
	}

	const searchId = $props.id();

	function gradeRange(min: string, max: string): string {
		return min === max ? gradeName(labels, min) : `${gradeName(labels, min)} – ${gradeName(labels, max)}`;
	}
</script>

<PageHeader
	title="Вакансии для вас"
	description="Вы видите вакансии и своё соответствие им. Обычно контакт начинает работодатель — сразу с зарплатой и сроком ответа; на вакансию можно откликнуться и самому, с тем же соответствием."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
	{#snippet actions()}
		<a href={resolve('/me/invitations')} class={buttonVariants({ variant: 'outline' })}>
			<InboxIcon aria-hidden="true" />
			Приглашения
		</a>
		<a href={resolve('/me/applications')} class={buttonVariants({ variant: 'outline' })}>Мои отклики</a>
	{/snippet}
</PageHeader>

<SectionCard
	title="Готовность получать предложения"
	description="Работодатели находят вас сами. Статус поиска виден в карточке; «Не ищу» убирает профиль из каталога."
	testId="search-status"
>
	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'statusSaved' in form}
		<FormMessage tone="success" text="Статус поиска сохранён." />
	{/if}
	<form method="POST" action="?/status" use:enhance class="grid gap-3">
		<CsrfInput />
		<fieldset class="grid gap-2 sm:grid-cols-3">
			<legend class="sr-only">Статус поиска</legend>
			{#each statuses as status (status)}
				<label
					class="flex cursor-pointer gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-accent"
				>
					<input
						type="radio"
						name="search_status"
						value={status}
						class="mt-0.5 size-4 accent-primary"
						checked={data.searchStatus === status}
					/>
					<span class="grid gap-0.5">
						<span class="font-medium">{SEARCH_STATUSES[status].label}</span>
						<span class="text-xs text-muted-foreground">{SEARCH_STATUSES[status].hint}</span>
					</span>
				</label>
			{/each}
		</fieldset>
		<div class="flex flex-wrap items-center gap-3">
			<Button type="submit" variant="outline">Сохранить статус</Button>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/visibility')}>
				Кто видит профиль — видимость и согласия
			</a>
		</div>
	</form>
</SectionCard>

<RecommendationNotice compact />
{#if data.page.mode.searchMode === 'fts_only'}
	<DegradedModeNotice operations={['embed']} />
{/if}

<form
	method="GET"
	class="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
	aria-label="Поиск вакансий"
	data-testid="vacancy-search"
	data-sveltekit-keepfocus
>
	<Field.Field>
		<Field.Label for="{searchId}-q">Название, навыки, компания</Field.Label>
		<Input id="{searchId}-q" name="q" type="search" value={search.text} placeholder="Например: Go, Kubernetes" />
	</Field.Field>
	<Field.Field>
		<Field.Label for="{searchId}-role">Роль</Field.Label>
		<NativeSelect id="{searchId}-role" name="role" value={search.roleKey ?? ''}>
			<option value="">Любая</option>
			{#each roleOptions as [key, name] (key)}
				<option value={key}>{name}</option>
			{/each}
		</NativeSelect>
	</Field.Field>
	<fieldset class="grid gap-2 md:col-span-2">
		<legend class="mb-1 text-sm font-medium">Формат работы</legend>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each formatOptions as [key, name] (key)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="format"
						value={key}
						checked={search.workFormats.includes(key)}
						class="size-4 accent-primary"
					/>
					{name}
				</label>
			{/each}
		</div>
	</fieldset>
	<div class="flex flex-wrap items-end gap-3">
		<Button type="submit">
			<SearchIcon aria-hidden="true" />
			Найти
		</Button>
		{#if filtered}
			<a class={buttonVariants({ variant: 'ghost' })} href={resolve('/me/vacancies')}>Сбросить</a>
		{/if}
	</div>
</form>

{#if data.page.items.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><BriefcaseIcon aria-hidden="true" /></Empty.Media>
			{#if filtered}
				<Empty.Title>По запросу вакансий нет</Empty.Title>
				<Empty.Description>Измените запрос или фильтры.</Empty.Description>
			{:else}
				<Empty.Title>Подходящих открытых вакансий сейчас нет</Empty.Title>
				<Empty.Description>Список обновляется по мере публикации вакансий.</Empty.Description>
			{/if}
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-4" data-testid="vacancy-list">
		{#each data.page.items as item (item.vacancyId)}
			{@const grade = gradeRange(item.gradeMin, item.gradeMax)}
			<li class="grid gap-3 rounded-xl border bg-card p-4 shadow-xs sm:p-5">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="grid gap-1">
						<h2 class="font-heading text-h3">{item.title}</h2>
						<p class="text-sm text-muted-foreground">
							{item.company}{item.companyVerification === 'verified'
								? ' · компания проверена'
								: ' · компания не проверена'}
						</p>
					</div>
					<p class="text-right">
						<span class="font-heading text-h2 text-link numeric">{percent.format(item.match.score)}</span>
						<span class="block text-xs text-muted-foreground">соответствие</span>
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
					<SalaryRange salary={salaryOf(item.salary)} />
					<span>Грейд: {grade}</span>
					<span>{labels.workFormats[item.workFormat] ?? item.workFormat}</span>
				</div>
				{#if item.requiredSkillKeys.length > 0}
					<p class="text-sm">
						<span class="text-muted-foreground">Обязательные навыки:</span>
						{item.requiredSkillKeys.map((key) => skillName(labels, key)).join(', ')}
					</p>
				{/if}
				<a
					class="justify-self-start text-sm text-link underline underline-offset-4"
					href={resolve('/(app)/me/vacancies/[id]', { id: item.vacancyId })}
					data-testid="vacancy-apply">Вакансия и отклик</a
				>
				{#if item.invitation}
					<p class="flex flex-wrap items-center gap-2 text-sm">
						<InvitationStatus status={item.invitation.status} />
						<a
							class="text-link underline underline-offset-4"
							href={resolve('/(app)/me/invitations/[id]', { id: item.invitation.id })}>Открыть приглашение</a
						>
					</p>
				{/if}
				<details class="rounded-lg border">
					<summary class="cursor-pointer px-3 py-2 text-sm font-medium">Почему подходит и чего не хватает</summary>
					<div class="p-3 pt-0">
						<MatchBreakdown match={candidateMatchView(item.match, labels)} />
					</div>
				</details>
			</li>
		{/each}
	</ul>
	<div class="flex flex-wrap gap-3">
		{#if search.cursor !== null}
			<a href="{resolve('/me/vacancies')}?{searchQuery(null)}" class={buttonVariants({ variant: 'outline' })}
				>К началу списка</a
			>
		{/if}
		{#if data.page.nextCursor}
			<a
				href="{resolve('/me/vacancies')}?{searchQuery(data.page.nextCursor)}"
				class={buttonVariants({ variant: 'outline' })}>Следующие вакансии</a
			>
		{/if}
	</div>
{/if}
