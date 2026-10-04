<script lang="ts">
	import InfoIcon from '@lucide/svelte/icons/info';
	import { cn } from '$lib/components/utils.js';
	import { HONEST_NOTES } from './model.js';

	/**
	 * What a platform test of the kind confirms and what it does not: shown before any attempt and next to every
	 * result.
	 */
	let { kind, class: className }: { kind: keyof typeof HONEST_NOTES; class?: string } = $props();
</script>

<p
	class={cn('flex items-start gap-2 rounded-lg bg-muted p-3 text-sm', className)}
	data-testid="honest-note"
	data-kind={kind}
>
	<InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	<span>{HONEST_NOTES[kind]}</span>
</p>
