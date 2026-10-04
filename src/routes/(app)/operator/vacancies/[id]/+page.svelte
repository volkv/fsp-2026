<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import VacancyStatus from '$lib/components/employer/vacancy-status.svelte';
	import { COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import {
		MODERATION_HISTORY,
		MODERATION_OUTCOMES,
		TEXT_CHECK_CATEGORIES,
		TEXT_FIELDS
	} from '$lib/components/operator/model.js';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const c = $derived(data.moderationCase);
	const vacancy = $derived(c.vacancy);
	const labels = $derived(data.labels);
	const moderation = $derived(vacancy.textCheck.moderation);
	const company = $derived(COMPANY_STATUSES[c.company.status]);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const DECIDED: Record<string, string> = {
		publish: 'Вакансия опубликована: требование признано законным.',
		return: 'Вакансия возвращена компании на правку с вашей причиной.',
		reject: 'Вакансия отклонена и закрыта.'
	};
	const grade = $derived(
		vacancy.gradeMin === vacancy.gradeMax
			? (labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin)
			: `${labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin} – ${labels.grades[vacancy.gradeMax] ?? vacancy.gradeMax}`
	);
	const BY: Record<string, string> = { company: 'компания', operator: 'оператор', system: 'система' };
</script>

<PageHeader
	title={vacancy.title}
	description="Дело модерации вакансии: проверка текста на дискриминационные требования."
>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/vacancies')}>Модерация вакансий</a>
	{/snippet}
	{#snippet actions()}
		<VacancyStatus status={vacancy.status} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.decided && DECIDED[data.decided]}
	<FormProblem tone="success" text={DECIDED[data.decided] ?? ''} />
{/if}

<div
	class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
	data-moderation-case={vacancy.id}
	data-status={vacancy.status}
>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что нашла проверка текста</h2></Card.Title>
				<Card.Description>
					Блокирующее требование закон не разрешает ставить условием найма, кроме установленных законом случаев.
					Предупреждения компания подтверждает сама.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if c.findings.length === 0}
					<p class="text-sm text-muted-foreground">В текущем тексте проверка ничего не находит.</p>
				{:else}
					<ul class="grid gap-3 text-sm" aria-label="Фрагменты текста">
						{#each c.findings as finding, index (index)}
							<li
								class={cn(
									'grid gap-1.5 rounded-lg border px-3 py-2',
									finding.severity === 'block'
										? 'border-destructive/30 bg-danger-subtle'
										: 'border-warning/30 bg-warning-subtle'
								)}
								data-finding={finding.rule}
							>
								<p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									<StatusPill
										label={finding.severity === 'block' ? 'Блокирует' : 'Предупреждение'}
										tone={finding.severity === 'block' ? 'danger' : 'warning'}
									/>
									{TEXT_CHECK_CATEGORIES[finding.category] ?? finding.category} · правило
									<code class="font-mono">{finding.rule}</code> · {TEXT_FIELDS[finding.field] ?? finding.field}
								</p>
								<blockquote class="text-foreground/90">
									{finding.quote.before}<mark class="rounded-sm bg-background px-0.5 font-medium"
										>{finding.quote.text}</mark
									>{finding.quote.after}
								</blockquote>
								<p class="text-muted-foreground">{finding.explanation}</p>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Вакансия</h2></Card.Title>
				<Card.Description>Версия {vacancy.revision}</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				<dl class="grid gap-3 sm:grid-cols-2">
					<div>
						<dt class="text-muted-foreground">Роль и грейд</dt>
						<dd>{labels.roles[vacancy.roleKey] ?? vacancy.roleKey} · {grade}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Вилка</dt>
						<dd><SalaryRange salary={vacancy.salary} /></dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Возраст кандидатов</dt>
						<dd>{vacancy.minAge === null ? 'только совершеннолетние' : `с ${vacancy.minAge} лет`}</dd>
					</div>
				</dl>
				<details class="rounded-lg border">
					<summary class="cursor-pointer px-3 py-2 font-medium">Полный текст описания</summary>
					<p class="border-t px-3 py-2 whitespace-pre-line">{vacancy.description}</p>
				</details>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Компания</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-2 text-sm">
					<div>
						<dd class="flex flex-wrap items-center gap-2">
							<a
								class="font-medium underline-offset-4 hover:underline"
								href={resolve('/(app)/operator/companies/[id]', { id: c.company.id })}>{c.company.displayName}</a
							>
							<StatusPill label={company.label} tone={company.tone} />
						</dd>
						<dd class="text-muted-foreground">{c.company.legalName}, ИНН {c.company.inn}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Решение</h2></Card.Title>
				{#if moderation}
					<Card.Description>На модерации с {formatDateTime(moderation.opened_at)}</Card.Description>
				{/if}
			</Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				{#if vacancy.status === 'pending_moderation'}
					<!-- A refused decision because the case changed (409) reopens the case with the vacancy as it is now. -->
					<form
						method="POST"
						use:enhance={() =>
							async ({ result, update }) => {
								await update();
								if (result.type === 'failure' && result.status === 409) await invalidateAll();
							}}
						class="grid gap-4"
						data-testid="moderation-form"
					>
						<CsrfInput />
						<input type="hidden" name="revision" value={vacancy.revision} />
						<Field.Field>
							<Field.Label for="moderation-reason">Причина для компании</Field.Label>
							<Textarea
								id="moderation-reason"
								name="reason"
								rows={4}
								maxlength={data.reasonMax}
								value={form && 'reason' in form ? form.reason : ''}
								aria-invalid={problem?.fields.reason ? true : undefined}
							/>
							<Field.Description>
								Обязательна при возврате и отказе — компания увидит её на странице вакансии. При публикации — по
								желанию: например, на каком основании требование законно.
							</Field.Description>
							{#if problem?.fields.reason}<Field.Error>{problem.fields.reason}</Field.Error>{/if}
						</Field.Field>
						<div class="flex flex-wrap gap-2">
							<Button type="submit" formaction="?/publish">Опубликовать</Button>
							<Button type="submit" variant="outline" formaction="?/return">Вернуть на правку</Button>
							<Button type="submit" variant="destructive" formaction="?/reject">Отклонить</Button>
						</div>
					</form>
				{:else if moderation?.decision}
					{@const outcome = MODERATION_OUTCOMES[moderation.decision.outcome]}
					<p class="flex flex-wrap items-center gap-2" data-testid="moderation-decision">
						<StatusPill label={outcome.label} tone={outcome.tone} />
						<span class="text-muted-foreground">{formatDateTime(moderation.decision.at)}</span>
					</p>
					{#if moderation.decision.reason}<p class="whitespace-pre-line">{moderation.decision.reason}</p>{/if}
				{:else}
					<p class="text-muted-foreground">Вакансия не на модерации: решение по ней сейчас не нужно.</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">История</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				{#if c.history.length === 0}
					<p class="text-sm text-muted-foreground">В журнале нет событий по этой вакансии.</p>
				{:else}
					<ol class="grid gap-2 text-sm" data-testid="moderation-history">
						{#each c.history as entry, index (index)}
							<li class="grid gap-0.5">
								<span>
									{MODERATION_HISTORY[entry.action] ?? entry.action}{entry.decision
										? `: ${MODERATION_OUTCOMES[entry.decision].label.toLowerCase()}`
										: ''}
								</span>
								<span class="text-xs text-muted-foreground">{formatDateTime(entry.at)} · {BY[entry.by]}</span>
							</li>
						{/each}
					</ol>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
