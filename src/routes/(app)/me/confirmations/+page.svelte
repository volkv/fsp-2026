<script lang="ts">
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STATUS = {
		requested: { label: 'Ждёт ответа', tone: 'info' },
		accepted: { label: 'Блок-тест начат', tone: 'info' },
		declined: { label: 'Отказ', tone: 'neutral' },
		completed: { label: 'Закрыт результатом', tone: 'success' },
		expired: { label: 'Срок истёк', tone: 'neutral' }
	} as const;

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const open = (request: (typeof data.requests)[number]) =>
		request.status === 'requested' && new Date(request.expiresAt).getTime() > data.now.getTime();
</script>

<PageHeader
	title="Запросы подтверждения"
	description="Компания просит подтвердить блок, которого нет в твоей категории. Блок-тест — четыре задания, проходится по желанию; отказ ни на что не влияет, категория не меняется ни при каком исходе."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/tests')}>Тесты</a>{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'shared' in form}
	<FormMessage
		tone="success"
		text="Запрос закрыт результатом, который у тебя уже есть: компания его увидела, новый тест не нужен."
	/>
{:else if form && 'declined' in form}
	<FormMessage tone="success" text="Отказ записан." />
{:else if form && 'visibility' in form}
	<FormMessage
		tone="success"
		text={form.visibility === 'all_companies'
			? 'Результат виден всем компаниям, которые видят твой профиль.'
			: 'Результат виден только компании запроса.'}
	/>
{/if}

{#if data.requests.length === 0 && data.results.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><BadgeCheckIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Запросов пока нет</Empty.Title>
			<Empty.Description>
				Работодатель может попросить подтвердить блок навыков, которого нет в категории, — запрос появится здесь.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}

{#if data.requests.length > 0}
	<SectionCard title="Запросы компаний" testId="confirmation-requests">
		<ul class="grid gap-3">
			{#each data.requests as request (request.id)}
				<li class="grid gap-3 rounded-lg border p-3" data-request-status={request.status}>
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="grid gap-1">
							<span class="font-medium">{request.blockTitle} · {data.names.grades[request.grade]}</span>
							<span class="text-sm text-muted-foreground">
								{request.companyName} · запрошено {formatDate(request.createdAt)}{request.status === 'requested'
									? ` · ответить до ${formatDateTime(request.expiresAt)}`
									: ''}
							</span>
						</div>
						<StatusPill label={STATUS[request.status].label} tone={STATUS[request.status].tone} />
					</div>
					{#if request.attemptId}
						<a
							class="text-sm text-link underline underline-offset-4"
							href={resolve('/(app)/me/tests/attempts/[attemptId]', { attemptId: request.attemptId })}
							>Продолжить блок-тест</a
						>
					{/if}
					{#if open(request)}
						<div class="flex flex-wrap gap-2">
							<form method="POST" action="?/accept" use:enhance>
								<CsrfInput />
								<input type="hidden" name="requestId" value={request.id} />
								<Button type="submit" size="sm">Пройти блок-тест</Button>
							</form>
							<form method="POST" action="?/decline" use:enhance>
								<CsrfInput />
								<input type="hidden" name="requestId" value={request.id} />
								<Button type="submit" size="sm" variant="ghost">Отказаться</Button>
							</form>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</SectionCard>
{/if}

{#if data.results.length > 0}
	<SectionCard
		title="Результаты блок-тестов"
		description="Отдельное доказательство: подтверждает блок на грейде запроса, грейд и категорию не меняет. Аннулированная попытка снимает результат."
		testId="block-results"
	>
		<ul class="grid gap-3">
			{#each data.results as result (result.id)}
				<li class="grid gap-2 rounded-lg border p-3" data-verdict={result.verdict}>
					<div class="flex flex-wrap items-start justify-between gap-2">
						<div class="grid gap-1">
							<span class="font-medium">{result.blockTitle} · {data.names.grades[result.grade]}</span>
							<span class="text-sm text-muted-foreground">{result.checks}</span>
							<span class="text-xs text-muted-foreground">
								{formatDate(result.decidedAt)} · выпуск {result.bankReleaseId} · баллы {result.scoreSum / 20} из порога {result.cutSum /
									20}
							</span>
						</div>
						<div class="flex flex-wrap gap-2">
							{#if result.status === 'annulled'}
								<StatusPill label="Аннулирован" tone="danger" />
							{:else}
								<StatusPill
									label={result.verdict === 'confirmed' ? 'Подтверждено' : 'Не подтверждено'}
									tone={result.verdict === 'confirmed' ? 'success' : 'neutral'}
								/>
							{/if}
						</div>
					</div>
					{#if result.status === 'valid' && result.verdict === 'confirmed'}
						<form method="POST" action="?/visibility" use:enhance class="flex flex-wrap items-center gap-2">
							<CsrfInput />
							<input type="hidden" name="confirmationId" value={result.id} />
							<input
								type="hidden"
								name="visibility"
								value={result.visibility === 'requester' ? 'all_companies' : 'requester'}
							/>
							<span class="text-sm text-muted-foreground">
								{result.visibility === 'requester'
									? 'Видит только компания запроса. Открыв всем, ты добавишь навыки блока в подтверждённые в профиле.'
									: 'Видят все компании; навыки блока — в профиле как подтверждённые тестом.'}
							</span>
							<Button type="submit" size="sm" variant="outline">
								{result.visibility === 'requester' ? 'Открыть всем компаниям' : 'Оставить только компании запроса'}
							</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</SectionCard>
{/if}
