<script lang="ts">
	import type { Snippet } from 'svelte';

	let { id, title, description, children }: { id: string; title: string; description?: string; children: Snippet } =
		$props();
</script>

<section {id} class="scroll-mt-24 space-y-6 border-t pt-10" aria-labelledby="{id}-title">
	<header class="space-y-1">
		<h2 id="{id}-title" class="text-h2">{title}</h2>
		{#if description}<p class="max-w-3xl text-muted-foreground">{description}</p>{/if}
	</header>
	{@render children()}
</section>
