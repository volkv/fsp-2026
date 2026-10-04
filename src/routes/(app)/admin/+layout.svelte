<script lang="ts">
	import AdminTabs from '$lib/components/admin/admin-tabs.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<div class="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 sm:py-10" data-workspace="admin">
	<AdminTabs />
	{@render children()}
</div>
