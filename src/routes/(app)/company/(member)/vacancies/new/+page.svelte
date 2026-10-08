<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MarketPosition from '$lib/components/employer/market-position.svelte';
	import { modelReason } from '$lib/components/employer/model.js';
	import { pluralize } from '$lib/components/product/model.js';
	import TextCheckNotice from '$lib/components/employer/text-check-notice.svelte';
	import VacancyForm from '$lib/components/employer/vacancy-form.svelte';
	import VacancyTestSpec from '$lib/components/employer/vacancy-test-spec.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { DegradedModeNotice } from '$lib/components/product/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Draft = NonNullable<Extract<NonNullable<PageProps['form']>, { draft: unknown }>['draft']>;

	/**
	 * The last parse of the text: the range check and a refused save answer with the form values only, and the quotes,
	 * the fields to fill in and the text check of that parse stay on the page while the form still carries its result.
	 */
	let lastDraft = $state<Draft | null>(null);
	$effect.pre(() => {
		if (form && 'draft' in form && form.draft) lastDraft = form.draft;
	});
	const formMlResultId = $derived(
		form && 'mlResultId' in form && typeof form.mlResultId === 'string' ? form.mlResultId : ''
	);
	const draft = $derived(
		form && 'draft' in form && form.draft
			? form.draft
			: lastDraft !== null && formMlResultId !== '' && lastDraft.mlResultId === formMlResultId
				? lastDraft
				: null
	);
	const text = $derived(form && 'text' in form && typeof form.text === 'string' ? form.text : '');
	const values = $derived(form && 'values' in form && form.values ? form.values : (draft?.values ?? data.empty));
	const problems = $derived(form && 'problems' in form && form.problems ? form.problems : {});
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const marketPosition = $derived(form && 'marketPosition' in form ? form.marketPosition : null);
	const mlResultId = $derived(draft?.mlResultId ?? formMlResultId);
	/** The pool of the vacancy as it stands now, before saving: from the parse or from the last recalculation. */
	const pool = $derived(form && 'pool' in form ? form.pool : null);

	const nameOf = (list: { key: string; name: string }[], key: string) =>
		list.find((item) => item.key === key)?.name ?? key;
	/** The category the pool is counted for: role and grade range of the form. */
	const category = $derived(
		[
			values.roleKey === '' ? null : nameOf(data.vocabulary.roles, values.roleKey),
			values.gradeMin === ''
				? null
				: values.gradeMax === '' || values.gradeMax === values.gradeMin
					? nameOf(data.vocabulary.grades, values.gradeMin)
					: `${nameOf(data.vocabulary.grades, values.gradeMin)}–${nameOf(data.vocabulary.grades, values.gradeMax)}`
		]
			.filter((part): part is string => part !== null)
			.join(' · ')
	);

	const MISSING_LABELS: Record<string, string> = {
		title: 'название',
		roleKey: 'роль',
		grade: 'грейд',
		workFormat: 'формат работы',
		employmentForm: 'занятость',
		contractTypes: 'тип договора',
		'salary.bounds': 'границы вилки',
		'salary.currency': 'валюта',
		'salary.period': 'период вилки',
		'salary.taxBase': 'налоговая база вилки'
	};
</script>

<PageHeader
	title="Новая вакансия"
	description="Вставьте текст вакансии как есть — система разложит его на роль, грейд, навыки и вилку с цитатами. Проверьте поля и сохраните черновик."
>
	{#snippet eyebrow()}
		<a class="text-link underline-offset-4 hover:underline" href={resolve('/company/vacancies')}>Вакансии</a>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
	<Card.Root class="self-start">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Вставить текст</h2></Card.Title>
			<Card.Description>Из письма тимлида, с сайта компании — любой текст вакансии.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/parse" use:enhance class="grid gap-4">
				<CsrfInput />
				<Field.Field>
					<Field.Label for="vacancy-text">Текст вакансии</Field.Label>
					<Textarea id="vacancy-text" name="text" value={text} rows={14} maxlength={data.textMaxLength} required />
				</Field.Field>
				<Button type="submit" variant="outline" class="justify-self-start">
					<SparklesIcon aria-hidden="true" />
					Разобрать
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">{draft ? 'Черновик из текста' : 'Поля вакансии'}</h2></Card.Title>
			<Card.Description>
				{draft
					? 'Каждое найденное значение — с цитатой из текста. Чего в тексте нет, система не выдумывает: такие поля выделены.'
					: 'Заполните поля вручную или начните со вставки текста.'}
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4">
			{#if draft}
				<div class="grid gap-3" data-testid="draft" data-mode={draft.mode}>
					{#if draft.mode === 'rules'}
						<DegradedModeNotice operations={['extract']} />
						<p class="text-sm text-muted-foreground" data-testid="rules-mode">
							<span class="font-medium text-foreground">Разобрано правилами, проверьте поля.</span>
							Модель недоступна ({modelReason(draft.modelFailure)}): правила нашли только то, что написано явно, — роль
							по названию, грейд, навыки из справочника, вилку, формат, занятость и договор, каждое с цитатой. Текст
							сохранён в описании.
						</p>
					{/if}
					{#if draft.missing.length > 0}
						<p class="text-sm" data-testid="draft-missing">
							<span class="font-medium">Дозаполните:</span>
							{draft.missing.map((item) => MISSING_LABELS[item] ?? item).join(', ')}.
						</p>
					{/if}
					{#if draft.unrecognizedSkills.length > 0}
						<p class="text-sm text-muted-foreground">
							Нет в справочнике навыков, не добавлены: {draft.unrecognizedSkills.join(', ')}.
						</p>
					{/if}
					{#if draft.negatedSkills.length > 0}
						<p class="text-sm text-muted-foreground">
							Текст говорит, что не требуется: {draft.negatedSkills.join(', ')} — требованием не стало.
						</p>
					{/if}
					<TextCheckNotice check={draft.textCheck} />
				</div>
			{/if}
			{#if pool}
				<p class="flex items-start gap-2 text-sm" data-testid="pool-estimate" data-pool-status={pool.status}>
					<UsersIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span>
						{#if category !== ''}
							<span class="block"><span class="text-muted-foreground">Категория:</span> {category}</span>
						{/if}
						{#if pool.status === 'counted'}
							В пуле ≈<span class="font-semibold numeric">{pool.count}</span>
							{pluralize(pool.count, [
								'подтверждённый кандидат',
								'подтверждённых кандидата',
								'подтверждённых кандидатов'
							])}
						{:else if pool.status === 'below_threshold'}
							В пуле меньше {pool.threshold} подтверждённых кандидатов
						{:else}
							Пул не считается: у вакансии нет обязательных навыков
						{/if}
						{#if pool.status !== 'insufficient_data'}
							<span class="block text-xs text-muted-foreground">
								оценка до сохранения, без смысловой близости текста; точное число посчитается после сохранения
							</span>
						{/if}
					</span>
				</p>
			{/if}
			{#key mlResultId + JSON.stringify(values)}
				<VacancyForm
					action="?/create"
					{values}
					vocabulary={data.vocabulary}
					{problems}
					quotes={draft?.quotes ?? {}}
					missing={draft?.missing ?? []}
					minorTermsAccepted={data.minorTermsAccepted}
					submitLabel="Сохранить черновик"
				>
					{#snippet salaryAside()}
						{#if marketPosition}<MarketPosition position={marketPosition} />{/if}
						<Button
							type="submit"
							variant="outline"
							size="sm"
							formaction="?/position"
							formnovalidate
							class="justify-self-start"
						>
							{marketPosition ? 'Пересчитать положение вилки' : 'Сравнить вилку с рынком'}
						</Button>
					{/snippet}
					{#snippet hidden()}
						{#if mlResultId !== ''}<input type="hidden" name="mlResultId" value={mlResultId} />{/if}
					{/snippet}
				</VacancyForm>
			{/key}
		</Card.Content>
	</Card.Root>
</div>

{#if draft}
	<VacancyTestSpec
		spec={draft.testSpec}
		skillNames={draft.skillNames}
		note="По разобранному тексту, до правок формы; после сохранения страница вакансии покажет тест по её полям."
	/>
{/if}
