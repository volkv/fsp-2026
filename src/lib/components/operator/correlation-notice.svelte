<script lang="ts">
	import InfoIcon from '@lucide/svelte/icons/info';
	import { cn } from '$lib/components/utils.js';

	/** The analytics of the federation compare counts; they never prove what a skill or a result is worth. */
	let { class: className }: { class?: string } = $props();
</script>

<p class={cn('flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm', className)} data-notice="correlation">
	<InfoIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	<span>
		<span class="font-medium">Это корреляция, а не доказанная ценность навыка.</span>
		<span class="text-muted-foreground">
			Числа показывают, как часто встречаются события, но не то, что навык или результат соревнования стал их причиной.
		</span>
	</span>
</p>
