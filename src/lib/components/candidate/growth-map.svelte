<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import { skillName, type Labels } from './model.js';

	/**
	 * «Карта роста»: the required skills missing most often across the feed «Вакансии для вас», and how many vacancies
	 * each one would clear completely. Confirming a skill raises the match; it does not promise an invitation.
	 */
	let {
		growth,
		labels
	}: {
		growth: {
			vacancies: number;
			withGaps: number;
			best: number | null;
			skills: { skillKey: string; vacancies: number; clears: number }[];
		};
		labels: Labels;
	} = $props();

	const id = $props.id();
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const top = $derived(growth.skills[0]?.vacancies ?? 1);

	/** «в 1 вакансии», «в 5 вакансиях». */
	function inVacancies(count: number): string {
		return count % 10 === 1 && count % 100 !== 11 ? 'вакансии' : 'вакансиях';
	}

	/** «из 1 вакансии», «из 5 вакансий». */
	function ofVacancies(count: number): string {
		return count % 10 === 1 && count % 100 !== 11 ? 'вакансии' : 'вакансий';
	}
</script>

{#if growth.vacancies > 0}
	<section
		class="relative overflow-hidden rounded-3xl border bg-card p-5 sm:p-6"
		aria-labelledby="{id}-title"
		data-testid="growth-map"
	>
		<div
			class="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-primary/10 blur-3xl"
			aria-hidden="true"
		></div>
		<div class="relative grid gap-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:gap-8">
			<div class="grid content-start gap-2">
				<p class="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-link uppercase">
					<TrendingUpIcon class="size-4" aria-hidden="true" />
					Карта роста
				</p>
				<h2 id="{id}-title" class="font-heading text-h3 text-pretty">
					{growth.skills.length > 0 ? 'Что откроет больше вакансий' : 'Обязательное закрыто везде'}
				</h2>
				<p class="text-sm text-muted-foreground">
					{#if growth.skills.length > 0}
						Пробелы в обязательных навыках — в {growth.withGaps} из {growth.vacancies}
						{ofVacancies(growth.vacancies)} с соответствием от 50 %. Подтвердите навык, и соответствие вырастет.
					{:else}
						Профиль покрывает обязательные навыки во всех {growth.vacancies}
						{inVacancies(growth.vacancies)} с соответствием от 50 %{growth.best === null
							? ''
							: `. Лучшее совпадение — ${percent.format(growth.best)}`}.
					{/if}
				</p>
			</div>

			{#if growth.skills.length > 0}
				<ol class="grid content-center gap-3">
					{#each growth.skills as skill, index (skill.skillKey)}
						<li
							class="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]"
						>
							<span class="font-heading text-sm text-muted-foreground numeric">{index + 1}</span>
							<div class="grid min-w-0 gap-1">
								<div class="flex flex-wrap items-baseline justify-between gap-x-2">
									<span class="truncate text-sm font-medium">{skillName(labels, skill.skillKey)}</span>
									<span class="text-xs text-muted-foreground numeric">
										нужен в {skill.vacancies}
										{inVacancies(skill.vacancies)}{#if skill.clears > 0}<span class="text-success">
												· закроет все пробелы в {skill.clears}</span
											>{/if}
									</span>
								</div>
								<div class="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
									<div
										class="h-full rounded-full bg-linear-to-r from-primary/60 to-primary"
										style:width="{Math.max(8, (skill.vacancies / top) * 100)}%"
									></div>
								</div>
							</div>
							<a
								href={resolve('/me/tests')}
								class="col-start-2 inline-flex items-center gap-1 justify-self-start text-xs font-medium text-link underline-offset-4 hover:underline sm:col-start-3"
							>
								Подтвердить навык
								<ArrowRightIcon class="size-3.5" aria-hidden="true" />
							</a>
						</li>
					{/each}
				</ol>
			{:else}
				<div class="grid content-center">
					<a href={resolve('/me/vacancies')} class={cn(buttonVariants({ variant: 'outline' }), 'justify-self-start')}
						>Смотреть вакансии</a
					>
				</div>
			{/if}
		</div>
	</section>
{/if}
