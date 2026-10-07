<script lang="ts">
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { modelReadingLabel, type ModelReadingView } from './model.js';

	/**
	 * The mode a text was read in, next to the result: an external model through its API, the platform's own model, or
	 * the rules without a model (contracts §3.5). Said in words, with the model and where the text went.
	 */
	let { reading, class: className }: { reading: ModelReadingView | null; class?: string } = $props();

	const mode = $derived(modelReadingLabel(reading));
</script>

<span class="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="model-mode">
	<StatusPill label={mode.label} tone={mode.tone} class={className} />
	<span>{mode.hint}</span>
</span>
