<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import RadarIcon from '@lucide/svelte/icons/radar';
	import SendIcon from '@lucide/svelte/icons/send';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { candidateMatchView } from '$lib/components/candidate/match.js';
	import {
		DISCLOSURE_FIELDS,
		gradeName,
		REQUIRED_DISCLOSURE,
		type DisclosureField
	} from '$lib/components/candidate/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { APPLICATION_STATUS } from '$lib/components/product/application-status.js';
	import { MatchBreakdown } from '$lib/components/product/index.js';
	import { TAX_BASES } from '$lib/components/product/model.js';
	import { buttonVariants, Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cn } from '$lib/components/utils.js';
	import MatchRadar from '../_parts/match-radar.svelte';
	import { plural, toneOf } from '../_parts/score.js';
	import ScoreRing from '../_parts/score-ring.svelte';
	import SkillChips from '../_parts/skill-chips.svelte';
	import { componentViews, salaryText, skillViews } from '../_parts/view.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const id = $props.id();
	const card = $derived(data.card);
	const vacancy = $derived(card.vacancy);
	const labels = $derived(data.labels);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const optionalFields = (Object.keys(DISCLOSURE_FIELDS) as DisclosureField[]).filter(
		(field) => !REQUIRED_DISCLOSURE.includes(field)
	);

	const tone = $derived(toneOf(card.match.score));
	const salary = $derived(salaryText(vacancy.salary));
	const grade = $derived(
		vacancy.gradeMin === vacancy.gradeMax
			? gradeName(labels, vacancy.gradeMin)
			: `${gradeName(labels, vacancy.gradeMin)} – ${gradeName(labels, vacancy.gradeMax)}`
	);
	const skills = $derived(skillViews(card.match, vacancy.requiredSkillKeys, labels));
	const required = $derived(skills.filter((skill) => skill.required));
	const nice = $derived(skills.filter((skill) => !skill.required));
	const confirmed = $derived(required.filter((skill) => skill.have === true).length);
	const missing = $derived(required.filter((skill) => skill.have === false));
	const components = $derived(componentViews(card.match));
	const toVerify = $derived(card.match.explanation.to_verify.length);
	const canApply = $derived(
		card.application === null && vacancy.status === 'published' && card.adult && card.disclosureDocument !== null
	);

	const surface = 'rounded-2xl border bg-card p-5 shadow-xs sm:p-6';
	const heading = 'inline-flex items-center gap-2 font-heading text-h3';
</script>

<div class="grid min-w-0 gap-6">
	<section
		class="relative isolate overflow-hidden rounded-3xl border bg-card px-4 py-6 shadow-xs sm:px-8 sm:py-8"
		aria-labelledby="{id}-title"
	>
		<div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10">
			<div class="absolute -top-24 -left-16 size-72 rounded-full bg-brand-500/15 blur-3xl dark:bg-brand-500/25"></div>
			<div
				class="absolute -right-10 -bottom-28 size-72 rounded-full bg-discipline-product/10 blur-3xl dark:bg-discipline-product/20"
			></div>
		</div>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-10">
			<div class="grid min-w-0 gap-3">
				<a
					href={resolve('/me/vacancies')}
					class="inline-flex items-center gap-1.5 justify-self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					<ArrowLeftIcon class="size-4" aria-hidden="true" />
					Вакансии для вас
				</a>
				<p class="flex flex-wrap items-center gap-1.5 text-sm">
					<span class="font-medium">{card.company.displayName}</span>
					{#if card.company.verification === 'verified'}
						<span class="inline-flex items-center gap-1 text-link">
							<BadgeCheckIcon class="size-4" aria-hidden="true" />
							компания проверена
						</span>
					{:else}
						<span class="text-muted-foreground">· компания не проверена</span>
					{/if}
				</p>
				<h1 id="{id}-title" class="font-heading text-h1 text-balance">{vacancy.title}</h1>
				<dl class="flex flex-wrap items-center gap-2 text-sm">
					<div class="inline-flex items-baseline gap-1.5 rounded-md bg-muted px-3 py-1.5">
						<dt class="sr-only">Зарплата</dt>
						<dd class={cn('font-medium numeric', salary === null && 'font-normal text-muted-foreground')}>
							{salary ?? 'зарплата не указана'}
						</dd>
						{#if salary !== null && vacancy.salary.taxBase !== null}
							<dd class="text-xs text-muted-foreground">{TAX_BASES[vacancy.salary.taxBase]}</dd>
						{/if}
					</div>
					<div class="inline-flex items-center rounded-md border px-3 py-1.5">
						<dt class="sr-only">Грейд</dt>
						<dd>{grade}</dd>
					</div>
					<div class="inline-flex items-center rounded-md border px-3 py-1.5">
						<dt class="sr-only">Формат</dt>
						<dd>{labels.workFormats[vacancy.workFormat] ?? vacancy.workFormat}</dd>
					</div>
				</dl>
			</div>

			<div class="flex items-center gap-5 lg:grid lg:justify-items-center lg:gap-3">
				<ScoreRing score={card.match.score} size={140} stroke={11} />
				<div class="grid gap-2 lg:justify-items-center lg:text-center">
					<p class={cn('text-sm font-medium', tone.text)}>{tone.label}</p>
					{#if card.application}
						<StatusPill
							label={APPLICATION_STATUS[card.application.status].label}
							tone={APPLICATION_STATUS[card.application.status].tone}
						/>
					{:else if canApply}
						<a href="#{id}-apply" class={buttonVariants()}>
							<SendIcon aria-hidden="true" />
							Откликнуться
						</a>
					{/if}
				</div>
			</div>
		</div>
	</section>

	{#if problem}
		<FormMessage text={problem.message} />
	{/if}

	<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
		<div class="grid min-w-0 gap-6">
			{#if skills.length > 0}
				<section class={cn(surface, 'grid gap-4')} aria-labelledby="{id}-skills">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<h2 id="{id}-skills" class={heading}>
							<ListChecksIcon class="size-5 text-link" aria-hidden="true" />
							Навыки
						</h2>
						{#if required.length > 0}
							<p class="text-sm text-muted-foreground">
								подтверждено <span class="font-medium text-foreground numeric">{confirmed}</span> из
								<span class="numeric">{required.length}</span> обязательных
							</p>
						{/if}
					</div>
					{#if required.length > 0}
						<div class="grid gap-2">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Обязательные</p>
							<SkillChips skills={required} label="Обязательные навыки" />
						</div>
					{/if}
					{#if nice.length > 0}
						<div class="grid gap-2">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Желательные</p>
							<SkillChips skills={nice} label="Желательные навыки" />
						</div>
					{/if}
				</section>
			{/if}

			<section class={cn(surface, 'grid gap-3')} aria-labelledby="{id}-about">
				<h2 id="{id}-about" class={heading}>
					<FileTextIcon class="size-5 text-link" aria-hidden="true" />
					О вакансии
				</h2>
				<p class="max-w-prose leading-relaxed whitespace-pre-line">{vacancy.description}</p>
			</section>

			<section class={cn(surface, 'grid gap-3')} aria-labelledby="{id}-why">
				<div class="grid gap-1">
					<h2 id="{id}-why" class={heading}>
						<RadarIcon class="size-5 text-link" aria-hidden="true" />
						Разбор соответствия
					</h2>
					<p class="text-sm text-muted-foreground">
						Тот же расчёт, что видит компания; с откликом она получит его снимок без внутренних идентификаторов.
					</p>
				</div>
				<MatchBreakdown match={candidateMatchView(card.match, labels)} />
			</section>

			{#if card.application}
				<section class={cn(surface, 'grid gap-2')} data-testid="own-application" aria-labelledby="{id}-own">
					<h2 id="{id}-own" class={heading}>Ваш отклик</h2>
					<p class="flex flex-wrap items-center gap-2 text-sm">
						<StatusPill
							label={APPLICATION_STATUS[card.application.status].label}
							tone={APPLICATION_STATUS[card.application.status].tone}
						/>
						<a class="text-link underline underline-offset-4" href={resolve('/me/applications')}>Мои отклики</a>
					</p>
				</section>
			{:else if vacancy.status !== 'published'}
				<p class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
					Вакансия больше не принимает отклики.
				</p>
			{:else if !card.adult}
				<p class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
					Откликнуться можно с 18 лет: до совершеннолетия компания выходит на кандидата сама, с согласия законного
					представителя.
				</p>
			{:else if card.disclosureDocument}
				<section
					id="{id}-apply"
					class={cn(surface, 'relative isolate grid scroll-mt-24 gap-4 overflow-hidden border-primary/30')}
					aria-labelledby="{id}-apply-title"
				>
					<div
						aria-hidden="true"
						class="pointer-events-none absolute -top-20 -right-16 -z-10 size-64 rounded-full bg-primary/10 blur-3xl"
					></div>
					<div class="grid gap-1">
						<h2 id="{id}-apply-title" class={heading}>
							<SendIcon class="size-5 text-link" aria-hidden="true" />
							Откликнуться
						</h2>
						<p class="text-sm text-muted-foreground">
							С откликом компания получит выбранные контакты — только эта компания. Раскрытие записывается в журнал;
							отозвав отклик, вы закрываете компании дальнейший доступ.
						</p>
					</div>
					<form method="POST" action="?/apply" use:enhance class="grid gap-4" data-testid="application-form">
						<CsrfInput />
						<input type="hidden" name="disclosureDocumentId" value={card.disclosureDocument.id} />
						<label class="grid gap-1.5 text-sm">
							<span>Сопроводительное сообщение — по желанию</span>
							<Textarea name="message" maxlength={2000} rows={4} />
						</label>
						<fieldset class="grid gap-2">
							<legend class="mb-2 text-sm font-medium">Что раскрыть компании</legend>
							<div class="grid gap-2 sm:grid-cols-2">
								{#each REQUIRED_DISCLOSURE as field (field)}
									<input type="hidden" name="disclose_fields" value={field} />
									<label class="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
										<input type="checkbox" checked disabled class="size-4 accent-primary" />
										{DISCLOSURE_FIELDS[field]}
										<span class="ml-auto text-xs text-muted-foreground">обязательно</span>
									</label>
								{/each}
								{#each optionalFields as field (field)}
									<label
										class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors has-checked:border-primary/50 has-checked:bg-accent has-disabled:cursor-not-allowed has-disabled:opacity-60"
									>
										<input
											type="checkbox"
											name="disclose_fields"
											value={field}
											class="size-4 accent-primary"
											disabled={card.emptyFields.includes(field)}
										/>
										{DISCLOSURE_FIELDS[field]}
										{#if card.emptyFields.includes(field)}
											<span class="ml-auto text-xs text-muted-foreground">нет в профиле</span>
										{/if}
									</label>
								{/each}
							</div>
						</fieldset>
						<details class="group/doc rounded-md border text-sm">
							<summary
								class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 font-medium [&::-webkit-details-marker]:hidden"
							>
								{card.disclosureDocument.title} · редакция {card.disclosureDocument.version}
								<ChevronDownIcon
									class="size-4 shrink-0 text-muted-foreground transition-transform group-open/doc:rotate-180"
									aria-hidden="true"
								/>
							</summary>
							<div class="max-h-64 overflow-y-auto border-t px-3 py-3 whitespace-pre-line">
								{card.disclosureDocument.body}
							</div>
						</details>
						<Button type="submit" class="justify-self-start">
							<SendIcon aria-hidden="true" />
							Откликнуться и раскрыть выбранное
						</Button>
					</form>
				</section>
			{:else}
				<p class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
					Текст согласия на раскрытие контактов не опубликован — откликнуться сейчас нельзя.
				</p>
			{/if}
		</div>

		<aside class="grid gap-4 lg:sticky lg:top-20" aria-label="Соответствие вакансии">
			<section class={cn(surface, 'grid gap-4 p-4 sm:p-5')} aria-labelledby="{id}-profile">
				<h2 id="{id}-profile" class="text-sm font-medium">Профиль совпадения</h2>
				<MatchRadar {components} />
			</section>

			<section
				class={cn(
					surface,
					'grid gap-2 p-4 sm:p-5',
					missing.length > 0 ? 'border-primary/30 bg-accent/60 dark:bg-accent/40' : 'border-success/30'
				)}
				aria-labelledby="{id}-grow"
			>
				{#if missing.length > 0}
					<h2 id="{id}-grow" class="inline-flex items-center gap-1.5 text-sm font-medium text-accent-foreground">
						<SparklesIcon class="size-4" aria-hidden="true" />
						Что усилит отклик
					</h2>
					<p class="text-sm">
						Подтвердите {missing.map((skill) => skill.name).join(', ')} — это
						{plural(missing.length, ['обязательный навык', 'обязательных навыка', 'обязательных навыков'])} вакансии.
					</p>
					<a
						href={resolve('/me/tests')}
						class="inline-flex items-center gap-1 justify-self-start text-sm font-medium text-link hover:underline"
					>
						Пройти тест
						<ArrowRightIcon class="size-3.5" aria-hidden="true" />
					</a>
				{:else}
					<h2 id="{id}-grow" class="inline-flex items-center gap-1.5 text-sm font-medium text-success">
						<CheckIcon class="size-4" aria-hidden="true" />
						Обязательное подтверждено
					</h2>
					<p class="text-sm text-muted-foreground">Все обязательные навыки вакансии есть в профиле.</p>
				{/if}
				{#if toVerify > 0}
					<p class="border-t pt-2 text-xs text-muted-foreground">
						{toVerify}
						{plural(toVerify, ['пункт уточнят', 'пункта уточнят', 'пунктов уточнят'])} на собеседовании — подробности в разборе.
					</p>
				{/if}
			</section>
		</aside>
	</div>
</div>
