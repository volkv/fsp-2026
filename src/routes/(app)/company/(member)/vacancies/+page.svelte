<script lang="ts">
	import { resolve } from '$app/paths';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PoolCounter from '$lib/components/employer/pool-counter.svelte';
	import VacancyStatus from '$lib/components/employer/vacancy-status.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

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
			<Empty.Description>Вставьте текст вакансии — черновик соберётся за секунды.</Empty.Description>
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
