<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import NeedForm from '$lib/components/employer/need-form.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const need = $derived(data.need);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const skillName = (key: string) => data.options.skillNames[key] ?? key;
	const specializationTitle = (key: string) => data.options.specializations.find((s) => s.key === key)?.title ?? key;
	const gradeTitle = (key: string) => data.options.grades.find((g) => g.key === key)?.title ?? key;
	const FIELDS: Record<string, string> = {
		specialization: 'Специализация',
		grade: 'Грейд',
		skill_keys: 'Обязательный навык',
		nice_skill_keys: 'Желательный навык',
		work_format: 'Формат',
		region_code: 'Регион',
		salary: 'Вилка'
	};
	const BASIS = { form: 'по форме', neighbour_grade: 'соседний грейд', skills: 'по навыкам' } as const;
	const STATUS = {
		draft: { label: 'Черновик', tone: 'neutral' },
		active: { label: 'Действует', tone: 'success' },
		closed: { label: 'Закрыта', tone: 'neutral' }
	} as const;

	function fieldValue(path: string, value: unknown): string {
		if (path === 'specialization' && typeof value === 'string') return specializationTitle(value);
		if (path === 'grade' && typeof value === 'string') return gradeTitle(value);
		if (path.endsWith('skill_keys') && typeof value === 'string') return skillName(value);
		if (path === 'work_format' && typeof value === 'string') {
			return data.options.workFormats.find((f) => f.key === value)?.name ?? value;
		}
		if (path === 'region_code' && typeof value === 'string') {
			return data.options.regions.find((r) => r.code === value)?.name ?? value;
		}
		if (path === 'salary' && typeof value === 'object' && value !== null && 'min' in value && 'max' in value) {
			const format = new Intl.NumberFormat('ru-RU');
			return `${format.format(Number(value.min))}–${format.format(Number(value.max))} ₽`;
		}
		return typeof value === 'string' ? value : JSON.stringify(value);
	}
	const count = (cell: { value: number } | { below: number }) =>
		'value' in cell ? String(cell.value) : `< ${cell.below}`;
</script>

<PageHeader
	title={need.form.specialization ? `Потребность: ${specializationTitle(need.form.specialization)}` : 'Потребность'}
	description="Подтвердите поля формы: разбор лишь подсказывает. Категории пересчитываются при каждом открытии."
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/needs')}>Потребности</a>
	{/snippet}
	{#snippet actions()}
		<StatusPill label={STATUS[need.status].label} tone={STATUS[need.status].tone} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'saved' in form}
	<FormMessage
		tone="success"
		text={form.saved === 'active'
			? 'Потребность подтверждена и действует.'
			: form.saved === 'closed'
				? 'Потребность закрыта.'
				: 'Форма сохранена.'}
	/>
{:else if data.created}
	<FormMessage tone="success" text="Потребность сохранена черновиком. Проверьте поля и подтвердите." />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<div class="grid content-start gap-6">
		{#if need.text}
			<Card.Root data-testid="need-parse">
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Текст и разбор</h2></Card.Title>
					<Card.Description>
						{need.parse?.mode === 'model'
							? 'Поля предложила модель; у каждого — слова текста, на которых оно держится.'
							: 'Поля прочитаны правилами без модели; у каждого — слова текста, на которых оно держится.'}
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-4 text-sm">
					<p class="rounded-md border bg-muted/40 p-3 whitespace-pre-line">{need.text}</p>
					{#if need.parse && need.parse.fields.length > 0}
						<ul class="grid gap-2">
							{#each need.parse.fields as field, index (index)}
								<li class="grid gap-0.5" data-parsed={field.path}>
									<span>
										<span class="text-muted-foreground">{FIELDS[field.path] ?? field.path}:</span>
										<span class="font-medium">{fieldValue(field.path, field.value)}</span>
									</span>
									<q class="text-xs text-muted-foreground">{field.quote}</q>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground">Разбор не нашёл в тексте полей формы — заполните их сами.</p>
					{/if}
					{#if need.textCheck.result === 'warnings'}
						<Alert.Root class="border-warning/40 bg-warning-subtle">
							<Alert.Description>
								{need.textCheck.phrases.map((phrase) => `«${phrase.text}»: ${phrase.explanation}`).join(' ')}
							</Alert.Description>
						</Alert.Root>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Форма потребности</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/save" use:enhance class="grid gap-4" data-testid="need-form">
					<CsrfInput />
					<fieldset disabled={need.status === 'closed'} class="grid gap-4">
						<NeedForm
							options={data.options}
							values={{
								...(need.form.specialization ? { specialization: need.form.specialization } : {}),
								...(need.form.grade ? { grade: need.form.grade } : {}),
								skills: need.form.skill_keys.map(skillName).join(', '),
								niceSkills: need.form.nice_skill_keys.map(skillName).join(', '),
								...(need.form.team ? { team: need.form.team } : {}),
								...(need.form.work_format ? { workFormat: need.form.work_format } : {}),
								...(need.form.region_code ? { regionCode: need.form.region_code } : {}),
								...(need.form.salary
									? {
											salary: {
												min: need.form.salary.min,
												max: need.form.salary.max,
												taxBase: need.form.salary.tax_base
											}
										}
									: {}),
								fspRelevant: need.form.fsp_relevant ?? false
							}}
							problems={problem?.fields ?? {}}
						/>
					</fieldset>
					{#if need.status !== 'closed'}
						<div class="flex flex-wrap gap-2">
							<Button type="submit" name="status" value="active">
								{need.status === 'active' ? 'Сохранить' : 'Подтвердить'}
							</Button>
							{#if need.status === 'draft'}
								<Button type="submit" variant="outline">Сохранить черновик</Button>
							{/if}
						</div>
					{/if}
				</form>
				{#if need.status !== 'closed'}
					<form method="POST" action="?/close" use:enhance class="mt-4">
						<CsrfInput />
						<Button type="submit" variant="ghost">Закрыть потребность</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root class="content-start" data-testid="need-categories">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Рекомендованные категории</h2></Card.Title>
			<Card.Description>
				Число — кандидаты с подтверждённой категорией, которых ваша компания видит в каталоге; меньше пяти показывается
				как «&lt; 5».
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.categories.length === 0}
				<p class="text-sm text-muted-foreground">
					Укажите специализацию или обязательные навыки, которые проверяет тест платформы, — тогда появятся категории.
				</p>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root label="Рекомендованные категории">
						<Table.Header>
							<Table.Row>
								<Table.Head>Категория</Table.Head>
								<Table.Head>Кандидатов</Table.Head>
								<Table.Head>С ФСП</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.categories as category (`${category.specialization}:${category.grade}`)}
								<Table.Row data-category={`${category.specialization}:${category.grade}`}>
									<Table.Cell>
										<span class="font-medium"
											>{specializationTitle(category.specialization)} · {gradeTitle(category.grade)}</span
										>
										<span class="block text-xs text-muted-foreground">{BASIS[category.basis]}</span>
									</Table.Cell>
									<Table.Cell>{count(category.candidates)}</Table.Cell>
									<Table.Cell>{count(category.withFsp)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
