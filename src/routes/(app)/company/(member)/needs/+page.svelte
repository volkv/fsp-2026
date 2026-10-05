<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import TargetIcon from '@lucide/svelte/icons/target';
	import NeedForm from '$lib/components/employer/need-form.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form?.problem ?? null);
	const STATUS = {
		draft: { label: 'Черновик', tone: 'neutral' },
		active: { label: 'Действует', tone: 'success' },
		closed: { label: 'Закрыта', tone: 'neutral' }
	} as const;
	const specializationTitle = (key: string | undefined) =>
		key === undefined
			? 'специализация не указана'
			: (data.options.specializations.find((s) => s.key === key)?.title ?? key);
</script>

<PageHeader
	title="Потребности"
	description="Опишите, кого ищете: текстом, формой или и тем и другим. Платформа разберёт текст с цитатами и подскажет категории кандидатов с их числом — вакансия для этого не нужна."
/>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Опишите, кого ищете</h2></Card.Title>
			<Card.Description>Поля формы, которые вы заполните, сохранятся поверх подсказки разбора.</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if problem}
				<FormMessage text={problem.message} />
			{/if}
			<form method="POST" action="?/create" use:enhance class="grid gap-4" data-testid="need-create">
				<CsrfInput />
				<Field.Field data-invalid={problem?.fields.text !== undefined}>
					<Field.Label for="need-text">Кого ищем</Field.Label>
					<Textarea
						id="need-text"
						name="text"
						rows={6}
						maxlength={5000}
						placeholder="Ищем бэкенд-разработчика уровня middle в команду платежей. Нужны Go и PostgreSQL. Удалённо."
					/>
					{#if problem?.fields.text}<Field.Error>{problem.fields.text}</Field.Error>{/if}
				</Field.Field>
				<details class="rounded-lg border">
					<summary class="cursor-pointer px-3 py-2 text-sm font-medium">Заполнить форму</summary>
					<div class="border-t p-3">
						<NeedForm options={data.options} problems={problem?.fields ?? {}} />
					</div>
				</details>
				<Button type="submit" class="justify-self-start">Разобрать и сохранить</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<section class="grid content-start gap-3" aria-labelledby="needs-heading">
		<h2 id="needs-heading" class="font-heading text-h3">Потребности компании</h2>
		{#if data.needs.length === 0}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<TargetIcon class="size-4" aria-hidden="true" /> Потребностей пока нет.
			</p>
		{:else}
			<ul class="grid gap-2" data-testid="need-list">
				{#each data.needs as need (need.id)}
					<li>
						<a
							class="grid gap-1 rounded-xl border bg-card p-3 text-sm hover:bg-muted/40"
							href={resolve('/(app)/company/(member)/needs/[id]', { id: need.id })}
							data-need={need.id}
						>
							<span class="flex flex-wrap items-center justify-between gap-2">
								<span class="font-medium">{specializationTitle(need.form.specialization)}</span>
								<StatusPill label={STATUS[need.status].label} tone={STATUS[need.status].tone} />
							</span>
							<span class="text-muted-foreground">{need.text ?? 'Без текста — по форме'}</span>
							<span class="text-xs text-muted-foreground">{formatDateTime(need.createdAt)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
