<script lang="ts">
	import { resolve } from '$app/paths';
	import FlagIcon from '@lucide/svelte/icons/flag';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { COMPLAINT_DECISIONS, COMPLAINT_REASONS } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Жалобы кандидатов на предложения"
	description="Кандидат жалуется на предложение компании: условия не совпали, работы нет, собирают контакты, требуют оплату. Решение — без последствий, предупреждение или приостановка компании; кандидат видит объяснение, компания — только причину обоснованной жалобы."
/>

<section aria-labelledby="complaints-heading" class="grid gap-4">
	<h2 id="complaints-heading" class="font-heading text-h3">Открытые</h2>
	{#if data.queue.open.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><FlagIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Открытых жалоб нет</Empty.Title>
				<Empty.Description>Новые появятся здесь, старые — первыми.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Открытые жалобы" data-testid="complaint-queue">
					<Table.Header>
						<Table.Row>
							<Table.Head>Подана</Table.Head>
							<Table.Head>Компания</Table.Head>
							<Table.Head>Причина</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.queue.open as item (item.id)}
							<Table.Row data-complaint={item.id}>
								<Table.Cell>
									<a
										class="font-medium underline-offset-4 hover:underline"
										href={resolve('/(app)/operator/complaints/[id]', { id: item.id })}
										>{formatDateTime(item.createdAt)}</a
									>
								</Table.Cell>
								<Table.Cell>{item.companyName}</Table.Cell>
								<Table.Cell>{COMPLAINT_REASONS[item.reasonCode] ?? item.reasonCode}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>

{#if data.queue.decided.length > 0}
	<section aria-labelledby="decided-heading" class="grid gap-4">
		<h2 id="decided-heading" class="font-heading text-h3">Недавно рассмотренные</h2>
		<ul class="grid gap-2 text-sm">
			{#each data.queue.decided as item (item.id)}
				{@const decision = item.decision ? COMPLAINT_DECISIONS[item.decision] : undefined}
				<li class="flex flex-wrap items-center gap-3">
					<a
						class="underline-offset-4 hover:underline"
						href={resolve('/(app)/operator/complaints/[id]', { id: item.id })}
						>{item.decidedAt ? formatDateTime(item.decidedAt) : 'без даты'}</a
					>
					<span>{item.companyName}</span>
					{#if decision}<StatusPill label={decision.label} tone={decision.tone} />{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
