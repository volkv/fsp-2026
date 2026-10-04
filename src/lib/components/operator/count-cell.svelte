<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { cellText, type Cell } from './model.js';

	/** A count of an aggregate; a small one is «< N», so a small group does not point at a person. */
	let { cell, class: className }: { cell: Cell; class?: string } = $props();
</script>

{#if 'below' in cell}
	<span
		class={cn('text-muted-foreground tabular-nums', className)}
		data-small-cell
		title={`Меньше ${cell.below}: малые числа скрыты, чтобы не указывать на конкретных людей`}
	>
		{cellText(cell)}
	</span>
{:else}
	<span class={cn('tabular-nums', className)}>{cellText(cell)}</span>
{/if}
