<script lang="ts">
	import { candidateLabel } from '$lib/text/candidate-label';
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const STATUS = {
		requested: { label: 'Ждёт ответа', tone: 'info' },
		accepted: { label: 'Блок-тест идёт', tone: 'info' },
		declined: { label: 'Отказ', tone: 'neutral' },
		completed: { label: 'Завершён', tone: 'success' },
		expired: { label: 'Срок истёк', tone: 'neutral' }
	} as const;
</script>

<PageHeader
	title="Запросы подтверждения"
	description="Кандидат проходит блок-тест по желанию; отказ ни на что не влияет. Результат — отдельное доказательство с областью блока, категорию кандидата не меняет; подтверждённый блок можно назвать в «почему вы» нового предложения."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/company/candidates')}>Кандидаты</a
		>{/snippet}
</PageHeader>

{#if data.requests.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><BadgeCheckIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Запросов пока нет</Empty.Title>
			<Empty.Description>Запросить подтверждение блока можно из карточки кандидата.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-testid="company-confirmations">
		{#each data.requests as request (request.id)}
			<li class="grid gap-2 rounded-xl border bg-card p-4 shadow-xs" data-request-status={request.status}>
				<div class="flex flex-wrap items-start justify-between gap-2">
					<div class="grid gap-1">
						<a
							class="font-medium underline-offset-4 hover:underline"
							href={resolve('/(app)/company/(member)/candidates/[pseudonym]', {
								pseudonym: request.candidatePseudonym ?? ''
							})}>{candidateLabel(request.candidatePseudonym)}</a
						>
						<span class="text-sm text-muted-foreground">
							{request.blockTitle} · {data.names.grades[request.grade]} · {formatDate(request.createdAt)}
						</span>
					</div>
					{#if request.result}
						<StatusPill
							label={request.result.status === 'annulled'
								? 'Результат аннулирован'
								: request.result.verdict === 'confirmed'
									? 'Подтверждено'
									: 'Не подтверждено'}
							tone={request.result.status === 'valid' && request.result.verdict === 'confirmed' ? 'success' : 'neutral'}
						/>
					{:else}
						<StatusPill label={STATUS[request.status].label} tone={STATUS[request.status].tone} />
					{/if}
				</div>
				{#if request.result}
					<p class="text-xs text-muted-foreground">
						{request.result.checks} · баллы {request.result.scoreSum / 20} при пороге {request.result.cutSum / 20} · выпуск
						{request.result.bankReleaseId}
					</p>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
