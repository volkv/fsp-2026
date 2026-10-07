<script lang="ts">
	import { enhance } from '$app/forms';
	import SendIcon from '@lucide/svelte/icons/send';
	import { pluralize } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import NativeSelect from './native-select.svelte';

	/**
	 * The terms of an offer version (domain 13.5): what the company offers — title, description, a range in roubles per
	 * month with the tax base it chooses, the work format, how to reach it — and «why you», each point with the place of
	 * the profile it comes from. A vacancy is optional. Sent terms never change: a revision is a new version.
	 */
	interface Props {
		action: string;
		/** Own published vacancies the offer may name; empty — the choice is not shown. */
		vacancies: { id: string; title: string }[];
		workFormats: { key: string; name: string }[];
		/** Points of «why you» the profile supports; the employer picks 1–5 and may reword them. */
		whyYouOptions: { key: string; text: string }[];
		initial?: {
			title: string;
			description: string;
			salaryMin: number | null;
			salaryMax: number | null;
			taxBase: 'gross' | 'net';
			workFormat: string | null;
			contactKind: 'email' | 'phone' | 'telegram' | 'other';
			contactValue: string;
			contactNote: string | null;
			vacancyId: string | null;
			message: string | null;
			/** Keys of the points picked to start with. */
			whyYou: string[];
		};
		responseWindowHours: number | null;
		/** Keys of the points picked to start with when there is no previous version (an offer from a shortlist). */
		preselected?: string[];
		/** The need the offer is made for (an offer from a shortlist). */
		needId?: string | null;
		/** The work format and the range of the need, to start with when there is no previous version. */
		needTerms?: {
			workFormat: string | null;
			salary: { min: number; max: number; taxBase: 'gross' | 'net' } | null;
		} | null;
		/** Field problems by the path of the service (`title`, `salary_min`, `why_you.0.text`, …). */
		problems?: Record<string, string>;
		submitLabel?: string;
	}

	let {
		action,
		vacancies,
		workFormats,
		whyYouOptions,
		initial,
		responseWindowHours,
		preselected = [],
		needId = null,
		needTerms = null,
		problems = {},
		submitLabel = 'Отправить предложение'
	}: Props = $props();

	const id = $props.id();
	const CONTACT_KINDS = [
		{ key: 'email', name: 'Почта' },
		{ key: 'telegram', name: 'Telegram' },
		{ key: 'phone', name: 'Телефон' },
		{ key: 'other', name: 'Другое' }
	] as const;
	const responseWindow = $derived.by(() => {
		if (responseWindowHours === null) return null;
		if (responseWindowHours % 24 === 0) {
			const days = responseWindowHours / 24;
			return `${days} ${pluralize(days, ['день', 'дня', 'дней'])}`;
		}
		return `${responseWindowHours} ч`;
	});
	const whyYouProblem = $derived(
		problems.why_you ?? Object.entries(problems).find(([path]) => path.startsWith('why_you.'))?.[1] ?? undefined
	);
	const salaryMin = $derived(initial ? initial.salaryMin : (needTerms?.salary?.min ?? null));
	const salaryMax = $derived(initial ? initial.salaryMax : (needTerms?.salary?.max ?? null));
	const contactProblem = $derived(
		problems['contact_method.value'] ?? problems['contact_method.kind'] ?? problems['contact_method.note']
	);
</script>

<form method="POST" {action} use:enhance class="grid gap-4" data-testid="offer-form">
	<CsrfInput />
	{#if needId}<input type="hidden" name="needId" value={needId} />{/if}
	<Field.Field data-invalid={problems.title !== undefined}>
		<Field.Label for="{id}-title">Название предложения</Field.Label>
		<Input id="{id}-title" name="title" maxlength={120} value={initial?.title ?? ''} required />
		{#if problems.title}<Field.Error>{problems.title}</Field.Error>{/if}
	</Field.Field>
	<Field.Field data-invalid={problems.description !== undefined}>
		<Field.Label for="{id}-description">Описание: задачи, команда, условия</Field.Label>
		<Textarea
			id="{id}-description"
			name="description"
			rows={5}
			minlength={50}
			maxlength={5000}
			value={initial?.description ?? ''}
			required
		/>
		<Field.Description>От 50 до 5000 символов.</Field.Description>
		{#if problems.description}<Field.Error>{problems.description}</Field.Error>{/if}
	</Field.Field>

	<fieldset class="grid gap-3">
		<legend class="mb-1 text-sm font-medium">Зарплата в рублях в месяц</legend>
		<div class="grid gap-3 sm:grid-cols-2">
			<Field.Field data-invalid={problems.salary_min !== undefined}>
				<Field.Label for="{id}-min">От, ₽</Field.Label>
				<Input
					id="{id}-min"
					name="salaryMin"
					inputmode="numeric"
					value={salaryMin === null ? '' : String(salaryMin)}
					required
				/>
				{#if problems.salary_min}<Field.Error>{problems.salary_min}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={problems.salary_max !== undefined}>
				<Field.Label for="{id}-max">До, ₽</Field.Label>
				<Input
					id="{id}-max"
					name="salaryMax"
					inputmode="numeric"
					value={salaryMax === null ? '' : String(salaryMax)}
					required
				/>
				{#if problems.salary_max}<Field.Error>{problems.salary_max}</Field.Error>{/if}
			</Field.Field>
		</div>
		<Field.Field data-invalid={problems.salary_tax_base !== undefined}>
			<Field.Label for="{id}-tax">Налоговая база</Field.Label>
			<NativeSelect
				id="{id}-tax"
				name="salaryTaxBase"
				value={initial?.taxBase ?? needTerms?.salary?.taxBase ?? 'gross'}
			>
				<option value="gross">До вычета НДФЛ</option>
				<option value="net">На руки</option>
			</NativeSelect>
		</Field.Field>
		{#if problems.salary_currency}<Field.Error>{problems.salary_currency}</Field.Error>{/if}
	</fieldset>

	<div class="grid gap-3 sm:grid-cols-2">
		<Field.Field data-invalid={problems.work_format !== undefined}>
			<Field.Label for="{id}-format">Формат работы</Field.Label>
			<NativeSelect
				id="{id}-format"
				name="workFormat"
				value={initial?.workFormat ?? needTerms?.workFormat ?? workFormats[0]?.key ?? ''}
			>
				{#each workFormats as format (format.key)}
					<option value={format.key}>{format.name}</option>
				{/each}
			</NativeSelect>
			{#if problems.work_format}<Field.Error>{problems.work_format}</Field.Error>{/if}
		</Field.Field>
		{#if vacancies.length > 0}
			<Field.Field data-invalid={problems.vacancy_id !== undefined}>
				<Field.Label for="{id}-vacancy">Вакансия (необязательно)</Field.Label>
				<NativeSelect id="{id}-vacancy" name="vacancyId" value={initial?.vacancyId ?? ''}>
					<option value="">Без вакансии</option>
					{#each vacancies as vacancy (vacancy.id)}
						<option value={vacancy.id}>{vacancy.title}</option>
					{/each}
				</NativeSelect>
				{#if problems.vacancy_id}<Field.Error>{problems.vacancy_id}</Field.Error>{/if}
			</Field.Field>
		{/if}
	</div>

	<fieldset class="grid gap-3">
		<legend class="mb-1 text-sm font-medium">Как связаться с компанией</legend>
		<div class="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
			<Field.Field>
				<Field.Label for="{id}-contact-kind">Способ</Field.Label>
				<NativeSelect id="{id}-contact-kind" name="contactKind" value={initial?.contactKind ?? 'email'}>
					{#each CONTACT_KINDS as kind (kind.key)}
						<option value={kind.key}>{kind.name}</option>
					{/each}
				</NativeSelect>
			</Field.Field>
			<Field.Field data-invalid={contactProblem !== undefined}>
				<Field.Label for="{id}-contact-value">Контакт</Field.Label>
				<Input
					id="{id}-contact-value"
					name="contactValue"
					maxlength={200}
					value={initial?.contactValue ?? ''}
					required
				/>
			</Field.Field>
		</div>
		<Field.Field>
			<Field.Label for="{id}-contact-note">Пояснение (необязательно)</Field.Label>
			<Input id="{id}-contact-note" name="contactNote" maxlength={500} value={initial?.contactNote ?? ''} />
		</Field.Field>
		{#if contactProblem}<Field.Error>{contactProblem}</Field.Error>{/if}
		<p class="text-xs text-muted-foreground">Кандидат видит контакт компании сразу, до ответа.</p>
	</fieldset>

	<fieldset class="grid gap-2" data-testid="why-you">
		<legend class="mb-1 text-sm font-medium">Почему вы: что компания увидела в профиле (1–5 пунктов)</legend>
		{#if whyYouOptions.length === 0}
			<p class="text-sm text-muted-foreground">
				В карточке нет пунктов с источником: «почему вы» без источника не отправляется.
			</p>
		{/if}
		{#each whyYouOptions as option (option.key)}
			<div class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
				<input
					type="checkbox"
					class="mt-2.5 size-4"
					name="whyYou"
					value={option.key}
					aria-label={`Включить пункт: ${option.text}`}
					checked={initial?.whyYou.includes(option.key) ?? preselected.includes(option.key)}
				/>
				<Input name={`whyYouText:${option.key}`} maxlength={300} value={option.text} aria-label="Текст пункта" />
			</div>
		{/each}
		{#if whyYouProblem}<Field.Error>{whyYouProblem}</Field.Error>{/if}
	</fieldset>

	<Field.Field data-invalid={problems.message !== undefined}>
		<Field.Label for="{id}-message">Личное сообщение (необязательно)</Field.Label>
		<Textarea id="{id}-message" name="message" rows={3} maxlength={2000} value={initial?.message ?? ''} />
		{#if problems.message}<Field.Error>{problems.message}</Field.Error>{/if}
	</Field.Field>
	{#if responseWindow}
		<p class="text-sm">Срок ответа — <span class="font-medium">{responseWindow}</span> с момента отправки.</p>
	{/if}
	<Button type="submit" class="justify-self-start">
		<SendIcon aria-hidden="true" />
		{submitLabel}
	</Button>
</form>
