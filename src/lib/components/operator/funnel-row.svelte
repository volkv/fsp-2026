<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import CountCell from './count-cell.svelte';
	import SyntheticNote from './synthetic-note.svelte';
	import { SMALL_GROUPS, type FunnelGroupView } from './model.js';

	/**
	 * One group of the funnel table: a row, or an indented row inside the group `parent`. A pool of small groups is set
	 * apart: it is a sum of several groups, not a group.
	 */
	let {
		group,
		name,
		parent,
		highlighted = false
	}: { group: FunnelGroupView; name: string; parent?: string; highlighted?: boolean } = $props();
</script>

<Table.Row
	data-group={group.key}
	data-parent={parent}
	data-pooled={group.key === SMALL_GROUPS ? group.pooled : undefined}
	class={highlighted ? 'bg-muted/30' : undefined}
>
	<Table.Cell class={parent === undefined ? 'font-medium' : 'pl-8'}>
		<span class={group.key === SMALL_GROUPS ? 'text-muted-foreground italic' : undefined}>{name}</span>
		{#if group.synthetic}<SyntheticNote compact class="ml-1" />{/if}
	</Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.invited} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.contact} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.interview.total} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.offer.total} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.hired.confirmed} /></Table.Cell>
	<Table.Cell class="text-right">
		<CountCell cell={group.hired.singleParty.company} /> / <CountCell cell={group.hired.singleParty.candidate} />
	</Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.hired.diverged} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.notHired} /></Table.Cell>
	<Table.Cell class="text-right"><CountCell cell={group.unknown} /></Table.Cell>
</Table.Row>
