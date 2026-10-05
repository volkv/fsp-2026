<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HonestNote from '$lib/components/assessments/honest-note.svelte';
	import ItemAnswer from '$lib/components/assessments/item-answer.svelte';
	import { ANNUL_REASONS, ATTEMPT_STATUSES, languageName } from '$lib/components/assessments/model.js';
	import SignalsJournal from '$lib/components/assessments/signals-journal.svelte';
	import { AttemptSignals } from '$lib/components/assessments/signals.svelte.js';
	import StatementView from '$lib/components/assessments/statement-view.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const attempt = $derived(data.attempt);
	const status = $derived(ATTEMPT_STATUSES[attempt.status]);
	const current = $derived(attempt.items.find((item) => item.seq === attempt.current) ?? null);
	const answered = $derived(attempt.items.filter((item) => item.seq !== attempt.current).reverse());
	const signals = new AttemptSignals();

	// While the sandbox scores a practice the page asks again every few seconds; it stops once nothing waits.
	$effect(() => {
		if (!attempt.waitingSandbox) return;
		const timer = setInterval(() => void invalidateAll(), 3000);
		return () => {
			clearInterval(timer);
		};
	});

	const ITEM_STATUSES: Record<string, string> = {
		served: 'ждёт ответа',
		answered: 'задача проверена, открыт шаг «измени своё решение»',
		awaiting_sandbox: 'проверяется в песочнице',
		scored: 'оценено'
	};

	const answerText = (content: Record<string, unknown> | null): string | null => {
		if (content === null) return null;
		if (typeof content.answer === 'string') return content.answer;
		if (Array.isArray(content.answer)) return content.answer.join('\n');
		if (typeof content.source === 'string') return content.source;
		if (Array.isArray(content.cases)) {
			return (content.cases as { input: string; expected: string }[])
				.map((c, i) => `${i + 1}. ${c.input} → ${c.expected}`)
				.join('\n');
		}
		return null;
	};
</script>

<PageHeader
	title="Тест {attempt.title}"
	description="Форма {attempt.form} · начата {formatDateTime(attempt.startedAt)}"
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/tests')}>Тест на грейд</a>{/snippet}
	{#snippet actions()}{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}{/snippet}
</PageHeader>

{#if data.annulment}
	<div class="grid gap-1 rounded-xl border border-destructive/40 p-4 text-sm" role="note" data-testid="annulment">
		<p class="font-medium">Попытка аннулирована {formatDateTime(data.annulment.annulledAt)}</p>
		<p data-reason={data.annulment.reason}>{ANNUL_REASONS[data.annulment.reason]}</p>
		<p class="text-muted-foreground">
			Её результат больше не учитывается в профиле.
			{data.annulment.countsAsAttempt
				? 'Попытка засчитывается в число попыток по правилам грейда.'
				: 'Попытка не засчитывается — тест можно пройти снова сразу.'}
		</p>
	</div>
{/if}

{#if attempt.decision && attempt.decision.status === 'valid'}
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4" data-testid="decided">
		<p class="flex items-center gap-2 text-sm">
			<CircleCheckIcon class="size-4 text-success" aria-hidden="true" />Решение о грейде принято.
		</p>
		<a
			href={resolve('/(app)/me/tests/decisions/[decisionId]', { decisionId: attempt.decision.id })}
			class={buttonVariants()}>Открыть результат</a
		>
	</div>
{:else if attempt.purpose === 'vacancy_block' && attempt.status === 'decided'}
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4" data-testid="block-decided">
		<p class="flex items-center gap-2 text-sm">
			<CircleCheckIcon class="size-4 text-success" aria-hidden="true" />Блок-тест завершён: результат передан компании
			запроса. Категория не меняется.
		</p>
		<a href={resolve('/me/confirmations')} class={buttonVariants()}>Открыть результат</a>
	</div>
{:else if attempt.purpose === 'vacancy_block' && attempt.status === 'expired'}
	<p class="rounded-xl border p-4 text-sm">
		Время блок-теста истекло до результата. Категория не меняется; запрос компании закроется по сроку.
	</p>
{:else if attempt.status === 'expired'}
	<p class="rounded-xl border p-4 text-sm">
		Время попытки истекло до решения: попытка засчитывается как неудачная, решения по ней нет.
	</p>
{:else if attempt.status === 'in_progress'}
	<p class="text-sm text-muted-foreground" data-testid="deadline">
		Задание {attempt.items.length} · попытка идёт до {formatDateTime(attempt.deadlineAt)}. Задания подаются по одному,
		вернуться к отвеченному нельзя.
	</p>
{/if}

{#if form?.problem}<FormMessage text={form.problem.message} />{/if}

{#if current}
	<SectionCard
		title="Задание {current.seq}"
		description={current.blockTitle}
		testId="current-item"
		class="border-primary/40"
	>
		<StatementView blocks={current.blocks} />
		{#if current.statement.code}
			<pre
				class="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 [tab-size:4]"
				data-language={current.statement.code.language}>{current.statement.code.source}</pre>
		{/if}
		{#if current.qa}
			<div class="grid gap-1 rounded-lg border p-3 text-sm">
				<p class="font-medium">Спецификация</p>
				<p class="whitespace-pre-wrap">{current.qa.specification}</p>
			</div>
		{/if}
		{#if current.status === 'answered' && current.changeStep && current.stepBlocks}
			{#each current.practiceResult as result (result.stage)}
				<p class="text-sm" data-testid="practice-result">
					Задача: пройдено групп тестов {result.passedGroups} из {result.totalGroups}.
				</p>
			{/each}
			<div class="grid gap-2 rounded-lg border border-info/30 bg-info-subtle p-3" data-testid="change-step">
				<p class="font-medium">Измени своё решение</p>
				<StatementView blocks={current.stepBlocks} />
				{#if current.changeStep.specification}
					<p class="text-sm whitespace-pre-wrap">{current.changeStep.specification}</p>
				{/if}
			</div>
		{/if}
		<ItemAnswer
			seq={current.seq}
			answerKind={current.answerKind}
			languages={current.languages}
			qa={current.qa}
			step={current.status === 'answered' ? current.changeStep : null}
			{signals}
		/>
	</SectionCard>
{:else if attempt.waitingSandbox}
	<p class="flex items-center gap-2 rounded-xl border p-4 text-sm" role="status" data-testid="waiting-sandbox">
		<LoaderIcon class="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
		Практика проверяется в песочнице. Сбой песочницы не засчитывается против тебя: проверка повторится, а при повторном сбое
		попытку разберёт оператор ФСП.
	</p>
{/if}

{#if answered.length > 0}
	<SectionCard title="Отвеченные задания" testId="answered-items">
		<ol class="grid gap-3">
			{#each answered as item (item.seq)}
				<li class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="answered-item" data-status={item.status}>
					<p class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium">Задание {item.seq} · {item.blockTitle}</span>
						<span class="text-muted-foreground">{ITEM_STATUSES[item.status]}</span>
					</p>
					<details>
						<summary class="cursor-pointer text-muted-foreground">Условие и твой ответ</summary>
						<div class="mt-2 grid gap-2">
							<StatementView blocks={item.blocks} />
							{#if item.statement.code}
								<pre class="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5">{item.statement.code
										.source}</pre>
							{/if}
							{#each item.answers as answer, index (index)}
								{@const shown = answerText(answer.content)}
								{#if shown !== null}
									<p class="text-muted-foreground">
										{answer.stage === 'change_step' ? 'Шаг «измени своё решение»' : 'Ответ'}{typeof answer.content
											?.language === 'string'
											? `, ${languageName(answer.content.language)}`
											: ''}:
									</p>
									<pre class="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5">{shown}</pre>
								{/if}
							{/each}
						</div>
					</details>
					{#each item.practiceResult as result (result.stage)}
						<p data-testid="practice-result">
							{result.stage === 'step' ? 'Шаг' : 'Задача'}: пройдено групп тестов {result.passedGroups} из {result.totalGroups}.
						</p>
					{/each}
				</li>
			{/each}
		</ol>
	</SectionCard>
{/if}

<SignalsJournal entries={attempt.signals.entries} />
<HonestNote />
