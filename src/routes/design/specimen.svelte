<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/components/utils.js';

	/** One labelled example on the showcase. */
	let { title, class: className, children }: { title: string; class?: string; children: Snippet } = $props();
</script>

<figure class={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4', className)}>
	<figcaption class="font-mono text-label text-muted-foreground">{title}</figcaption>
	<div class="min-w-0">{@render children()}</div>
</figure>
