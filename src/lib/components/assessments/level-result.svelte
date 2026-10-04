<script lang="ts">
	import { resolve } from '$app/paths';
	import { TrustChip } from '$lib/components/product/index.js';
	import { formatDate } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import { confidenceOf, levelName, percent, type ScoreView } from './model.js';

	/**
	 * The result of an attempt and where it went: a reached level is a fact of the profile «Подтверждено платформой»
	 * for the skills of the coverage; an unreached one stays in the history and changes nothing.
	 */
	let {
		score,
		title,
		version,
		kind,
		skills,
		class: className
	}: {
		score: ScoreView;
		title: string;
		version: number;
		kind: 'code_task' | 'quiz';
		skills: Record<string, string>;
		class?: string;
	} = $props();

	const confidence = $derived(confidenceOf(score));
</script>

<div
	class={cn('grid gap-3 rounded-xl border p-4', score.confirmed ? 'bg-success-subtle' : 'bg-muted', className)}
	data-testid="attempt-result"
	data-level={score.level}
	data-confirmed={score.confirmed}
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="font-heading text-lg">{levelName(score.level)}</p>
		{#if score.confirmed}<TrustChip level="platform_verified" register="sport" />{/if}
	</div>
	<p class="text-sm">
		{#if kind === 'code_task'}
			Пройдено тестов: {score.score} из {score.maxScore}.
		{:else}
			Верных ответов: {score.score} из {score.maxScore}{#if confidence !== null}; уверенность в уровне — {percent(
					confidence
				)}{/if}.
		{/if}
		Оценено {formatDate(score.scoredAt)}.
	</p>
	{#if score.confirmed && score.fact}
		<p class="text-sm">
			В профиль добавлен факт «Подтверждено платформой: задание «{title}» v{version}, {formatDate(score.scoredAt)},
			уровень
			{levelName(score.level)}» для навыков: {score.fact.skillKeys.map((key) => skills[key] ?? key).join(', ')}.
			Категория пересчитается по этому факту.
			<a class="text-link underline underline-offset-4" href={resolve('/me/profile')}>Открыть профиль</a>
		</p>
	{:else}
		<p class="text-sm text-muted-foreground">
			Уровень задания не достигнут: попытка осталась в истории и в профиль не попала.
		</p>
	{/if}
</div>
