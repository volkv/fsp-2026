<script lang="ts">
	import { resolve } from '$app/paths';
	import GitCompareIcon from '@lucide/svelte/icons/git-compare';
	import UsersIcon from '@lucide/svelte/icons/users';
	import CandidateRow from '$lib/components/employer/candidate-row.svelte';
	import CatalogFilters from '$lib/components/employer/catalog-filters.svelte';
	import ComparisonTable from '$lib/components/employer/comparison-table.svelte';
	import PoolCounter from '$lib/components/employer/pool-counter.svelte';
	import SearchModeNotice from '$lib/components/employer/search-mode-notice.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { RecommendationNotice, SalaryRange } from '$lib/components/product/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const vacancy = $derived(data.vacancy);
	const catalog = $derived(data.catalog);
	const labels = $derived(data.labels);
	const grade = $derived(
		vacancy.gradeMin === vacancy.gradeMax
			? (labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin)
			: `${labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin}–${labels.grades[vacancy.gradeMax] ?? vacancy.gradeMax}`
	);
	const groups = $derived.by(
		(): { key: string; title: string | null; items: NonNullable<NonNullable<typeof catalog>['page']>['items'] }[] => {
			const items = catalog?.page?.items ?? [];
			// Without a category a candidate is in the base, not in a category (domain 12.7): listed apart and marked.
			if (items.every((item) => item.categoryConfirmed)) return [{ key: 'all', title: null, items }];
			return [
				{
					key: 'confirmed',
					title: 'С подтверждённой категорией',
					items: items.filter((item) => item.categoryConfirmed)
				},
				{
					key: 'not_confirmed',
					title: 'Категория не подтверждена',
					items: items.filter((item) => !item.categoryConfirmed)
				}
			].filter((group) => group.items.length > 0);
		}
	);
</script>

<PageHeader title="Кандидаты под вакансию" description={vacancy.title}>
	{#snippet eyebrow()}
		<a
			class="text-link underline-offset-4 hover:underline"
			href={resolve('/(app)/company/(member)/vacancies/[id]', { id: vacancy.id })}>{vacancy.title}</a
		>
	{/snippet}
</PageHeader>

<section
	class="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
	aria-label="Требования вакансии"
>
	<div class="grid gap-1 text-sm">
		<p class="font-medium">
			{labels.roles[vacancy.roleKey] ?? vacancy.roleKey} · {grade} · {vacancy.requiredSkillKeys
				.map((key) => labels.skills[key] ?? key)
				.join(', ')}
		</p>
		<SalaryRange salary={vacancy.salary} />
	</div>
	<PoolCounter pool={vacancy.pool} />
</section>

<RecommendationNotice />

{#if catalog === null}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><UsersIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>
				{vacancy.status === 'closed' ? 'Вакансия закрыта' : 'Каталог кандидатов закрыт'}
			</Empty.Title>
			<Empty.Description>
				{vacancy.status === 'closed'
					? 'По закрытой вакансии кандидатов не подбирают.'
					: 'Действия компании закрыты оператором ФСП: компания приостановлена или проверка отклонена.'}
			</Empty.Description>
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
			{/if}

			{#if catalog.comparison}
				<section class="grid gap-2" aria-labelledby="comparison-heading">
					<h2 id="comparison-heading" class="font-heading text-h3">Сравнение по требованиям вакансии</h2>
					<ComparisonTable comparison={catalog.comparison} {labels} />
				</section>
			{/if}

			{#if catalog.page && catalog.page.items.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Title>Никого не нашлось</Empty.Title>
						<Empty.Description>
							Ослабьте фильтры или включите группу «грейд не установлен» — сильные кандидаты без коммерческого опыта
							находятся там.
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else if catalog.page}
				<form method="GET" id="compare-form" class="flex flex-wrap items-center justify-between gap-2">
					{#each catalog.params as [name, value], index (index)}
						<input type="hidden" {name} {value} />
					{/each}
					<p class="text-sm text-muted-foreground">Кандидаты псевдонимные: ни имён, ни контактов до согласия.</p>
					<Button type="submit" variant="outline" size="sm">
						<GitCompareIcon aria-hidden="true" />
						Сравнить отмеченных
					</Button>
				</form>
				{#each groups as group (group.key)}
					<section class="grid gap-3" aria-label={group.title ?? 'Найденные кандидаты'}>
						{#if group.title}
							<h2 class="font-heading text-h3">{group.title}</h2>
						{/if}
						{#each group.items as item (item.pseudonym)}
							<CandidateRow
								pseudonym={item.pseudonym}
								summary={item.summary}
								match={item.match}
								{labels}
								href={resolve('/(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]', {
									id: vacancy.id,
									pseudonym: item.pseudonym
								})}
								compareForm="compare-form"
								compared={catalog.compared.includes(item.pseudonym)}
							/>
						{/each}
					</section>
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
