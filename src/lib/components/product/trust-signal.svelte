<script lang="ts">
	import { cn } from '$lib/components/utils.js';

	/**
	 * Three nodes joined by links, the motif of the FSP sign: the number of filled nodes shows trust.
	 * Decorative — the trust label next to it carries the meaning.
	 */
	let { filled, class: className }: { filled: 0 | 1 | 2 | 3; class?: string } = $props();

	const nodes = [0, 1, 2] as const;
</script>

<svg viewBox="0 0 28 8" class={cn('h-2 w-7 shrink-0', className)} aria-hidden="true" data-filled={filled}>
	<path d="M7 4h4M17 4h4" stroke="currentColor" stroke-width="1.25" />
	{#each nodes as index (index)}
		<circle
			cx={4 + index * 10}
			cy="4"
			r="2.75"
			stroke="currentColor"
			stroke-width="1.25"
			fill={index < filled ? 'currentColor' : 'none'}
		/>
	{/each}
</svg>
