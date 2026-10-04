<script lang="ts">
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import CorrelationNotice from '$lib/components/operator/correlation-notice.svelte';
	import CountCell from '$lib/components/operator/count-cell.svelte';
	import { shareText } from '$lib/components/operator/model.js';
	import SyntheticNote from '$lib/components/operator/synthetic-note.svelte';
	import { InsufficientData } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const f = $derived(data.feedback);
	const empty = $derived(f.rows.length === 0);
	/** Both shares on one 0–100 % scale: the bars of a row are comparable, the counts behind them are not. */
	const width = (share: number | null) => (share === null ? 0 : Math.max(1, Math.round(share * 100)));
	const gap = (demand: number | null, supply: number | null) =>
		demand === null || supply === null ? null : Math.round((supply - demand) * 100);
</script>

<PageHeader
	title="Навыки рынка ↔ навыки ФСП"
	description="Обратная связь для дисциплин и кейсов: как часто навык требуют вакансии и у какой доли участников ФСП он выведен из результатов соревнований."
/>

<form method="GET" class="flex flex-wrap items-end gap-3">
	<Field.Field class="w-48">
		<Field.Label for="skills-window">Окно вакансий</Field.Label>
		<NativeSelect id="skills-window" name="window" value={String(f.windowDays)}>
			{#each data.windows as days (days)}
				<option value={String(days)}>{days} дней</option>
			{/each}
		</NativeSelect>
	</Field.Field>
	<Button type="submit" variant="outline">Показать</Button>
</form>

<CorrelationNotice />
{#if f.synthetic}<SyntheticNote />{/if}

<dl class="grid gap-4 sm:grid-cols-2">
	<div class="rounded-lg border p-4">
		<dt class="text-sm text-muted-foreground">Спрос: вакансий с {formatDate(f.since)}</dt>
		<dd class="font-heading text-h1"><CountCell cell={f.vacancies} /></dd>
		<dd class="text-xs text-muted-foreground">собственные опубликованные и внешние из источников</dd>
	</div>
	<div class="rounded-lg border p-4">
		<dt class="text-sm text-muted-foreground">Предложение: кандидатов с навыками из результатов ФСП</dt>
		<dd class="font-heading text-h1"><CountCell cell={f.fspCandidates} /></dd>
		<dd class="text-xs text-muted-foreground">по опубликованной категоризации</dd>
	</div>
</dl>

<Card.Root>
	<Card.Header>
		<Card.Title><h2 class="font-heading text-h3">Сопоставление по навыкам</h2></Card.Title>
		<Card.Description>
			Доли — от всех вакансий окна и от всех участников ФСП на платформе. Доли малых чисел (&lt; {f.threshold}) не
			показываются.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if empty}
			<div data-testid="skills-empty">
				<InsufficientData
					hint="Нет вакансий с распознанными навыками за окно и нет навыков, выведенных из результатов ФСП."
				/>
			</div>
		{:else}
			<div class="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-hidden="true">
				<span class="inline-flex items-center gap-1.5"
					><span class="h-2 w-4 rounded-sm bg-chart-1"></span>спрос рынка</span
				>
				<span class="inline-flex items-center gap-1.5"
					><span class="h-2 w-4 rounded-sm bg-chart-5"></span>предложение ФСП</span
				>
			</div>
			<Table.Root label="Сопоставление по навыкам" data-testid="skills-table">
				<Table.Header>
					<Table.Row>
						<Table.Head>Навык</Table.Head>
						<Table.Head class="text-right">Вакансий</Table.Head>
						<Table.Head class="text-right">Доля вакансий</Table.Head>
						<Table.Head class="text-right">Участников ФСП</Table.Head>
						<Table.Head class="text-right">Доля участников</Table.Head>
						<Table.Head class="text-right">Прямо подтверждено</Table.Head>
						<Table.Head class="w-48">Сравнение долей</Table.Head>
						<Table.Head class="text-right">Разница, п. п.</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each f.rows as row (row.skillKey)}
						{@const diff = gap(row.demandShare, row.supplyShare)}
						<Table.Row data-skill={row.skillKey}>
							<Table.Cell class="font-medium">{data.skills[row.skillKey] ?? row.skillKey}</Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.demand} /></Table.Cell>
							<Table.Cell class="text-right tabular-nums">{shareText(row.demandShare)}</Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.supply} /></Table.Cell>
							<Table.Cell class="text-right tabular-nums">{shareText(row.supplyShare)}</Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.supplyDirect} /></Table.Cell>
							<Table.Cell>
								<div class="grid gap-0.5" aria-hidden="true">
									<div class="h-2 rounded-sm bg-muted">
										<div class="h-2 rounded-sm bg-chart-1" style:width={`${width(row.demandShare)}%`}></div>
									</div>
									<div class="h-2 rounded-sm bg-muted">
										<div class="h-2 rounded-sm bg-chart-5" style:width={`${width(row.supplyShare)}%`}></div>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff}`}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			<p class="mt-2 text-xs text-muted-foreground">
				Разница — доля участников ФСП минус доля вакансий: отрицательная значит, что рынок просит навык чаще, чем его
				дают результаты соревнований. Это повод посмотреть на кейсы и дисциплины, а не оценка навыка.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
