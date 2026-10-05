<script lang="ts">
	import { resolve } from '$app/paths';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import { BLOCK_REASONS, OUTCOMES, points, share } from '$lib/components/assessments/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const decision = $derived(data.decision);
	const explanation = $derived(decision.explanation);
	const outcome = $derived(OUTCOMES[decision.outcome]);
	const available = $derived(decision.next.filter((option) => option.available));

	const verdictTone: Record<string, string> = {
		'выше порога': 'text-success',
		'ниже порога': 'text-destructive',
		'на уровне порога': 'text-muted-foreground'
	};
</script>

<PageHeader title={explanation.title} description="Тест {decision.title} · {formatDateTime(decision.decidedAt)}">
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/tests')}>Тест на грейд</a>{/snippet}
	{#snippet actions()}
		{#if decision.status === 'annulled'}
			<StatusPill label="Аннулировано" tone="danger" />
		{:else if outcome}
			<StatusPill label={outcome.label} tone={outcome.tone} />
		{/if}
	{/snippet}
</PageHeader>

{#if decision.status === 'annulled'}
	<p class="rounded-xl border border-destructive/40 p-4 text-sm" role="note">
		Решение аннулировано: оно больше не учитывается в профиле и категории.
	</p>
{/if}

<SectionCard title="Почему такой итог" testId="decision-reason">
	<p data-outcome={decision.outcome}>{explanation.reason}</p>
	<p class="text-sm text-muted-foreground">{explanation.summary}</p>
	{#if explanation.confident}
		<p class="rounded-lg border border-success/40 bg-success-subtle p-3 text-sm" data-testid="confident">
			Уверенный результат: тест следующего грейда доступен сразу, в течение 30 дней.
		</p>
	{/if}
	{#if decision.judgementNote}
		<p class="text-sm text-muted-foreground" data-testid="decision-judgement">{decision.judgementNote}</p>
	{/if}
	{#if decision.seeded}<p class="text-sm text-muted-foreground">
			Синтетика: попытка засева демонстрационного стенда.
		</p>{/if}
</SectionCard>

<SectionCard
	title="Блоки"
	description="По каждому блоку — заданий, набранный балл и порог: сумма оценок пограничного кандидата по твоим заданиям. Два определяющих блока грейда проверяются отдельно: провал любого из них не даёт подтвердить грейд, а их навыки входят в подтверждённый стек."
	testId="decision-blocks"
>
	<div class="overflow-x-auto">
		<table class="w-full text-sm">
			<thead class="text-left text-muted-foreground">
				<tr>
					<th class="py-2 pr-4 font-medium">Блок</th>
					<th class="py-2 pr-4 font-medium">Заданий</th>
					<th class="py-2 pr-4 font-medium">Балл</th>
					<th class="py-2 pr-4 font-medium">Порог</th>
					<th class="py-2 pr-4 font-medium">Вердикт</th>
				</tr>
			</thead>
			<tbody>
				{#each explanation.blocks as block (block.code)}
					<tr class="border-t align-top" data-testid="decision-block" data-passed={block.passed}>
						<td class="py-2 pr-4">
							<p class="font-medium">
								{block.title}{block.defining ? (block.passed ? ' · определяющий, пройден' : ' · определяющий') : ''}
							</p>
							<p class="text-xs text-muted-foreground">{block.checks}</p>
						</td>
						<td class="py-2 pr-4 tabular-nums">{block.items}</td>
						<td class="py-2 pr-4 tabular-nums">{points(block.score)}</td>
						<td class="py-2 pr-4 tabular-nums">{points(block.cut)}</td>
						<td class={cn('py-2 pr-4', verdictTone[block.verdict])}>{block.verdict}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</SectionCard>

{#if explanation.practice}
	<SectionCard title="Практика" testId="decision-practice">
		<p>
			{explanation.practice.title}: балл {share(explanation.practice.score)} при пороге {share(
				explanation.practice.gateMinScore
			)} —
			{explanation.practice.passed ? 'ворота практики пройдены' : 'ворота практики не пройдены, тест остановлен'}.
		</p>
	</SectionCard>
{/if}

<SectionCard title="Что тест не проверяет" testId="does-not-check">
	<ul class="grid list-disc gap-1 pl-5 text-sm">
		{#each explanation.doesNotCheck as item (item)}<li>{item}</li>{/each}
	</ul>
</SectionCard>

<SectionCard title="Что дальше" testId="decision-next">
	{#if available.length > 0}
		<p class="text-sm">Можно пройти: {available.map((option) => option.title).join(', ')}.</p>
		<a href={resolve('/me/tests')} class={cn(buttonVariants(), 'w-fit')}>К тестам</a>
	{/if}
	<ul class="grid gap-1 text-sm text-muted-foreground">
		{#each decision.next.filter((option) => !option.available) as option (option.grade)}
			<li>
				{option.title}: {BLOCK_REASONS[option.reason ?? ''] ?? option.reason}
				{#if option.availableFrom}Откроется {formatDate(option.availableFrom)}.{/if}
			</li>
		{/each}
	</ul>
	<p class="text-sm">
		Не согласен с результатом — подай возражение на странице
		<a class="text-link underline underline-offset-4" href={resolve('/me/category')}>«Категория и грейд»</a>: его
		рассмотрит человек в течение 30 дней по сохранённым заданиям и ответам.
	</p>
</SectionCard>

<p class="text-xs text-muted-foreground">
	Выпуск банка {decision.bankReleaseId} · процедура {decision.procedureVersion}
</p>
<HonestNote />
