<script lang="ts">
	import { resolve } from '$app/paths';
	import MessageSquareWarningIcon from '@lucide/svelte/icons/message-square-warning';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DueStatus from '$lib/components/operator/due-status.svelte';
	import { DISPUTE_STATUSES } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Возражения по категориям"
	description="Кандидат вправе оспорить автоматическую категорию; ответ — в течение 30 дней (ч. 4 ст. 16 152-ФЗ). Отвечает оператор, взявший возражение в работу."
/>

<section aria-labelledby="disputes-heading" class="grid gap-4">
	<h2 id="disputes-heading" class="font-heading text-h3">Открытые</h2>
	{#if data.queue.items.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><MessageSquareWarningIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Открытых возражений нет</Empty.Title>
				<Empty.Description>Новые появятся здесь со сроком ответа.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Открытые возражения" data-testid="dispute-queue">
					<Table.Header>
						<Table.Row>
							<Table.Head>Возражение</Table.Head>
							<Table.Head>Оспариваемая роль</Table.Head>
							<Table.Head>Статус</Table.Head>
							<Table.Head>Ответственный</Table.Head>
							<Table.Head>Срок ответа</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.queue.items as item (item.id)}
							{@const status = DISPUTE_STATUSES[item.status]}
							<Table.Row data-dispute={item.id}>
								<Table.Cell>
									<a
										class="font-medium underline-offset-4 hover:underline"
										href={resolve('/(app)/operator/disputes/[id]', { id: item.id })}
										>от {formatDateTime(item.openedAt)}</a
									>
									{#if item.isMinor}<span class="block text-xs text-muted-foreground">кандидату 14–17 лет</span>{/if}
								</Table.Cell>
								<Table.Cell
									>{item.roleKey ? (data.roles[item.roleKey] ?? item.roleKey) : 'роль не установлена'}</Table.Cell
								>
								<Table.Cell
									>{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}</Table.Cell
								>
								<Table.Cell>
									{#if item.assignee}
										{item.mine ? 'вы' : (item.assignee.name ?? 'оператор')}
									{:else}
										<span class="text-muted-foreground">не назначен</span>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<DueStatus dueAt={item.dueAt} now={data.now} overdue={item.overdue} dueSoon={item.dueSoon} />
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>

{#if data.queue.resolved.length > 0}
	<section aria-labelledby="resolved-heading" class="grid gap-4">
		<h2 id="resolved-heading" class="font-heading text-h3">Недавно решённые</h2>
		<ul class="grid gap-2 text-sm">
			{#each data.queue.resolved as item (item.id)}
				{@const status = DISPUTE_STATUSES[item.status]}
				<li class="flex flex-wrap items-center gap-3">
					<a class="underline-offset-4 hover:underline" href={resolve('/(app)/operator/disputes/[id]', { id: item.id })}
						>{item.resolvedAt ? formatDateTime(item.resolvedAt) : 'без даты'}</a
					>
					{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
					<span class="text-muted-foreground">{item.assigneeName ?? ''}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}
