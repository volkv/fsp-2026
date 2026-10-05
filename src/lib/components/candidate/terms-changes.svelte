<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { termsFieldName, termsValue, type Labels } from './model.js';

	/** Differences of a version of the terms from the previous one (`invitation_terms.changes`, domain 13.5). */
	interface Changes {
		previous_version: number;
		fields: { field: string; from: unknown; to: unknown }[];
		salary_comparison: 'lower' | 'equal' | 'higher' | 'overlap' | 'not_comparable';
		salary_lowered: boolean;
	}

	let { changes, labels }: { changes: Changes; labels: Labels } = $props();

	const COMPARISON: Record<Changes['salary_comparison'], string> = {
		lower: 'Вилка ниже предыдущей версии.',
		equal: 'Вилка не изменилась.',
		higher: 'Вилка выше предыдущей версии.',
		overlap: 'Вилка пересекается с предыдущей.',
		not_comparable: 'Вилку нельзя сравнить с предыдущей: изменилась налоговая база.'
	};
</script>

<div class="grid gap-2" data-testid="terms-changes">
	{#if changes.salary_lowered}
		<p class="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-warning">
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Ниже предыдущего предложения этой компании.
		</p>
	{/if}
	<p class="text-sm">{COMPARISON[changes.salary_comparison]}</p>
	{#if changes.fields.length > 0}
		<table class="w-full text-sm">
			<caption class="sr-only">Отличия от версии {changes.previous_version}</caption>
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th scope="col" class="py-1.5 pr-3 font-medium">Условие</th>
					<th scope="col" class="py-1.5 pr-3 font-medium">Было (версия {changes.previous_version})</th>
					<th scope="col" class="py-1.5 font-medium">Стало</th>
				</tr>
			</thead>
			<tbody>
				{#each changes.fields as change (change.field)}
					<tr class="border-b last:border-0">
						<th scope="row" class="py-1.5 pr-3 text-left font-normal">{termsFieldName(change.field)}</th>
						<td class="py-1.5 pr-3 text-muted-foreground line-through"
							>{termsValue(change.field, change.from, labels)}</td
						>
						<td class="py-1.5 font-medium">{termsValue(change.field, change.to, labels)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
