<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import { cn } from '$lib/components/utils.js';
	import { languageName, levelName, type CoverageView } from './model.js';

	/** Coverage of an assessment version: the skills it confirms, what it checks and, as prominently, what it does not. */
	let {
		coverage,
		skills,
		class: className
	}: { coverage: CoverageView; skills: Record<string, string>; class?: string } = $props();
</script>

<div class={cn('grid gap-4 text-sm', className)} data-testid="coverage">
	<div class="grid gap-1.5">
		<p class="font-medium">Что подтверждает успешная попытка</p>
		<ul class="flex flex-wrap gap-1.5" aria-label="Навыки и уровни">
			{#each coverage.skills as skill (skill.skillKey)}
				<li class="rounded-full border px-2.5 py-1 text-xs">
					{skills[skill.skillKey] ?? skill.skillKey} · {skill.levels.map(levelName).join(' / ')}
					{#if skill.languages}
						<span class="text-muted-foreground">— если решено на {skill.languages.map(languageName).join(', ')}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
	<div class="grid gap-4 sm:grid-cols-2">
		<div class="grid content-start gap-1.5">
			<p class="font-medium">Проверяет</p>
			<ul class="grid gap-1">
				{#each coverage.checks as item (item)}
					<li class="flex items-start gap-2">
						<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
						<span>{item}</span>
					</li>
				{/each}
			</ul>
		</div>
		<div class="grid content-start gap-1.5">
			<p class="font-medium">Не проверяет</p>
			<ul class="grid gap-1" data-testid="coverage-not-checked">
				{#each coverage.doesNotCheck as item (item)}
					<li class="flex items-start gap-2">
						<CircleMinusIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span>{item}</span>
					</li>
				{/each}
			</ul>
		</div>
	</div>
	{#if coverage.notes && coverage.notes.length > 0}
		<ul class="grid gap-1 text-muted-foreground">
			{#each coverage.notes as note (note)}
				<li>{note}</li>
			{/each}
		</ul>
	{/if}
</div>
