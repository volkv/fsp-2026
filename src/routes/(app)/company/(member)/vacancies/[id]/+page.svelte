<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ScanTextIcon from '@lucide/svelte/icons/scan-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PoolCounter from '$lib/components/employer/pool-counter.svelte';
	import TextCheckNotice from '$lib/components/employer/text-check-notice.svelte';
	import VacancyForm from '$lib/components/employer/vacancy-form.svelte';
	import VacancyStatus from '$lib/components/employer/vacancy-status.svelte';
	import VacancyTestSpec from '$lib/components/employer/vacancy-test-spec.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { RecommendationNotice, SalaryRange } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const vacancy = $derived(data.vacancy);
	const labels = $derived(data.labels);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const editValues = $derived(form && 'values' in form && form.values ? form.values : data.form);
	const editProblems = $derived(form && 'problems' in form && form.problems ? form.problems : {});
	const needsConfirmation = $derived(
		vacancy.textCheck.result === 'warnings' && vacancy.textCheck.warnings_confirmed === null
	);
	const moderation = $derived(vacancy.textCheck.moderation);
	const decision = $derived(moderation?.decision ?? null);
	const UPDATED: Record<string, string> = {
		stayed_pending:
			'Изменения сохранены, но в тексте остались недопустимые требования: вакансия по-прежнему на модерации.',
		entered_pending: 'Изменения сохранены: в тексте есть недопустимые требования, вакансия ушла на модерацию.',
		left_published: 'Текст прошёл проверку: вакансия вышла из модерации и снова в каталоге.',
		left_paused: 'Текст прошёл проверку: вакансия вышла из модерации и осталась приостановленной.',
		left_draft: 'Текст прошёл проверку, но компания сейчас не проверена: вакансия сохранена черновиком.'
	};
	const updatedText = $derived(
		form && 'outcome' in form && form.outcome !== undefined ? UPDATED[form.outcome] : undefined
	);
	const skills = (keys: string[]) => keys.map((key) => labels.skills[key] ?? key);
	const grade = $derived(
		vacancy.gradeMin === vacancy.gradeMax
			? (labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin)
			: `${labels.grades[vacancy.gradeMin] ?? vacancy.gradeMin} – ${labels.grades[vacancy.gradeMax] ?? vacancy.gradeMax}`
	);
</script>

<PageHeader title={vacancy.title}>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/vacancies')}>Вакансии</a>
	{/snippet}
	{#snippet actions()}
		<VacancyStatus status={vacancy.status} />
		{#if vacancy.status !== 'closed'}
			<a
				class={buttonVariants()}
				href={resolve('/(app)/company/(member)/vacancies/[id]/candidates', { id: vacancy.id })}
			>
				<SearchIcon aria-hidden="true" />
				Кандидаты под вакансию
			</a>
		{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if data.created && !form}
	<FormMessage tone="success" text="Черновик сохранён. Проверьте поля и опубликуйте вакансию." />
{:else if form && 'published' in form}
	<FormMessage
		tone="success"
		text={form.published === 'published'
			? 'Вакансия опубликована.'
			: 'Вакансия отправлена на модерацию: в тексте есть недопустимые требования.'}
	/>
{:else if form && 'updated' in form}
	<FormMessage
		tone="success"
		text={updatedText ?? 'Изменения сохранены: пул и соответствие пересчитываются для новой версии.'}
	/>
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Требования и условия</h2></Card.Title>
			<Card.Description>
				Версия {vacancy.revision}{vacancy.fromText ? ' · собрана из вставленного текста' : ''}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<dl class="grid gap-4 text-sm sm:grid-cols-2">
				<div>
					<dt class="text-muted-foreground">Роль</dt>
					<dd class="font-medium">{labels.roles[vacancy.roleKey] ?? vacancy.roleKey}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Грейд</dt>
					<dd class="font-medium">{grade}</dd>
				</div>
				<div class="sm:col-span-2">
					<dt class="text-muted-foreground">Обязательные навыки</dt>
					<dd class="mt-1 flex flex-wrap gap-1">
						{#each skills(vacancy.requiredSkillKeys) as skill (skill)}
							<span class="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">{skill}</span>
						{:else}
							<span class="text-muted-foreground">не указаны</span>
						{/each}
					</dd>
				</div>
				<div class="sm:col-span-2">
					<dt class="text-muted-foreground">Желательные навыки</dt>
					<dd class="mt-1 flex flex-wrap gap-1">
						{#each skills(vacancy.niceSkillKeys) as skill (skill)}
							<span class="rounded-md border px-2 py-0.5 font-mono text-xs">{skill}</span>
						{:else}
							<span class="text-muted-foreground">не указаны</span>
						{/each}
					</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Вилка</dt>
					<dd><SalaryRange salary={vacancy.salary} /></dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Формат и занятость</dt>
					<dd>
						{labels.terms.work_format[vacancy.workFormat] ?? vacancy.workFormat} · {labels.terms.employment_form[
							vacancy.employmentForm
						] ?? vacancy.employmentForm}
					</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Договор</dt>
					<dd>
						{vacancy.contractTypes.map((key) => labels.terms.contract_type[key] ?? key).join(', ')}
					</dd>
				</div>
				{#if vacancy.cityId}
					<div>
						<dt class="text-muted-foreground">Город</dt>
						<dd>{vacancy.cityId}</dd>
					</div>
				{/if}
				<div>
					<dt class="text-muted-foreground">Возраст кандидатов</dt>
					<dd data-testid="vacancy-min-age">
						{vacancy.minAge === null ? 'только совершеннолетние' : `с ${vacancy.minAge} лет`}
					</dd>
				</div>
			</dl>
		</Card.Content>
	</Card.Root>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Публикация</h2></Card.Title>
				{#if vacancy.publishedAt}
					<Card.Description>Опубликована {formatDateTime(vacancy.publishedAt)}</Card.Description>
				{/if}
			</Card.Header>
			<Card.Content class="grid gap-4">
				<PoolCounter pool={vacancy.pool} />
				{#if vacancy.status === 'pending_moderation'}
					<Alert.Root class="border-warning/40 bg-warning-subtle" data-testid="moderation-status" data-state="pending">
						<ScanTextIcon aria-hidden="true" class="text-warning" />
						<Alert.Title>На модерации у оператора ФСП</Alert.Title>
						<Alert.Description class="grid gap-1">
							{#if moderation}<p>С {formatDateTime(moderation.opened_at)}.</p>{/if}
							<p>
								Оператор решит, законно ли требование, которое нашла проверка текста. Можно не ждать: исправьте текст
								ниже — если проверка пройдёт, вакансия сразу вернётся {moderation?.resume_to === 'paused'
									? 'в паузу'
									: 'в каталог'}.
							</p>
						</Alert.Description>
					</Alert.Root>
				{:else if decision?.outcome === 'returned' && vacancy.status === 'draft'}
					<Alert.Root class="border-warning/40 bg-warning-subtle" data-testid="moderation-status" data-state="returned">
						<ScanTextIcon aria-hidden="true" class="text-warning" />
						<Alert.Title>Оператор ФСП вернул вакансию на правку</Alert.Title>
						<Alert.Description class="grid gap-1">
							<p class="whitespace-pre-line">{decision.reason}</p>
							<p class="text-muted-foreground">
								{formatDateTime(decision.at)}. Исправьте текст и опубликуйте снова.
							</p>
						</Alert.Description>
					</Alert.Root>
				{:else if decision?.outcome === 'rejected' && vacancy.status === 'closed'}
					<Alert.Root
						class="border-destructive/40 bg-danger-subtle"
						data-testid="moderation-status"
						data-state="rejected"
					>
						<ScanTextIcon aria-hidden="true" class="text-destructive" />
						<Alert.Title>Оператор ФСП отклонил вакансию</Alert.Title>
						<Alert.Description class="grid gap-1">
							<p class="whitespace-pre-line">{decision.reason}</p>
							<p class="text-muted-foreground">{formatDateTime(decision.at)}</p>
						</Alert.Description>
					</Alert.Root>
				{:else if decision?.outcome === 'published'}
					<Alert.Root data-testid="moderation-status" data-state="published">
						<ScanTextIcon aria-hidden="true" />
						<Alert.Title>Оператор ФСП допустил требования вакансии</Alert.Title>
						<Alert.Description class="grid gap-1">
							{#if decision.reason}<p class="whitespace-pre-line">{decision.reason}</p>{/if}
							<p class="text-muted-foreground">
								{formatDateTime(decision.at)}. Пока эти формулировки не меняются, повторная модерация не нужна.
							</p>
						</Alert.Description>
					</Alert.Root>
				{/if}
				<TextCheckNotice check={vacancy.textCheck} />
				{#if vacancy.status === 'draft'}
					<form method="POST" action="?/publish" use:enhance class="grid gap-3">
						<CsrfInput />
						{#if needsConfirmation}
							<label class="flex items-start gap-2 text-sm">
								<input type="checkbox" name="confirmWarnings" class="mt-0.5 size-4 accent-primary" required />
								Формулировки связаны с деловыми качествами — подтверждаю
							</label>
						{/if}
						<Button type="submit" class="justify-self-start">Опубликовать</Button>
					</form>
				{/if}
				<div class="flex flex-wrap gap-2">
					{#if vacancy.status === 'published'}
						<form method="POST" action="?/pause" use:enhance>
							<CsrfInput />
							<Button type="submit" variant="outline">Приостановить</Button>
						</form>
					{:else if vacancy.status === 'paused'}
						<form method="POST" action="?/resume" use:enhance>
							<CsrfInput />
							<Button type="submit" variant="outline">Вернуть в каталог</Button>
						</form>
					{/if}
					{#if vacancy.status !== 'closed'}
						<form method="POST" action="?/close" use:enhance>
							<CsrfInput />
							<Button type="submit" variant="ghost" class="text-destructive">Закрыть вакансию</Button>
						</form>
					{/if}
				</div>
				<RecommendationNotice compact />
			</Card.Content>
		</Card.Root>
	</div>
</div>

<VacancyTestSpec spec={data.testSpec} skillNames={labels.skills} />

{#if vacancy.status !== 'closed'}
	<details class="group rounded-xl border bg-card" open={Object.keys(editProblems).length > 0}>
		<summary class="cursor-pointer px-6 py-4 font-heading text-h3">Изменить вакансию</summary>
		<div class="border-t px-6 py-6">
			{#key JSON.stringify(editValues)}
				<VacancyForm
					action="?/update"
					values={editValues}
					vocabulary={data.vocabulary}
					problems={editProblems}
					minorTermsAccepted={data.minorTermsAccepted}
					submitLabel="Сохранить изменения"
				>
					{#snippet footer()}
						<input type="hidden" name="previousStatus" value={vacancy.status} />
						{#if vacancy.status === 'published' || vacancy.status === 'paused' || vacancy.status === 'pending_moderation'}
							<label class="flex items-start gap-2 text-sm">
								<input type="checkbox" name="confirmWarnings" class="mt-0.5 size-4 accent-primary" />
								Если в новом тексте найдутся спорные формулировки — они связаны с деловыми качествами, подтверждаю
							</label>
						{/if}
					{/snippet}
				</VacancyForm>
			{/key}
		</div>
	</details>
{/if}
