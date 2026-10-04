<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CoveragePanel from '$lib/components/assessments/coverage-panel.svelte';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import LevelResult from '$lib/components/assessments/level-result.svelte';
	import { ATTEMPT_STATUSES, languageName, RUN_STATES } from '$lib/components/assessments/model.js';
	import SignalsJournal from '$lib/components/assessments/signals-journal.svelte';
	import VerdictList from '$lib/components/assessments/verdict-list.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const attempt = $derived(data.attempt);
	const run = $derived(attempt.code?.run ?? 'none');
	const waiting = $derived(attempt.status === 'submitted' && (run === 'queued' || run === 'running'));

	// While the sandbox works the page asks again every few seconds; it stops as soon as the result is in.
	$effect(() => {
		if (!waiting) return;
		const timer = setInterval(() => void invalidateAll(), 3000);
		return () => {
			clearInterval(timer);
		};
	});

	/** Why the operator of FSP annulled the attempt, in the candidate's words. */
	const ANNUL_REASONS: Record<NonNullable<PageProps['data']['annulment']>['reason'], string> = {
		plagiarism: 'Оператор ФСП установил по коду и ответам, что решение выполнено не самостоятельно.',
		technical_failure: 'Попытка сорвалась из-за технического сбоя на стороне платформы.',
		version_defect: 'В этой версии задания нашлась ошибка — в условии или в тестах.',
		candidate_request: 'Результат снят по твоей просьбе.'
	};

	const optionText = (options: { id: string; text: string }[], id: string) =>
		options.find((option) => option.id === id)?.text ?? id;
</script>

<PageHeader
	title="Попытка: {attempt.title}"
	description="Версия задания {attempt.version} · начата {formatDateTime(attempt.startedAt)}"
>
	{#snippet eyebrow()}
		<a
			class="underline underline-offset-4"
			href={resolve('/(app)/me/tests/[assessmentId]', { assessmentId: attempt.assessmentId })}>К заданию</a
		>
	{/snippet}
	{#snippet actions()}<StatusPill label={ATTEMPT_STATUSES[attempt.status] ?? attempt.status} />{/snippet}
</PageHeader>

{#if data.annulment}
	<div class="grid gap-1 rounded-xl border border-destructive/40 p-4 text-sm" role="note" data-testid="annulment">
		<p class="font-medium">Попытка аннулирована {formatDateTime(data.annulment.annulledAt)}</p>
		<p data-reason={data.annulment.reason}>{ANNUL_REASONS[data.annulment.reason]}</p>
		<p class="text-muted-foreground">
			Её результат больше не учитывается в профиле.
			{data.annulment.countsTowardLimit
				? 'Попытка засчитывается в лимит попыток теста.'
				: 'Попытка не засчитывается в лимит — тест можно пройти снова.'}
		</p>
	</div>
{/if}

{#if attempt.score}
	<LevelResult
		score={attempt.score}
		title={attempt.title}
		version={attempt.version}
		kind={attempt.kind}
		skills={data.skills}
	/>
	<HonestNote kind={attempt.kind} />
{:else if attempt.status === 'submitted'}
	<p class="flex items-center gap-2 rounded-xl border p-4 text-sm" role="status" data-testid="run-state" data-run={run}>
		{#if waiting}<LoaderIcon class="size-4 animate-spin text-muted-foreground" aria-hidden="true" />{/if}
		{RUN_STATES[run]}
	</p>
{:else if attempt.status === 'expired'}
	<p class="rounded-xl border p-4 text-sm">Время попытки истекло до отправки ответа — она не оценивается.</p>
{:else if attempt.status === 'started'}
	<p class="rounded-xl border p-4 text-sm">
		Попытка идёт до {formatDateTime(attempt.deadlineAt)}.
		<a
			class="text-link underline underline-offset-4"
			href={resolve('/(app)/me/tests/[assessmentId]', { assessmentId: attempt.assessmentId })}>Продолжить</a
		>
	</p>
{/if}

{#if attempt.cleared}
	<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
		Срок хранения артефактов этой попытки истёк: код, ответы и вывод удалены. Оценка и контрольные суммы артефактов
		остаются.
	</p>
{/if}

{#if attempt.code}
	{#if attempt.code.submission}
		<SectionCard
			title="Отправленное решение"
			description={languageName(attempt.code.submission.language)}
			testId="submission"
		>
			<pre
				class="rounded-lg bg-muted p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap [tab-size:4]">{attempt
					.code.submission.source}</pre>
		</SectionCard>
	{/if}
	{#if attempt.code.compile && attempt.code.compile.status !== 'ok'}
		<SectionCard title="Компиляция" testId="compile">
			<p class="text-sm text-destructive">Решение не скомпилировалось, тесты не запускались.</p>
			<pre class="rounded-lg bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">{attempt.code.compile
					.stderr || 'Компилятор не вывел сообщений.'}</pre>
		</SectionCard>
	{/if}
	{#if attempt.code.tests.length > 0}
		<SectionCard title="Результаты тестов" testId="test-results">
			<VerdictList tests={attempt.code.tests} />
		</SectionCard>
	{/if}
{/if}

{#if attempt.quiz}
	<SectionCard
		title="Ответы"
		description="Вопросы в том порядке, в каком их подобрал квиз, с разбором."
		testId="quiz-answers"
	>
		<ol class="grid gap-4">
			{#each attempt.quiz as step, index (step.itemId)}
				<li class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="quiz-step" data-correct={step.correct}>
					<p class="flex items-start gap-2 font-medium">
						{#if step.correct}
							<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-label="Верно" />
						{:else}
							<CircleXIcon class="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Неверно" />
						{/if}
						<span>{index + 1}. {step.prompt}</span>
					</p>
					{#if step.code}
						<pre class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{step.code}</pre>
					{/if}
					<p class={cn(!step.correct && 'text-destructive')}>Твой ответ: {optionText(step.options, step.answer)}</p>
					{#if !step.correct}<p>Верный ответ: {optionText(step.options, step.correctOption)}</p>{/if}
					<p class="text-muted-foreground">{step.explanation}</p>
				</li>
			{/each}
		</ol>
	</SectionCard>
{/if}

<details class="rounded-xl border p-4 text-sm">
	<summary class="cursor-pointer font-medium">Покрытие задания</summary>
	<CoveragePanel coverage={attempt.coverage} skills={data.skills} class="mt-3" />
</details>

<SignalsJournal entries={attempt.signals.entries} />
