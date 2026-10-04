<script lang="ts">
	import { TAXONOMY_STATUSES } from '$lib/components/admin/model.js';
	import ParamValue from '$lib/components/admin/param-value.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sections = $derived([
		{
			key: 'categorization',
			title: 'Правила категоризации',
			description:
				'Пороги осей, группировка вкладов, сигналы грейда и давность. Расчёт категории — чистая функция снимка, версии правил и таксономии.',
			rows: data.rules.categorization
		},
		{
			key: 'matching',
			title: 'Правила соответствия',
			description: 'Веса компонентов соответствия вакансия ↔ кандидат, пороги и правила «неизвестно».',
			rows: data.rules.matching
		}
	]);
	const ATTESTATIONS: Record<string, string> = { direct: 'прямо', derived: 'косвенно' };
	const APPLIES: Record<string, string> = { individual: 'личный', team: 'командный', any: 'любой' };
	const TARGETS: Record<string, string> = { skill: 'навык', role: 'роль', marker: 'маркер' };
</script>

<PageHeader
	title="Правила"
	description="Версии правил категоризации и соответствия с параметрами. Версия неизменяема: изменение — новая версия в справочнике, которую публикует посев."
/>

{#each sections as section (section.key)}
	<section aria-labelledby="{section.key}-heading" class="grid gap-4" data-ruleset={section.key}>
		<div class="grid gap-1">
			<h2 id="{section.key}-heading" class="font-heading text-h3">{section.title}</h2>
			<p class="max-w-3xl text-sm text-muted-foreground">{section.description}</p>
		</div>
		{#if section.rows.length === 0}
			<p class="text-sm text-muted-foreground">Версий нет: их публикует посев таксономии.</p>
		{:else}
			{#each section.rows as ruleset, index (ruleset.id)}
				{@const status = TAXONOMY_STATUSES[ruleset.taxonomyStatus]}
				<Card.Root data-version={ruleset.version}>
					<details open={index === 0}>
						<summary class="flex cursor-pointer flex-wrap items-center gap-3 px-6 text-sm">
							<span class="font-medium">Версия {ruleset.version}</span>
							<span class="text-muted-foreground">таксономия {ruleset.taxonomyLabel}</span>
							{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
							<span class="text-muted-foreground">{formatDateTime(ruleset.createdAt)}</span>
						</summary>
						<div class="px-6 pt-4">
							<ParamValue value={ruleset.params} />
						</div>
					</details>
				</Card.Root>
			{/each}
		{/if}
	</section>
{/each}

<section aria-labelledby="projection-heading" class="grid gap-4">
	<div class="grid gap-1">
		<h2 id="projection-heading" class="font-heading text-h3">Проекция результатов ФСП</h2>
		<p class="max-w-3xl text-sm text-muted-foreground">
			Какие навыки и роли подтверждает дисциплина соревнования и с каким весом. Командный результат прямо не
			подтверждает ничего.
		</p>
	</div>
	{#if data.rules.projection === null}
		<p class="text-sm text-muted-foreground">Опубликованной таксономии нет.</p>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Description>Таксономия {data.rules.projection.taxonomyLabel}</Card.Description>
			</Card.Header>
			<Card.Content>
				<Table.Root label="Правила проекции результатов ФСП" data-testid="projection-rules">
					<Table.Header>
						<Table.Row>
							<Table.Head>Дисциплина</Table.Head>
							<Table.Head>Цель</Table.Head>
							<Table.Head>Вес</Table.Head>
							<Table.Head>Подтверждение</Table.Head>
							<Table.Head>Результат</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.rules.projection.rules as rule (rule.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{rule.discipline}</Table.Cell>
								<Table.Cell>
									{TARGETS[rule.targetKind] ?? rule.targetKind}
									<span class="font-mono text-xs">{rule.targetKey}</span>
									{#if rule.requiresSpecialization}
										<span class="block text-xs text-muted-foreground">специализация {rule.requiresSpecialization}</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="tabular-nums">{rule.weight}</Table.Cell>
								<Table.Cell>{ATTESTATIONS[rule.attestation] ?? rule.attestation}</Table.Cell>
								<Table.Cell>{APPLIES[rule.appliesTo] ?? rule.appliesTo}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
