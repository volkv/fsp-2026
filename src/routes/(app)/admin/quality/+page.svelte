<script lang="ts">
	import QualityPanel from '$lib/components/admin/quality-panel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<QualityPanel panel={data.panel} latest />
