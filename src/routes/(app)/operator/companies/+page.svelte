<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { AUTHORITY_METHODS, COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import DueStatus from '$lib/components/operator/due-status.svelte';
	import { REGISTRY_STATES } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const registryState = (item: (typeof data.queue.items)[number]) => item.registryCheck?.status ?? 'pending';
	/** The filters of this page with the cursor of the next page. */
	const nextQuery = $derived.by(() => {
		const cursor = data.queue.nextCursor;
		if (cursor === null) return null;
		const pairs: [string, string][] = [...page.url.searchParams.entries()].filter(([key]) => key !== 'cursor');
		pairs.push(['cursor', cursor]);
		return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
	});
	/** A request due within this time is marked as near its due time. */
	const SOON_MS = 12 * 3_600_000;
	const STATUS_ORDER = ['submitted', 'verified', 'suspended', 'draft', 'rejected'] as const;
</script>

<PageHeader
	title="Проверка компаний"
	description="Решение о проверке принимает оператор: реестр ФНС — подсказка с источником и временем, связь заявителя с организацией подтверждается отдельно."
/>

<section aria-labelledby="queue-heading" class="grid gap-4">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<h2 id="queue-heading" class="font-heading text-h3">Очередь заявок</h2>
		<form method="GET" class="flex flex-wrap items-end gap-3" data-testid="queue-filters">
			<Field.Field class="w-56">
				<Field.Label for="filter-method">Способ полномочий</Field.Label>
				<NativeSelect id="filter-method" name="method" value={data.filters.method ?? ''}>
					<option value="">Любой</option>
					{#each Object.entries(AUTHORITY_METHODS) as [key, label] (key)}
						<option value={key}>{label}</option>
					{/each}
				</NativeSelect>
			</Field.Field>
			<Field.Field class="w-56">
				<Field.Label for="filter-registry">Реестр</Field.Label>
				<NativeSelect id="filter-registry" name="registry" value={data.filters.registry ?? ''}>
					<option value="">Любое состояние</option>
					{#each Object.entries(REGISTRY_STATES) as [key, state] (key)}
						<option value={key}>{state.label}</option>
					{/each}
				</NativeSelect>
			</Field.Field>
			<label class="flex h-9 items-center gap-2 text-sm">
				<input type="checkbox" name="overdue" value="1" checked={data.filters.overdueOnly} class="size-4" />
				Только просроченные
			</label>
			<Button type="submit" variant="outline">Показать</Button>
		</form>
	</div>

	{#if data.queue.items.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><ShieldCheckIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Заявок нет</Empty.Title>
				<Empty.Description>Новые заявки компаний появятся здесь со сроком решения.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Заявки на проверку компаний" data-testid="verification-queue">
					<Table.Header>
						<Table.Row>
							<Table.Head>Компания</Table.Head>
							<Table.Head>ИНН</Table.Head>
							<Table.Head>Полномочия</Table.Head>
							<Table.Head>Реестр</Table.Head>
							<Table.Head>Подана</Table.Head>
							<Table.Head>Срок решения</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.queue.items as item (item.verificationId)}
							{@const registry = REGISTRY_STATES[registryState(item)]}
							<Table.Row data-verification={item.verificationId} data-inn={item.inn}>
								<Table.Cell class="font-medium">
									<a
										class="underline-offset-4 hover:underline"
										href={resolve('/(app)/operator/companies/requests/[id]', { id: item.verificationId })}
										>{item.displayName}</a
									>
									{#if item.attempt > 1}
										<span class="block text-xs text-muted-foreground">попытка {item.attempt}</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="font-mono tabular-nums">{item.inn}</Table.Cell>
								<Table.Cell>
									{AUTHORITY_METHODS[item.authorityMethod] ?? item.authorityMethod}
									{#if item.hasEvidence}<span class="block text-xs text-muted-foreground">с документом</span>{/if}
								</Table.Cell>
								<Table.Cell>
									{#if registry}<StatusPill label={registry.label} tone={registry.tone} />{/if}
									{#if item.registryCheck?.name_match === false}
										<span class="block text-xs text-warning">название не совпадает</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="whitespace-nowrap">{formatDateTime(item.submittedAt)}</Table.Cell>
								<Table.Cell>
									<DueStatus
										dueAt={item.dueAt}
										now={data.now}
										overdue={item.overdue}
										dueSoon={item.dueAt.getTime() - data.now.getTime() < SOON_MS}
									/>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#if nextQuery}
					<a
						class={buttonVariants({ variant: 'outline', class: 'mt-4' })}
						href="{resolve('/operator/companies')}?{nextQuery}">Следующие заявки</a
					>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</section>

<section aria-labelledby="directory-heading" class="grid gap-4">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div class="grid gap-1">
			<h2 id="directory-heading" class="font-heading text-h3">Все компании</h2>
			<p class="text-sm text-muted-foreground">Приостановка, возврат и партнёрства — в карточке компании.</p>
		</div>
		<form method="GET" class="flex flex-wrap items-end gap-3">
			<Field.Field class="w-64">
				<Field.Label for="directory-q">Название или ИНН</Field.Label>
				<Input id="directory-q" name="q" value={data.filters.q} />
			</Field.Field>
			<Field.Field class="w-48">
				<Field.Label for="directory-status">Статус</Field.Label>
				<NativeSelect id="directory-status" name="status" value={data.filters.status ?? ''}>
					<option value="">Любой</option>
					{#each STATUS_ORDER as status (status)}
						<option value={status}>{COMPANY_STATUSES[status].label} ({data.directory.counts[status]})</option>
					{/each}
				</NativeSelect>
			</Field.Field>
			<Button type="submit" variant="outline">Найти</Button>
		</form>
	</div>
	{#if data.directory.items.length === 0}
		<p class="text-sm text-muted-foreground">Компаний с такими условиями нет.</p>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Все компании" data-testid="company-directory">
					<Table.Header>
						<Table.Row>
							<Table.Head>Компания</Table.Head>
							<Table.Head>ИНН</Table.Head>
							<Table.Head>Статус</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.directory.items as company (company.id)}
							{@const status = COMPANY_STATUSES[company.status]}
							<Table.Row data-company={company.id}>
								<Table.Cell>
									<a
										class="font-medium underline-offset-4 hover:underline"
										href={resolve('/(app)/operator/companies/[id]', { id: company.id })}>{company.displayName}</a
									>
									<span class="block text-xs text-muted-foreground">{company.legalName}</span>
								</Table.Cell>
								<Table.Cell class="font-mono tabular-nums">{company.inn}</Table.Cell>
								<Table.Cell><StatusPill label={status.label} tone={status.tone} /></Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#if data.directory.truncated}
					<p class="mt-3 text-sm text-muted-foreground">Показаны первые 100 — уточните поиск.</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</section>
