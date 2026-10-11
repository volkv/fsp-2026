<script lang="ts">
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { disciplineName } from '$lib/components/employer/model.js';
	import { FSP_LEVELS } from '$lib/components/candidate/model.js';
	import { DISCIPLINES } from '$lib/components/product/model.js';
	import CorrelationNotice from '$lib/components/operator/correlation-notice.svelte';
	import FunnelOverview from '$lib/components/operator/funnel-overview.svelte';
	import FunnelTable from '$lib/components/operator/funnel-table.svelte';
	import {
		FUNNEL_DIMENSIONS,
		MULTI_GROUP_DIMENSIONS,
		funnelGroupName,
		type FunnelNames,
		type FunnelGroupView
	} from '$lib/components/operator/model.js';
	import CountCell from '$lib/components/operator/count-cell.svelte';
	import SyntheticNote from '$lib/components/operator/synthetic-note.svelte';
	import { shareText } from '$lib/components/operator/model.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const funnel = $derived(data.funnel);
	const calibration = $derived(data.calibration);
	const threshold = $derived(funnel.threshold);
	const [primary, inner] = $derived(funnel.dimensions);
	const empty = $derived('value' in funnel.total.invited && funnel.total.invited.value === 0);
	const synthetic = $derived(funnel.total.synthetic);
	const names = $derived<FunnelNames>({
		specializations: data.specializations,
		grades: data.grades,
		competitions: funnel.competitions,
		discipline: (code: string) => disciplineName(code, 'short')
	});
	const dimensionName = (dimension: string | undefined) =>
		dimension === undefined ? '' : (FUNNEL_DIMENSIONS[dimension] ?? dimension);
	const title = $derived(
		inner === undefined ? dimensionName(primary) : `${dimensionName(primary)}, внутри — ${dimensionName(inner)}`
	);
	const nameOf = (group: FunnelGroupView, depth: 0 | 1) =>
		funnelGroupName((depth === 0 ? primary : inner) ?? '', group, names);
	/** The dimensions of the slice where a candidate is in several groups, with the rule in words. */
	const multiGroup = $derived(
		[primary, inner].flatMap((dimension) =>
			dimension !== undefined && MULTI_GROUP_DIMENSIONS[dimension]
				? [`${dimensionName(dimension).toLowerCase()} — ${MULTI_GROUP_DIMENSIONS[dimension]}`]
				: []
		)
	);
	const byCompetition = $derived(primary === 'competition' || inner === 'competition');
	const disciplines = Object.entries(DISCIPLINES).filter(([code]) => code !== 'unknown');
</script>

<PageHeader
	title="Карьерные исходы"
	description="Куда приходят участники федерации после приглашения работодателя: каждая стадия отдельно, с тем, кто её подтвердил, и с честным числом неизвестных исходов."
/>

<form method="GET" class="grid gap-4" data-testid="funnel-filters">
	<div class="flex flex-wrap items-end gap-3">
		<Field.Field class="w-60">
			<Field.Label for="funnel-by">Разрез</Field.Label>
			<NativeSelect id="funnel-by" name="by" value={data.filters.dimension}>
				{#each Object.entries(FUNNEL_DIMENSIONS) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-60">
			<Field.Label for="funnel-then">Внутри каждой строки</Field.Label>
			<NativeSelect id="funnel-then" name="then" value={data.filters.inner ?? ''}>
				<option value="">Без второго разреза</option>
				{#each Object.entries(FUNNEL_DIMENSIONS) as [key, label] (key)}
					<option value={key}>{label}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-44">
			<Field.Label for="funnel-from">Приглашения с</Field.Label>
			<Input id="funnel-from" name="from" type="date" value={data.filters.from ?? ''} />
		</Field.Field>
		<Field.Field class="w-44">
			<Field.Label for="funnel-to">по (не включая)</Field.Label>
			<Input id="funnel-to" name="to" type="date" value={data.filters.to ?? ''} />
		</Field.Field>
	</div>
	<fieldset class="flex flex-wrap items-end gap-3">
		<legend class="mb-2 text-sm font-medium">Только кандидаты</legend>
		<Field.Field class="w-52">
			<Field.Label for="funnel-discipline">Дисциплина ФСП</Field.Label>
			<NativeSelect id="funnel-discipline" name="fsp_discipline" value={data.filters.where.fsp_discipline ?? ''}>
				<option value="">Любая</option>
				{#each disciplines as [code, discipline] (code)}
					<option value={code}>{discipline.short}</option>
				{/each}
				<option value="none">Без уровня ФСП</option>
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-44">
			<Field.Label for="funnel-level">Уровень ФСП</Field.Label>
			<NativeSelect id="funnel-level" name="fsp_level" value={data.filters.where.fsp_level ?? ''}>
				<option value="">Любой</option>
				{#each Object.keys(FSP_LEVELS).sort() as level (level)}
					<option value={level}>{level}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-52">
			<Field.Label for="funnel-specialization">Специализация категории</Field.Label>
			<NativeSelect id="funnel-specialization" name="specialization" value={data.filters.where.specialization ?? ''}>
				<option value="">Любая</option>
				{#each Object.entries(data.specializations) as [key, name] (key)}
					<option value={key}>{name}</option>
				{/each}
				<option value="none">Категория не подтверждена</option>
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-44">
			<Field.Label for="funnel-region">Код региона</Field.Label>
			<Input id="funnel-region" name="region" placeholder="RU-MOW" value={data.filters.where.region ?? ''} />
		</Field.Field>
		<Button type="submit" variant="outline">Показать</Button>
	</fieldset>
</form>

{#if synthetic}
	<SyntheticNote />
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title><h2 class="font-heading text-h3">Вся выборка</h2></Card.Title>
		<Card.Description>
			Все приглашения периода с учётом фильтров. Числа меньше {threshold} показаны как «&lt; {threshold}»; если в
			выборке меньше {threshold} кандидатов, скрыты все числа, включая нули: малые группы указали бы на людей.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if empty}
			<p class="text-sm text-muted-foreground" data-testid="funnel-empty">
				За выбранный период и фильтры приглашений не было — исходов считать не из чего.
			</p>
		{:else}
			<FunnelOverview group={funnel.total} />
		{/if}
	</Card.Content>
</Card.Root>

<Card.Root>
	<Card.Header>
		<Card.Title>
			<h2 class="font-heading text-h3">По разрезу: {title}</h2>
		</Card.Title>
		<Card.Description class="grid gap-1" data-testid="funnel-rules">
			<span data-rule="small-groups">
				Группы, где меньше {threshold} кандидатов, не показываются по отдельности: они объединены в строку «Малые группы»,
				и к ней добавляются следующие по размеру, пока в ней не наберётся {threshold} человек{inner === undefined
					? ''
					: '. Внутри каждой строки — так же'}.
			</span>
			{#if multiGroup.length > 0}
				<span data-rule="multi-group">
					Кандидат с несколькими значениями учитывается вместе со своими приглашениями в каждой своей группе ({multiGroup.join(
						'; '
					)}), поэтому суммы по строкам не равны итогу.
				</span>
			{/if}
			{#if inner !== undefined}
				<span data-rule="nested">
					Строки внутри строки — её кандидаты по второму разрезу. У строки «Малые группы» внутренних строк нет: они
					раскрыли бы группы, которые она объединяет.
				</span>
			{/if}
			{#if byCompetition}
				<span data-rule="competition">
					Соревнование — любое, где у кандидата есть действующий результат; дисциплина и уровень рядом с ним — по
					дисциплине соревнования.
				</span>
			{/if}
			{#if primary === 'region' || inner === 'region'}
				<span data-testid="funnel-region-note">
					Регион — код из предпочтений кандидата в том виде, в каком он указан сейчас; кандидаты без региона собраны в
					отдельную группу.
				</span>
			{/if}
			<span>«Одной стороной» — выход отметила только компания / только кандидат.</span>
		</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if funnel.groups.length === 0}
			<p class="text-sm text-muted-foreground">Данных для разреза нет.</p>
		{:else}
			<FunnelTable groups={funnel.groups} {nameOf} label="Воронка — {title}" />
		{/if}
	</Card.Content>
</Card.Root>

<CorrelationNotice />

<Card.Root class="mt-6" data-testid="interview-calibration">
	<Card.Header>
		<Card.Title>
			<h2 class="font-heading text-h3">Грейд теста и собеседования</h2>
		</Card.Title>
		<Card.Description class="grid gap-1">
			<span>
				Внешний критерий теста: после принятого предложения компания отмечает, показал ли кандидат на собеседовании
				уровень ниже, на уровне или выше грейда, подтверждённого тестом. Строки — категория и выпуск банка заданий, по
				которым грейд был подтверждён на момент предложения.
			</span>
			<span>
				Сводка — сигнал для пересмотра порогов и заданий выпуска; категории кандидатов и подборки от отзывов не
				меняются. Числа меньше {calibration.threshold} показаны как «&lt; {calibration.threshold}», доля согласия —
				только когда отзывов не меньше {calibration.threshold}.
			</span>
		</Card.Description>
		{#if calibration.synthetic}<SyntheticNote compact />{/if}
	</Card.Header>
	<Card.Content>
		{#if calibration.rows.length === 0}
			<p class="text-sm text-muted-foreground">Отзывов о собеседованиях пока нет.</p>
		{:else}
			<Table.Root label="Согласие грейда с собеседованиями" data-testid="interview-calibration-table">
				<Table.Header>
					<Table.Row>
						<Table.Head>Категория</Table.Head>
						<Table.Head>Выпуск банка</Table.Head>
						<Table.Head class="text-right">Отзывов</Table.Head>
						<Table.Head class="text-right">Ниже</Table.Head>
						<Table.Head class="text-right">Соответствует</Table.Head>
						<Table.Head class="text-right">Выше</Table.Head>
						<Table.Head class="text-right">Согласие</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each calibration.rows as row (`${row.specialization}|${row.grade}|${row.bankReleaseId}`)}
						<Table.Row>
							<Table.Cell class="font-medium"
								>{data.specializations[row.specialization] ?? row.specialization} · {data.grades[row.grade] ??
									row.grade}</Table.Cell
							>
							<Table.Cell class="font-mono text-xs">{row.bankReleaseId}</Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.total} /></Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.below} /></Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.matches} /></Table.Cell>
							<Table.Cell class="text-right"><CountCell cell={row.above} /></Table.Cell>
							<Table.Cell class="text-right tabular-nums">{shareText(row.agreement)}</Table.Cell>
						</Table.Row>
						{#each row.blocks as block (block.code)}
							<Table.Row class="text-muted-foreground">
								<Table.Cell class="pl-6" colspan={2}>блок «{block.title}»</Table.Cell>
								<Table.Cell class="text-right"><CountCell cell={block.total} /></Table.Cell>
								<Table.Cell class="text-right"><CountCell cell={block.below} /></Table.Cell>
								<Table.Cell class="text-right"><CountCell cell={block.matches} /></Table.Cell>
								<Table.Cell class="text-right"><CountCell cell={block.above} /></Table.Cell>
								<Table.Cell></Table.Cell>
							</Table.Row>
						{/each}
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>
