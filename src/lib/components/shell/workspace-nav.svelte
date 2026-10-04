<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import type { NavItem } from '$lib/navigation.js';
	import NavLinks from './nav-links.svelte';

	/**
	 * Sections of a workspace in one row under the header. A row wider than the container scrolls sideways; a faded edge
	 * shows on the side where more sections are hidden, and the current section is scrolled into view.
	 */
	let { items, pathname, label }: { items: NavItem[]; pathname: string; label: string } = $props();

	let scroller: HTMLDivElement | undefined = $state();
	let hiddenBefore = $state(false);
	let hiddenAfter = $state(false);

	function measure(): void {
		if (!scroller) return;
		hiddenBefore = scroller.scrollLeft > 1;
		hiddenAfter = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
	}

	$effect(() => {
		if (!scroller) return;
		const row = scroller;
		const current = row.querySelector<HTMLElement>('[aria-current="page"]');
		if (current) row.scrollLeft = current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		for (const child of row.children) observer.observe(child);
		return () => {
			observer.disconnect();
		};
	});

	const edge = 'pointer-events-none absolute inset-y-0 w-12 from-header to-transparent transition-opacity duration-150';
</script>

<div class="relative">
	<div
		bind:this={scroller}
		onscroll={measure}
		class="relative [scrollbar-width:thin] overflow-x-auto py-1.5"
		data-testid="workspace-nav"
	>
		<nav aria-label={label} class="w-max">
			<NavLinks {items} {pathname} />
		</nav>
	</div>
	<div
		class={cn(edge, 'left-0 bg-linear-to-r', hiddenBefore ? 'opacity-100' : 'opacity-0')}
		aria-hidden="true"
		data-edge="start"
		data-shown={hiddenBefore}
	></div>
	<div
		class={cn(edge, 'right-0 bg-linear-to-l', hiddenAfter ? 'opacity-100' : 'opacity-0')}
		aria-hidden="true"
		data-edge="end"
		data-shown={hiddenAfter}
	></div>
</div>
