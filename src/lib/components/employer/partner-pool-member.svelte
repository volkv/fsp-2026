<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import { AWARDS, type Award } from '$lib/components/product/model.js';
	import { POOL_STAGES } from '$lib/components/operator/model.js';
	import { categoryLine } from './model.js';

	/**
	 * A finalist of the partner pool: the result the candidate entered the pool with, the categories in force, the full
	 * catalog card on demand (`children`) and how an offer reaches the candidate: from the card without a vacancy, or
	 * naming an own vacancy. When the rules refuse both, the row says why instead of offering what would be refused.
	 */
	interface Props {
		pseudonym: string;
		result: { place: number | null; award?: string; stage: string | null };
		categories: { specialization: string; grade: string }[];
		labels: { specializations: Record<string, string>; grades: Record<string, string> };
		offer: { withoutVacancy: boolean; vacancies: { id: string; title: string }[] };
		/** The catalog card of the candidate. */
		children: Snippet;
	}

	let { pseudonym, result, categories, labels, offer, children }: Props = $props();

	const award = $derived(result.award && result.award in AWARDS ? AWARDS[result.award as Award] : null);
	const resultText = $derived(
		[
			award ?? 'Результат не передан',
			result.place === null ? null : `${result.place} место`,
			result.stage === null ? null : (POOL_STAGES[result.stage] ?? result.stage)
		]
			.filter((part) => part !== null)
			.join(' · ')
	);
	const line = $derived(categoryLine(categories, labels));
</script>

<article class="grid gap-3 rounded-xl border bg-card p-4 sm:p-5" data-pool-candidate={pseudonym}>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="grid gap-1">
			<h3 class="font-heading text-h3">Кандидат {pseudonym}</h3>
			<p class="text-sm text-muted-foreground">
				{line ?? 'Категория не подтверждена: тест на грейд не пройден'}
			</p>
		</div>
		<p
			class="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground"
			data-testid="pool-result"
		>
			<TrophyIcon class="size-4" aria-hidden="true" />
			{resultText}
		</p>
	</div>

	<details class="group rounded-lg border bg-background/60">
		<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
			<ChevronRightIcon class="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
			Карточка кандидата
		</summary>
		<div class="border-t p-3">
			{@render children()}
		</div>
	</details>

	<div class="grid gap-2 text-sm" data-testid="pool-invite">
		{#if !offer.withoutVacancy && offer.vacancies.length === 0}
			<p class="text-muted-foreground">
				Предложить работу сейчас нельзя: кандидат показал карточку только партнёрам соревнования, а предложение идёт по
				общим правилам — кандидат должен быть виден компании в каталоге или в контексте её вакансии.
			</p>
		{/if}
		{#if offer.withoutVacancy}
			<a
				class="justify-self-start text-link underline underline-offset-4"
				href={resolve('/(app)/company/(member)/candidates/[pseudonym]', { pseudonym })}
				data-sveltekit-preload-data="tap">Предложить работу без вакансии</a
			>
		{/if}
		{#if offer.vacancies.length > 0}
			<span class="font-medium">Предложить с вакансией:</span>
			<ul class="flex flex-wrap gap-2">
				{#each offer.vacancies as vacancy (vacancy.id)}
					<li>
						<a
							class="inline-flex items-center rounded-full border px-3 py-1 text-link hover:bg-muted"
							href={resolve('/(app)/company/(member)/vacancies/[id]/candidates/[pseudonym]', {
								id: vacancy.id,
								pseudonym
							})}
							data-sveltekit-preload-data="tap">{vacancy.title}</a
						>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</article>
