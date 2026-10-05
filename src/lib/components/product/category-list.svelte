<script lang="ts">
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import { cn } from '$lib/components/utils.js';
	import { DISCIPLINES, formatDate, type CategoryBadgeView, type DisciplineCode, type FspLevel } from './model.js';

	interface Props {
		/** Categories in force; empty — the category is not confirmed. */
		categories: CategoryBadgeView[];
		/** FSP levels by discipline: a facet of the evidence, apart from the category. */
		fspLevels?: { discipline: DisciplineCode; level: FspLevel }[];
		/** Who reads the empty state: the company sees a candidate, the candidate sees themselves. */
		reader?: 'company' | 'candidate';
		class?: string;
	}

	let { categories, fspLevels = [], reader = 'company', class: className }: Props = $props();
</script>

<section
	class={cn('space-y-3', className)}
	aria-label="Категория"
	data-category-state={categories.length > 0 ? 'confirmed' : 'not_confirmed'}
>
	{#if categories.length === 0}
		<p class="rounded-lg border border-dashed p-3 text-sm">
			<span class="font-medium">Категория не подтверждена.</span>
			<span class="text-muted-foreground">
				{reader === 'company'
					? 'Кандидат ещё не прошёл тест на грейд: он есть в базе и находится поиском, но не в выдаче категорий.'
					: 'Категорию даёт только тест на заявленный грейд: пройди его, чтобы попасть в выдачу категорий.'}
			</span>
		</p>
	{:else}
		<ul class="grid gap-3 sm:grid-cols-2">
			{#each categories as category (category.key)}
				<li class="rounded-lg border p-3" data-category={category.key}>
					<p class="flex items-center gap-2 font-medium">
						<BadgeCheckIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
						{category.specialization} · {category.grade}
					</p>
					<p class="mt-1 text-xs text-muted-foreground">
						Подтверждено тестом {formatDate(category.assignedOn)} · определяющих блоков: {category.blocks}
					</p>
					{#if category.skills.length > 0}
						<p class="mt-2 flex flex-wrap gap-1" aria-label="Подтверждённый стек">
							{#each category.skills as skill (skill)}
								<span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{skill}</span>
							{/each}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if fspLevels.length > 0}
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<span class="text-muted-foreground">Уровень ФСП (отдельно от категории):</span>
			{#each fspLevels as item (item.discipline)}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
				>
					{DISCIPLINES[item.discipline].short}
					<span class="font-mono">{item.level}</span>
				</span>
			{/each}
		</div>
	{/if}
</section>
