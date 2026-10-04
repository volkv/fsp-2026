<script lang="ts">
	import { resolve } from '$app/paths';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { TrustChip } from '$lib/components/product/index.js';
	import { formatDateTime, pluralize } from '$lib/components/product/model.js';
	import CoveragePanel from './coverage-panel.svelte';
	import { languageName, levelName, REFUSALS, type CatalogEntryView } from './model.js';

	/** One assessment of the catalog: what it is, its limits, the attempts left, the best result and the coverage. */
	let { entry, skills }: { entry: CatalogEntryView; skills: Record<string, string> } = $props();

	const skillName = (key: string) => skills[key] ?? key;

	const attemptsLine = $derived.by(() => {
		const { used, max, blocked, nextAt } = entry.allowance;
		const base = `Попыток: ${used} из ${max}`;
		if (blocked === 'retake_interval' && nextAt) return `${base}. Следующая — с ${formatDateTime(nextAt)}`;
		if (blocked === 'attempts_exhausted') return `${base}. ${REFUSALS.attempts_exhausted}`;
		return base;
	});
</script>

<li
	class="grid content-start gap-3 rounded-xl border bg-card p-4 shadow-xs"
	data-testid="assessment-card"
	data-kind={entry.kind}
>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div class="grid gap-1">
			<a
				class="font-heading text-lg text-link underline-offset-4 hover:underline"
				href={resolve('/(app)/me/tests/[assessmentId]', { assessmentId: entry.assessmentId })}>{entry.title}</a
			>
			<p class="text-sm text-muted-foreground">{entry.summary}</p>
		</div>
		{#if entry.level}<StatusPill label={levelName(entry.level)} tone="info" />{/if}
	</div>
	<dl class="grid gap-1 text-sm">
		<div class="flex flex-wrap gap-1.5">
			<dt class="text-muted-foreground">Навыки:</dt>
			<dd>{entry.skillKeys.map(skillName).join(', ')}</dd>
		</div>
		{#if entry.languages.length > 0}
			<div class="flex flex-wrap gap-1.5">
				<dt class="text-muted-foreground">Языки:</dt>
				<dd>{entry.languages.map(languageName).join(', ')}</dd>
			</div>
		{/if}
		<div class="flex flex-wrap gap-1.5">
			<dt class="text-muted-foreground">Время:</dt>
			<dd>
				{entry.timeLimitMinutes}
				{pluralize(entry.timeLimitMinutes, ['минута', 'минуты', 'минут'])}{#if entry.maxQuestions}, до {entry.maxQuestions}
					{pluralize(entry.maxQuestions, ['вопроса', 'вопросов', 'вопросов'])}{/if}
			</dd>
		</div>
	</dl>
	<p class="text-sm" data-testid="attempts-line">{attemptsLine}</p>
	{#if entry.best}
		<p class="flex flex-wrap items-center gap-2 text-sm" data-testid="best-result">
			<TrustChip level="platform_verified" register="sport" />
			Засчитано: {levelName(entry.best.level)}
		</p>
	{/if}
	<details class="rounded-lg border text-sm">
		<summary class="cursor-pointer px-3 py-2 font-medium">Что проверяет и чего не проверяет</summary>
		<CoveragePanel coverage={entry.coverage} {skills} class="px-3 pb-3" />
	</details>
</li>
