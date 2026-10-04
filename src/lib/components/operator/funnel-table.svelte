<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import FunnelRow from './funnel-row.svelte';
	import type { FunnelGroupView } from './model.js';

	/**
	 * The funnel by a dimension: every stage in its own column, the groups of the second dimension as indented rows
	 * under their group. A pool of small groups is set apart: it is a sum of several groups, not a group.
	 */
	let {
		groups,
		nameOf,
		label
	}: {
		groups: FunnelGroupView[];
		/** The name of a group of the rows (depth 0) or of the rows inside them (depth 1). */
		nameOf: (group: FunnelGroupView, depth: 0 | 1) => string;
		/** The name of the table: the dimensions it is sliced by. */
		label: string;
	} = $props();

	const nested = $derived(groups.some((group) => group.children.length > 0));
</script>

<Table.Root {label} data-testid="funnel-table">
	<Table.Header>
		<Table.Row>
			<Table.Head>Группа</Table.Head>
			<Table.Head class="text-right">Приглашены</Table.Head>
			<Table.Head class="text-right">Контакт</Table.Head>
			<Table.Head class="text-right">Собеседование</Table.Head>
			<Table.Head class="text-right">Предложение</Table.Head>
			<Table.Head class="text-right">Выход подтверждён</Table.Head>
			<Table.Head class="text-right">Одной стороной</Table.Head>
			<Table.Head class="text-right">Расхождение</Table.Head>
			<Table.Head class="text-right">Не нанят</Table.Head>
			<Table.Head class="text-right">Неизвестен</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each groups as group (group.key)}
			<FunnelRow {group} name={nameOf(group, 0)} highlighted={nested} />
			{#each group.children as child (child.key)}
				<FunnelRow group={child} name={nameOf(child, 1)} parent={group.key} />
			{/each}
		{/each}
	</Table.Body>
</Table.Root>
