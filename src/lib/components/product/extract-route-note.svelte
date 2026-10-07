<script lang="ts">
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import { cn } from '$lib/components/utils.js';
	import type { ExtractRoute } from './model.js';

	/**
	 * Where a text goes before the person sends it: to an external model through its API, to the platform's own model,
	 * or nowhere — the rules read it. Shown at every field whose text the model reads.
	 */
	let { route, class: className }: { route: ExtractRoute; class?: string } = $props();
</script>

<p
	class={cn(
		'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
		route.kind === 'external' ? 'border-info/30 bg-info-subtle text-info' : 'bg-muted/40 text-muted-foreground',
		className
	)}
	data-testid="extract-route"
	data-route={route.kind}
>
	<CpuIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
	<span>
		{#if route.kind === 'external'}
			Текст разбирает внешняя языковая модель {route.model} через API: он передаётся её провайдеру за пределы платформы. Так
			устроен демонстрационный стенд; в эксплуатации — локальная или российская модель.
		{:else if route.kind === 'own'}
			Текст разбирает языковая модель {route.model} на сервере платформы: за её пределы он не уходит.
		{:else}
			Языковая модель сейчас не подключена: текст разберут правила, без модели.
		{/if}
	</span>
</p>
