<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { TAXONOMY_STATUSES } from '$lib/components/admin/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DemoLockNotice from '$lib/components/product/demo-lock-notice.svelte';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const queue = $derived(data.queue);

	type Status = 'pending' | 'added' | 'rejected';
	const REVIEW: Record<Status, { label: string; tone: 'info' | 'success' | 'neutral' }> = {
		pending: { label: 'ждёт разбора', tone: 'info' },
		added: { label: 'добавлено в словарь', tone: 'success' },
		rejected: { label: 'отклонено', tone: 'neutral' }
	};
	const FILTERS: { value: Status | 'all'; label: string }[] = [
		{ value: 'pending', label: 'Ждут разбора' },
		{ value: 'added', label: 'Добавлены' },
		{ value: 'rejected', label: 'Отклонены' },
		{ value: 'all', label: 'Все' }
	];
	const total = $derived(queue.counts.pending + queue.counts.added + queue.counts.rejected);
	const countOf = (value: Status | 'all') => (value === 'all' ? total : queue.counts[value]);

	/** The query string of a filter link: the mark (none for the default) and the search kept. */
	function filterQuery(value: Status | 'all') {
		const pairs = [
			...(value === 'pending' ? [] : [['status', value]]),
			...(queue.query === '' ? [] : [['q', queue.query]])
		];
		return pairs.length === 0 ? '' : `?${pairs.map(([k = '', v = '']) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
	}

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const done = $derived(form && 'done' in form ? form.done : null);
</script>

<PageHeader
	title="Неизвестные навыки"
	description="Теги внешних вакансий, которые таксономия не распознала: самые частые первыми. Словарь меняется новой версией таксономии; здесь отмечается, что стало с написанием. Резюме в очередь не попадают."
>
	{#snippet actions()}
		<a class="text-sm font-medium text-link underline-offset-4 hover:underline" href={resolve('/admin/taxonomy')}
			>К таксономии</a
		>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if done}
	<FormMessage tone="success" text="«{done.spelling}»: {REVIEW[done.status].label}." />
{/if}

{#if data.demoLocked}
	<DemoLockNotice
		text="Очередь общая для всех посетителей стенда: в демо-сессии её можно посмотреть, но не отметить."
	/>
{/if}

<div class="flex flex-wrap items-end justify-between gap-4">
	<nav aria-label="Отметка" class="flex flex-wrap gap-2 text-sm">
		{#each FILTERS as filter (filter.value)}
			<a
				class="rounded-md border px-3 py-1.5 underline-offset-4 hover:underline aria-[current=page]:border-primary aria-[current=page]:font-medium"
				aria-current={queue.filter === filter.value ? 'page' : undefined}
				href="{resolve('/admin/taxonomy/unknown-skills')}{filterQuery(filter.value)}"
			>
				{filter.label} <span class="text-muted-foreground tabular-nums">{countOf(filter.value)}</span>
			</a>
		{/each}
	</nav>
	<form method="GET" class="flex flex-wrap items-end gap-3" role="search">
		{#if queue.filter !== 'pending'}<input type="hidden" name="status" value={queue.filter} />{/if}
		<Field.Field class="w-64">
			<Field.Label for="unknown-q">Написание</Field.Label>
			<Input id="unknown-q" name="q" value={queue.query} />
		</Field.Field>
		<Button type="submit" variant="outline">Найти</Button>
	</form>
</div>

{#if queue.rows.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><InboxIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Здесь пусто</Empty.Title>
			<Empty.Description>
				{queue.query === ''
					? 'Написаний с такой отметкой нет. Очередь пополняется при нормализации внешних вакансий.'
					: `Написаний по запросу «${queue.query}» нет.`}
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Неизвестные навыки" data-testid="unknown-skills">
				<Table.Header>
					<Table.Row>
						<Table.Head>Написание</Table.Head>
						<Table.Head class="text-right">Публикаций</Table.Head>
						<Table.Head>Впервые</Table.Head>
						<Table.Head>Последняя публикация</Table.Head>
						<Table.Head>В словаре</Table.Head>
						<Table.Head>Отметка</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each queue.rows as row (row.spelling)}
						<Table.Row data-spelling={row.spelling} data-review={row.status}>
							<Table.Cell class="max-w-56 font-mono text-xs break-words whitespace-normal">{row.spelling}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{row.count}</Table.Cell>
							<Table.Cell class="whitespace-nowrap">{formatDate(row.firstSeenAt)}</Table.Cell>
							<Table.Cell class="max-w-sm text-xs whitespace-normal">
								{#if row.lastSeen}
									<a
										class="text-link underline-offset-4 hover:underline"
										href={row.lastSeen.url}
										target="_blank"
										rel="external noopener nofollow">{row.lastSeen.title}</a
									>
									<span class="block text-muted-foreground">
										{formatDate(row.lastSeen.at)} · как написано: «{row.lastSeen.written}»
									</span>
								{:else}
									<span class="text-muted-foreground">сейчас ни в одной публикации</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="text-xs whitespace-normal">
								{#if row.inTaxonomy.length === 0}
									<span class="text-muted-foreground">нет</span>
								{:else}
									<ul class="grid gap-1">
										{#each row.inTaxonomy as entry (entry.label)}
											<li>
												{entry.label}
												<span class="text-muted-foreground">
													({TAXONOMY_STATUSES[entry.status]?.label ?? entry.status}) → {entry.skillKey}
												</span>
											</li>
										{/each}
									</ul>
								{/if}
							</Table.Cell>
							<Table.Cell class="whitespace-normal">
								<div class="grid justify-items-start gap-2">
									<StatusPill label={REVIEW[row.status].label} tone={REVIEW[row.status].tone} />
									{#if !data.demoLocked}
										<form method="POST" action="?/review" use:enhance class="flex flex-wrap gap-2">
											<CsrfInput />
											<input type="hidden" name="spelling" value={row.spelling} />
											{#if row.status === 'pending'}
												<Button type="submit" name="status" value="added" variant="outline" size="xs">Добавлено</Button>
												<Button type="submit" name="status" value="rejected" variant="outline" size="xs">
													Отклонить
												</Button>
											{:else}
												<Button type="submit" name="status" value="pending" variant="outline" size="xs">
													Вернуть в очередь
												</Button>
											{/if}
										</form>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#if queue.truncated}
				<p class="mt-3 text-sm text-muted-foreground">Показаны самые частые — уточните поиск.</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
