<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { ATTEMPT_STATUSES, languageName, levelName, verdictOf } from '$lib/components/assessments/model.js';
	import SignalsJournal from '$lib/components/assessments/signals-journal.svelte';
	import StatementView from '$lib/components/assessments/statement-view.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const a = $derived(data.attempt);
	const annullable = $derived(a.status === 'submitted' || a.status === 'scored');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];

	const REASONS: Record<string, { label: string; hint: string }> = {
		plagiarism: {
			label: 'Заимствование',
			hint: 'Решение не самостоятельное: установлено человеком по артефактам, не по сигналам одним.'
		},
		technical_failure: {
			label: 'Технический сбой',
			hint: 'Попытка сорвалась по вине платформы; не входит в лимит попыток кандидата.'
		},
		version_defect: {
			label: 'Дефект версии задания',
			hint: 'Ошибка в условии или тестах; не входит в лимит попыток кандидата.'
		},
		candidate_request: { label: 'Просьба кандидата', hint: 'Кандидат попросил снять результат.' }
	};
	const FACT_STATUSES: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
		active: { label: 'в профиле', tone: 'success' },
		superseded: { label: 'заменён новой оценкой', tone: 'neutral' },
		withdrawn: { label: 'изъят', tone: 'neutral' },
		annulled: { label: 'аннулирован', tone: 'danger' }
	};
	const DONE: Record<string, string> = {
		annulled:
			'Попытка аннулирована: её факты сняты с профиля, квитанции отвечают «аннулировано», категория пересчитывается.',
		already: 'Попытка уже была аннулирована — ничего не изменилось.'
	};
	const toneClass = { success: 'text-success', error: 'text-destructive', muted: 'text-muted-foreground' };
	const optionText = (options: { id: string; text: string }[], id: string) =>
		options.find((option) => option.id === id)?.text ?? id;
</script>

<PageHeader
	title="Попытка: {data.version.title}"
	description="Версия {data.version.version} · начата {formatDateTime(a.startedAt)}{a.submittedAt
		? ` · отправлена ${formatDateTime(a.submittedAt)}`
		: ''}"
>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/assessments')}>Попытки тестов</a>
	{/snippet}
	{#snippet actions()}
		<StatusPill label={ATTEMPT_STATUSES[a.status] ?? a.status} tone={a.status === 'annulled' ? 'danger' : 'neutral'} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.done && DONE[data.done]}
	<FormProblem tone="success" text={DONE[data.done] ?? ''} />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" data-attempt={a.id} data-status={a.status}>
	<div class="grid min-w-0 content-start gap-6">
		{#if data.cleared}
			<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
				Срок хранения части артефактов истёк: их содержимое удалено, контрольные суммы и оценки остаются.
			</p>
		{/if}

		{#if data.version.statement}
			<Card.Root>
				<Card.Header><Card.Title><h2 class="font-heading text-h3">Условие</h2></Card.Title></Card.Header>
				<Card.Content>
					<StatementView blocks={data.version.statement} />
				</Card.Content>
			</Card.Root>
		{/if}

		{#if data.code}
			<Card.Root data-testid="review-submission">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
					{#if data.code.submission}<Card.Description>{languageName(data.code.submission.language)}</Card.Description
						>{/if}
				</Card.Header>
				<Card.Content>
					{#if data.code.submission}
						<pre
							class="rounded-lg bg-muted p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap [tab-size:4]">{data
								.code.submission.source}</pre>
					{:else}
						<p class="text-sm text-muted-foreground">Код недоступен.</p>
					{/if}
					{#if data.code.compile}
						<p class="mt-3 text-sm">Компиляция: {data.code.compile.status}</p>
						{#if data.code.compile.stderr}<pre
								class="rounded-lg bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">{data.code.compile
									.stderr}</pre>{/if}
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Прогоны</h2></Card.Title>
					<Card.Description
						>Все тесты версии с их данными, скрытые тоже; вывод программы на скрытых тестах хранится только хэшем.</Card.Description
					>
				</Card.Header>
				<Card.Content>
					{#if data.code.tests.length === 0}
						<p class="text-sm text-muted-foreground">Результатов прогона нет.</p>
					{:else}
						<ul class="grid gap-3" data-testid="review-tests">
							{#each data.code.tests as test (test.id)}
								{@const verdict = verdictOf(test.verdict)}
								<li class="grid gap-2 rounded-lg border p-3 text-sm" data-verdict={test.verdict}>
									<div class="flex flex-wrap items-center justify-between gap-2">
										<span class="font-medium">{test.hidden ? 'Скрытый' : 'Открытый'} тест {test.id}</span>
										<span class={cn('font-medium', toneClass[verdict.tone])}>{verdict.label}</span>
									</div>
									<p class="text-xs text-muted-foreground">
										{test.skipped
											? 'Не запускался'
											: `${test.cpuTimeMs} мс процессора · ${test.wallTimeMs} мс всего · ${Math.round(test.memoryKb / 1024)} МБ`}{test.exitCode !==
										null
											? ` · код выхода ${test.exitCode}`
											: ''}
									</p>
									<div class="grid gap-2 md:grid-cols-3">
										{#each [['Вход', test.stdin], ['Ожидалось', test.expected], ['Вывод (начало)', test.stdoutPreview ?? (test.stdoutSha256 ? `sha256 ${test.stdoutSha256}` : null)]] as [label, text] (label)}
											<div class="grid min-w-0 content-start gap-1">
												<span class="text-xs text-muted-foreground">{label}</span>
												<pre class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{text ??
														'—'}</pre>
											</div>
										{/each}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if data.quiz}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Ответы квиза</h2></Card.Title>
					<Card.Description>В порядке подбора, с оценкой способности после каждого ответа.</Card.Description>
				</Card.Header>
				<Card.Content>
					<ol class="grid gap-3" data-testid="review-quiz">
						{#each data.quiz as step, index (step.itemId)}
							<li class="grid gap-1 rounded-lg border p-3 text-sm" data-correct={step.correct}>
								<p class="font-medium">
									{index + 1}. {step.prompt} <span class="text-xs text-muted-foreground">(v{step.itemVersion})</span>
								</p>
								{#if step.code}<pre
										class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{step.code}</pre>{/if}
								<p class={cn(!step.correct && 'text-destructive')}>Ответ: {optionText(step.options, step.answer)}</p>
								{#if !step.correct}<p>Верный: {optionText(step.options, step.correctOption)}</p>{/if}
								<p class="text-xs text-muted-foreground">
									Способность после ответа {step.ability.toFixed(2)} ± {step.standardError.toFixed(2)}
								</p>
							</li>
						{/each}
					</ol>
				</Card.Content>
			</Card.Root>
		{/if}

		<SignalsJournal entries={data.signals} />
	</div>

	<div class="grid min-w-0 content-start gap-6">
		<Card.Root>
			<Card.Header><Card.Title><h2 class="font-heading text-h3">Оценки</h2></Card.Title></Card.Header>
			<Card.Content>
				{#if data.scores.length === 0}
					<p class="text-sm text-muted-foreground">Оценки нет.</p>
				{:else}
					<ul class="grid gap-2 text-sm" data-testid="review-scores">
						{#each data.scores as score (score.id)}
							<li class={cn(!score.current && 'text-muted-foreground')}>
								{levelName(score.level)} · {score.score} из {score.maxScore}
								<span class="block text-xs"
									>{score.scoredBy === 'automatic' ? 'автоматически' : 'пересмотр'} · {score.scorerVersion} · {formatDateTime(
										score.createdAt
									)}{score.current ? '' : ' · заменена'}</span
								>
							</li>
						{/each}
					</ul>
				{/if}
				<p class="mt-3 text-xs text-muted-foreground">
					Версия задания {data.version.version} ({data.version.status}), хэш содержимого {data.version.contentSha256.slice(
						0,
						12
					)}…
				</p>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">В профиле</h2></Card.Title>
				<Card.Description>Факты «подтверждено платформой», в которые перешли оценки попытки.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if data.facts.length === 0}
					<p class="text-sm text-muted-foreground">
						Попытка не стала фактом профиля: уровень версии не достигнут или оценки нет.
					</p>
				{:else}
					<ul class="grid gap-2 text-sm" data-testid="review-facts">
						{#each data.facts as fact (fact.id)}
							{@const status = FACT_STATUSES[fact.status]}
							<li data-fact-status={fact.status}>
								<StatusPill label={status?.label ?? fact.status} tone={status?.tone ?? 'neutral'} />
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Аннулирование</h2></Card.Title>
				<Card.Description>
					Факты попытки уходят из профиля, квитанции по ним отвечают «аннулировано», категория пересчитывается.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if a.status === 'annulled'}
					<p class="text-sm" data-testid="annulled-info">
						Аннулирована {a.annulledAt ? formatDateTime(a.annulledAt) : ''}: {REASONS[a.annulReason ?? '']?.label ??
							a.annulReason}.
					</p>
				{:else if !annullable}
					<p class="text-sm text-muted-foreground">Аннулировать можно только отправленную попытку.</p>
				{:else}
					<form method="POST" action="?/annul" use:enhance class="grid gap-4" data-testid="annul-form">
						<CsrfInput />
						<Field.Field data-invalid={fieldError('reason') !== undefined}>
							<Field.Label for="annul-reason">Причина</Field.Label>
							<NativeSelect id="annul-reason" name="reason" required>
								<option value="">Выберите причину</option>
								{#each data.reasons as reason (reason)}
									<option value={reason}>{REASONS[reason]?.label ?? reason}</option>
								{/each}
							</NativeSelect>
							<Field.Description>
								{#each data.reasons as reason (reason)}
									<span class="block">{REASONS[reason]?.label}: {REASONS[reason]?.hint}</span>
								{/each}
							</Field.Description>
							{#if fieldError('reason')}<Field.Error>{fieldError('reason')}</Field.Error>{/if}
						</Field.Field>
						<div><Button type="submit" variant="destructive">Аннулировать попытку</Button></div>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
