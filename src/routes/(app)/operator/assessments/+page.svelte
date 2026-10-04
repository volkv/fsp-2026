<script lang="ts">
	import { resolve } from '$app/paths';
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import { ATTEMPT_STATUSES, levelName } from '$lib/components/assessments/model.js';
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
	const KINDS: Record<string, string> = { code_task: 'задача', quiz: 'квиз', open_answer: 'открытый ответ' };
	const REASONS: Record<string, string> = {
		plagiarism: 'заимствование',
		technical_failure: 'технический сбой',
		version_defect: 'дефект версии',
		candidate_request: 'просьба кандидата'
	};
</script>

<PageHeader
	title="Попытки тестов"
	description="Пересмотр попытки по её артефактам и аннулирование с причиной. Сигналы попытки — повод посмотреть человеку, а не вывод о заимствовании: платформа не заявляет обнаружения сгенерированного кода."
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
					? 'Здесь появятся попытки со вставками или уходами со страницы и отправки, которые песочница не проверила.'
					: 'Здесь появятся отправленные попытки кандидатов.'}
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Попытки тестов" data-testid="attempt-list">
				<Table.Header>
					<Table.Row>
						<Table.Head>Задание</Table.Head>
						<Table.Head>Отправлена</Table.Head>
						<Table.Head>Статус</Table.Head>
						<Table.Head>Сигналы</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.attempts as item (item.attemptId)}
						<Table.Row data-attempt={item.attemptId}>
							<Table.Cell>
								<a
									class="font-medium underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/assessments/[id]', { id: item.attemptId })}
								>
									{item.title}
								</a>
								<span class="block text-xs text-muted-foreground"
									>{KINDS[item.kind] ?? item.kind}, версия {item.version}</span
								>
							</Table.Cell>
							<Table.Cell>{item.submittedAt ? formatDateTime(item.submittedAt) : '—'}</Table.Cell>
							<Table.Cell>
								<span class="flex flex-wrap items-center gap-1.5">
									<StatusPill
										label={ATTEMPT_STATUSES[item.status] ?? item.status}
										tone={item.status === 'annulled' ? 'danger' : item.stuck ? 'warning' : 'neutral'}
									/>
									{#if item.level}<span class="text-xs">{levelName(item.level)}</span>{/if}
								</span>
								{#if item.stuck}<span class="block text-xs text-warning">без результата песочницы</span>{/if}
								{#if item.annulReason}<span class="block text-xs text-muted-foreground"
										>{REASONS[item.annulReason] ?? item.annulReason}</span
									>{/if}
							</Table.Cell>
							<Table.Cell class="text-sm">
								вставок {item.signals.pastes}, уходов {item.signals.departures}
								{#if item.signals.silent > 0}<span class="block text-xs text-muted-foreground"
										>без сигналов страницы: {item.signals.silent}</span
									>{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
{/if}
