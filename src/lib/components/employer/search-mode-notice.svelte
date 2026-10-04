<script lang="ts">
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import { DegradedModeNotice } from '$lib/components/product/index.js';
	import type { ModelOperation } from '$lib/components/product/model.js';
	import { modelReason } from './model.js';

	/**
	 * How this search was made (contracts 5.4): hybrid — by words and by meaning; words only — with the reason; the
	 * refining model — used, unavailable or not applied. Said explicitly, never hidden.
	 */
	interface Mode {
		searchMode: 'hybrid' | 'fts_only';
		semanticReason: string | null;
		reranker: { status: 'used' | 'unavailable' | 'not_applicable' };
	}

	let { mode }: { mode: Mode } = $props();

	const degraded = $derived<ModelOperation[]>([
		...(mode.searchMode === 'fts_only' && mode.semanticReason !== 'no_query' ? (['embed'] as const) : []),
		...(mode.reranker.status === 'unavailable' ? (['rerank'] as const) : [])
	]);
</script>

<div class="grid gap-2" data-testid="search-mode" data-search-mode={mode.searchMode}>
	<p class="flex flex-wrap items-center gap-2 text-sm">
		<ScanSearchIcon class="size-4 text-muted-foreground" aria-hidden="true" />
		<span class="font-medium">
			Режим поиска: {mode.searchMode === 'hybrid' ? 'гибридный — по словам и по смыслу' : 'только по словам'}
		</span>
		{#if mode.searchMode === 'fts_only'}
			<span class="text-muted-foreground">({modelReason(mode.semanticReason)})</span>
		{/if}
		{#if mode.reranker.status === 'used'}
			<span class="text-muted-foreground">· порядок уточнён моделью</span>
		{/if}
	</p>
	{#if degraded.length > 0}
		<DegradedModeNotice operations={degraded} />
	{/if}
</div>
