<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cn } from '$lib/components/utils.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FieldQuote from './field-quote.svelte';
	import FieldStatus from './field-status.svelte';
	import { CURRENCIES, PERIODS, type VacancyFormValues, type VocabularyView } from './model.js';
	import NativeSelect from './native-select.svelte';

	interface Props {
		action: string;
		values: VacancyFormValues;
		vocabulary: VocabularyView;
		/** Field problems by the path of the service input (`salary.min`, `requiredSkillKeys`, …). */
		problems?: Record<string, string>;
		/** Quotes of the pasted text behind the prefilled fields. */
		quotes?: Partial<Record<keyof VacancyFormValues, string[]>>;
		/** Fields the pasted text did not state (`missing` of the draft): the employer fills them in. */
		missing?: string[];
		submitLabel: string;
		/** The company accepted the offer on the work of minors: only then a vacancy may be open from 14–16 years. */
		minorTermsAccepted: boolean;
		/** Under the salary range, inside the form: its position against the market and the button that evaluates it. */
		salaryAside?: Snippet;
		hidden?: Snippet;
		footer?: Snippet;
	}

	let {
		action,
		values,
		vocabulary,
		problems = {},
		quotes = {},
		missing = [],
		submitLabel,
		minorTermsAccepted,
		salaryAside,
		hidden,
		footer
	}: Props = $props();

	const id = $props.id();

	/** Ages a vacancy for minors may start from (domain 7.3). */
	const MIN_AGES = [16, 15, 14] as const;

	/** `missing` of the draft → fields of the form. */
	const MISSING_FIELDS: Record<string, (keyof VacancyFormValues)[]> = {
		title: ['title'],
		roleKey: ['roleKey'],
		grade: ['gradeMin', 'gradeMax'],
		workFormat: ['workFormat'],
		employmentForm: ['employmentForm'],
		contractTypes: ['contractTypes'],
		'salary.bounds': ['salaryMin', 'salaryMax'],
		'salary.currency': ['currency'],
		'salary.period': ['period'],
		'salary.taxBase': ['taxBase']
	};
	const toFill = $derived(new Set(missing.flatMap((item) => MISSING_FIELDS[item] ?? [])));

	const PATHS: Partial<Record<keyof VacancyFormValues, string>> = {
		requiredSkills: 'requiredSkillKeys',
		niceSkills: 'niceSkillKeys',
		salaryMin: 'salary.min',
		salaryMax: 'salary.max',
		currency: 'salary.currency',
		period: 'salary.period',
		taxBase: 'salary.taxBase'
	};
	const problemOf = (field: keyof VacancyFormValues): string | undefined => problems[PATHS[field] ?? field];
	const invalid = (field: keyof VacancyFormValues) => problemOf(field) !== undefined;
	const fillClass = (field: keyof VacancyFormValues) =>
		toFill.has(field) ? 'rounded-md ring-2 ring-warning/60 ring-offset-2 ring-offset-background' : '';
</script>

<form method="POST" {action} use:enhance class="grid gap-6">
	<CsrfInput />
	{@render hidden?.()}

	<Field.Group>
		<Field.Field data-invalid={invalid('title')} class={fillClass('title')}>
			<Field.Label for="{id}-title">Название вакансии</Field.Label>
			<Input id="{id}-title" name="title" value={values.title} maxlength={200} required />
			<FieldQuote quotes={quotes.title} />
			<FieldStatus problem={problemOf('title')} toFill={toFill.has('title')} />
		</Field.Field>

		<div class="grid gap-4 sm:grid-cols-3">
			<Field.Field data-invalid={invalid('roleKey')} class={fillClass('roleKey')}>
				<Field.Label for="{id}-role">Роль</Field.Label>
				<NativeSelect id="{id}-role" name="roleKey" value={values.roleKey} required>
					<option value="">— выберите —</option>
					{#each vocabulary.roles as role (role.key)}
						<option value={role.key}>{role.name}</option>
					{/each}
				</NativeSelect>
				<FieldStatus problem={problemOf('roleKey')} toFill={toFill.has('roleKey')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('gradeMin')} class={fillClass('gradeMin')}>
				<Field.Label for="{id}-grade-min">Грейд от</Field.Label>
				<NativeSelect id="{id}-grade-min" name="gradeMin" value={values.gradeMin} required>
					<option value="">— выберите —</option>
					{#each vocabulary.grades as grade (grade.key)}
						<option value={grade.key}>{grade.name}</option>
					{/each}
				</NativeSelect>
				<FieldQuote quotes={quotes.gradeMin} />
				<FieldStatus problem={problemOf('gradeMin')} toFill={toFill.has('gradeMin')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('gradeMax')} class={fillClass('gradeMax')}>
				<Field.Label for="{id}-grade-max">Грейд до</Field.Label>
				<NativeSelect id="{id}-grade-max" name="gradeMax" value={values.gradeMax} required>
					<option value="">— выберите —</option>
					{#each vocabulary.grades as grade (grade.key)}
						<option value={grade.key}>{grade.name}</option>
					{/each}
				</NativeSelect>
				<FieldStatus problem={problemOf('gradeMax')} toFill={toFill.has('gradeMax')} />
			</Field.Field>
		</div>

		<Field.Field data-invalid={invalid('requiredSkills')}>
			<Field.Label for="{id}-required">Обязательные навыки</Field.Label>
			<Input
				id="{id}-required"
				name="requiredSkills"
				value={values.requiredSkills}
				aria-describedby="{id}-skills-hint"
				placeholder="Go, PostgreSQL, Kafka"
			/>
			<FieldQuote quotes={quotes.requiredSkills} />
			<FieldStatus problem={problemOf('requiredSkills')} toFill={toFill.has('requiredSkills')} />
		</Field.Field>
		<Field.Field data-invalid={invalid('niceSkills')}>
			<Field.Label for="{id}-nice">Желательные навыки</Field.Label>
			<Input
				id="{id}-nice"
				name="niceSkills"
				value={values.niceSkills}
				aria-describedby="{id}-skills-hint"
				placeholder="Kubernetes"
			/>
			<FieldQuote quotes={quotes.niceSkills} />
			<FieldStatus problem={problemOf('niceSkills')} toFill={toFill.has('niceSkills')} />
			<Field.Description id="{id}-skills-hint">
				Через запятую, названиями или синонимами из справочника навыков. Требования — решение компании: подбор считается
				по ним.
			</Field.Description>
		</Field.Field>
	</Field.Group>

	<Field.Set>
		<Field.Legend variant="label">Вилка</Field.Legend>
		<div class="grid gap-4 sm:grid-cols-4">
			<Field.Field data-invalid={invalid('salaryMin')} class={fillClass('salaryMin')}>
				<Field.Label for="{id}-salary-min">От</Field.Label>
				<Input id="{id}-salary-min" name="salaryMin" value={values.salaryMin} inputmode="numeric" required />
				<FieldQuote quotes={quotes.salaryMin} />
				<FieldStatus problem={problemOf('salaryMin')} toFill={toFill.has('salaryMin')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('salaryMax')} class={fillClass('salaryMax')}>
				<Field.Label for="{id}-salary-max">До</Field.Label>
				<Input id="{id}-salary-max" name="salaryMax" value={values.salaryMax} inputmode="numeric" required />
				<FieldStatus problem={problemOf('salaryMax')} toFill={toFill.has('salaryMax')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('currency')} class={fillClass('currency')}>
				<Field.Label for="{id}-currency">Валюта</Field.Label>
				<NativeSelect id="{id}-currency" name="currency" value={values.currency} required>
					<option value="">— выберите —</option>
					{#each CURRENCIES as currency (currency.key)}
						<option value={currency.key}>{currency.name}</option>
					{/each}
				</NativeSelect>
				<FieldStatus problem={problemOf('currency')} toFill={toFill.has('currency')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('period')} class={fillClass('period')}>
				<Field.Label for="{id}-period">Период</Field.Label>
				<NativeSelect id="{id}-period" name="period" value={values.period} required>
					<option value="">— выберите —</option>
					{#each PERIODS as period (period.key)}
						<option value={period.key}>{period.name}</option>
					{/each}
				</NativeSelect>
				<FieldStatus problem={problemOf('period')} toFill={toFill.has('period')} />
			</Field.Field>
		</div>
		<fieldset class={cn('grid gap-2', fillClass('taxBase'))}>
			<legend class="mb-2 text-sm font-medium">Налоговая база</legend>
			<div class="flex flex-wrap gap-4">
				<label class="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name="taxBase"
						value="net"
						checked={values.taxBase === 'net'}
						class="size-4 accent-primary"
					/>
					на руки
				</label>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="radio"
						name="taxBase"
						value="gross"
						checked={values.taxBase === 'gross'}
						class="size-4 accent-primary"
					/>
					до вычета НДФЛ
				</label>
			</div>
			<FieldStatus problem={problemOf('taxBase')} toFill={toFill.has('taxBase')} />
		</fieldset>
		<Field.Description>
			Кандидат получит приглашение с вилкой из вакансии; нижняя граница приглашения не опускается ниже неё.
		</Field.Description>
		{@render salaryAside?.()}
	</Field.Set>

	<Field.Set>
		<Field.Legend variant="label">Условия работы</Field.Legend>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field data-invalid={invalid('workFormat')} class={fillClass('workFormat')}>
				<Field.Label for="{id}-format">Формат</Field.Label>
				<NativeSelect id="{id}-format" name="workFormat" value={values.workFormat} required>
					<option value="">— выберите —</option>
					{#each vocabulary.terms.work_format as term (term.key)}
						<option value={term.key}>{term.name}</option>
					{/each}
				</NativeSelect>
				<FieldQuote quotes={quotes.workFormat} />
				<FieldStatus problem={problemOf('workFormat')} toFill={toFill.has('workFormat')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('employmentForm')} class={fillClass('employmentForm')}>
				<Field.Label for="{id}-employment">Занятость</Field.Label>
				<NativeSelect id="{id}-employment" name="employmentForm" value={values.employmentForm} required>
					<option value="">— выберите —</option>
					{#each vocabulary.terms.employment_form as term (term.key)}
						<option value={term.key}>{term.name}</option>
					{/each}
				</NativeSelect>
				<FieldQuote quotes={quotes.employmentForm} />
				<FieldStatus problem={problemOf('employmentForm')} toFill={toFill.has('employmentForm')} />
			</Field.Field>
		</div>
		<fieldset class={cn('grid gap-2', fillClass('contractTypes'))}>
			<legend class="mb-2 text-sm font-medium">Тип договора</legend>
			<div class="flex flex-wrap gap-4">
				{#each vocabulary.terms.contract_type as term (term.key)}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="contractTypes"
							value={term.key}
							checked={values.contractTypes.includes(term.key)}
							class="size-4 accent-primary"
						/>
						{term.name}
					</label>
				{/each}
			</div>
			<FieldQuote quotes={quotes.contractTypes} />
			<FieldStatus problem={problemOf('contractTypes')} toFill={toFill.has('contractTypes')} />
		</fieldset>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field data-invalid={invalid('cityId')}>
				<Field.Label for="{id}-city">Город (необязательно)</Field.Label>
				<Input id="{id}-city" name="cityId" value={values.cityId} maxlength={100} />
				<FieldQuote quotes={quotes.cityId} />
				<FieldStatus problem={problemOf('cityId')} toFill={toFill.has('cityId')} />
			</Field.Field>
			<Field.Field data-invalid={invalid('timezoneOverlapHours')}>
				<Field.Label for="{id}-overlap">Пересечение по времени, ч (необязательно)</Field.Label>
				<Input id="{id}-overlap" name="timezoneOverlapHours" value={values.timezoneOverlapHours} inputmode="numeric" />
				<FieldStatus problem={problemOf('timezoneOverlapHours')} toFill={toFill.has('timezoneOverlapHours')} />
			</Field.Field>
		</div>
		<Field.Field data-invalid={invalid('minAge')}>
			<Field.Label for="{id}-min-age">Возраст кандидатов</Field.Label>
			<NativeSelect id="{id}-min-age" name="minAge" value={values.minAge} aria-describedby="{id}-min-age-hint">
				<option value="">Только совершеннолетние (18+)</option>
				{#each MIN_AGES as age (age)}
					<option value={String(age)} disabled={!minorTermsAccepted && values.minAge !== String(age)}>
						С {age} лет
					</option>
				{/each}
			</NativeSelect>
			<FieldStatus problem={problemOf('minAge')} toFill={false} />
			<Field.Description id="{id}-min-age-hint">
				{#if minorTermsAccepted}
					Кандидатов 14–17 лет компания видит только в подборе к этой вакансии и только не младше указанного возраста.
				{:else}
					Вакансия для кандидатов 14–17 лет требует оферты о соблюдении главы 42 ТК РФ — её принимает владелец компании
					в <a class="text-link underline underline-offset-4" href={resolve('/company/profile')}>профиле</a>.
				{/if}
			</Field.Description>
		</Field.Field>
	</Field.Set>

	<Field.Field data-invalid={invalid('description')}>
		<Field.Label for="{id}-description">Описание</Field.Label>
		<Textarea id="{id}-description" name="description" value={values.description} rows={10} required />
		<FieldStatus problem={problemOf('description')} toFill={toFill.has('description')} />
	</Field.Field>

	{@render footer?.()}

	<Button type="submit" class="justify-self-start">{submitLabel}</Button>
</form>
