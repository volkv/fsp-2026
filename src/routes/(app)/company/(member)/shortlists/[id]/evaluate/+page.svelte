<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const result = $derived(form && 'result' in form ? form.result : (data.evaluation?.judged ?? null));
	const skill = (key: string) => data.names.skills[key] ?? key;
	const category = (c: { specialization: string; grade: string }) =>
		`${data.names.specializations[c.specialization] ?? c.specialization} · ${data.names.grades[c.grade] ?? c.grade}`;
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const WINNER = { product: 'подборка платформы', keywords: 'поиск по ключевым словам', tie: 'ничья' } as const;
</script>

<PageHeader
	title="Оцените подбор"
	description="Слепое сравнение: первая десятка подборки и первая десятка поиска по ключевым словам на той же потребности, перемешанные. Какая система выбрала карточку — не показано. Отметьте тех, кто подходит."
>
	{#snippet eyebrow()}
		<a
			class="text-link underline-offset-4 hover:underline"
			href={resolve('/(app)/company/(member)/shortlists/[id]', { id: data.shortlistId })}>Подборка</a
		>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{/if}

{#if data.needText}
	<Card.Root>
		<Card.Content class="pt-6 text-sm whitespace-pre-line">{data.needText}</Card.Content>
	</Card.Root>
{/if}

{#if result}
	<Card.Root data-testid="evaluation-result">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Результат оценки</h2></Card.Title>
		</Card.Header>
		<Card.Content class="grid gap-1 text-sm">
			<p>
				Precision@10: подборка — <span class="font-medium">{percent.format(result.precision_at_10.product)}</span>,
				поиск по ключевым словам — <span class="font-medium">{percent.format(result.precision_at_10.keywords)}</span>
			</p>
			<p>
				Предпочтение по чередованию: {WINNER[result.preference.winner]} ({result.preference.product} : {result
					.preference.keywords})
			</p>
			<p class="text-muted-foreground">
				Без результатов ФСП в первой десятке: подборка — {result.without_fsp_top10.product === null
					? '—'
					: percent.format(result.without_fsp_top10.product)}, поиск — {result.without_fsp_top10.keywords === null
					? '—'
					: percent.format(result.without_fsp_top10.keywords)}
			</p>
		</Card.Content>
	</Card.Root>
{:else if data.evaluation}
	<form method="POST" action="?/judge" use:enhance class="grid gap-3" data-testid="evaluation-cards">
		<CsrfInput />
		<input type="hidden" name="evaluation" value={data.evaluation.id} />
		<div class="grid gap-3 md:grid-cols-2">
			{#each data.evaluation.cards as card (card.position)}
				<label class="grid gap-2 rounded-xl border bg-card p-4 text-sm" data-position={card.position}>
					<span class="flex items-center gap-2 font-medium">
						<input type="checkbox" class="size-4" name="selected" value={card.position} disabled={!card.available} />
						Карточка {card.position}
					</span>
					{#if card.available}
						<span class="text-muted-foreground">
							{card.categories.length > 0 ? card.categories.map(category).join('; ') : 'категория не подтверждена'}
						</span>
						{#if card.confirmedSkills.length > 0}
							<span>Подтверждено тестом: {card.confirmedSkills.map(skill).join(', ')}</span>
						{/if}
						{#if card.skills.length > 0}
							<span class="text-xs text-muted-foreground">
								Навыки профиля: {card.skills.map((s) => `${skill(s.key)}${s.confirmed ? ' ✓' : ''}`).join(', ')}
							</span>
						{/if}
					{:else}
						<span class="text-muted-foreground">Кандидат больше недоступен</span>
					{/if}
				</label>
			{/each}
		</div>
		<Button type="submit" class="justify-self-start">Сохранить оценку</Button>
	</form>
{:else}
	<form method="POST" action="?/start" use:enhance>
		<CsrfInput />
		<Button type="submit">Показать карточки</Button>
	</form>
{/if}
