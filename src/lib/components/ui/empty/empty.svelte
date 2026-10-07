<script lang="ts">
	import BrandStrip from '$lib/components/brand/brand-strip.svelte';
	import { cn, type WithElementRef } from '$lib/components/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="empty"
	class={cn(
		'flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border-dashed p-12 text-center text-balance',
		className
	)}
	{...restProps}
>
	<!-- The brand accent of every empty state: one tile of the FSP pattern above the message. -->
	<BrandStrip tiles={1} class="h-3.5" />
	{@render children?.()}
</div>
