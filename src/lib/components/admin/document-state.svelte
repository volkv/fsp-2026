<script lang="ts">
	import StatusPill from '$lib/components/forms/status-pill.svelte';

	/** Where a document version stands: in force, replaced, not yet published, or listed without a screen. */
	let { document }: { document: { publishedAt: Date | null; supersededAt: Date | null; available: boolean } } =
		$props();
</script>

<span class="flex flex-wrap gap-1.5">
	{#if document.supersededAt}
		<StatusPill label="заменён" />
	{:else if document.publishedAt}
		<StatusPill label="действует" tone="success" />
	{:else}
		<StatusPill label="черновик" tone="warning" />
	{/if}
	{#if !document.available}
		<StatusPill label="экрана нет" tone="info" />
	{/if}
</span>
