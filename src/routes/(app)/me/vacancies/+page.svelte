<script lang="ts">
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resolve } from '$app/paths';
	import { candidateMatchView } from '$lib/components/candidate/match.js';
	import { gradeName, skillName } from '$lib/components/candidate/model.js';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
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

	let { data }: PageProps = $props();

	const labels = $derived(data.labels);
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

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
	const filtered = $derived(
		search.text !== '' || search.roleKey !== null || search.gradeKey !== null || search.workFormats.length > 0
	);
	const roleOptions = $derived(Object.entries(labels.roles).sort(([, a], [, b]) => a.localeCompare(b, 'ru')));
	const gradeOptions = $derived(Object.entries(labels.grades));
	const formatOptions = $derived(Object.entries(labels.workFormats));

	/** The address of the same search at `cursor` (the first page without it). */
	function searchQuery(cursor: string | null): string {
		const pairs: [string, string][] = [];
		if (search.text !== '') pairs.push(['q', search.text]);
		if (search.roleKey !== null) pairs.push(['role', search.roleKey]);
		if (search.gradeKey !== null) pairs.push(['grade', search.gradeKey]);
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
		<a href={resolve('/me/applications')} class={buttonVariants({ variant: 'outline' })}>Мои отклики</a>
	{/snippet}
</PageHeader>

<RecommendationNotice compact />
{#if data.page.mode.searchMode === 'fts_only'}
	<DegradedModeNotice operations={['embed']} />
{/if}

<form
	method="GET"
	class="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]"
	aria-label="Поиск вакансий"
	data-testid="vacancy-search"
	data-sveltekit-keepfocus
>
	<Field.Field class="md:col-span-2 lg:col-span-1">
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
	<Field.Field>
		<Field.Label for="{searchId}-grade">Грейд</Field.Label>
		<NativeSelect id="{searchId}-grade" name="grade" value={search.gradeKey ?? ''}>
			<option value="">Любой</option>
			{#each gradeOptions as [key, name] (key)}
				<option value={key}>{name}</option>
			{/each}
		</NativeSelect>
	</Field.Field>
	<fieldset class="grid gap-2 md:col-span-2 lg:col-span-3">
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
