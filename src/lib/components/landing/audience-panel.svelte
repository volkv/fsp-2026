<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import { cn } from '$lib/components/utils.js';
	import AudienceVisual from './audience-visual.svelte';
	import type { Audience } from './content.js';
	import { reveal } from './reveal.js';

	/**
	 * One audience: its promise beside a drawing of the product for it. The text and the drawing slide in towards each
	 * other when the panel comes into view (or is mounted in view, as a newly opened tab is).
	 */
	let {
		audience,
		headingId,
		mirrored = false,
		class: className
	}: { audience: Audience; headingId: string; mirrored?: boolean; class?: string } = $props();
</script>

<div
	class={cn('group grid grid-cols-[minmax(0,1fr)] items-center gap-12 lg:grid-cols-2 lg:gap-20', className)}
	use:reveal={0.2}
>
	<div
		class={cn(
			'transition-all duration-1000 ease-standard group-data-[reveal=pending]:opacity-0',
			mirrored ? 'group-data-[reveal=pending]:translate-x-16 lg:order-2' : 'group-data-[reveal=pending]:-translate-x-16'
		)}
	>
		<span class="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
			<audience.icon class="size-6" aria-hidden="true" />
		</span>
		<h3 id={headingId} class="mt-8 text-[clamp(1.623rem,3.324vw,2.89rem)] leading-none font-bold tracking-[-0.05em]">
			{audience.title}
		</h3>
		<p class="mt-6 max-w-lg text-xl text-balance text-muted-foreground sm:text-2xl">{audience.lead}</p>
		<ul class="mt-10 space-y-4">
			{#each audience.short as line, index (line)}
				<li
					class="flex items-start gap-3 text-lg transition-all duration-700 ease-standard group-data-[reveal=pending]:translate-y-4 group-data-[reveal=pending]:opacity-0"
					style="transition-delay: {400 + index * 120}ms"
				>
					<CheckIcon class="mt-1 size-5 shrink-0 text-link" aria-hidden="true" />
					{line}
				</li>
			{/each}
		</ul>
	</div>
	<div
		class={cn(
			'transition-all delay-150 duration-1000 ease-standard group-data-[reveal=pending]:scale-95 group-data-[reveal=pending]:opacity-0',
			mirrored ? 'group-data-[reveal=pending]:-translate-x-16 lg:order-1' : 'group-data-[reveal=pending]:translate-x-16'
		)}
	>
		<AudienceVisual audience={audience.id} />
	</div>
</div>
