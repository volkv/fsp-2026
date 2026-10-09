<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import NeedForm from '$lib/components/employer/need-form.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import VacancyTestSpec from '$lib/components/employer/vacancy-test-spec.svelte';
	import { ModelModeLabel } from '$lib/components/product/index.js';
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
	const gradeRangeTitle = (range: { min: string; max: string }) =>
		range.min === range.max ? gradeTitle(range.min) : `${gradeTitle(range.min)}–${gradeTitle(range.max)}`;
	const roleName = (key: string) => data.options.roles.find((r) => r.key === key)?.name ?? key;
	const FIELDS: Record<string, string> = {
		role_key: 'Роль',
		specialization: 'Специализация',
		grade: 'Грейд',
		skill_keys: 'Обязательный навык',
		nice_skill_keys: 'Желательный навык',
		other_skills: 'Обязательное требование вне таксономии',
		other_nice_skills: 'Желательное требование вне таксономии',
		work_format: 'Формат',
		region_code: 'Регион',
		salary: 'Вилка'
	};
	const BASIS = {
		form: 'по форме',
		role: 'по роли',
		composite_role:
			'составная роль: вторая половина работы — расширение; кандидаты с обеими категориями в подборке идут выше',
		neighbour_grade: 'соседний грейд — расширение: грейд вне заявленного',
		skills: 'предложение по навыкам'
	} as const;
	const own = $derived(data.categories.filter((c) => c.basis === 'form' || c.basis === 'role'));
	/** Why the need has no category of its own; `null` — it has. */
	const notice = $derived.by(() => {
		if (own.length > 0) return null;
		const role = need.form.role_key ? roleName(need.form.role_key) : null;
		switch (data.basis) {
			case 'unsupported_role':
				return `Для роли «${role ?? ''}» нет подтверждаемой категории: ни один тест платформы её работу не проверяет.`;
			case 'closed':
				return `Категория ${data.closed.map(specializationTitle).join(', ')} сейчас закрыта: тест ещё не выпущен.`;
			default:
				return 'Укажите роль или специализацию — тогда у потребности появятся свои категории.';
		}
	});
	const coveredText = (category: { coveredSkills: string[] }) =>
		`подтверждает ${category.coveredSkills.map(skillName).join(', ')} — ${category.coveredSkills.length} из ${need.form.skill_keys.length} обязательных`;
	const STATUS = {
		draft: { label: 'Черновик', tone: 'neutral' },
		active: { label: 'Действует', tone: 'success' },
		closed: { label: 'Закрыта', tone: 'neutral' }
	} as const;

	function fieldValue(path: string, value: unknown): string {
		if (path === 'role_key' && typeof value === 'string') return roleName(value);
		if (path === 'specialization' && typeof value === 'string') return specializationTitle(value);
		if (path === 'grade' && typeof value === 'object' && value !== null && 'min' in value && 'max' in value) {
			return gradeRangeTitle({ min: String(value.min), max: String(value.max) });
		}
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
					{#if need.parse}
						<ModelModeLabel
							reading={need.parse.model
								? {
										modelId: need.parse.model.id,
										runtime: need.parse.model.runtime,
										cached: need.parse.model.cached === true
									}
								: null}
						/>
					{/if}
					<p class="rounded-md border bg-muted/40 p-3 whitespace-pre-line">{need.text.trim()}</p>
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
								...(need.form.role_key ? { roleKey: need.form.role_key } : {}),
								...(need.form.specialization ? { specialization: need.form.specialization } : {}),
								...(need.form.grade ? { grade: need.form.grade } : {}),
								skills: need.form.skill_keys.map(skillName).join(', '),
								niceSkills: need.form.nice_skill_keys.map(skillName).join(', '),
								otherSkills: (need.form.other_skills ?? []).join(', '),
								otherNiceSkills: (need.form.other_nice_skills ?? []).join(', '),
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

	<div class="grid content-start gap-6">
		<Card.Root class="content-start" data-testid="need-categories">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Рекомендованные категории</h2></Card.Title>
				<Card.Description>
					Число — кандидаты с подтверждённой категорией, которых ваша компания видит в каталоге; меньше пяти
					показывается как «&lt; 5».
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-3">
				{#if notice}
					<Alert.Root data-testid="need-categories-notice">
						<Alert.Description>
							{notice}
							{#if data.categories.length > 0}
								Ниже — категории, чьи тесты подтверждают обязательные навыки потребности: это предложение, а не замена
								роли; выберите их сами.
							{/if}
						</Alert.Description>
					</Alert.Root>
				{/if}
				{#if data.categories.length > 0}
					<!-- The basis of a category wraps within its column; the counts keep to their width, so the table fits
					     the narrow column of the page and a phone without scrolling. -->
					<Table.Root label="Рекомендованные категории" class="table-fixed">
						<colgroup>
							<col />
							<col class="w-24" />
							<col class="w-16" />
						</colgroup>
						<Table.Header>
							<Table.Row>
								<Table.Head>Категория</Table.Head>
								<Table.Head class="text-right">Кандидатов</Table.Head>
								<Table.Head class="text-right">С ФСП</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.categories as category (`${category.specialization}:${category.grade}`)}
								<Table.Row data-category={`${category.specialization}:${category.grade}`}>
									<Table.Cell class="whitespace-normal">
										<span class="font-medium"
											>{specializationTitle(category.specialization)} · {gradeTitle(category.grade)}</span
										>
										<span class="block text-xs break-words text-muted-foreground">
											{BASIS[category.basis]}{category.basis === 'skills' ? `: ${coveredText(category)}` : ''}
										</span>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{count(category.candidates)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{count(category.withFsp)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>
		<Card.Root class="content-start" data-testid="need-shortlists">
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Подборка кандидатов</h2></Card.Title>
				<Card.Description>
					Кандидаты отмеченных категорий, ранжированные по соответствию потребности и силе подтверждённого профиля, с
					объяснением «почему подходит». Уточнения сохраняются шагами — подборка не теряется.
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4">
				{#if need.status !== 'closed'}
					<form method="POST" action="?/shortlist" use:enhance class="grid gap-3" data-testid="shortlist-create">
						<CsrfInput />
						<fieldset class="grid gap-2">
							<legend class="mb-1 text-sm font-medium">Категории подборки</legend>
							{#if data.categories.length === 0}
								<p class="text-sm text-muted-foreground">
									Своих категорий нет — подборка будет пустой и скажет почему.
								</p>
							{/if}
							{#each data.categories as category (`${category.specialization}:${category.grade}`)}
								<label class="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										class="size-4"
										name="category"
										value={`${category.specialization}:${category.grade}`}
										checked={category.basis === 'form' || category.basis === 'role'}
									/>
									{specializationTitle(category.specialization)} · {gradeTitle(category.grade)}
									<span class="text-xs text-muted-foreground">({count(category.candidates)})</span>
								</label>
							{/each}
						</fieldset>
						<Button type="submit" class="justify-self-start">Собрать подборку</Button>
					</form>
				{/if}
				{#if data.shortlists.length > 0}
					<ul class="grid gap-2" data-testid="shortlist-list">
						{#each data.shortlists as shortlist (shortlist.id)}
							<li>
								<a
									class="text-sm font-medium text-link underline-offset-4 hover:underline"
									href={resolve('/(app)/company/(member)/shortlists/[id]', { id: shortlist.id })}
								>
									Подборка от {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(shortlist.createdAt)}
								</a>
								<span class="text-xs text-muted-foreground"> · шагов: {shortlist.steps}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>

<VacancyTestSpec spec={data.testSpec} skillNames={data.options.skillNames} subject="потребности" />
