<script lang="ts">
	import QuoteIcon from '@lucide/svelte/icons/quote';

	/** Quotes of the pasted text a prefilled field was taken from: the employer sees where the value came from. */
	let { quotes }: { quotes: string[] | undefined } = $props();
</script>

{#if quotes && quotes.length > 0}
	<p class="flex flex-wrap items-start gap-1 text-xs text-muted-foreground" data-quote>
		<QuoteIcon class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
		<span class="sr-only">Из текста:</span>
		{#each quotes as quote, index (index)}
			<mark class="rounded-sm bg-accent px-1 text-accent-foreground">{quote}</mark>
		{/each}
	</p>
{/if}
