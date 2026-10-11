<script lang="ts">
	import { page } from '$app/state';
	import { cn } from '$lib/components/utils.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// The profile lays its sections out in two columns, the title of a section beside its controls: it takes the width
	// of the header.
	const wide = $derived(page.route.id === '/(app)/me/profile');
</script>

<div
	class={cn('mx-auto grid w-full gap-8 px-4 py-8 sm:px-6 sm:py-10', wide ? 'max-w-7xl' : 'max-w-6xl')}
	data-cabinet="candidate"
>
	{@render children()}
</div>
