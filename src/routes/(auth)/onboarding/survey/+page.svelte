<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import RegionPicker from '$lib/components/candidate/region-picker.svelte';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { SALARY_PERIODS, TAX_BASES } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AuthPage from '../../auth-page.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const STEPS = ['Направление', 'Специализация', 'Стек', 'Формат и ожидания'] as const;
	let step = $state(0);
	// The answers in force are the starting point of a repeated survey; afterwards the candidate's choice rules.
	let direction = $derived(data.current?.direction ?? '');
	let specialization = $derived(data.current?.specialization ?? '');
	let chosenSkills = $derived<string[]>([...(data.current?.declaredSkillKeys ?? [])]);
	let query = $state('');

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const expectation = $derived(data.preferences.salary_expectation);
	const skillName = $derived(new Map(data.skills.map((skill) => [skill.key, skill.name])));
	const inDirection = $derived(data.specializations.filter((s) => s.direction === direction));
	const chosenSpecialization = $derived(data.specializations.find((s) => s.key === specialization) ?? null);
	const needle = $derived(query.trim().toLocaleLowerCase('ru'));
	const found = $derived(
		needle === ''
			? []
			: data.skills
					.filter((skill) => skill.name.toLocaleLowerCase('ru').includes(needle) || skill.key.includes(needle))
					.slice(0, 20)
	);
	const full = $derived(chosenSkills.length >= data.maxSkills);

	function toggle(key: string) {
		chosenSkills = chosenSkills.includes(key)
			? chosenSkills.filter((skill) => skill !== key)
			: full
				? chosenSkills
				: [...chosenSkills, key];
	}

	const canContinue = $derived(
		[direction !== '', chosenSpecialization?.open === true, chosenSkills.length > 0, true][step] ?? false
	);
	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
	const checkClass = 'size-4 accent-primary';
	const optionClass =
		'flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-accent has-disabled:cursor-not-allowed has-disabled:opacity-60';
</script>

<AuthPage
	title={data.current ? 'Опрос заново' : 'Опрос'}
	description="Четыре шага: направление, специализация, стек и формат работы. По ответам строится подсказка грейда, а тест идёт по выбранной специализации."
	width="wide"
>
	{#if data.current}
		<p class="rounded-lg bg-info-subtle p-3 text-sm text-info">
			Новый опрос сохранится новой версией, прежние останутся в истории. Категория прежней специализации остаётся
			действительной.
		</p>
	{/if}
	{#if problem}
		<FormMessage tone="error" text={problem.message} />
	{/if}

	<ol class="flex flex-wrap gap-2 text-sm" aria-label="Шаги опроса">
		{#each STEPS as title, index (title)}
			<li
				class="rounded-full border px-3 py-1 {index === step
					? 'border-primary bg-accent font-medium'
					: 'text-muted-foreground'}"
				aria-current={index === step ? 'step' : undefined}
			>
				{index + 1}. {title}
			</li>
		{/each}
	</ol>

	<form method="POST" use:enhance class="grid gap-6" data-testid="survey-form">
		<CsrfField viewer={data.viewer} />

		<fieldset class="grid gap-3" hidden={step !== 0} data-step="direction">
			<legend class="mb-2 font-medium">В каком направлении вы работаете?</legend>
			{#each data.directions as option (option.key)}
				<label class={optionClass}>
					<input
						type="radio"
						name="direction"
						value={option.key}
						class={checkClass}
						bind:group={direction}
						onchange={() => (specialization = '')}
					/>
					{option.title}
				</label>
			{/each}
		</fieldset>

		<fieldset class="grid gap-3" hidden={step !== 1} data-step="specialization">
			<legend class="mb-2 font-medium">Специализация</legend>
			{#each inDirection as option (option.key)}
				<label class={optionClass}>
					<input
						type="radio"
						name="specialization"
						value={option.key}
						class="{checkClass} mt-0.5"
						bind:group={specialization}
						disabled={!option.open}
					/>
					<span class="grid gap-1">
						<span class="font-medium">{option.title}{option.open ? '' : ' — тест ещё не выпущен'}</span>
						<span class="text-muted-foreground">{option.summary}</span>
					</span>
				</label>
			{:else}
				<p class="text-sm text-muted-foreground">Сначала выберите направление.</p>
			{/each}
			{#if fieldError('specialization')}<p class="text-sm text-destructive">{fieldError('specialization')}</p>{/if}
		</fieldset>

		<fieldset class="grid gap-4" hidden={step !== 2} data-step="stack">
			<legend class="mb-2 font-medium">Ваш стек: от 1 до {data.maxSkills} навыков</legend>
			<p class="text-sm text-muted-foreground">
				Это заявленный стек: он помогает найти вас, но подтверждёнными становятся только навыки пройденных блоков теста.
			</p>
			{#each chosenSkills as key (key)}
				<input type="hidden" name="declared_skill_keys" value={key} />
			{/each}
			<div class="flex flex-wrap gap-2" aria-live="polite" data-testid="chosen-skills">
				{#each chosenSkills as key (key)}
					<button
						type="button"
						class="rounded-full border border-primary bg-accent px-3 py-1 text-sm"
						onclick={() => {
							toggle(key);
						}}
						aria-label="Убрать {skillName.get(key) ?? key}"
					>
						{skillName.get(key) ?? key} ×
					</button>
				{:else}
					<span class="text-sm text-muted-foreground">Навыки не выбраны.</span>
				{/each}
			</div>
			{#if chosenSpecialization}
				<div class="grid gap-2">
					<span class="text-sm font-medium">Что проверяет тест специализации «{chosenSpecialization.title}»</span>
					<div class="flex flex-wrap gap-2">
						{#each chosenSpecialization.suggestedSkills.filter((key) => !chosenSkills.includes(key)) as key (key)}
							<button
								type="button"
								class="rounded-full border px-3 py-1 text-sm disabled:opacity-50"
								disabled={full}
								onclick={() => {
									toggle(key);
								}}
							>
								+ {skillName.get(key) ?? key}
							</button>
						{/each}
					</div>
				</div>
			{/if}
			<label class="grid gap-1.5 text-sm">
				<span>Найти навык</span>
				<Input bind:value={query} placeholder="Например, PostgreSQL" autocomplete="off" />
			</label>
			{#if found.length > 0}
				<ul class="grid gap-1 sm:grid-cols-2">
					{#each found as skill (skill.key)}
						<li>
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									class={checkClass}
									checked={chosenSkills.includes(skill.key)}
									disabled={full && !chosenSkills.includes(skill.key)}
									onchange={() => {
										toggle(skill.key);
									}}
								/>
								{skill.name}
							</label>
						</li>
					{/each}
				</ul>
			{:else if needle !== ''}
				<p class="text-sm text-muted-foreground">Такого навыка в справочнике нет.</p>
			{/if}
			{#if fieldError('declared_skill_keys')}
				<p class="text-sm text-destructive">{fieldError('declared_skill_keys')}</p>
			{/if}
		</fieldset>

		<div class="grid gap-6" hidden={step !== 3} data-step="terms">
			<div class="grid gap-6 sm:grid-cols-2">
				<fieldset class="grid gap-2">
					<legend class="mb-1 text-sm font-medium">Формат работы</legend>
					{#each data.workFormats as option (option.key)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="work_formats"
								value={option.key}
								class={checkClass}
								checked={data.preferences.work_formats?.includes(option.key) ?? false}
							/>
							{option.name}
						</label>
					{/each}
				</fieldset>
				<fieldset class="grid gap-2">
					<legend class="mb-1 text-sm font-medium">Занятость</legend>
					{#each data.employmentForms as option (option.key)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="employment_forms"
								value={option.key}
								class={checkClass}
								checked={data.preferences.employment_forms?.includes(option.key) ?? false}
							/>
							{option.name}
						</label>
					{/each}
				</fieldset>
			</div>
			<RegionPicker
				regions={data.regions}
				value={data.preferences.region_code}
				error={fieldError('preferences.region_code')}
			/>
			<label class="grid max-w-xs gap-1.5 text-sm">
				<span>Переезд</span>
				<select name="relocation" class={selectClass}>
					<option value="" selected={data.preferences.relocation === undefined}>не указано</option>
					<option value="yes" selected={data.preferences.relocation === true}>готов к переезду</option>
					<option value="no" selected={data.preferences.relocation === false}>без переезда</option>
				</select>
			</label>
			<fieldset class="grid gap-3">
				<legend class="mb-1 text-sm font-medium">Ожидания по зарплате, ₽</legend>
				<div class="grid gap-4 sm:grid-cols-4">
					<label class="grid gap-1.5 text-sm">
						<span>От</span>
						<Input name="salary_min" inputmode="numeric" value={expectation?.min ?? ''} />
						{#if fieldError('preferences.salary_expectation.min')}
							<span class="text-destructive">{fieldError('preferences.salary_expectation.min')}</span>
						{/if}
					</label>
					<label class="grid gap-1.5 text-sm">
						<span>До</span>
						<Input name="salary_max" inputmode="numeric" value={expectation?.max ?? ''} />
						{#if fieldError('preferences.salary_expectation.max')}
							<span class="text-destructive">{fieldError('preferences.salary_expectation.max')}</span>
						{/if}
					</label>
					<label class="grid gap-1.5 text-sm">
						<span>Период</span>
						<select name="salary_period" class={selectClass}>
							{#each Object.entries(SALARY_PERIODS) as [key, label] (key)}
								<option value={key} selected={(expectation?.period ?? 'month') === key}>{label}</option>
							{/each}
						</select>
					</label>
					<label class="grid gap-1.5 text-sm">
						<span>Налоговая база</span>
						<select name="salary_tax_base" class={selectClass}>
							{#each Object.entries(TAX_BASES) as [key, label] (key)}
								<option value={key} selected={(expectation?.tax_base ?? 'net') === key}>{label}</option>
							{/each}
						</select>
					</label>
				</div>
				<p class="text-sm text-muted-foreground">Оставьте обе границы пустыми, если не хотите указывать ожидания.</p>
			</fieldset>
		</div>

		<div class="flex flex-wrap gap-3">
			{#if step > 0}
				<Button type="button" variant="outline" onclick={() => (step -= 1)}>Назад</Button>
			{/if}
			{#if step < STEPS.length - 1}
				<Button type="button" disabled={!canContinue} onclick={() => (step += 1)}>Дальше</Button>
			{:else}
				<Button type="submit">Сохранить опрос</Button>
			{/if}
		</div>
	</form>

	{#snippet footer()}
		<a class="text-link underline underline-offset-4" href={resolve('/onboarding')}>К шагам регистрации</a>
	{/snippet}
</AuthPage>
