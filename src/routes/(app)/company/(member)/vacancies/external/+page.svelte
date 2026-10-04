<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import { resolve } from '$app/paths';
	import ExternalVacancyCard from '$lib/components/employer/external-vacancy-card.svelte';
	import ExternalVacancyFilters from '$lib/components/employer/external-vacancy-filters.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const labels = $derived({
		roles: data.labels.roles,
		grades: data.labels.grades,
		skills: data.labels.skills,
		workFormats: data.labels.terms.work_format
	});

	/** What a claim leads to for this company (domain 13.3): the operator, the verification first, or nothing. */
	const access = $derived(
		data.company.status === 'verified'
			? 'open'
			: data.company.status === 'rejected' || data.company.status === 'suspended'
				? 'closed'
				: 'after_verification'
	);

	function resultFor(vacancyId: string) {
		if (!form || form.vacancyId !== vacancyId) return null;
		if (form.claimed) return { kind: 'claimed' as const, status: form.claimed.status };
		return { kind: 'problem' as const, message: form.problem.message };
	}

	/** The address of the same search at `cursor` (the first page without it). */
	function searchQuery(cursor: string | null): string {
		const pairs: [string, string][] = [];
		if (data.query.text !== '') pairs.push(['q', data.query.text]);
		if (data.query.roleKey !== null) pairs.push(['role', data.query.roleKey]);
		for (const format of data.query.workFormats) pairs.push(['format', format]);
		if (cursor !== null) pairs.push(['cursor', cursor]);
		return pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
	}
</script>

<PageHeader
	title="Внешние вакансии"
	description="Вакансии с Хабр Карьеры и «Работы России», собранные платформой. Нашли свою — нажмите «Это наша вакансия»: после проверки вы опубликуете её как свою и пригласите кандидатов из пула."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/company/vacancies')}>Вакансии компании</a
		>{/snippet}
</PageHeader>

<section
	class="grid gap-2 rounded-xl border bg-muted/40 p-4 text-sm"
	aria-labelledby="claim-how"
	data-testid="claim-how"
>
	<h2 id="claim-how" class="font-medium">Как работает «Это наша вакансия»</h2>
	{#if access === 'open'}
		<p>
			Оператор ФСП сверяет ИНН и название организации из публикации с реквизитами компании. После подтверждения вы
			публикуете вакансию как свою — с полной вилкой — и приглашаете кандидатов. Пока вакансия внешняя, приглашать по
			ней нельзя.
		</p>
	{:else if access === 'after_verification'}
		<p>
			Компания ещё не проверена. Заявку можно подать уже сейчас: она подождёт проверки компании, затем её рассмотрит
			оператор ФСП. После подтверждения вы опубликуете вакансию как свою и сможете приглашать кандидатов.
			{#if data.role === 'owner'}
				<a class="text-link underline underline-offset-4" href={resolve('/company/profile')}>Проверка компании</a>
			{/if}
		</p>
	{:else}
		<p>Заявки «Это наша вакансия» закрыты: компания отклонена или приостановлена оператором ФСП.</p>
	{/if}
</section>

<ExternalVacancyFilters values={data.query} roles={data.filters.roles} formats={data.filters.formats} />

{#if data.page.items.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><GlobeIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Внешних вакансий по запросу нет</Empty.Title>
			<Empty.Description
				>Измените запрос или фильтры. Вакансии из источников обновляются несколько раз в день.</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-4" aria-label="Внешние вакансии" data-testid="external-vacancies">
		{#each data.page.items as vacancy (vacancy.id)}
			<li>
				<ExternalVacancyCard {vacancy} {labels} {access} result={resultFor(vacancy.id)} />
			</li>
		{/each}
	</ul>
	<div class="flex flex-wrap gap-3">
		{#if data.query.cursor}
			<a
				href="{resolve('/company/vacancies/external')}?{searchQuery(null)}"
				class={buttonVariants({ variant: 'outline' })}>К началу списка</a
			>
		{/if}
		{#if data.page.nextCursor}
			<a
				href="{resolve('/company/vacancies/external')}?{searchQuery(data.page.nextCursor)}"
				class={buttonVariants({ variant: 'outline' })}>Следующие вакансии</a
			>
		{/if}
	</div>
{/if}
