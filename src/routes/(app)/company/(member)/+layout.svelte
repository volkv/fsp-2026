<script lang="ts">
	import CompanyGateNotice from '$lib/components/employer/company-gate-notice.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 sm:py-10" data-company-status={data.company.status}>
	{#if data.company.status !== 'verified'}
		<CompanyGateNotice status={data.company.status} role={data.role} />
	{/if}
	{@render children()}
</div>
