<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { ANNUL_REASONS, ATTEMPT_STATUSES, points } from '$lib/components/assessments/model.js';
	import SignalsJournal from '$lib/components/assessments/signals-journal.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const attempt = $derived(data.attempt);
	const status = $derived(ATTEMPT_STATUSES[attempt.status]);
	const json = (value: unknown) => JSON.stringify(value, null, 2);
</script>

<PageHeader
	title="Попытка: {attempt.title}"
	description="Форма {attempt.form} · выпуск {attempt.bankReleaseId} · процедура {attempt.procedureVersion} · начата {formatDateTime(
		attempt.startedAt
	)}{attempt.seeded ? ' · синтетика засева' : ''}"
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/operator/assessments')}>Попытки тестов</a
		>{/snippet}
	{#snippet actions()}{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}{/snippet}
</PageHeader>

{#if data.done === 'annulled'}<FormMessage tone="success" text="Попытка аннулирована" />{/if}
{#if data.done === 'already'}<FormMessage tone="success" text="Попытка уже была аннулирована" />{/if}
{#if form?.problem}<FormMessage text={form.problem.message} />{/if}
{#if data.cleared}
	<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
		Срок хранения части артефактов истёк: их содержимое удалено, хэши и баллы остаются.
	</p>
{/if}

{#each data.decisions as decision (decision.id)}
	<Card.Root data-testid="review-decision" data-status={decision.status}>
		<Card.Header>
			<Card.Title>{decision.explanation.title}{decision.status === 'annulled' ? ' (аннулировано)' : ''}</Card.Title>
			<Card.Description>{formatDateTime(decision.decidedAt)} · LLR {points(decision.llr)}</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-2 text-sm">
			<p>{decision.explanation.reason}</p>
			<p class="text-muted-foreground">{decision.explanation.summary}</p>
			<ul class="grid gap-1">
				{#each decision.explanation.blocks as block (block.code)}
					<li>
						{block.title}: {block.items} заданий, балл {points(block.score)} при пороге {points(block.cut)} — {block.verdict}{block.passed
							? ', подтверждён'
							: ''}
					</li>
				{/each}
			</ul>
			{#if decision.explanation.practice}
				<p>
					Практика: {points(decision.explanation.practice.score)}, ворота {points(
						decision.explanation.practice.gateMinScore
					)} — {decision.explanation.practice.passed ? 'пройдены' : 'не пройдены'}
				</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/each}

<Card.Root>
	<Card.Header>
		<Card.Title>Кластеры</Card.Title>
		<Card.Description
			>Экземпляры целиком: условие, ключ, скрытые тесты и мутанты; ответы и прогоны кандидата.</Card.Description
		>
	</Card.Header>
	<Card.Content>
		<ol class="grid gap-3">
			{#each data.items as item (item.seq)}
				<li class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="review-item">
					<p class="font-medium">
						{item.seq}. {item.block} · {item.format} · {item.family}, класс {item.classId} · Angoff {points(
							item.angoff
						)} ·
						{item.score === null ? item.status : `балл ${points(item.score)}`}
					</p>
					<details>
						<summary class="cursor-pointer text-muted-foreground">Экземпляр</summary>
						<pre class="mt-2 max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-xs">{json(item.instance)}</pre>
					</details>
					{#if item.scoreDetail}
						<details>
							<summary class="cursor-pointer text-muted-foreground">Разбор балла</summary>
							<pre class="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-xs">{json(item.scoreDetail)}</pre>
						</details>
					{/if}
					{#if item.artifacts.length > 0}
						<details>
							<summary class="cursor-pointer text-muted-foreground">Артефакты ({item.artifacts.length})</summary>
							<ul class="mt-2 grid gap-2">
								{#each item.artifacts as artifact (artifact.seq)}
									<li>
										<p class="text-xs text-muted-foreground">
											#{artifact.seq}
											{artifact.kind} · {formatDateTime(artifact.createdAt)}
										</p>
										<pre class="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs">{artifact.content ===
											null
												? 'содержимое удалено по сроку хранения'
												: json(artifact.content)}</pre>
									</li>
								{/each}
							</ul>
						</details>
					{/if}
				</li>
			{/each}
		</ol>
	</Card.Content>
</Card.Root>

<SignalsJournal entries={data.signals} />

{#if attempt.status !== 'annulled'}
	<Card.Root>
		<Card.Header>
			<Card.Title>Аннулировать попытку</Card.Title>
			<Card.Description>
				Решение и факт теста станут аннулированными, категория, назначенная решением, будет отозвана. Идущую попытку
				можно аннулировать, только если её практика ждёт песочницу дольше 30 минут. Технический сбой и дефект версии не
				засчитываются в попытки кандидата.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/annul" use:enhance class="grid gap-3">
				<CsrfInput />
				<fieldset class="grid gap-2">
					<legend class="text-sm font-medium">Причина</legend>
					{#each data.reasons as reason (reason)}
						<label class="flex items-start gap-2 text-sm">
							<input type="radio" name="reason" value={reason} class="mt-1" />
							<span>{ANNUL_REASONS[reason]}</span>
						</label>
					{/each}
				</fieldset>
				<Button type="submit" variant="destructive" class="w-fit">Аннулировать</Button>
			</form>
		</Card.Content>
	</Card.Root>
{:else if attempt.status === 'annulled' && attempt.annulReason}
	<p class="rounded-xl border border-destructive/40 p-4 text-sm">
		Аннулирована {attempt.annulledAt ? formatDateTime(attempt.annulledAt) : ''}: {ANNUL_REASONS[attempt.annulReason]}
	</p>
{/if}
