<script lang="ts">
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import { cn } from '$lib/components/utils.js';

	/** Honest unknown: the value is not established, with a hint what would establish it. */
	let { hint, class: className }: { hint?: string; class?: string } = $props();
</script>

<div class={cn('flex items-start gap-1.5 text-sm text-muted-foreground', className)} data-insufficient-data>
	<CircleDashedIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<div>
		<p class="font-medium">Недостаточно данных</p>
		{#if hint}<p class="text-xs">{hint}</p>{/if}
	</div>
</div>
