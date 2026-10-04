<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { cn } from '$lib/components/utils.js';

	interface Props {
		title: string;
		description?: string;
		/** Wide pages hold several cards (account); narrow ones — one form. */
		width?: 'narrow' | 'wide';
		children: Snippet;
		footer?: Snippet;
	}

	let { title, description, width = 'narrow', children, footer }: Props = $props();
</script>

<svelte:head>
	<title>{title} — ФСП | Карьера</title>
</svelte:head>

<div class={cn('mx-auto w-full px-4 py-10 sm:px-6 sm:py-14', width === 'narrow' ? 'max-w-lg' : 'max-w-3xl')}>
	<Card.Root>
		<Card.Header>
			<Card.Title class="font-heading text-h2">
				<h1>{title}</h1>
			</Card.Title>
			{#if description}
				<Card.Description class="text-base">{description}</Card.Description>
			{/if}
		</Card.Header>
		<Card.Content class="grid gap-6">
			{@render children()}
		</Card.Content>
		{#if footer}
			<Card.Footer class="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
				{@render footer()}
			</Card.Footer>
		{/if}
	</Card.Root>
</div>
