<script lang="ts">
	import type { Inline } from './model.js';

	/** Inline parts of a statement line: text, `code` and **strong**. */
	let { parts }: { parts: Inline[] } = $props();
</script>

{#each parts as part, index (index)}{#if part.kind === 'code'}<code
			class="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{part.text}</code
		>{:else if part.kind === 'strong'}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}
