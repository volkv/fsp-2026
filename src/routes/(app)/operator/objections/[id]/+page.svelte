<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DueStatus from '$lib/components/operator/due-status.svelte';
	import { OBJECTION_OUTCOMES, OBJECTION_STATUSES } from '$lib/components/operator/model.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const o = $derived(data.objection);
	const status = $derived(OBJECTION_STATUSES[o.status]);
	const outcome = $derived(o.outcome ? OBJECTION_OUTCOMES[o.outcome] : undefined);
	const active = $derived(o.status === 'open' || o.status === 'in_review');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const name = (list: readonly { key: string; name: string }[], key: string) =>
		list.find((item) => item.key === key)?.name ?? key;
	const pair = (specialization: string, grade: string) =>
		`${name(data.options.specializations, specialization)} · ${name(data.options.grades, grade)}`;

	const DECISION_OUTCOMES: Record<string, string> = {
		confirmed: 'грейд подтверждён',
		not_confirmed: 'грейд не подтверждён',
		undetermined: 'не определено'
	};
	const CATEGORY_STATUSES: Record<string, string> = {
		active: 'действует',
		superseded: 'заменена следующим грейдом',
		revoked: 'отозвана'
	};
	const ANSWERED: Record<string, string> = {
		upheld: 'Ответ отправлен: решение теста оставлено.',
		annulled: 'Попытка аннулирована: она не засчитывается, категория этого решения отозвана.',
		rescored: 'Оценка заданий исправлена, решение пересчитано и применено к категории.'
	};
	let answer = $state<'upheld' | 'annulled' | 'rescored'>('upheld');
</script>

<PageHeader title="Возражение по результату теста" description={`Подано ${formatDateTime(o.openedAt)}.`}>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/objections')}>Возражения</a>
	{/snippet}
	{#snippet actions()}
		{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
		{#if outcome}<StatusPill label={outcome.label} tone={outcome.tone} />{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if data.answered && ANSWERED[data.answered]}
	<FormMessage tone="success" text={ANSWERED[data.answered] ?? ''} />
{:else if form && 'taken' in form}
	<FormMessage tone="success" text="Возражение у вас в работе: ответ даёте вы." />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-objection={o.id} data-status={o.status}>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что пишет кандидат</h2></Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-2 text-sm">
				<blockquote class="border-l-2 pl-4 whitespace-pre-line" data-testid="objection-reason">{o.reason}</blockquote>
				{#if o.items.length > 0}
					<p class="text-muted-foreground">Оспорено заданий: {o.items.length}.</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Оспариваемое решение</h2></Card.Title>
				<Card.Description>
					Задания, ответы, артефакты и баллы — в деле попытки (проверка попыток тестов), с записью в журнал.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-1 text-sm">
				<p class="font-medium">{pair(o.decision.specialization, o.decision.grade)}</p>
				<p>
					{DECISION_OUTCOMES[o.decision.outcome] ?? o.decision.outcome} · {formatDateTime(o.decision.decidedAt)}
					{o.decision.status === 'annulled' ? '· решение аннулировано' : ''}
				</p>
				<p class="text-muted-foreground">Попытка {o.decision.attemptId}</p>
			</Card.Content>
		</Card.Root>

		{#if o.candidate}
			{@const candidate = o.candidate}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Категории кандидата</h2></Card.Title>
					<Card.Description>
						Данные кандидата открыты только на время дела; каждое открытие записано в журнал.
						{candidate.isMinor ? 'Кандидату 14–17 лет.' : ''}
					</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm">
					{#if candidate.categories.length === 0}
						<p class="text-muted-foreground">Категорий нет.</p>
					{:else}
						<ul class="grid gap-1">
							{#each candidate.categories as category (category.id)}
								<li>
									{pair(category.specialization, category.grade)} — {CATEGORY_STATUSES[category.status] ??
										category.status}, назначена {formatDate(category.assignedAt)}
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Ответ</h2></Card.Title>
				<Card.Description>
					{#if o.assignee}
						Ответственный: {o.mine ? 'вы' : (o.assignee.name ?? 'оператор')}.
					{:else}
						Ответственный не назначен.
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				{#if active}
					<DueStatus dueAt={o.dueAt} now={data.now} overdue={o.overdue} dueSoon={o.dueSoon} />
					{#if !o.mine}
						<form method="POST" action="?/take" use:enhance>
							<CsrfInput />
							<Button type="submit">{o.assignee ? 'Взять себе' : 'Взять в работу'}</Button>
						</form>
					{:else}
						<form method="POST" action="?/answer" use:enhance class="grid gap-4" data-testid="answer-form">
							<CsrfInput />
							<fieldset class="grid gap-2">
								<legend class="mb-1 font-medium">Исход</legend>
								<label class="flex items-center gap-2">
									<input type="radio" name="outcome" value="upheld" bind:group={answer} class="size-4" />
									Оставить решение теста
								</label>
								<label class="flex items-center gap-2">
									<input type="radio" name="outcome" value="annulled" bind:group={answer} class="size-4" />
									Аннулировать попытку: не засчитывается, повтор сразу
								</label>
								<label class="flex items-center gap-2">
									<input type="radio" name="outcome" value="rescored" bind:group={answer} class="size-4" />
									Исправить баллы заданий и пересчитать решение
								</label>
							</fieldset>
							{#if answer === 'rescored'}
								<fieldset class="grid gap-2">
									<legend class="mb-1 font-medium">Исправленные баллы</legend>
									{#each [0, 1, 2] as row (row)}
										<div class="grid gap-2 sm:grid-cols-[5rem_5rem_minmax(0,1fr)]">
											<Input name="seq" inputmode="numeric" placeholder="Слот" aria-label={`Слот ${row + 1}`} />
											<Input name="score" inputmode="decimal" placeholder="0,8" aria-label={`Балл ${row + 1}`} />
											<Input
												name="itemReason"
												placeholder="Обоснование по артефактам"
												aria-label={`Обоснование ${row + 1}`}
											/>
										</div>
									{/each}
									{#if fieldError('rescored_items')}<p class="text-destructive">{fieldError('rescored_items')}</p>{/if}
								</fieldset>
							{/if}
							<Field.Field data-invalid={fieldError('resolution') !== undefined}>
								<Field.Label for="resolution">Объяснение кандидату</Field.Label>
								<Textarea id="resolution" name="resolution" rows={5} required maxlength={4000} />
								{#if fieldError('resolution')}<Field.Error>{fieldError('resolution')}</Field.Error>{/if}
							</Field.Field>
							<Button type="submit" class="justify-self-start">Отправить ответ</Button>
						</form>
					{/if}
				{:else}
					{#if o.resolution}
						<p class="whitespace-pre-line" data-testid="resolution">{o.resolution}</p>
					{/if}
					{#if o.resolvedAt}<p class="text-muted-foreground">Решено {formatDateTime(o.resolvedAt)}.</p>{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
