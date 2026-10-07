<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DemandBlock from '$lib/components/candidate/demand-block.svelte';
	import NeedDemandBlock from '$lib/components/candidate/need-demand-block.svelte';
	import { OBJECTION_STATUSES } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { CategoryList, RecommendationNotice, ResponseDeadline } from '$lib/components/product/index.js';
	import { formatDate, type CategoryBadgeView } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const catalog = $derived(data.catalog);
	const grade = (key: string | null) => (key === null ? '—' : (catalog.grades[key] ?? key));
	const specialization = (key: string) => catalog.specializations[key] ?? key;
	const skill = (key: string) => data.labels.skills[key] ?? key;

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
	const ended = $derived(data.categories.filter((item) => item.status !== 'active'));
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

	const STEPS = [
		{ key: 'survey', title: 'Опрос' },
		{ key: 'declaration', title: 'Заявленный грейд' },
		{ key: 'test', title: 'Тест и категория' }
	] as const;
</script>

<PageHeader
	title="Категория и грейд"
	description="Категория — специализация и грейд, подтверждённые тестом. Заявленный грейд — ваш выбор, подтверждённый — результат теста; провал теста выше подтверждённый грейд не понижает."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

<RecommendationNotice />

<SectionCard
	title={data.category ? 'Категория подтверждена' : 'Шаг до категории'}
	description={data.category
		? undefined
		: 'Без теста вас нет в категории и её числах: в подборке по заявленной категории вы видны отдельной группой «грейд не подтверждён» — после всех кандидатов с подтверждённым грейдом, а в поиске по всей базе — с меткой «категория не подтверждена».'}
	testId="step-to-category"
>
	<ol class="grid gap-3 sm:grid-cols-3">
		{#each STEPS as step (step.key)}
			{@const done = data.steps[step.key]}
			<li class="flex items-center gap-2 text-sm" data-step={step.key} data-done={done}>
				{#if done}
					<CircleCheckIcon class="size-5 shrink-0 text-success" aria-hidden="true" />
				{:else}
					<CircleDashedIcon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
				{/if}
				{step.title}<span class="sr-only">{done ? ' — готово' : ' — не пройдено'}</span>
			</li>
		{/each}
	</ol>
	<div class="flex flex-wrap items-center gap-3" data-testid="next-step" data-next={data.next.kind}>
		{#if data.next.kind === 'survey'}
			<a href={resolve('/onboarding/survey')} class={buttonVariants()}>Пройти опрос</a>
		{:else if data.next.kind === 'declare'}
			<a href={resolve('/onboarding/grade')} class={buttonVariants()}>Заявить грейд</a>
		{:else if data.next.kind === 'test'}
			<a href={resolve('/me/tests')} class={buttonVariants()}>Пройти тест: {grade(data.next.grade)}</a>
			<span class="text-sm text-muted-foreground">{data.next.text}</span>
		{:else if data.next.kind === 'wait'}
			<span class="text-sm">Тест {grade(data.next.grade)}: {data.next.text}</span>
		{:else}
			<span class="text-sm">Подтверждён высший грейд специализации.</span>
		{/if}
	</div>
</SectionCard>

<SectionCard title="Сейчас" testId="grade-status">
	{#if data.survey}
		<dl class="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
			<div class="grid gap-1">
				<dt class="text-muted-foreground">Направление</dt>
				<dd>{catalog.directions[data.survey.direction]}</dd>
			</div>
			<div class="grid gap-1">
				<dt class="text-muted-foreground">Специализация</dt>
				<dd>{specialization(data.survey.specialization)}</dd>
			</div>
			<div class="grid gap-1" data-testid="declared-grade">
				<dt class="text-muted-foreground">Заявленный грейд</dt>
				<dd>
					{grade(data.declaration?.grade ?? null)}
					{#if data.declaration}<span class="text-muted-foreground">· {formatDate(data.declaration.declaredAt)}</span
						>{/if}
				</dd>
			</div>
			<div class="grid gap-1" data-testid="confirmed-grade">
				<dt class="text-muted-foreground">Подтверждённый грейд</dt>
				<dd>
					{#if data.category}
						<StatusPill tone="success" label={grade(data.category.grade)} />
						<span class="text-muted-foreground">с {formatDate(data.category.assignedAt)}</span>
					{:else}
						<StatusPill label="категория не подтверждена" />
					{/if}
				</dd>
			</div>
		</dl>
		{#if data.category && data.category.confirmedBlocks.length > 0}
			<div class="grid gap-2 text-sm">
				<span class="text-muted-foreground">Пройденные блоки</span>
				<ul class="flex flex-wrap gap-2">
					{#each data.category.confirmedBlocks as block (block)}
						<li class="rounded-full border px-3 py-1">{catalog.blocks[block] ?? block}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<div class="grid gap-2 text-sm">
			<span class="text-muted-foreground">Заявленный стек (не подтверждён тестом)</span>
			<ul class="flex flex-wrap gap-2">
				{#each data.survey.declaredSkillKeys as key (key)}
					<li class="rounded-full border border-dashed px-3 py-1">{skill(key)}</li>
				{/each}
			</ul>
		</div>
		<div class="flex flex-wrap gap-3">
			<a href={resolve('/onboarding/grade')} class={buttonVariants({ variant: 'outline', size: 'sm' })}
				>Изменить заявленный грейд</a
			>
			<a href={resolve('/onboarding/survey')} class={buttonVariants({ variant: 'outline', size: 'sm' })}
				>Пройти опрос заново или сменить специализацию</a
			>
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">Опрос ещё не пройден.</p>
	{/if}
</SectionCard>

{#if data.options.length > 0}
	<SectionCard
		title="Тесты по грейдам"
		description="Какой тест можно начать сейчас и когда откроются остальные — по правилам грейда."
		testId="grade-options"
	>
		<ul class="grid gap-2">
			{#each data.options as option (option.grade)}
				<li
					class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
					data-grade={option.grade}
					data-available={option.available}
				>
					<span class="grid gap-0.5">
						<span class="font-medium">{grade(option.grade)}</span>
						<span class="text-muted-foreground">{option.text}</span>
					</span>
					{#if option.available}
						<a href={resolve('/me/tests')} class={buttonVariants({ size: 'sm' })}>Начать тест</a>
					{:else}
						<StatusPill label="закрыт" />
					{/if}
				</li>
			{/each}
		</ul>
	</SectionCard>
{/if}

<SectionCard title="Действующие категории" testId="categories">
	<CategoryList categories={inForce} reader="candidate" />
	{#if ended.length > 0}
		<details class="text-sm">
			<summary class="cursor-pointer text-muted-foreground">История категорий</summary>
			<ul class="mt-2 grid gap-2">
				{#each ended as item (item.id)}
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

<NeedDemandBlock demand={data.needs} {labels} />
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

<SectionCard title="История" testId="grade-history">
	<div class="grid gap-6 md:grid-cols-2">
		<div class="grid content-start gap-2">
			<h3 class="text-sm font-semibold">Опросы</h3>
			{#if data.surveys.length === 0}
				<p class="text-sm text-muted-foreground">Пока нет.</p>
			{:else}
				<ul class="grid gap-2 text-sm">
					{#each data.surveys as survey (survey.version)}
						<li class="rounded-md border p-2" data-survey-version={survey.version}>
							<span class="font-medium">Версия {survey.version}</span> · {formatDate(survey.createdAt)} · {specialization(
								survey.specialization
							)}
							<span class="block text-muted-foreground">{survey.declaredSkillKeys.map(skill).join(', ')}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="grid content-start gap-2">
			<h3 class="text-sm font-semibold">Заявления грейда</h3>
			{#if data.declarations.length === 0}
				<p class="text-sm text-muted-foreground">Пока нет.</p>
			{:else}
				<ul class="grid gap-2 text-sm">
					{#each data.declarations as declaration (declaration.id)}
						<li class="rounded-md border p-2">
							<span class="font-medium">{grade(declaration.grade)}</span> · {specialization(declaration.specialization)}
							· {formatDate(declaration.declaredAt)}
							<span class="block text-muted-foreground">
								{declaration.suggested ? `Подсказка советовала: ${grade(declaration.suggested)}` : 'Подсказки не было'}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</SectionCard>
