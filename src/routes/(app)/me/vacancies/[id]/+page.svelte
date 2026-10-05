<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { candidateMatchView } from '$lib/components/candidate/match.js';
	import {
		DISCLOSURE_FIELDS,
		gradeName,
		REQUIRED_DISCLOSURE,
		skillName,
		type DisclosureField
	} from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { MatchBreakdown, SalaryRange } from '$lib/components/product/index.js';
	import type { SalaryView } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { APPLICATION_STATUS } from '$lib/components/product/application-status.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const card = $derived(data.card);
	const vacancy = $derived(card.vacancy);
	const labels = $derived(data.labels);
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const optionalFields = (Object.keys(DISCLOSURE_FIELDS) as DisclosureField[]).filter(
		(field) => !REQUIRED_DISCLOSURE.includes(field)
	);

	const salary = $derived<SalaryView>({
		min: vacancy.salary.min,
		max: vacancy.salary.max,
		...(vacancy.salary.currency === null ? {} : { currency: vacancy.salary.currency }),
		...(vacancy.salary.taxBase === null ? {} : { taxBase: vacancy.salary.taxBase })
	});
	const grade = $derived(
		vacancy.gradeMin === null || vacancy.gradeMax === null
			? 'не указан'
			: vacancy.gradeMin === vacancy.gradeMax
				? gradeName(labels, vacancy.gradeMin)
				: `${gradeName(labels, vacancy.gradeMin)} – ${gradeName(labels, vacancy.gradeMax)}`
	);
</script>

<PageHeader title={vacancy.title} description={card.company.displayName}>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/vacancies')}>Вакансии</a>{/snippet}
	{#snippet actions()}
		<StatusPill
			label={card.company.verification === 'verified' ? 'Компания проверена' : 'Компания не проверена'}
			tone={card.company.verification === 'verified' ? 'success' : 'neutral'}
		/>
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{/if}

<SectionCard title="Вакансия">
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
		<SalaryRange {salary} />
		<span>Грейд: {grade}</span>
		{#if vacancy.workFormat}<span>{labels.workFormats[vacancy.workFormat] ?? vacancy.workFormat}</span>{/if}
	</div>
	{#if vacancy.requiredSkillKeys.length > 0}
		<p class="text-sm">
			<span class="text-muted-foreground">Обязательные навыки:</span>
			{vacancy.requiredSkillKeys.map((key) => skillName(labels, key)).join(', ')}
		</p>
	{/if}
	{#if vacancy.description}<p class="whitespace-pre-line">{vacancy.description}</p>{/if}
</SectionCard>

<SectionCard
	title={`Соответствие — ${percent.format(card.match.score)}`}
	description="Тот же расчёт, что видит компания; с откликом она получит его снимок без внутренних идентификаторов."
>
	<MatchBreakdown match={candidateMatchView(card.match, labels)} />
</SectionCard>

{#if card.application}
	<SectionCard title="Твой отклик" testId="own-application">
		<p class="flex flex-wrap items-center gap-2 text-sm">
			<StatusPill
				label={APPLICATION_STATUS[card.application.status].label}
				tone={APPLICATION_STATUS[card.application.status].tone}
			/>
			<a class="text-link underline underline-offset-4" href={resolve('/me/applications')}>Мои отклики</a>
		</p>
	</SectionCard>
{:else if vacancy.status !== 'published'}
	<p class="text-sm text-muted-foreground">Вакансия больше не принимает отклики.</p>
{:else if !card.adult}
	<p class="text-sm text-muted-foreground">
		Откликнуться можно с 18 лет: до совершеннолетия компания выходит на кандидата сама, с согласия законного
		представителя.
	</p>
{:else if card.disclosureDocument}
	<SectionCard
		title="Откликнуться"
		description="С откликом компания получит выбранные контакты — только эта компания. Раскрытие записывается в журнал; отозвав отклик, ты закрываешь компании дальнейший доступ."
	>
		<form method="POST" action="?/apply" use:enhance class="grid gap-4" data-testid="application-form">
			<CsrfInput />
			<input type="hidden" name="disclosureDocumentId" value={card.disclosureDocument.id} />
			<label class="grid gap-1.5 text-sm">
				<span>Сопроводительное сообщение — по желанию</span>
				<Textarea name="message" maxlength={2000} rows={4} />
			</label>
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Что раскрыть компании</legend>
				{#each REQUIRED_DISCLOSURE as field (field)}
					<input type="hidden" name="disclose_fields" value={field} />
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" checked disabled class="size-4 accent-primary" />
						{DISCLOSURE_FIELDS[field]} <span class="text-xs text-muted-foreground">— обязательно</span>
					</label>
				{/each}
				{#each optionalFields as field (field)}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name="disclose_fields"
							value={field}
							class="size-4 accent-primary"
							disabled={field === 'phone' && !card.hasPhone}
						/>
						{DISCLOSURE_FIELDS[field]}
						{#if field === 'phone' && !card.hasPhone}
							<span class="text-xs text-muted-foreground">— не указан в профиле</span>
						{/if}
					</label>
				{/each}
			</fieldset>
			<details class="rounded-lg border text-sm">
				<summary class="cursor-pointer px-3 py-2 font-medium">
					{card.disclosureDocument.title} · редакция {card.disclosureDocument.version}
				</summary>
				<div class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line">{card.disclosureDocument.body}</div>
			</details>
			<Button type="submit" class="justify-self-start">
				<SendIcon aria-hidden="true" />
				Откликнуться и раскрыть выбранное
			</Button>
		</form>
	</SectionCard>
{:else}
	<p class="text-sm text-muted-foreground">
		Текст согласия на раскрытие контактов не опубликован — откликнуться сейчас нельзя.
	</p>
{/if}
