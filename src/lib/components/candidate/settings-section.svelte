<script lang="ts">
	import type UserIcon from '@lucide/svelte/icons/user';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/components/utils.js';

	/**
	 * A row of a settings-like page: on the left the title of the section and what it is about, on the right its
	 * controls. On a narrow screen the description stands above the controls; the heading names the section for screen
	 * readers. A section without cards of its own sets its controls on a panel.
	 */
	interface Props {
		title: string;
		description?: string;
		icon?: typeof UserIcon;
		children: Snippet;
		/** Beside the title: the state of what the section saves. */
		status?: Snippet;
		/** Sets the controls on a rounded panel of the card colour. */
		panel?: boolean;
		class?: string;
		testId?: string;
	}

	let { title, description, icon: Icon, children, status, panel = false, class: className, testId }: Props = $props();
	const headingId = $props.id();
</script>

<section
	aria-labelledby={headingId}
	class={cn('grid scroll-mt-32 gap-4 border-t py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] lg:gap-x-12', className)}
	data-testid={testId}
>
	<div class="grid content-start gap-1.5 lg:sticky lg:top-36 lg:self-start">
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
			<h2 id={headingId} class="flex items-center gap-2 font-heading text-lg font-semibold">
				{#if Icon}<Icon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
				{title}
			</h2>
			{@render status?.()}
		</div>
		{#if description}<p class="text-sm text-pretty text-muted-foreground">{description}</p>{/if}
	</div>
	<div
		class={cn(
			'grid min-w-0 content-start gap-4',
			panel && 'rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5'
		)}
	>
		{@render children()}
	</div>
</section>
