<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { MatchBreakdown, TrustChip } from '$lib/components/product/index.js';
	import type { TrustLevel } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import { categoryLine, disciplineName, matchView, type CompanyMatchData, type Labels } from './model.js';

	/** A found candidate in the list: pseudonym, categories in force, FSP level, confirmed skills and why they fit. */
	interface Summary {
		categories: { specialization: string; grade: string; confirmedSkillKeys: string[] }[];
		evidenceState: 'available' | 'recalculating' | 'none';
		fspLevels: { discipline: string; level: string }[];
		confirmedSkills: { skillKey: string; badgeTrust: string }[];
	}

	interface Props {
		pseudonym: string;
		summary: Summary;
		match: CompanyMatchData | null;
		labels: Labels;
		href: ResolvedPathname;
		/** The id of the comparison form the checkbox belongs to; absent — no comparison on this page. */
		compareForm?: string;
		compared?: boolean;
	}

	let { pseudonym, summary, match, labels, href, compareForm, compared = false }: Props = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const line = $derived(categoryLine(summary.categories, labels));
	const view = $derived(match ? matchView(match, labels) : null);
	/** Without an evidence run the score rests on no evidence: the row says so instead of a percent. */
	const insufficientData = $derived(
		match?.explanation.to_verify.some((item) => item.code === 'profile_insufficient_data') ?? false
	);
</script>

<article class="grid gap-3 rounded-xl border bg-card p-4 sm:p-5" data-candidate={pseudonym}>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="grid gap-1">
			<h3 class="font-heading text-h3">
				<a class="hover:underline" {href} data-sveltekit-preload-data="tap">Кандидат {pseudonym}</a>
			</h3>
			<p class="text-sm text-muted-foreground">
				{line ?? 'Категория не подтверждена: тест на грейд не пройден'}
				{#if summary.evidenceState === 'recalculating'}
					· профиль пересчитывается после изменения доказательств
				{/if}
			</p>
		</div>
		{#if match}
			<p class="text-right">
				{#if insufficientData}
					<span class="font-heading text-h3 text-muted-foreground">недостаточно данных</span>
					<span class="block text-xs text-muted-foreground"
						>соответствие {percent.format(match.score)} · покрытие {percent.format(match.coverage)}</span
					>
				{:else}
					<span class="font-heading text-h2 text-link numeric">{percent.format(match.score)}</span>
					<span class="block text-xs text-muted-foreground"
						>соответствие · покрытие {percent.format(match.coverage)}</span
					>
				{/if}
			</p>
		{/if}
	</div>

	<div class="flex flex-wrap items-center gap-2">
		{#if summary.categories.length === 0}
			<span
				class="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
				data-testid="category-not-confirmed">категория не подтверждена</span
			>
		{/if}
		{#each summary.fspLevels as item (item.discipline)}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
			>
				Уровень ФСП · {disciplineName(item.discipline)} <span class="font-mono">{item.level}</span>
			</span>
		{/each}
		{#each summary.confirmedSkills.slice(0, 6) as skill (skill.skillKey)}
			<TrustChip level={skill.badgeTrust as TrustLevel} skill={labels.skills[skill.skillKey] ?? skill.skillKey} />
		{/each}
	</div>

	{#if view}
		<details class="group rounded-lg border bg-background/60">
			<summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
				<ChevronRightIcon class="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
				Разложение соответствия
			</summary>
			<div class="border-t p-3">
				<MatchBreakdown match={view} />
			</div>
		</details>
	{/if}

	<div class={cn('flex flex-wrap items-center gap-4', compareForm ? 'justify-between' : 'justify-end')}>
		{#if compareForm}
			<label class="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					name="compare"
					value={pseudonym}
					form={compareForm}
					checked={compared}
					class="size-4 accent-primary"
				/>
				Сравнить
			</label>
		{/if}
		<a class="text-sm font-medium text-link underline-offset-4 hover:underline" {href} data-sveltekit-preload-data="tap"
			>Открыть карточку</a
		>
	</div>
</article>
