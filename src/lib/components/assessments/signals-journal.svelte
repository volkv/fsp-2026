<script lang="ts">
	import { formatDateTime } from '$lib/components/product/model.js';
	import { SIGNALS_NOTE, STAGE_NAMES, type SignalEntryView } from './model.js';

	/** The attempt journal as it is stored: shown to the candidate in full, with what it is for and what it is not. */
	let { entries }: { entries: SignalEntryView[] } = $props();

	const seconds = (ms: number) => `${Math.round(ms / 1000)} с`;
</script>

<details class="rounded-lg border text-sm" data-testid="signals">
	<summary class="cursor-pointer px-3 py-2 font-medium">Журнал сигналов попытки</summary>
	<div class="grid gap-2 px-3 pb-3">
		<p class="text-muted-foreground">{SIGNALS_NOTE}</p>
		{#if entries.length === 0}
			<p>Записей нет.</p>
		{:else}
			<ul class="grid gap-1">
				{#each entries as entry, index (index)}
					<li>
						{formatDateTime(entry.at)} · задание {entry.seq}, {STAGE_NAMES[entry.stage]}
						{#if entry.responseMs !== undefined}· ответ за {seconds(entry.responseMs)}{/if}
						{#if entry.client}
							· на странице {seconds(entry.client.elapsedMs)}, вставок {entry.client.pasteCount} ({entry.client
								.pastedChars}
							симв.), уходов со страницы {entry.client.blurCount}
						{:else}
							· страница не передала сигналы
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</details>
