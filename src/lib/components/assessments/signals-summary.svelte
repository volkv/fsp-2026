<script lang="ts">
	import { pluralize } from '$lib/components/product/model.js';
	import { SIGNALS_SUMMARY_NOTE, type SignalSummaryView } from './model.js';

	/**
	 * The totals of the signal journal of the attempt that assigned a category — the same lines for the company that sees
	 * the card and for the candidate; never the entries or the time of single items.
	 */
	let { summary, title }: { summary: SignalSummaryView; title: string } = $props();

	const times = (count: number) => `${count} ${pluralize(count, ['раз', 'раза', 'раз'])}`;
</script>

<div class="grid gap-1 text-sm" data-testid="signals-summary">
	<span class="font-medium">{title}</span>
	{#if summary.entries === 0}
		<span class="text-muted-foreground">Журнал попытки пуст.</span>
	{:else}
		<span>
			вставки из буфера — {times(summary.pastes)}{summary.pastes > 0 ? ` (${summary.pastedChars} симв.)` : ''}, уходы со
			страницы — {times(summary.departures)}; записей журнала {summary.entries}{summary.silent > 0
				? `, без сигналов страницы ${summary.silent}`
				: ''}
		</span>
	{/if}
	<span class="text-xs text-muted-foreground">{SIGNALS_SUMMARY_NOTE}</span>
</div>
