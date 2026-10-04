<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { MATCH_COMPONENT_STATUSES, MATCH_COMPONENTS, type MatchView } from './model.js';
	import TrustChip from './trust-chip.svelte';

	let { match, class: className }: { match: MatchView; class?: string } = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const headingId = $props.id();
</script>

<section class={cn('space-y-4', className)} aria-labelledby={headingId}>
	<div class="flex items-baseline justify-between gap-3">
		<h3 id={headingId} class="font-sans text-sm font-semibold">Почему подходит</h3>
		<p class="text-right">
			<span class="font-heading text-h2 text-link numeric">{percent.format(match.score)}</span>
			<span class="block text-xs text-muted-foreground">по компонентам, входящим в оценку</span>
		</p>
	</div>

	<ul class="space-y-2" aria-label="Компоненты соответствия">
		{#each match.components as component (component.key)}
			<li
				class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm"
				data-status={component.status}
			>
				<span>{MATCH_COMPONENTS[component.key]}</span>
				{#if component.status === 'computed' && component.value !== undefined}
					<span class="text-right font-mono text-xs numeric">
						{percent.format(component.value)}
						{#if component.weight !== undefined}<span class="text-muted-foreground">
								· вес {percent.format(component.weight)}</span
							>{/if}
					</span>
					<span class="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
						<span class="block h-full rounded-full bg-primary" style:width="{component.value * 100}%"></span>
					</span>
					{#if component.note}
						<span class="col-span-2 text-xs text-muted-foreground">{component.note}</span>
					{/if}
				{:else if component.status !== 'computed' && component.weight !== undefined}
					<span class="text-right text-xs text-muted-foreground">
						нет данных · засчитан как неподтверждённый · вес {percent.format(component.weight)}
					</span>
					{#if component.reason}
						<span class="col-span-2 text-xs text-muted-foreground">{component.reason}</span>
					{/if}
				{:else if component.status !== 'computed'}
					<span class="text-right text-xs text-muted-foreground">
						{MATCH_COMPONENT_STATUSES[component.status]} · не входит в оценку
					</span>
					{#if component.reason}
						<span class="col-span-2 text-xs text-muted-foreground">{component.reason}</span>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>

	<div class="grid gap-4 sm:grid-cols-2">
		{#if match.matches.length > 0}
			<div class="sm:col-span-2">
				<p class="mb-1.5 text-sm font-semibold">Что подходит и чем подтверждено</p>
				<ul class="space-y-1.5 text-sm">
					{#each match.matches as item (item.requirement)}
						<li class="flex flex-wrap items-center gap-2">
							<TrustChip level={item.trust} skill={item.requirement} />
							<span class="text-muted-foreground">{item.evidence}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#each [{ title: 'Неизвестно', items: match.unknown }, { title: 'Проверить на собеседовании', items: match.toVerify }, { title: 'Чего не хватает', items: match.gaps }] as group (group.title)}
			{#if group.items.length > 0}
				<div>
					<p class="mb-1.5 text-sm font-semibold">{group.title}</p>
					<ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						{#each new Set(group.items) as item (item)}<li>{item}</li>{/each}
					</ul>
				</div>
			{/if}
		{/each}
	</div>
</section>
