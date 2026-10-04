<script lang="ts">
	import ScaleIcon from '@lucide/svelte/icons/scale';
	import { cn } from '$lib/components/utils.js';

	/** Notice of a recommender system: the system ranks and explains, a person decides. */
	let { compact = false, class: className }: { compact?: boolean; class?: string } = $props();
</script>

<aside
	class={cn(
		'flex gap-2.5 rounded-lg border border-primary/25 bg-info-subtle text-sm text-info',
		compact ? 'items-center px-3 py-2' : 'items-start px-4 py-3',
		className
	)}
	aria-label="Рекомендательная система"
	data-notice="recommendation"
>
	<ScaleIcon class={cn('size-4 shrink-0', !compact && 'mt-0.5')} aria-hidden="true" />
	{#if compact}
		<p>Рекомендательная система: подборка — подсказка, решение принимает человек.</p>
	{:else}
		<div class="space-y-0.5">
			<p class="font-semibold">Рекомендательная система — решение принимает человек</p>
			<p>
				Категории, порядок кандидатов и оценка соответствия — подсказка с объяснением, а не решение. Система никого не
				отклоняет и не приглашает сама; кандидат может оспорить свою категорию.
			</p>
		</div>
	{/if}
</aside>
