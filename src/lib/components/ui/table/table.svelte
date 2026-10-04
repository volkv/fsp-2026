<script lang="ts">
	import { cn, type WithElementRef } from '$lib/components/utils.js';
	import type { HTMLTableAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		label,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> & {
		/** The name of the scroll area for assistive technology, used while the table is wider than its container. */
		label: string;
	} = $props();

	let container = $state<HTMLDivElement | null>(null);
	/** The table is wider than its container: the area scrolls and must be reachable from the keyboard. */
	let scrollable = $state(false);

	$effect(() => {
		const element = container;
		if (!element) return;
		const measure = () => {
			scrollable = element.scrollWidth > element.clientWidth;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		if (ref) observer.observe(ref);
		return () => {
			observer.disconnect();
		};
	});
</script>

<!-- A scrolling container takes focus so it can be scrolled from the keyboard; a table that fits adds no tab stop. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={container}
	data-slot="table-container"
	class="relative w-full overflow-x-auto focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
	role={scrollable ? 'region' : undefined}
	aria-label={scrollable ? `${label}: прокручивается по горизонтали` : undefined}
	tabindex={scrollable ? 0 : undefined}
	data-scrollable={scrollable}
>
	<table bind:this={ref} data-slot="table" class={cn('w-full caption-bottom text-sm', className)} {...restProps}>
		{@render children?.()}
	</table>
</div>
