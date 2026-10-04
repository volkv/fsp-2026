<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/components/utils.js';

	/** A titled block of a cabinet page; the heading names the section for screen readers. */
	interface Props {
		title: string;
		description?: string;
		actions?: Snippet;
		children: Snippet;
		class?: string;
		testId?: string;
	}

	let { title, description, actions, children, class: className, testId }: Props = $props();
	const headingId = $props.id();
</script>

<section
	aria-labelledby={headingId}
	class={cn('grid gap-4 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-6', className)}
	data-testid={testId}
>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="grid gap-1">
			<h2 id={headingId} class="font-heading text-h3">{title}</h2>
			{#if description}<p class="text-sm text-muted-foreground">{description}</p>{/if}
		</div>
		{#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
	</div>
	{@render children()}
</section>
