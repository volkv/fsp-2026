<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DemandBlock from '$lib/components/candidate/demand-block.svelte';
	import { OBJECTION_STATUSES } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { CategoryList, RecommendationNotice, ResponseDeadline } from '$lib/components/product/index.js';
	import { formatDate, type CategoryBadgeView } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const labels = $derived(data.labels);
	const name = (map: Record<string, string>, key: string) => map[key] ?? key;

	const badge = (item: (typeof data.categories)[number]): CategoryBadgeView => ({
		key: item.specialization,
		specialization: name(labels.specializations, item.specialization),
		grade: name(labels.grades, item.grade),
		skills: item.confirmedSkillKeys.map((key) => name(labels.skills, key)),
		blocks: item.confirmedBlocks.length,
		assignedOn: item.assignedAt.toISOString().slice(0, 10)
	});
	const inForce = $derived(data.categories.filter((item) => item.status === 'active').map(badge));
	const history = $derived(data.categories.filter((item) => item.status !== 'active'));
	const problem = $derived(form && 'problem' in form ? form.problem : null);

	const ENDED: Record<string, string> = {
		superseded: 'заменена следующим грейдом',
		decision_annulled: 'отозвана: решение теста аннулировано',
		objection_annulled: 'отозвана: попытка аннулирована по возражению',
		objection_rescored: 'отозвана: решение пересчитано по возражению'
	};
	const OUTCOMES: Record<string, string> = {
		upheld: 'решение теста оставлено',
		annulled: 'попытка аннулирована, тест можно пройти снова',
		rescored: 'оценка заданий исправлена, решение пересчитано'
	};
</script>

<PageHeader
	title="Твоя категория"
	description="Специализация и грейд, подтверждённые тестом на грейд. Резюме, достижения ФСП и публичные профили — основания профиля: они уточняют ранжирование, но категорию не назначают и не отзывают."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

<RecommendationNotice />

<SectionCard title="Действующие категории" testId="categories">
	<CategoryList categories={inForce} reader="candidate" />
	{#if history.length > 0}
		<details class="text-sm">
			<summary class="cursor-pointer text-muted-foreground">История категорий</summary>
			<ul class="mt-2 grid gap-2">
				{#each history as item (item.id)}
					<li class="rounded-md border p-3">
						{name(labels.specializations, item.specialization)} · {name(labels.grades, item.grade)} — назначена
						{formatDate(item.assignedAt)},
						{name(ENDED, item.revokeReason ?? item.status)}{item.endedAt ? ` ${formatDate(item.endedAt)}` : ''}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</SectionCard>

<DemandBlock demand={data.demand} {labels} />

<SectionCard
	title="Возражения"
	description="Не согласен с результатом теста — возрази с экрана результата. Оператор ФСП отвечает в течение 30 дней."
	testId="objections"
>
	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'objectionWithdrawn' in form}
		<FormMessage tone="success" text="Возражение отозвано." />
	{/if}
	{#if data.objections.length === 0}
		<p class="text-sm text-muted-foreground">Возражений нет.</p>
	{:else}
		<ul class="grid gap-2 text-sm">
			{#each data.objections as objection (objection.id)}
				{@const status = OBJECTION_STATUSES[objection.status]}
				<li class="grid gap-2 rounded-md border p-3" data-objection={objection.id}>
					<span class="flex flex-wrap items-center gap-2">
						<StatusPill label={status.label} tone={status.tone} />
						<span class="text-xs text-muted-foreground">подано {formatDate(objection.openedAt)}</span>
						{#if objection.status === 'open' || objection.status === 'in_review'}
							<ResponseDeadline dueAt={objection.dueAt} label="Ответ оператора до" />
						{/if}
					</span>
					<span class="whitespace-pre-line">{objection.reason}</span>
					{#if objection.outcome}
						<span>Итог: {name(OUTCOMES, objection.outcome)}.</span>
					{/if}
					{#if objection.resolution}<span>Ответ оператора: {objection.resolution}</span>{/if}
					{#if objection.status === 'open' || objection.status === 'in_review'}
						<form method="POST" action="?/withdraw" use:enhance>
							<CsrfInput />
							<input type="hidden" name="objectionId" value={objection.id} />
							<Button type="submit" variant="outline" size="sm">Отозвать возражение</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>
