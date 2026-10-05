<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { APPLICATION_STATUS } from '$lib/components/product/application-status.js';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
</script>

<PageHeader
	title="Отклики"
	description="Кандидаты сами откликаются на ваши опубликованные вакансии — со своим соответствием и контактами, которые решили раскрыть. Пригласить — отправить предложение: отклик станет «приглашение»."
/>

{#if data.applications.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><SendIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Откликов пока нет</Empty.Title>
			<Empty.Description>Отклики приходят на опубликованные собственные вакансии компании.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-testid="incoming-applications">
		{#each data.applications as item (item.id)}
			<li>
				<a
					href={resolve('/(app)/company/(member)/applications/[id]', { id: item.id })}
					class="grid gap-2 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
					data-application-status={item.status}
				>
					<span class="grid gap-1">
						<span class="font-medium">Кандидат {item.candidatePseudonym} · {item.vacancy.title}</span>
						<span class="text-sm text-muted-foreground">
							{formatDate(item.submittedAt)} · соответствие {percent.format(item.match.score)}
						</span>
					</span>
					<StatusPill label={APPLICATION_STATUS[item.status].label} tone={APPLICATION_STATUS[item.status].tone} />
				</a>
			</li>
		{/each}
	</ul>
{/if}
