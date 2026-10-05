<script lang="ts">
	import LightbulbIcon from '@lucide/svelte/icons/lightbulb';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import AuthPage from '../../auth-page.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const titleOf = (key: string | null) => data.grades.find((g) => g.key === key)?.title ?? '';
	// The declared grade, else the suggested one: the candidate changes it freely.
	let chosen = $derived(data.declared ?? data.hint.suggested ?? '');

	const SOURCES = { resume: 'Резюме', fsp: 'ФСП', public_profile: 'Публичный профиль' } as const;
	const optionClass =
		'flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-accent';
</script>

<AuthPage
	title="Заявленный грейд"
	description="Специализация «{data.specialization
		.title}». Заявите грейд, который готовы подтвердить тестом: подсказка советует, решаете вы."
	width="wide"
>
	{#if data.justDeclared && data.declared}
		<FormMessage tone="success" text="Грейд {titleOf(data.declared)} заявлен. Дальше — тест на этот грейд." />
		<div class="flex flex-wrap gap-3" data-testid="after-declaration">
			<a href={resolve('/me/tests')} class={buttonVariants()}>Перейти к тесту</a>
			<a href={resolve('/me/category')} class={buttonVariants({ variant: 'outline' })}>Категория и грейд</a>
		</div>
	{/if}
	{#if problem}
		<FormMessage tone="error" text={problem.message} />
	{/if}

	<section class="grid gap-3 rounded-lg border p-4" data-testid="grade-hint" data-suggested={data.hint.suggested ?? ''}>
		<h2 class="flex items-center gap-2 font-medium">
			<LightbulbIcon class="size-4 text-link" aria-hidden="true" />
			{data.hint.suggested ? `Подсказка: ${titleOf(data.hint.suggested)}` : 'Подсказки нет'}
		</h2>
		{#if data.hint.bases.length > 0}
			<ul class="grid gap-1.5 text-sm">
				{#each data.hint.bases as basis, index (index)}
					<li><span class="text-muted-foreground">{SOURCES[basis.source]}:</span> {basis.text}</li>
				{/each}
			</ul>
		{/if}
		<ul class="grid gap-1 text-sm text-muted-foreground">
			{#each data.hint.caveats as caveat, index (index)}
				<li>{caveat}</li>
			{/each}
		</ul>
	</section>

	<form method="POST" use:enhance class="grid gap-4" data-testid="grade-form">
		<CsrfField viewer={data.viewer} />
		<fieldset class="grid gap-3">
			<legend class="mb-2 font-medium">Какой грейд заявляете</legend>
			{#each data.grades as grade (grade.key)}
				<label class={optionClass}>
					<input
						type="radio"
						name="grade"
						value={grade.key}
						class="mt-0.5 size-4 accent-primary"
						bind:group={chosen}
						required
					/>
					<span class="grid gap-1">
						<span class="font-medium">
							{grade.title}{grade.key === data.hint.suggested ? ' — советует подсказка' : ''}{grade.key ===
							data.declared
								? ' — заявлен сейчас'
								: ''}
						</span>
						<span class="text-muted-foreground">{grade.borderline}</span>
						<span class="text-xs text-muted-foreground">Блоки теста: {grade.blocks.join(', ')}</span>
					</span>
				</label>
			{/each}
		</fieldset>
		<Button type="submit" class="justify-self-start">Заявить грейд</Button>
	</form>

	{#snippet footer()}
		<a class="text-link underline underline-offset-4" href={resolve('/onboarding/survey')}>Изменить ответы опроса</a>
		<a class="text-link underline underline-offset-4" href={resolve('/onboarding')}>К шагам регистрации</a>
	{/snippet}
</AuthPage>
