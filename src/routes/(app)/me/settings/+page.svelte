<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import RegionPicker from '$lib/components/candidate/region-picker.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { SALARY_PERIODS, TAX_BASES } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const settings = $derived(data.settings);
	const expectation = $derived(settings.preferences.salary_expectation);
	const slots = [0, 1, 2] as const;
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
	const checkClass = 'size-4 accent-primary';
</script>

<PageHeader
	title="Предпочтения"
	description="Что вы заявляете о поиске: роли, формат, ожидания по зарплате. Работодатель видит это в карточке, соответствие вакансиям пересчитывается после сохранения."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

<form method="POST" action="?/save" use:enhance class="grid gap-6" data-testid="settings-form">
	<CsrfInput />
	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'saved' in form}
		<FormMessage tone="success" text="Сохранено. Соответствие вакансиям пересчитывается." />
	{/if}

	<SectionCard
		title="Желаемые роли"
		description="До трёх ролей. Желаемая роль показывается рядом с выведенной и не подменяет её: категория строится из фактов."
	>
		<div class="grid gap-3 sm:grid-cols-3">
			{#each slots as slot (slot)}
				<label class="grid gap-1.5 text-sm">
					<span>Роль {slot + 1}</span>
					<select name="desired_role" class={selectClass}>
						<option value="">— не выбрана —</option>
						{#each settings.options.roles as role (role.key)}
							<option value={role.key} selected={settings.desiredRoleKeys[slot] === role.key}>{role.name}</option>
						{/each}
					</select>
				</label>
			{/each}
		</div>
		{#if fieldError('desired_role_keys')}<p class="text-sm text-destructive">{fieldError('desired_role_keys')}</p>{/if}
	</SectionCard>

	<SectionCard title="Формат и занятость">
		<div class="grid gap-6 sm:grid-cols-2">
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Формат работы</legend>
				{#each settings.options.workFormats as option (option.key)}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="work_formats"
							value={option.key}
							class={checkClass}
							checked={settings.preferences.work_formats?.includes(option.key) ?? false}
						/>
						{option.name}
					</label>
				{/each}
			</fieldset>
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Занятость</legend>
				{#each settings.options.employmentForms as option (option.key)}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="employment_forms"
							value={option.key}
							class={checkClass}
							checked={settings.preferences.employment_forms?.includes(option.key) ?? false}
						/>
						{option.name}
					</label>
				{/each}
			</fieldset>
		</div>
		<label class="grid max-w-xs gap-1.5 text-sm">
			<span>Переезд</span>
			<select name="relocation" class={selectClass}>
				<option value="" selected={settings.preferences.relocation === undefined}>не указано</option>
				<option value="yes" selected={settings.preferences.relocation === true}>готов к переезду</option>
				<option value="no" selected={settings.preferences.relocation === false}>без переезда</option>
			</select>
		</label>
	</SectionCard>

	<SectionCard
		title="Регион"
		description="Работодатель видит регион, но не город. Без региона в карточке стоит «регион не указан», а фильтр каталога по региону вас не находит."
	>
		<RegionPicker regions={data.regions} value={settings.preferences.region_code} error={fieldError('region_code')} />
	</SectionCard>

	<SectionCard
		title="Ожидания по зарплате"
		description="Сравниваются с вилкой вакансии только при одинаковых валюте, периоде и налоговой базе — иначе «несравнимо», а не «ниже» или «выше»."
	>
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
			<label class="grid gap-1.5 text-sm">
				<span>От</span>
				<Input
					name="salary_min"
					inputmode="numeric"
					value={expectation?.min ?? ''}
					aria-invalid={fieldError('salary_min') ? 'true' : undefined}
				/>
				{#if fieldError('salary_min')}<span class="text-destructive">{fieldError('salary_min')}</span>{/if}
			</label>
			<label class="grid gap-1.5 text-sm">
				<span>До</span>
				<Input
					name="salary_max"
					inputmode="numeric"
					value={expectation?.max ?? ''}
					aria-invalid={fieldError('salary_max') ? 'true' : undefined}
				/>
				{#if fieldError('salary_max')}<span class="text-destructive">{fieldError('salary_max')}</span>{/if}
			</label>
			<label class="grid gap-1.5 text-sm">
				<span>Валюта</span>
				<select name="salary_currency" class={selectClass}>
					{#each ['RUB', 'USD', 'EUR'] as currency (currency)}
						<option value={currency} selected={(expectation?.currency ?? 'RUB') === currency}>{currency}</option>
					{/each}
				</select>
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
		{#if fieldError('salary_expectation')}
			<p class="text-sm text-destructive">{fieldError('salary_expectation')}</p>
		{/if}
		<p class="text-sm text-muted-foreground">Оставьте обе границы пустыми, если не хотите указывать ожидания.</p>
	</SectionCard>

	<div class="flex flex-wrap gap-3">
		<Button type="submit">Сохранить</Button>
		<a href={resolve('/me/profile')} class="inline-flex items-center text-sm text-link underline underline-offset-4"
			>К профилю</a
		>
	</div>
</form>
