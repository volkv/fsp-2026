<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/components/utils.js';

	interface Props {
		title: string;
		description?: string;
		/** Small line above the title: the section or the parent object. */
		eyebrow?: Snippet;
		actions?: Snippet;
		class?: string;
	}

	let { title, description, eyebrow, actions, class: className }: Props = $props();
</script>

<svelte:head>
	<title>{title} — ФСП | Карьера</title>
</svelte:head>

<header class={cn('flex flex-wrap items-end justify-between gap-4', className)}>
	<div class="grid min-w-0 gap-1">
		{#if eyebrow}
			<div class="text-sm text-muted-foreground">{@render eyebrow()}</div>
		{/if}
		<h1 class="font-heading text-h1 text-balance">{title}</h1>
		{#if description}
			<p class="max-w-3xl text-muted-foreground">{description}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
