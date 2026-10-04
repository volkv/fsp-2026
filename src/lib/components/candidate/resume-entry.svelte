<script lang="ts">
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase-business';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { TrustChip } from '$lib/components/product/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { cn } from '$lib/components/utils.js';
	import { roleName, skillName, type Labels } from './model.js';
	import { periodInput, periodText, REVIEW_STATES, reviewState, type ResumeEntryView } from './quotes';
	import ResumeReview from './resume-review.svelte';

	/**
	 * A job from the resume: position, role, company and period with the quotes they rest on, the skills applied in it,
	 * and the candidate's decision — confirm, reject, or correct the fields; a correction keeps the quotes.
	 */
	let {
		entry,
		labels,
		roles,
		located,
		selected,
		documentId,
		problem,
		correcting: correctingAfterFailure,
		onshow,
		children
	}: {
		entry: ResumeEntryView;
		labels: Labels;
		roles: { key: string; name: string }[];
		located: boolean;
		selected: boolean;
		documentId: string;
		problem: { message: string; fields: Record<string, string> } | null;
		/** The last correction of this entry was refused: the form stays open with the problems. */
		correcting: boolean;
		onshow: (key: string) => void;
		/** Other fields of the resume that belong to this job. */
		children?: Snippet;
	} = $props();

	const review = $derived(reviewState(entry.candidateReview));
	const shownState = $derived(REVIEW_STATES[review]);
	const title = $derived(entry.positionTitle ?? 'Должность не найдена');
	const period = $derived(periodText(entry));
	const id = $props.id();

	let editing = $state(false);
	let pending = $state(false);
	const open = $derived(editing || correctingAfterFailure);
	const fieldError = (name: string) => problem?.fields[name];

	const PERIOD_NOTES: Record<string, string> = {
		missing: 'Период работы не найден — добавь его, иначе опыт не посчитается в грейде.',
		invalid: 'Период не сходится: конец раньше начала или дата в будущем — поправь его.'
	};
	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
</script>

<article
	class={cn('grid gap-3 rounded-xl border bg-card p-4 shadow-xs', review === 'rejected' && 'border-dashed')}
	aria-labelledby="{id}-title"
	data-testid="resume-entry"
	data-review={review}
>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div class="flex items-start gap-2.5">
			<BriefcaseIcon class="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="grid gap-0.5">
				<h3 id="{id}-title" class={cn('font-heading text-lg', review === 'rejected' && 'line-through')}>{title}</h3>
				<p class="text-sm">
					{entry.organizationName ?? 'Компания не найдена'}{#if entry.roleKey}<span class="text-muted-foreground"
							>{` · ${roleName(labels, entry.roleKey)}`}</span
						>{/if}
				</p>
				<p class="text-sm text-muted-foreground">{period ?? 'Период не указан'}</p>
			</div>
		</div>
		<StatusPill label={shownState.label} tone={shownState.tone} />
	</div>

	{#if PERIOD_NOTES[entry.periodStatus]}
		<p class="rounded-lg bg-warning-subtle p-3 text-sm text-warning">{PERIOD_NOTES[entry.periodStatus]}</p>
	{/if}

	{#if entry.appliedSkillKeys.length > 0}
		<div class="grid gap-1.5">
			<p class="text-sm font-medium">Навыки в этой работе</p>
			<ul class="flex flex-wrap gap-1.5" aria-label="Навыки в этой работе">
				{#each entry.appliedSkillKeys as key (key)}
					<li><TrustChip level="claimed" skill={skillName(labels, key)} /></li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="grid gap-1.5 text-sm">
		<p class="flex items-center gap-1.5 text-muted-foreground">
			<QuoteIcon class="size-3.5" aria-hidden="true" />
			Откуда в резюме
		</p>
		<ul class="grid gap-1 border-l-2 pl-3">
			{#each entry.quotes as quote, index (index)}
				<li>«{quote.text}»</li>
			{/each}
		</ul>
		{#if located}
			<Button
				variant="link"
				size="sm"
				class="w-fit px-0"
				aria-controls={documentId}
				aria-pressed={selected}
				onclick={() => {
					onshow(entry.sourceKey);
				}}
			>
				Показать в тексте резюме<span class="sr-only"> «{title}»</span>
			</Button>
		{:else}
			<p class="text-muted-foreground">Цитаты — из прежнего чтения файла, в тексте резюме не отмечены.</p>
		{/if}
	</div>

	{#if children}{@render children()}{/if}

	<div class="flex flex-wrap items-center gap-2">
		<ResumeReview action="?/reviewEntry" idField="entry_id" id={entry.id} {review} subject={title} />
		{#if !open}
			<Button
				size="sm"
				variant="outline"
				aria-expanded="false"
				aria-controls="{id}-form"
				onclick={() => {
					editing = true;
				}}
			>
				<PencilIcon aria-hidden="true" />
				Поправить<span class="sr-only"> «{title}»</span>
			</Button>
		{/if}
	</div>
	{#if problem && !open}<FormMessage text={problem.message} />{/if}

	{#if open}
		<form
			id="{id}-form"
			method="POST"
			action="?/correctEntry"
			class="grid gap-3 rounded-lg border p-3"
			aria-label="Исправить опыт: {title}"
			use:enhance={() => {
				pending = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					pending = false;
					if (result.type === 'success') editing = false;
				};
			}}
		>
			<CsrfInput />
			<input type="hidden" name="entry_id" value={entry.id} />
			{#if problem}<FormMessage text={problem.message} />{/if}
			<p class="text-sm text-muted-foreground">
				Исправленные поля заменят извлечённые, цитаты из резюме останутся как основание. Пустое поле — «не указано».
			</p>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="grid gap-1.5 text-sm">
					<span>Должность</span>
					<Input
						name="position_title"
						maxlength={200}
						value={entry.positionTitle ?? ''}
						aria-invalid={fieldError('positionTitle') ? 'true' : undefined}
					/>
					{#if fieldError('positionTitle')}<span class="text-destructive">{fieldError('positionTitle')}</span>{/if}
				</label>
				<label class="grid gap-1.5 text-sm">
					<span>Роль</span>
					<select name="role_key" class={selectClass} aria-invalid={fieldError('roleKey') ? 'true' : undefined}>
						<option value="">— не выбрана —</option>
						{#each roles as role (role.key)}
							<option value={role.key} selected={entry.roleKey === role.key}>{role.name}</option>
						{/each}
					</select>
					{#if fieldError('roleKey')}<span class="text-destructive">{fieldError('roleKey')}</span>{/if}
				</label>
				<label class="grid gap-1.5 text-sm sm:col-span-2">
					<span>Компания</span>
					<Input
						name="organization_name"
						maxlength={200}
						value={entry.organizationName ?? ''}
						aria-invalid={fieldError('organizationName') ? 'true' : undefined}
					/>
					{#if fieldError('organizationName')}<span class="text-destructive">{fieldError('organizationName')}</span
						>{/if}
				</label>
				<label class="grid gap-1.5 text-sm">
					<span>Начало</span>
					<Input
						name="period_from"
						placeholder="2021-03"
						inputmode="numeric"
						value={periodInput(entry.periodFrom, entry.periodFromPrecision)}
						aria-describedby="{id}-period-hint"
						aria-invalid={fieldError('periodFrom') ? 'true' : undefined}
					/>
					{#if fieldError('periodFrom')}<span class="text-destructive">{fieldError('periodFrom')}</span>{/if}
				</label>
				<label class="grid gap-1.5 text-sm">
					<span>Окончание</span>
					<Input
						name="period_to"
						placeholder="2023-11"
						inputmode="numeric"
						value={entry.isCurrent ? '' : periodInput(entry.periodTo, entry.periodToPrecision)}
						aria-describedby="{id}-period-hint"
						aria-invalid={fieldError('periodTo') ? 'true' : undefined}
					/>
					{#if fieldError('periodTo')}<span class="text-destructive">{fieldError('periodTo')}</span>{/if}
				</label>
			</div>
			<p id="{id}-period-hint" class="text-xs text-muted-foreground">Год и месяц — 2021-03, или только год — 2021.</p>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="is_current" class="size-4 accent-primary" checked={entry.isCurrent} />
				Работаю здесь сейчас
			</label>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm" disabled={pending}>Сохранить</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => {
						editing = false;
						correctingAfterFailure = false;
					}}>Отмена</Button
				>
			</div>
		</form>
	{/if}
</article>
