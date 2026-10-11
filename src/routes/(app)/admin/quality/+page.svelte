<script lang="ts">
	import FairnessAudit from '$lib/components/admin/fairness-audit.svelte';
	import QualityPanel from '$lib/components/admin/quality-panel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<QualityPanel panel={data.panel} latest />
<FairnessAudit audit={data.fairness} />
