<script lang="ts">
	import CountCell from './count-cell.svelte';
	import { cellText, cellValue, type Cell, type FunnelGroupView } from './model.js';

	/**
	 * The funnel of the whole federation. «Invited» counts candidates; the stages after it count hiring processes
	 * (one per accepted invitation), so only those share one scale. Each stage is its own number with who reported it —
	 * never one «employment rate».
	 */
	let { group }: { group: FunnelGroupView } = $props();

	const stages = $derived([
		{ key: 'contact', label: 'Контакт', hint: 'приглашение принято, контакты раскрыты', cell: group.contact },
		{ key: 'interview', label: 'Собеседование', hint: 'хотя бы одна сторона сообщила', cell: group.interview.total },
		{ key: 'offer', label: 'Предложение', hint: 'хотя бы одна сторона сообщила', cell: group.offer.total },
		{ key: 'hired', label: 'Выход подтверждён', hint: 'обеими сторонами', cell: group.hired.confirmed }
	]);
	const base = $derived(cellValue(group.contact) ?? 0);
	const width = (cell: Cell) => {
		const value = cellValue(cell);
		return value === null || base === 0 ? 0 : Math.max(2, Math.round((value / base) * 100));
	};
	const bySource = (sources: Record<'company' | 'candidate' | 'both', Cell>) =>
		`компания ${cellText(sources.company)} · кандидат ${cellText(sources.candidate)} · обе стороны ${cellText(sources.both)}`;
</script>

<div class="grid gap-6">
	<dl class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
		<div class="rounded-lg border p-4" data-stage="invited">
			<dt class="text-sm text-muted-foreground">Приглашены</dt>
			<dd class="font-heading text-h1"><CountCell cell={group.invited} /></dd>
			<dd class="text-xs text-muted-foreground">кандидатов с хотя бы одним приглашением</dd>
		</div>
		<div class="rounded-lg border p-4" data-stage="not_hired">
			<dt class="text-sm text-muted-foreground">Не нанят</dt>
			<dd class="font-heading text-h1"><CountCell cell={group.notHired} /></dd>
			<dd class="text-xs text-muted-foreground">исход согласован сторонами</dd>
		</div>
		<div class="rounded-lg border p-4" data-stage="single_party">
			<dt class="text-sm text-muted-foreground">Выход — со слов одной стороны</dt>
			<dd class="text-sm">
				компания <CountCell cell={group.hired.singleParty.company} /> · кандидат
				<CountCell cell={group.hired.singleParty.candidate} />
			</dd>
			<dd class="mt-1 text-sm">стороны разошлись: <CountCell cell={group.hired.diverged} /></dd>
		</div>
		<div class="rounded-lg border border-dashed p-4" data-stage="unknown">
			<dt class="text-sm text-muted-foreground">Исход неизвестен</dt>
			<dd class="font-heading text-h1"><CountCell cell={group.unknown} /></dd>
			<dd class="text-xs text-muted-foreground">стороны не сообщили в срок — молчание не считается исходом</dd>
		</div>
	</dl>

	<table class="w-full text-sm" data-testid="funnel-stages">
		<caption class="mb-2 text-left text-sm text-muted-foreground">
			Процессы найма после принятого приглашения; ширина полосы — доля от контактов
		</caption>
		<thead class="sr-only">
			<tr><th scope="col">Этап</th><th scope="col">Число</th><th scope="col">Доля от контактов</th></tr>
		</thead>
		<tbody>
			{#each stages as stage (stage.key)}
				<tr data-stage={stage.key} class="align-middle">
					<th scope="row" class="w-44 py-2 pr-4 text-left font-normal">
						<span class="font-medium">{stage.label}</span>
						<span class="block text-xs text-muted-foreground">{stage.hint}</span>
					</th>
					<td class="w-16 py-2 pr-4 text-right font-medium"><CountCell cell={stage.cell} /></td>
					<td class="py-2">
						{#if 'below' in stage.cell}
							<div class="h-3 w-full rounded-sm border border-dashed" aria-hidden="true"></div>
						{:else}
							<div class="h-3 w-full rounded-sm bg-muted" aria-hidden="true">
								<div class="h-3 rounded-sm bg-primary" style:width={`${width(stage.cell)}%`}></div>
							</div>
						{/if}
						{#if stage.key === 'interview'}
							<p class="mt-1 text-xs text-muted-foreground">{bySource(group.interview.bySource)}</p>
						{:else if stage.key === 'offer'}
							<p class="mt-1 text-xs text-muted-foreground">{bySource(group.offer.bySource)}</p>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
