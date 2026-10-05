<script lang="ts">
	import { resolve } from '$app/paths';
	import UsersIcon from '@lucide/svelte/icons/users';
	import CandidateRow from '$lib/components/employer/candidate-row.svelte';
	import CatalogFilters from '$lib/components/employer/catalog-filters.svelte';
	import SearchModeNotice from '$lib/components/employer/search-mode-notice.svelte';
	import VacancyStatus from '$lib/components/employer/vacancy-status.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { RecommendationNotice } from '$lib/components/product/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const catalog = $derived(data.catalog);
</script>

<PageHeader
	title="Кандидаты"
	description="Каталог проверяемых профилей: категории по осям, уровень ФСП, подтверждённые навыки. Соответствие и приглашение — под конкретную вакансию."
/>

{#if data.vacancies.length > 0}
	<nav aria-label="Подбор под вакансию" class="flex flex-wrap items-center gap-2 text-sm">
		<span class="text-muted-foreground">Подбор под вакансию:</span>
		{#each data.vacancies as vacancy (vacancy.id)}
			<a
				class="inline-flex items-center gap-2 rounded-full border px-3 py-1 hover:bg-muted"
				href={resolve('/(app)/company/(member)/vacancies/[id]/candidates', { id: vacancy.id })}
			>
				{vacancy.title}
				<VacancyStatus status={vacancy.status} />
			</a>
		{/each}
	</nav>
{/if}

<RecommendationNotice compact />

{#if catalog === null}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><UsersIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Каталог кандидатов закрыт до проверки компании</Empty.Title>
			<Empty.Description>Кандидатов видит только компания, проверенная оператором ФСП.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
		<aside class="lg:sticky lg:top-20 lg:self-start">
			<CatalogFilters
				values={catalog.query}
				specializations={data.filters.specializations}
				grades={data.filters.grades}
				formats={data.filters.formats}
				regions={data.filters.regions}
			/>
		</aside>
		<div class="grid content-start gap-4">
			{#if catalog.unknownStack.length > 0}
				<FormMessage
					text={`Нет в справочнике навыков, фильтр по ним не применён: ${catalog.unknownStack.join(', ')}`}
				/>
			{/if}
			{#if catalog.problem}
				<FormMessage text={catalog.problem} />
			{/if}
			{#if catalog.page}
				<SearchModeNotice mode={catalog.page.mode} />
				{#each catalog.page.items as item (item.pseudonym)}
					<CandidateRow
						pseudonym={item.pseudonym}
						summary={item.summary}
						match={null}
						labels={data.labels}
						href={resolve('/(app)/company/(member)/candidates/[pseudonym]', { pseudonym: item.pseudonym })}
					/>
				{:else}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Title>Никого не нашлось</Empty.Title>
							<Empty.Description>Ослабьте фильтры или уточните запрос.</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{/each}
				{#if catalog.page.nextCursor}
					<form method="GET" class="justify-self-center">
						{#each catalog.params as [name, value], index (index)}
							<input type="hidden" {name} {value} />
						{/each}
						<input type="hidden" name="cursor" value={catalog.page.nextCursor} />
						<Button type="submit" variant="outline">Следующие кандидаты</Button>
					</form>
				{/if}
			{/if}
		</div>
	</div>
{/if}
