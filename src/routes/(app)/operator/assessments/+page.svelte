<script lang="ts">
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import { resolve } from '$app/paths';
	import { ATTEMPT_STATUSES, OUTCOMES } from '$lib/components/assessments/model.js';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const FILTERS = [
		{ key: 'attention', label: 'Требуют внимания', query: '' },
		{ key: 'all', label: 'Все последние', query: '?filter=all' }
	] as const;
</script>

<PageHeader
	title="Попытки тестов"
	description="Пересмотр попытки теста на грейд по сохранённым экземплярам и ответам и аннулирование с причиной. Сигналы попытки — повод посмотреть человеку, а не вывод о заимствовании: платформа не заявляет обнаружения сгенерированного кода."
/>

<nav aria-label="Какие попытки показать">
	<ul class="flex flex-wrap gap-2">
		{#each FILTERS as item (item.key)}
			<li>
				<a
					href="{resolve('/operator/assessments')}{item.query}"
					aria-current={data.filter === item.key ? 'page' : undefined}
					class={cn(
						'inline-flex rounded-full border px-3 py-1 text-sm',
						data.filter === item.key ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
					)}>{item.label}</a
				>
			</li>
		{/each}
	</ul>
</nav>

{#if data.attempts.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><ClipboardCheckIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>{data.filter === 'attention' ? 'Нечего пересматривать' : 'Попыток пока нет'}</Empty.Title>
			<Empty.Description>
				{data.filter === 'attention'
					? 'Здесь появятся попытки со вставками или уходами со страницы и практика, которую песочница не проверила.'
					: 'Здесь появятся попытки кандидатов.'}
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Попытки тестов" data-testid="attempt-list">
				<Table.Header>
					<Table.Row>
						<Table.Head>Тест</Table.Head>
						<Table.Head>Начата</Table.Head>
						<Table.Head>Статус</Table.Head>
						<Table.Head>Сигналы</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.attempts as item (item.attemptId)}
						{@const status = ATTEMPT_STATUSES[item.status]}
						{@const outcome = item.outcome ? OUTCOMES[item.outcome] : null}
						<Table.Row data-attempt={item.attemptId}>
							<Table.Cell>
								<a
									class="font-medium underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/assessments/[id]', { id: item.attemptId })}>{item.title}</a
								>
								<p class="text-xs text-muted-foreground">
									{item.bankReleaseId}{item.seeded ? ' · синтетика' : ''}
								</p>
							</Table.Cell>
							<Table.Cell>{formatDateTime(item.startedAt)}</Table.Cell>
							<Table.Cell>
								<div class="flex flex-wrap gap-1">
									{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
									{#if outcome}<StatusPill label={outcome.label} tone={outcome.tone} />{/if}
									{#if item.stuck}<StatusPill label="Песочница не ответила" tone="warning" />{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="text-sm">
								вставок {item.signals.pastes} ({item.signals.pastedChars} симв.), уходов {item.signals.departures}
								{#if item.signals.silent > 0}· без сигналов {item.signals.silent}{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
{/if}
