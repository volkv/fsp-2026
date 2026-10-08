<script lang="ts">
	import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
	import type { ClosedPlan, OpenPlan, VacancyTestSpec } from '$lib/server/assessments/vacancy-spec';
	import { pluralize } from '$lib/components/product/model.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import SpecRequirements from './spec-requirements.svelte';
	import { CLOSED_TEXT, GAP_TEXT, minutes } from './test-spec';

	/**
	 * «Каким будет тест» of a vacancy or a need (domain 13.11): the requirements read from it and how the test covers
	 * each, the base — the test of the category, one for all — and the block tests the vacancy adds, with an example set
	 * of items drawn by the engine's own choice. Blocks and kinds of items only: no condition of any item.
	 */
	let {
		spec,
		skillNames,
		subject = 'вакансии',
		note
	}: { spec: VacancyTestSpec; skillNames: Record<string, string>; subject?: string; note?: string } = $props();

	const skill = (key: string) => skillNames[key] ?? key;
	const items = (n: number) => `${n} ${pluralize(n, ['задание', 'задания', 'заданий'])}`;
	const minutesText = (sec: number) => `${minutes(sec)} мин`;
	const closedPlans = $derived(spec.plans.filter((p): p is ClosedPlan => p.status === 'closed'));
	const openPlans = $derived(spec.plans.filter((p): p is OpenPlan => p.status === 'open'));
	/** Requirements the test of the plan does not confirm; a block test on request is offered, not missing. */
	const untested = (plan: OpenPlan) =>
		plan.requirements.filter((r) => !r.tested && r.coverage.kind !== 'block_on_request');
</script>

<Card.Root data-testid="vacancy-test-spec">
	<Card.Header>
		<Card.Title>
			<h2 class="flex items-center gap-2 font-heading text-h3">
				<ClipboardListIcon class="size-5 text-muted-foreground" aria-hidden="true" />
				Каким будет тест по этой {subject}
			</h2>
		</Card.Title>
		<Card.Description>
			{#if note}<span class="block">{note}</span>{/if}
			Основа — тест категории, общий для всех кандидатов; требования {subject} добавляют блок-тесты своих блоков. Пример набора
			собран тем же правилом выбора, что и настоящая попытка, для кандидата без истории: у каждого кандидата задания свои,
			условия заданий здесь не показываются.
		</Card.Description>
	</Card.Header>
	<Card.Content class="grid gap-6">
		{#each spec.gaps as gap (gap)}
			<p class="text-sm text-muted-foreground" data-testid="spec-gap">{GAP_TEXT[gap]}</p>
		{/each}
		{#if spec.requirements.length > 0}
			<section class="grid gap-2">
				<h3 class="font-medium">Требования {subject}</h3>
				<SpecRequirements list={spec.requirements} />
			</section>
		{/if}

		{#each closedPlans as plan (`${plan.specialization}:${plan.grade}`)}
			<p class="text-sm" data-testid="spec-closed">
				<span class="font-medium">{plan.title}</span>: {CLOSED_TEXT[plan.reason]}.
			</p>
		{/each}

		{#each openPlans as plan (`${plan.specialization}:${plan.grade}`)}
			{@const base = plan.base}
			<section class="grid gap-4 border-t pt-4 first:border-t-0 first:pt-0" data-testid="spec-plan">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h3 class="font-heading text-lg">{base.title}</h3>
					<span class="text-sm text-muted-foreground">
						{base.shortestSlots}–{base.longestSlots} заданий · по нормативам {minutesText(
							base.normShortestSec
						)}–{minutesText(base.normLongestSec)}{#each plan.vacancyBlocks as block (block.block)}
							+ {minutesText(block.normSec)}{/each}
					</span>
				</div>

				<div class="grid gap-2">
					<h4 class="text-sm font-medium">1. Что прочитано из {subject}</h4>
					{#if plan.requirements.length > 0}
						<SpecRequirements list={plan.requirements} />
					{:else}
						<p class="text-sm text-muted-foreground">Навыки не указаны — тест состоит из основы категории.</p>
					{/if}
				</div>

				<div class="grid gap-2">
					<h4 class="text-sm font-medium">2. Основа: тест категории {base.title}</h4>
					<ul class="grid gap-1 text-sm">
						{#each base.blocks as block (block.block)}
							<li class="flex flex-wrap items-baseline gap-x-2">
								<span class="w-6 text-right font-semibold numeric">{block.items}</span>
								<span>{block.title}</span>
								{#if block.defining}<Badge variant="secondary">определяющий</Badge>{/if}
								{#if block.practice}<Badge variant="outline">практика</Badge>{/if}
							</li>
						{/each}
					</ul>
					<p class="text-xs text-muted-foreground">
						Заданий в плане — на самой длинной траектории; тест адаптивный и останавливается, как только решение ясно
						(не раньше
						{items(base.shortestSlots)}). Лимит времени попытки — {minutesText(base.deadlineMs / 1000)}.
					</p>
					<p class="text-sm">
						Подтверждённый стек при успехе: {base.stackSkillKeys.map(skill).join(', ')}{base.practiceLanguageSkillKeys
							.length > 0
							? ` + язык практики на выбор (${base.practiceLanguageSkillKeys.map(skill).join(', ')})`
							: ''}.
					</p>
				</div>

				<div class="grid gap-2">
					<h4 class="text-sm font-medium">3. Блоки {subject}</h4>
					{#each plan.vacancyBlocks as block (block.block)}
						<div class="grid gap-1 rounded-lg border p-3 text-sm" data-testid="spec-vacancy-block">
							<p class="font-medium">
								Блок-тест «{block.title}» · {block.clusters}
								{pluralize(block.clusters, ['кластер', 'кластера', 'кластеров'])}
							</p>
							<p class="text-muted-foreground">{block.checks}</p>
							<p>
								Проверяет: {block.skillKeys.map(skill).join(', ')} · по нормативам {minutesText(block.normSec)}, лимит {minutesText(
									block.deadlineMs / 1000
								)}
							</p>
							<p class="text-muted-foreground">
								Типы: {block.sample.map((s) => s.formatTitle).join('; ')}
							</p>
							{#if !block.servable}
								<p class="text-destructive">Выпуск банка сейчас не обслуживает все кластеры этого блока.</p>
							{/if}
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">
							Блоков сверх основы нет: обязательные навыки либо уже в основе, либо тестом на этом грейде не проверяются.
						</p>
					{/each}
					<p class="text-xs text-muted-foreground">
						Блок-тест — отдельное доказательство: кандидат проходит его добровольно по запросу работодателя, категория
						от исхода не меняется.
					</p>
				</div>

				<details class="grid gap-2">
					<summary class="cursor-pointer text-sm font-medium"
						>4. Пример набора заданий основы ({base.sample.length})</summary
					>
					<ol class="mt-2 grid gap-1 text-sm" data-testid="spec-sample">
						{#each base.sample as slot (slot.position)}
							<li
								class="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-2 {slot.position > base.shortestSlots
									? 'text-muted-foreground'
									: ''}"
							>
								<span class="text-right numeric">{slot.position}</span>
								<span>{slot.blockTitle} — {slot.formatTitle}</span>
								<span class="numeric">{minutesText(slot.timeNormSec)}</span>
							</li>
						{/each}
					</ol>
					<p class="text-xs text-muted-foreground">
						Форма {base.form}. Серым — задания продления: они подаются, только если первых {base.shortestSlots} не хватило
						для решения.{#if base.unserved.length > 0}
							Позиции {base.unserved.join(', ')} выпуск банка сейчас не обслуживает.{/if}
					</p>
				</details>

				<div class="grid gap-1">
					<h4 class="text-sm font-medium">5. Чего тест не проверяет</h4>
					<ul class="list-disc pl-5 text-sm text-muted-foreground">
						{#each untested(plan) as r (`${r.requirement}:${r.skillKey ?? r.name}`)}
							<li>{r.name} — требование {subject}</li>
						{/each}
						{#each base.doesNotCheck as line (line)}
							<li>{line}</li>
						{/each}
					</ul>
				</div>
			</section>
		{/each}
	</Card.Content>
</Card.Root>
