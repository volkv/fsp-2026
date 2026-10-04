<script lang="ts">
	import { resolve } from '$app/paths';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import { enhance } from '$app/forms';
	import { CLAIM_STATUSES } from '$lib/components/employer/model.js';
	import PoolCounter from '$lib/components/employer/pool-counter.svelte';
	import VacancyStatus from '$lib/components/employer/vacancy-status.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** Claims the company can still take back: they wait for the verification of the company or for the operator. */
	const OPEN_CLAIM = new Set(['awaiting_company_verification', 'pending_review']);

	const grade = (min: string, max: string) =>
		min === max
			? (data.labels.grades[min] ?? min)
			: `${data.labels.grades[min] ?? min}–${data.labels.grades[max] ?? max}`;
</script>

<PageHeader
	title="Вакансии"
	description="Вакансии компании: по каждой — кандидаты с объяснением соответствия и приглашения с вилкой."
>
	{#snippet actions()}
		<a class={buttonVariants({ variant: 'outline' })} href={resolve('/company/vacancies/external')}>
			<GlobeIcon aria-hidden="true" />
			Внешние вакансии
		</a>
		<a class={buttonVariants()} href={resolve('/company/vacancies/new')}>
			<PlusIcon aria-hidden="true" />
			Новая вакансия
		</a>
	{/snippet}
</PageHeader>

{#if data.vacancies.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><BriefcaseIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Вакансий пока нет</Empty.Title>
			<Empty.Description>
				Вставьте текст вакансии — черновик соберётся за секунды. Если вакансия уже висит на Хабр Карьере или «Работе
				России», найдите её среди внешних и заявите своей.
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a class={buttonVariants()} href={resolve('/company/vacancies/new')}>Создать вакансию</a>
		</Empty.Content>
	</Empty.Root>
{:else}
	<ul class="grid gap-4" aria-label="Вакансии компании">
		{#each data.vacancies as vacancy (vacancy.id)}
			<li>
				<Card.Root data-vacancy={vacancy.id}>
					<Card.Header>
						<Card.Title class="flex flex-wrap items-center gap-3">
							<h2 class="font-heading text-h3">
								<a class="hover:underline" href={resolve('/(app)/company/(member)/vacancies/[id]', { id: vacancy.id })}>
									{vacancy.title}
								</a>
							</h2>
							<VacancyStatus status={vacancy.status} />
						</Card.Title>
						<Card.Description>
							{data.labels.roles[vacancy.roleKey] ?? vacancy.roleKey} · {grade(vacancy.gradeMin, vacancy.gradeMax)}
							· {data.labels.terms.work_format[vacancy.workFormat] ?? vacancy.workFormat}
						</Card.Description>
					</Card.Header>
					<Card.Content class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
						<div class="grid gap-2">
							<SalaryRange salary={vacancy.salary} />
							<PoolCounter pool={vacancy.pool} />
						</div>
						{#if vacancy.status !== 'closed'}
							<a
								class={cn(buttonVariants({ variant: 'outline' }), 'justify-self-start')}
								href={resolve('/(app)/company/(member)/vacancies/[id]/candidates', { id: vacancy.id })}
							>
								<SearchIcon aria-hidden="true" />
								Кандидаты под вакансию
							</a>
						{/if}
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}

{#if data.claims.length > 0}
	<section class="grid gap-3" aria-labelledby="claims-heading">
		<h2 id="claims-heading" class="font-heading text-h3">Заявленные внешние вакансии</h2>
		<p class="text-sm text-muted-foreground">
			«Это наша вакансия»: после подтверждения оператором компания публикует её как свою — приглашать можно только по
			своей вакансии.
			<a class="text-link underline underline-offset-4" href={resolve('/company/vacancies/external')}
				>Найти другие свои вакансии среди внешних</a
			>
		</p>
		<ul class="grid gap-2">
			{#each data.claims as claim (claim.claimId)}
				<li
					class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
					data-claim={claim.claimId}
					data-claim-status={claim.status}
				>
					<span class="font-medium">{claim.vacancy.title}</span>
					<span class="flex flex-wrap items-center gap-2 text-muted-foreground">
						подана {formatDate(claim.requestedAt)}
						<StatusPill
							label={CLAIM_STATUSES[claim.status] ?? claim.status}
							tone={claim.status === 'approved' ? 'success' : claim.status === 'rejected' ? 'danger' : 'info'}
						/>
					</span>
					{#if claim.reason}
						<p class="w-full text-muted-foreground">Причина отказа: {claim.reason}</p>
					{/if}
					{#if form?.claimId === claim.claimId}
						<div class="w-full">
							{#if form.problem}
								<FormMessage text={form.problem.message} />
							{:else if form.withdrawn}
								<FormMessage tone="success" text="Заявка отозвана: оператор её больше не увидит." />
							{/if}
						</div>
					{/if}
					{#if OPEN_CLAIM.has(claim.status)}
						<form method="POST" action="?/withdrawClaim" use:enhance class="w-full">
							<CsrfInput />
							<input type="hidden" name="vacancy_id" value={claim.vacancy.id} />
							<input type="hidden" name="claim_id" value={claim.claimId} />
							<Button type="submit" variant="outline" size="sm">
								<UndoIcon aria-hidden="true" />
								Отозвать заявку
							</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
