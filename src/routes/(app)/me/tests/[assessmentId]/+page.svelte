<script lang="ts">
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SendIcon from '@lucide/svelte/icons/send';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CodeEditor from '$lib/components/assessments/code-editor.svelte';
	import CoveragePanel from '$lib/components/assessments/coverage-panel.svelte';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import {
		ATTEMPT_STATUSES,
		languageName,
		levelName,
		SIGNALS_NOTE,
		STARTERS
	} from '$lib/components/assessments/model.js';
	import { AttemptSignals } from '$lib/components/assessments/signals.svelte.js';
	import StatementView from '$lib/components/assessments/statement-view.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime, pluralize } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const detail = $derived(data.detail);
	const entry = $derived(detail.entry);
	const active = $derived(detail.active);
	const problem = $derived(form && 'problem' in form ? form.problem : null);

	const signals = new AttemptSignals();
	$effect(() => signals.watchPage());

	// The editor starts from a template of the chosen language and keeps what the candidate typed.
	const codeLanguages = $derived(active?.kind === 'code_task' ? active.languages : []);
	let language = $state('');
	let source = $state('');
	$effect.pre(() => {
		const first = codeLanguages[0];
		if (first && !codeLanguages.includes(language)) {
			language = first;
			source = STARTERS[first] ?? '';
		}
	});

	function changeLanguage(next: string) {
		// A template the candidate has not touched follows the language; their own code stays.
		if (Object.values(STARTERS).includes(source)) source = STARTERS[next] ?? '';
		language = next;
	}

	let selected = $state('');
	const questionId = $derived(active?.kind === 'quiz' ? active.question.id : null);
	$effect.pre(() => {
		if (questionId !== null) {
			selected = '';
			signals.reset();
		}
	});

	const withSignals: SubmitFunction = ({ formData }) => {
		formData.set('signals', signals.serialize());
		return async ({ update }) => {
			await update({ reset: false });
		};
	};
</script>

<PageHeader title={entry.title} description={entry.summary}>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/tests')}>Тесты платформы</a>{/snippet}
	{#snippet actions()}
		{#if entry.level}<StatusPill label={levelName(entry.level)} tone="info" />{/if}
		<StatusPill label="Версия {entry.version}" />
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{/if}

<HonestNote kind={entry.kind} />

{#if active === null}
	<SectionCard
		title="Перед началом"
		description="Прочитай, что проверяет задание и на каких условиях идёт попытка."
		testId="before-start"
	>
		<CoveragePanel coverage={entry.coverage} skills={data.skills} />
		<ul class="grid list-disc gap-1 pl-5 text-sm">
			<li>
				На попытку — {entry.timeLimitMinutes}
				{pluralize(entry.timeLimitMinutes, ['минута', 'минуты', 'минут'])}. Отсчёт начинается сразу после старта.
			</li>
			{#if entry.kind === 'code_task'}
				<li>
					Решение отправляется один раз и проверяется на всех тестах; до отправки его можно проверить у себя на открытых
					примерах.
				</li>
				<li>
					Языки: {entry.languages.map(languageName).join(', ')}. Ввод — стандартный поток, вывод — стандартный поток.
				</li>
			{:else}
				<li>Вопросов — до {entry.maxQuestions}; следующий подбирается по твоим ответам. Вернуться к вопросу нельзя.</li>
			{/if}
			<li>Попыток: использовано {entry.allowance.used} из {entry.allowance.max}. Засчитывается лучшая.</li>
			<li>{SIGNALS_NOTE}</li>
			<li>
				Код, ответы и результаты прогонов хранятся {detail.retentionDays}
				{pluralize(detail.retentionDays, ['день', 'дня', 'дней'])}, затем удаляются; оценка остаётся.
			</li>
		</ul>
		{#if entry.allowance.blocked === null}
			<form method="POST" action="?/start" use:enhance>
				<CsrfInput />
				<Button type="submit"><PlayIcon aria-hidden="true" />Начать попытку</Button>
			</form>
		{:else if entry.allowance.blocked === 'retake_interval' && entry.allowance.nextAt}
			<p class="text-sm" data-testid="start-blocked">
				Следующая попытка откроется {formatDateTime(entry.allowance.nextAt)}.
			</p>
		{:else if entry.allowance.blocked === 'attempts_exhausted'}
			<p class="text-sm" data-testid="start-blocked">Попытки этого задания закончились.</p>
		{/if}
	</SectionCard>
{/if}

{#if detail.statement}
	<SectionCard title="Условие" testId="task-statement">
		<StatementView blocks={detail.statement} />
		{#if detail.openTests.length > 0}
			<div class="grid gap-3">
				<p class="text-sm font-medium">
					Открытые примеры — их и увидишь в результатах вместе с выводом своей программы
				</p>
				{#each detail.openTests as test (test.id)}
					<div class="grid gap-2 md:grid-cols-2">
						<div class="grid min-w-0 gap-1">
							<span class="text-xs text-muted-foreground">Пример {test.id}: вход</span>
							<pre class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{test.stdin}</pre>
						</div>
						<div class="grid min-w-0 gap-1">
							<span class="text-xs text-muted-foreground">Ожидаемый вывод</span>
							<pre class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{test.expected}</pre>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</SectionCard>
{/if}

{#if active?.kind === 'code_task'}
	<SectionCard
		title="Решение"
		description="Попытка идёт до {formatDateTime(active.deadlineAt)}. Отправить можно один раз."
		testId="solution"
	>
		<form method="POST" action="?/submit" use:enhance={withSignals} class="grid gap-3">
			<CsrfInput />
			<input type="hidden" name="attemptId" value={active.attemptId} />
			<label class="grid max-w-sm gap-1 text-sm">
				<span class="font-medium">Язык</span>
				<select
					name="language"
					value={language}
					onchange={(event) => {
						changeLanguage(event.currentTarget.value);
					}}
					class="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
				>
					{#each active.languages as key (key)}
						<option value={key}>{languageName(key)}</option>
					{/each}
				</select>
			</label>
			<div class="grid gap-1">
				<label for="source" class="text-sm font-medium">Код</label>
				<CodeEditor id="source" bind:value={source} {signals} describedBy="source-hint" />
				<p id="source-hint" class="text-xs text-muted-foreground">
					Tab вставляет отступ. Программа читает стандартный ввод и пишет ответ в стандартный вывод; сеть и файлы
					недоступны.
				</p>
			</div>
			<Button type="submit" class="justify-self-start"><SendIcon aria-hidden="true" />Отправить на проверку</Button>
		</form>
	</SectionCard>
{:else if active?.kind === 'quiz'}
	{@const question = active.question}
	<SectionCard
		title="Вопрос {question.answered + 1}"
		description="Не больше {question.maxQuestions} вопросов · попытка идёт до {formatDateTime(active.deadlineAt)}"
		testId="quiz-question"
	>
		<form method="POST" action="?/answer" use:enhance={withSignals} class="grid gap-4">
			<CsrfInput />
			<input type="hidden" name="attemptId" value={active.attemptId} />
			<input type="hidden" name="itemId" value={question.id} />
			<fieldset class="grid gap-3">
				<legend class="mb-2 text-base font-medium">{question.prompt}</legend>
				{#if question.code}
					<pre
						class="rounded-lg bg-muted p-3 font-mono text-xs leading-snug break-words whitespace-pre-wrap"
						data-testid="question-code">{question.code}</pre>
				{/if}
				{#each question.options as option (option.id)}
					<label
						class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-muted"
					>
						<input
							type="radio"
							name="option"
							value={option.id}
							bind:group={selected}
							required
							class="mt-0.5 size-4 accent-primary"
						/>
						<span>{option.text}</span>
					</label>
				{/each}
			</fieldset>
			<Button type="submit" class="justify-self-start">Ответить</Button>
		</form>
	</SectionCard>
{:else if active?.kind === 'pending'}
	<SectionCard title="Попытка на проверке" testId="pending">
		<p class="flex items-center gap-2 text-sm">
			<HourglassIcon class="size-4 text-muted-foreground" aria-hidden="true" />
			Решение отправлено и ждёт проверки в песочнице.
			<a
				class="text-link underline underline-offset-4"
				href={resolve('/(app)/me/tests/attempts/[attemptId]', { attemptId: active.attemptId })}>Статус и результаты</a
			>
		</p>
	</SectionCard>
{/if}

{#if active !== null}
	<details class="rounded-xl border p-4 text-sm">
		<summary class="cursor-pointer font-medium">Что проверяет задание</summary>
		<CoveragePanel coverage={entry.coverage} skills={data.skills} class="mt-3" />
	</details>
{/if}

<SectionCard title="Твои попытки" testId="attempt-history">
	{#if detail.attempts.length === 0}
		<p class="text-sm text-muted-foreground">Попыток ещё не было.</p>
	{:else}
		<ul class="grid gap-2">
			{#each [...detail.attempts].reverse() as attempt (attempt.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
					<a
						class="text-link underline underline-offset-4"
						href={resolve('/(app)/me/tests/attempts/[attemptId]', { attemptId: attempt.id })}
						>Попытка от {formatDateTime(attempt.startedAt)} · версия {attempt.version}</a
					>
					<span class="flex items-center gap-2">
						<StatusPill label={ATTEMPT_STATUSES[attempt.status] ?? attempt.status} />
						{#if attempt.score}
							<StatusPill
								label={levelName(attempt.score.level)}
								tone={attempt.score.confirmed ? 'success' : 'neutral'}
							/>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>
