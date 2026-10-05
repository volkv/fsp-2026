<script lang="ts">
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import {
		ATTEMPT_STATUSES,
		BLOCK_REASONS,
		HOW_IT_DECIDES,
		OPTION_KINDS,
		OUTCOMES
	} from '$lib/components/assessments/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<PageHeader
	title="Тест на грейд"
	description="Категорию — специализацию и грейд — назначает только тест. Каждому кандидату достаются свои варианты заданий: ответ считается кодом, практика проверяется в изолированной песочнице."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/category')}>Категория и грейд</a
		>{/snippet}
	{#snippet actions()}
		<a href={resolve('/me/confirmations')} class={buttonVariants({ variant: 'outline' })}>Запросы подтверждения</a>
	{/snippet}
</PageHeader>

<p class="max-w-3xl text-sm text-muted-foreground">{HOW_IT_DECIDES}</p>
<HonestNote />

{#if form?.problem}<FormMessage text={form.problem.message} />{/if}

{#if data.activeAttemptId}
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/30 bg-info-subtle p-4">
		<p class="text-sm">У тебя идёт попытка теста. Новую можно начать, когда эта закончится.</p>
		<a
			href={resolve('/(app)/me/tests/attempts/[attemptId]', { attemptId: data.activeAttemptId })}
			class={buttonVariants()}
		>
			<PlayIcon aria-hidden="true" />Продолжить
		</a>
	</div>
{/if}

{#if data.specializations.length === 0}
	<Empty.Root class="border p-8">
		<Empty.Header>
			<Empty.Media variant="icon"><ClipboardCheckIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Тест пока не выпущен ни для одной специализации</Empty.Title>
			<Empty.Description>Специализация открывается, когда выпущен и проверен банк её заданий.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	{#each data.specializations as specialization (specialization.key)}
		<SectionCard
			title={specialization.title}
			description="Грейды, которые можно пройти сейчас, и почему остальные закрыты."
			testId="specialization-{specialization.key}"
		>
			<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each specialization.options as option (option.grade)}
					<li
						class="grid content-between gap-3 rounded-lg border p-4"
						data-testid="grade-option"
						data-grade={option.grade}
						data-available={option.available}
					>
						<div class="grid gap-1">
							<p class="font-heading text-lg">{option.title}</p>
							{#if option.available}
								<p class="text-sm text-muted-foreground">{OPTION_KINDS[option.kind ?? ''] ?? ''}</p>
							{:else}
								<p class="text-sm text-muted-foreground" data-reason={option.reason}>
									{BLOCK_REASONS[option.reason ?? ''] ?? option.reason}
									{#if option.availableFrom}Откроется {formatDate(option.availableFrom)}.{/if}
								</p>
							{/if}
						</div>
						{#if option.available}
							<form method="POST" action="?/start" use:enhance>
								<CsrfInput />
								<input type="hidden" name="specialization" value={specialization.key} />
								<input type="hidden" name="grade" value={option.grade} />
								<Button type="submit" class="w-full">Начать тест</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		</SectionCard>
	{/each}
{/if}

<SectionCard title="Попытки" description="Все твои попытки и решения, новые сверху." testId="attempts">
	{#if data.attempts.length === 0}
		<p class="text-sm text-muted-foreground">Попыток пока нет.</p>
	{:else}
		<ul class="grid gap-2">
			{#each data.attempts as attempt (attempt.id)}
				{@const status = ATTEMPT_STATUSES[attempt.status]}
				<li
					class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
					data-testid="attempt"
				>
					<div class="grid gap-0.5">
						<a
							class="font-medium text-link underline-offset-4 hover:underline"
							href={resolve('/(app)/me/tests/attempts/[attemptId]', { attemptId: attempt.id })}>{attempt.title}</a
						>
						<span class="text-muted-foreground">
							Форма {attempt.form} · начата {formatDateTime(attempt.startedAt)}{attempt.seeded ? ' · синтетика' : ''}
						</span>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
						{#if attempt.decision}
							{@const outcome = OUTCOMES[attempt.decision.outcome]}
							<a href={resolve('/(app)/me/tests/decisions/[decisionId]', { decisionId: attempt.decision.id })}>
								<StatusPill
									label={`${outcome?.label ?? attempt.decision.outcome}${attempt.decision.status === 'annulled' ? ' (аннулировано)' : ''}`}
									tone={attempt.decision.status === 'annulled' ? 'neutral' : (outcome?.tone ?? 'neutral')}
								/>
							</a>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>
