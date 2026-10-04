<script lang="ts">
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<div class="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-10" data-cabinet="candidate">
	{@render children()}
</div>
