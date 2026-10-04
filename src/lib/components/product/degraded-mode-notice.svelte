<script lang="ts">
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import { cn } from '$lib/components/utils.js';
	import type { ModelOperation } from './model.js';

	/**
	 * Explicit simplified mode: a model operation is down and the product works without it instead of pretending
	 * (contracts §3.5). Each operation is reported on its own.
	 */
	let { operations, class: className }: { operations: ModelOperation[]; class?: string } = $props();

	const effects: Record<ModelOperation, string> = {
		extract: 'Разбор выполнен без модели — проверьте поля.',
		embed: 'Семантический поиск недоступен — ищем по словам.',
		rerank: 'Уточняющая модель недоступна — порядок по основным компонентам соответствия.'
	};
</script>

<aside
	class={cn(
		'flex items-start gap-2.5 rounded-lg border border-warning/50 bg-warning-subtle px-4 py-3 text-sm text-warning',
		className
	)}
	aria-label="Упрощённый режим без модели"
	data-notice="degraded"
>
	<CpuIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<div class="space-y-0.5">
		<p class="font-semibold">Упрощённый режим без модели</p>
		<ul class="space-y-0.5">
			{#each operations as operation (operation)}
				<li>{effects[operation]}</li>
			{/each}
		</ul>
	</div>
</aside>
