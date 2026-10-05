<script lang="ts">
	import SwordsIcon from '@lucide/svelte/icons/swords';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form?.problem ?? null);
	const STATUS = {
		draft: { label: 'Черновик', tone: 'neutral' },
		active: { label: 'Идёт', tone: 'success' },
		closed: { label: 'Закрыт', tone: 'neutral' }
	} as const;
	const specializations = $derived(Object.entries(data.names.specializations));
	const grades = $derived(Object.entries(data.names.grades));
	const error = (path: string) => problem?.fields[path];
</script>

<PageHeader
	title="Вызовы"
	description="Короткая задача с видимой вилкой и целью. Платформа регулярно предлагает её кандидатам подходящих категорий; вы видите решения под псевдонимами и приглашаете по решению."
/>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Новый вызов</h2></Card.Title>
			<Card.Description>
				Публикации нужен заполненный профиль компании. Опубликованные условия не меняются — только срок.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if problem}
				<FormMessage text={problem.message} />
			{/if}
			<form method="POST" action="?/create" use:enhance class="grid gap-4" data-testid="challenge-create">
				<CsrfInput />
				<Field.Field data-invalid={error('title') !== undefined}>
					<Field.Label for="challenge-title">Название</Field.Label>
					<Input id="challenge-title" name="title" maxlength={120} required />
					{#if error('title')}<Field.Error>{error('title')}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={error('statement') !== undefined}>
					<Field.Label for="challenge-statement">Условие</Field.Label>
					<Textarea id="challenge-statement" name="statement" rows={6} maxlength={5000} required />
					{#if error('statement')}<Field.Error>{error('statement')}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={error('goal') !== undefined}>
					<Field.Label for="challenge-goal">Цель</Field.Label>
					<Input id="challenge-goal" name="goal" maxlength={500} required placeholder="Кого и зачем ищем" />
					{#if error('goal')}<Field.Error>{error('goal')}</Field.Error>{/if}
				</Field.Field>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="challenge-kind">Ответ</Field.Label>
						<NativeSelect id="challenge-kind" name="answerKind">
							<option value="approach">Подход — как бы решал</option>
							<option value="solution">Решение — код или текст</option>
						</NativeSelect>
					</Field.Field>
					<Field.Field>
						<Field.Label for="challenge-time">Время на задачу, мин</Field.Label>
						<Input id="challenge-time" name="timeLimitMinutes" type="number" min={5} max={30} value="20" required />
					</Field.Field>
					<Field.Field>
						<Field.Label for="challenge-specialization">Специализация</Field.Label>
						<NativeSelect id="challenge-specialization" name="specialization">
							{#each specializations as [key, title] (key)}<option value={key}>{title}</option>{/each}
						</NativeSelect>
					</Field.Field>
					<Field.Field data-invalid={error('grades') !== undefined}>
						<span class="text-sm font-medium">Грейды</span>
						<span class="flex flex-wrap gap-3">
							{#each grades as [key, title] (key)}
								<label class="flex items-center gap-1.5 text-sm">
									<input type="checkbox" name="grades" value={key} class="size-4 accent-primary" />
									{title}
								</label>
							{/each}
						</span>
						{#if error('grades')}<Field.Error>{error('grades')}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={error('salary_min') !== undefined}>
						<Field.Label for="challenge-min">Вилка от, ₽ в месяц</Field.Label>
						<Input id="challenge-min" name="salaryMin" inputmode="numeric" required />
						{#if error('salary_min')}<Field.Error>{error('salary_min')}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={error('salary_max') !== undefined}>
						<Field.Label for="challenge-max">до, ₽ в месяц</Field.Label>
						<Input id="challenge-max" name="salaryMax" inputmode="numeric" required />
						{#if error('salary_max')}<Field.Error>{error('salary_max')}</Field.Error>{/if}
					</Field.Field>
					<Field.Field>
						<Field.Label for="challenge-tax">Налоговая база</Field.Label>
						<NativeSelect id="challenge-tax" name="salaryTaxBase">
							<option value="gross">До вычета НДФЛ</option>
							<option value="net">На руки</option>
						</NativeSelect>
					</Field.Field>
					<Field.Field data-invalid={error('ends_at') !== undefined}>
						<Field.Label for="challenge-ends">Идёт до</Field.Label>
						<Input id="challenge-ends" name="endsOn" type="date" value={data.defaultEndsOn} required />
						{#if error('ends_at')}<Field.Error>{error('ends_at')}</Field.Error>{/if}
					</Field.Field>
				</div>
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="publish" checked class="size-4 accent-primary" />
					Опубликовать сразу
				</label>
				<Button type="submit" class="justify-self-start">Сохранить вызов</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<section class="grid content-start gap-3" aria-labelledby="challenges-heading">
		<h2 id="challenges-heading" class="font-heading text-h3">Вызовы компании</h2>
		{#if data.challenges.length === 0}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<SwordsIcon class="size-4" aria-hidden="true" /> Вызовов пока нет.
			</p>
		{:else}
			<ul class="grid gap-2" data-testid="challenge-list">
				{#each data.challenges as challenge (challenge.id)}
					<li>
						<a
							class="grid gap-1 rounded-xl border bg-card p-3 text-sm hover:bg-muted/40"
							href={resolve('/(app)/company/(member)/challenges/[id]', { id: challenge.id })}
						>
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium">{challenge.title}</span>
								<StatusPill label={STATUS[challenge.status].label} tone={STATUS[challenge.status].tone} />
							</span>
							<SalaryRange
								salary={{
									min: challenge.salary.min,
									max: challenge.salary.max,
									currency: 'RUB',
									period: 'month',
									taxBase: challenge.salary.taxBase
								}}
							/>
							<span class="text-xs text-muted-foreground">
								до {formatDate(challenge.endsAt)} · доставлено {challenge.counts.delivered} · решений {challenge.counts
									.solutions}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
