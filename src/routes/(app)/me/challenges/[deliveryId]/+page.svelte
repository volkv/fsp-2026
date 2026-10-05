<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { onMount } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { CSRF_FIELD, viewerFrom } from '$lib/components/shell/viewer.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const delivery = $derived(data.delivery);
	const challenge = $derived(delivery.challenge);
	const solution = $derived(delivery.solution);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const kind = $derived(challenge.answerKind === 'solution' ? 'решение' : 'подход');

	// Opening the call in the browser marks it opened; a preload of the link on hover does not.
	onMount(() => {
		if (delivery.status !== 'delivered') return;
		const viewer = viewerFrom(page.data);
		if (!viewer) return;
		const body = new FormData();
		body.set(CSRF_FIELD, viewer.csrfToken);
		void fetch('?/viewed', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } }).then(
			async (response) => {
				const result = deserialize(await response.text());
				if (result.type === 'success') await invalidateAll();
			}
		);
	});
</script>

<PageHeader title={challenge.title} description={challenge.companyName}>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/challenges')}>Вызовы компаний</a
		>{/snippet}
	{#snippet actions()}
		{#if !challenge.open}
			<StatusPill label="Вызов закрыт" />
		{:else}
			<StatusPill label={`До ${formatDate(challenge.endsAt)}`} tone="info" />
		{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'solved' in form}
	<FormMessage tone="success" text="Отправлено: компания видит его без твоего имени и может пригласить по нему." />
{:else if form && 'withdrawn' in form}
	<FormMessage tone="success" text="Отозвано: компания его больше не видит." />
{:else if form && 'dismissed' in form}
	<FormMessage tone="success" text="Вызов убран из новых." />
{/if}

<SectionCard title="Задача" description={`Нужен ${kind}; на задачу — около ${challenge.timeLimitMinutes} мин.`}>
	<p class="whitespace-pre-line" data-testid="challenge-statement">{challenge.statement}</p>
	<dl class="grid gap-3 text-sm sm:grid-cols-3">
		<div class="grid gap-1">
			<dt class="text-muted-foreground">Вилка</dt>
			<dd>
				<SalaryRange
					salary={{
						min: challenge.salary.min,
						max: challenge.salary.max,
						currency: 'RUB',
						period: 'month',
						taxBase: challenge.salary.taxBase
					}}
				/>
			</dd>
		</div>
		<div class="grid gap-1">
			<dt class="text-muted-foreground">Цель компании</dt>
			<dd>{challenge.goal}</dd>
		</div>
		<div class="grid gap-1">
			<dt class="text-muted-foreground">Для кого</dt>
			<dd>
				{data.names.specializations[challenge.specialization]} · {challenge.grades
					.map((grade) => data.names.grades[grade])
					.join(', ')}
			</dd>
		</div>
	</dl>
</SectionCard>

{#if solution?.status === 'submitted'}
	<SectionCard
		title="Твоё решение"
		description={`Отправлено ${formatDateTime(solution.submittedAt)}. Оно принадлежит тебе: отозвать можно в любой момент.`}
		testId="own-solution"
	>
		<pre class="overflow-x-auto rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">{solution.content}</pre>
		{#if solution.decision === 'invited'}
			<StatusPill label="Компания отправила предложение по решению" tone="success" />
		{/if}
		<form method="POST" action="?/withdraw" use:enhance>
			<CsrfInput />
			<input type="hidden" name="solutionId" value={solution.id} />
			<Button type="submit" variant="outline" size="sm">Отозвать решение</Button>
		</form>
	</SectionCard>
{:else if challenge.open && delivery.status !== 'dismissed'}
	<SectionCard
		title={challenge.answerKind === 'solution' ? 'Отправить решение' : 'Отправить подход'}
		description="Компания увидит текст под псевдонимом. Отправленное решение — подтверждённое действие: профиль становится свежее в выдаче."
	>
		<form method="POST" action="?/solve" use:enhance class="grid gap-3">
			<CsrfInput />
			<Textarea name="content" rows={10} maxlength={20000} required aria-label="Решение или подход" />
			<div class="flex flex-wrap gap-3">
				<Button type="submit" class="justify-self-start">
					<SendIcon aria-hidden="true" />
					Отправить
				</Button>
			</div>
		</form>
		{#if !solution}
			<form method="POST" action="?/dismiss" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="ghost" size="sm">Не интересно</Button>
			</form>
		{/if}
	</SectionCard>
{/if}
