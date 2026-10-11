<script lang="ts">
	import type UserIcon from '@lucide/svelte/icons/user';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/components/utils.js';

	/**
	 * A row of a settings-like page: on the left the title of the section and what it is about, on the right its
	 * controls. On a narrow screen the description stands above the controls; the heading names the section for screen
	 * readers.
	 */
	interface Props {
		title: string;
		description?: string;
		icon?: typeof UserIcon;
		children: Snippet;
		class?: string;
		testId?: string;
	}

	let { title, description, icon: Icon, children, class: className, testId }: Props = $props();
	const headingId = $props.id();
</script>

<section
	aria-labelledby={headingId}
	class={cn('grid scroll-mt-32 gap-4 border-t py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] lg:gap-x-12', className)}
	data-testid={testId}
>
	<div class="grid content-start gap-1.5 lg:sticky lg:top-36 lg:self-start">
		<h2 id={headingId} class="flex items-center gap-2 font-heading text-lg font-semibold">
			{#if Icon}<Icon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
			{title}
		</h2>
		{#if description}<p class="text-sm text-pretty text-muted-foreground">{description}</p>{/if}
	</div>
	<div class="grid min-w-0 content-start gap-4">
		{@render children()}
	</div>
</section>
