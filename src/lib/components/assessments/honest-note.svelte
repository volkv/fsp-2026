<script lang="ts">
	import InfoIcon from '@lucide/svelte/icons/info';
	import { cn } from '$lib/components/utils.js';
	import { HONEST_NOTE } from './model.js';

	/** What the test confirms and what it does not: shown before any attempt and next to every result. */
	let { class: className }: { class?: string } = $props();
</script>

<p class={cn('flex items-start gap-2 rounded-lg bg-muted p-3 text-sm', className)} data-testid="honest-note">
	<InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	<span>{HONEST_NOTE}</span>
</p>
