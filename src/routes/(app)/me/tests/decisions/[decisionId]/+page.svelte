<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DemoPolicyNote from '$lib/components/assessments/demo-policy-note.svelte';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import { BLOCK_REASONS, OUTCOMES, points, share } from '$lib/components/assessments/model.js';
	import { OBJECTION_OUTCOMES, OBJECTION_STATUSES } from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { ResponseDeadline } from '$lib/components/product/index.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const decision = $derived(data.decision);
	const explanation = $derived(decision.explanation);
	const outcome = $derived(OUTCOMES[decision.outcome]);
	const available = $derived(decision.next.filter((option) => option.available));
	const problem = $derived(form && 'problem' in form ? form.problem : null);

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
	description="По каждому блоку — заданий, набранный балл и порог: сумма оценок пограничного кандидата по вашим заданиям. Два определяющих блока грейда проверяются отдельно: провал любого из них не даёт подтвердить грейд, а их навыки входят в подтверждённый стек."
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
	{#if data.demoNote}<DemoPolicyNote text={data.demoNote} />{/if}
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
</SectionCard>

<SectionCard
	title="Возражение"
	description="Решение принято автоматически по правилам теста. Не согласны — возразите здесь: возражение рассматривает оператор ФСП, человек, по сохранённым заданиям и ответам попытки и отвечает в течение 30 дней. До ответа решение и категория остаются как есть. Итог — решение оставлено; попытка аннулирована и не засчитывается, тест можно пройти снова сразу; или оценка заданий исправлена и решение пересчитано, а категория приводится к новому решению. Об ответе придёт уведомление."
	testId="decision-objection"
>
	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'objectionOpened' in form}
		<FormMessage tone="success" text="Возражение подано." />
	{:else if form && 'objectionWithdrawn' in form}
		<FormMessage tone="success" text="Возражение отозвано." />
	{/if}
	{#if data.objections.length > 0}
		<ul class="grid gap-2 text-sm">
			{#each data.objections as objection (objection.id)}
				{@const status = OBJECTION_STATUSES[objection.status]}
				<li class="grid gap-2 rounded-md border p-3" data-objection={objection.id} data-status={objection.status}>
					<span class="flex flex-wrap items-center gap-2">
						<StatusPill label={status.label} tone={status.tone} />
						<span class="text-xs text-muted-foreground">подано {formatDate(objection.openedAt)}</span>
						{#if objection.status === 'open' || objection.status === 'in_review'}
							<ResponseDeadline dueAt={objection.dueAt} label="Ответ оператора до" />
						{/if}
					</span>
					<span class="whitespace-pre-line">{objection.reason}</span>
					{#if objection.outcome}
						<span>Итог: {OBJECTION_OUTCOMES[objection.outcome] ?? objection.outcome}.</span>
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
	{#if data.intake.state === 'open'}
		<form method="POST" action="?/object" use:enhance class="grid gap-3" data-testid="objection-form">
			<CsrfInput />
			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">С чем вы не согласны и почему</span>
				<Textarea
					name="reason"
					rows={5}
					maxlength={data.reasonMaxLength}
					required
					value={form && 'reason' in form ? form.reason : ''}
					aria-invalid={problem?.fields.reason ? 'true' : undefined}
				/>
				<span class="text-xs text-muted-foreground">
					Например: какое задание и почему, на ваш взгляд, оценено неверно. Возразить можно до
					{formatDate(data.intake.until)}, пока хранится попытка.
				</span>
			</label>
			<Button type="submit" class="justify-self-start">Подать возражение</Button>
		</form>
	{:else if data.intake.state === 'closed'}
		<p class="text-sm text-muted-foreground">{data.intake.text}.</p>
	{/if}
</SectionCard>

<p class="text-xs text-muted-foreground">
	Выпуск банка {decision.bankReleaseId} · процедура {decision.procedureVersion}
</p>
<HonestNote />
