<script lang="ts">
	import FastForwardIcon from '@lucide/svelte/icons/fast-forward';
	import SendIcon from '@lucide/svelte/icons/send';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { categoryName, formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const challenge = $derived(data.challenge);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const STATUS = {
		draft: { label: 'Черновик', tone: 'neutral' },
		active: { label: 'Идёт', tone: 'success' },
		closed: { label: 'Закрыт', tone: 'neutral' }
	} as const;
</script>

<PageHeader title={challenge.title} description={challenge.goal}>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/company/challenges')}>Вызовы</a>{/snippet}
	{#snippet actions()}
		<StatusPill label={STATUS[challenge.status].label} tone={STATUS[challenge.status].tone} />
		{#if data.demoClockSeconds !== null && challenge.status === 'active'}
			<form method="POST" action="?/advanceClock" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="outline" size="sm" data-testid="advance-clock">
					<FastForwardIcon aria-hidden="true" />
					Промотать неделю
				</Button>
			</form>
		{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if data.created}
	<FormMessage
		tone="success"
		text={challenge.status === 'active'
			? 'Вызов опубликован: первая доставка кандидатам — при ближайшем прогоне.'
			: 'Черновик сохранён.'}
	/>
{:else if form && 'advanced' in form}
	<FormMessage
		tone="success"
		text={`Часы демо-сессии ушли на неделю вперёд: новых доставок — ${form.advanced}; неоткрытым ушло напоминание.`}
	/>
{:else if form && 'published' in form}
	<FormMessage tone="success" text="Вызов опубликован." />
{:else if form && 'closed' in form}
	<FormMessage tone="success" text="Вызов закрыт: новые доставки и решения не принимаются." />
{:else if form && 'dismissed' in form}
	<FormMessage tone="success" text="Решение отложено." />
{/if}
{#if data.demoClockSeconds !== null && data.demoClockSeconds > 0}
	<p class="text-sm text-muted-foreground" data-testid="demo-clock">
		Часы демо-сессии впереди на {Math.round(data.demoClockSeconds / 86_400)} дн.
	</p>
{/if}

<SectionCard
	title="Условия"
	description={`${data.names.specializations[challenge.specialization]} · ${challenge.grades.map((grade) => data.names.grades[grade]).join(', ')} · до ${formatDate(challenge.endsAt)}`}
>
	<p class="whitespace-pre-line">{challenge.statement}</p>
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
		<SalaryRange
			salary={{
				min: challenge.salary.min,
				max: challenge.salary.max,
				currency: 'RUB',
				period: 'month',
				taxBase: challenge.salary.taxBase
			}}
		/>
		<span>{challenge.answerKind === 'solution' ? 'Ответ — решение' : 'Ответ — подход'}</span>
		<span>около {challenge.timeLimitMinutes} мин</span>
	</div>
	<p class="text-sm text-muted-foreground" data-testid="challenge-counts">
		Доставлено {challenge.counts.delivered}, открыто {challenge.counts.opened}, решений {challenge.counts.solutions}.
	</p>
	<div class="flex flex-wrap gap-2">
		{#if challenge.status === 'draft'}
			<form method="POST" action="?/publish" use:enhance>
				<CsrfInput />
				<Button type="submit" size="sm">Опубликовать</Button>
			</form>
		{/if}
		{#if challenge.status !== 'closed'}
			<form method="POST" action="?/close" use:enhance>
				<CsrfInput />
				<Button type="submit" size="sm" variant="outline">Закрыть вызов</Button>
			</form>
		{/if}
	</div>
</SectionCard>

<SectionCard
	title="Решения"
	description="Под псевдонимами; отозванные и решения кандидатов, которых компания больше не видит, не показываются. Приглашение по решению называет его в «почему вы»."
	testId="challenge-solutions"
>
	{#if data.solutions.length === 0}
		<p class="text-sm text-muted-foreground">Решений пока нет.</p>
	{:else}
		<ul class="grid gap-3">
			{#each data.solutions as solution (solution.id)}
				<li class="grid gap-2 rounded-lg border p-3" data-solution={solution.id}>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium">
							Кандидат {solution.pseudonym}{solution.category
								? ` · ${categoryName(solution.category, data.names)}`
								: ''}
						</span>
						<span class="text-xs text-muted-foreground">{formatDateTime(solution.submittedAt)}</span>
					</div>
					<pre class="overflow-x-auto rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">{solution.content}</pre>
					<div class="flex flex-wrap items-center gap-2">
						{#if solution.decision === 'invited'}
							<StatusPill label="Приглашён" tone="success" />
						{:else if solution.decision === 'dismissed'}
							<StatusPill label="Отложено" />
						{:else}
							<a
								class={buttonVariants({ size: 'sm' })}
								href="{resolve('/(app)/company/(member)/candidates/[pseudonym]', {
									pseudonym: solution.pseudonym
								})}?solution={solution.id}"
							>
								<SendIcon aria-hidden="true" />
								Пригласить по решению
							</a>
							<form method="POST" action="?/dismiss" use:enhance>
								<CsrfInput />
								<input type="hidden" name="solutionId" value={solution.id} />
								<Button type="submit" size="sm" variant="ghost">Отложить</Button>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>
