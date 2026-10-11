<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import LoaderIcon from '@lucide/svelte/icons/loader-circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import RadarIcon from '@lucide/svelte/icons/radar';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TargetIcon from '@lucide/svelte/icons/target';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import WalletIcon from '@lucide/svelte/icons/wallet';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { afterNavigate } from '$app/navigation';
	import { RecommendationNotice } from '$lib/components/product/index.js';
	import { SALARY_PERIODS } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import Card from './vacancy-card.svelte';
	import Row from './vacancy-row.svelte';
	import { clamp01, pathOf, plural, toneOf } from './score.js';
	import Pill from './filter-pill.svelte';
	import type { VacanciesView, VacancyCard } from './view.js';

	let { view }: { view: VacanciesView } = $props();

	const formId = $props.id();
	const search = $derived(view.search);
	const cards = $derived(view.cards);

	const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 0 });
	const rouble = (value: number) => `${compact.format(value)}\u00a0₽`;

	const tile =
		'grid min-w-0 content-start gap-1.5 rounded-2xl border bg-card p-4 transition duration-300 ease-standard hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand-500/10 dark:hover:shadow-brand-300/10';
	const tileLabel = 'inline-flex items-center gap-1.5 text-xs';

	/** Figures of the whole page: what the candidate sees before reading any card. */
	const stats = $derived.by(() => {
		const best = cards.reduce<VacancyCard | null>(
			(top, card) => (top === null || card.score > top.score ? card : top),
			null
		);
		const strong = cards.filter((card) => card.score >= 0.75).length;

		// Salaries are compared only in roubles per month, so that the median means something.
		const monthly = cards.filter(
			(card) =>
				card.salaryText !== null &&
				card.salaryText.includes('₽') &&
				(card.salaryPeriod === null || card.salaryPeriod === SALARY_PERIODS.month)
		);
		const middles = monthly
			.flatMap((card) => {
				const low = card.salaryMin ?? card.salaryMax;
				const high = card.salaryMax ?? card.salaryMin;
				return low === null || high === null ? [] : [(low + high) / 2];
			})
			.sort((a, b) => a - b);
		const half = Math.floor(middles.length / 2);
		const median =
			middles.length === 0
				? null
				: middles.length % 2 === 1
					? (middles[half] ?? null)
					: ((middles[half - 1] ?? 0) + (middles[half] ?? 0)) / 2;
		const tops = monthly.flatMap((card) => {
			const high = card.salaryMax ?? card.salaryMin;
			return high === null ? [] : [high];
		});
		const top = tops.length === 0 ? null : Math.max(...tops);

		const gaps: Record<string, { count: number; only: number }> = {};
		for (const card of cards) {
			for (const name of card.missing.filter((value, index, all) => all.indexOf(value) === index)) {
				const entry = (gaps[name] ??= { count: 0, only: 0 });
				entry.count += 1;
				if (card.missing.length === 1) entry.only += 1;
			}
		}
		const gap =
			Object.entries(gaps)
				.map(([name, entry]) => ({ name, ...entry }))
				.sort((a, b) => b.count - a.count || b.only - a.only || a.name.localeCompare(b.name, 'ru'))[0] ?? null;

		return { best, strong, median, top, salaried: monthly.length, gap };
	});

	const featured = $derived(cards[0] ?? null);
	const side = $derived(cards[1] ?? null);
	const rest = $derived(cards.slice(2));

	const DEBOUNCE_MS = 350;
	let form = $state<HTMLFormElement>();
	let field = $state<HTMLInputElement>();
	/** What the candidate is typing, kept while the field has focus so a finished search does not overwrite it. */
	let typed = $state<string | null>(null);
	let pending = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	afterNavigate(() => {
		pending = false;
		if (document.activeElement !== field) typed = null;
	});

	function searchNow() {
		clearTimeout(timer);
		pending = true;
		form?.requestSubmit();
	}

	/** The text searches after a pause in typing; a chip or a select searches at once. */
	function oninput(event: Event) {
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || target.type !== 'search') return;
		typed = target.value;
		clearTimeout(timer);
		timer = setTimeout(searchNow, DEBOUNCE_MS);
	}

	function onchange(event: Event) {
		const target = event.target;
		if (target instanceof HTMLInputElement && target.type === 'search') return;
		if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) searchNow();
	}
</script>

<div class="grid min-w-0 gap-6">
	<section
		class="relative isolate overflow-hidden rounded-3xl border bg-card px-4 py-6 shadow-xs sm:px-8 sm:py-8"
		aria-labelledby="{formId}-title"
	>
		<div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10">
			<div class="absolute -top-24 -left-16 size-72 rounded-full bg-brand-500/15 blur-3xl dark:bg-brand-500/25"></div>
			<div
				class="absolute -right-10 -bottom-28 size-72 rounded-full bg-discipline-product/10 blur-3xl dark:bg-discipline-product/20"
			></div>
			<div
				class="absolute top-6 right-6 hidden size-44 overflow-hidden rounded-full border border-primary/15 lg:block dark:border-brand-300/20"
			>
				<div class="absolute inset-6 rounded-full border border-primary/15 dark:border-brand-300/20"></div>
				<div class="absolute inset-14 rounded-full border border-primary/15 dark:border-brand-300/20"></div>
				<div class="sweep absolute inset-0 rounded-full"></div>
			</div>
		</div>

		<div class="grid gap-6">
			<div class="flex flex-wrap items-end justify-between gap-4">
				<div class="grid gap-2">
					<p class="inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-link uppercase">
						<RadarIcon class="size-4" aria-hidden="true" />
						Подбор по верифицированному профилю
					</p>
					<h1 id="{formId}-title" class="font-heading text-h1">Вакансии для вас</h1>
					<p class="max-w-xl text-sm text-muted-foreground">
						Чем выше процент, тем точнее вакансия совпадает с подтверждённым профилем. Обычно первым пишет работодатель
						— сразу с зарплатой.
					</p>
				</div>
				<div class="flex flex-wrap gap-2 lg:mr-52">
					<a href={pathOf(view.applicationsHref)} class={buttonVariants({ variant: 'outline' })}>Мои отклики</a>
				</div>
			</div>

			<form
				method="GET"
				class="grid gap-4"
				aria-label="Поиск вакансий"
				data-testid="vacancy-search"
				data-sveltekit-keepfocus
				data-sveltekit-noscroll
				data-sveltekit-replacestate
				bind:this={form}
				{oninput}
				{onchange}
				onsubmit={() => {
					clearTimeout(timer);
					pending = true;
				}}
			>
				<div class="group/omni relative">
					<div
						aria-hidden="true"
						class="pointer-events-none absolute -inset-1 rounded-lg bg-linear-to-r from-brand-500 via-discipline-product to-discipline-uas opacity-25 blur-lg transition-opacity duration-500 group-focus-within/omni:opacity-60 dark:opacity-35"
					></div>
					<div class="relative flex items-center gap-2 rounded-md border bg-card px-3 shadow-sm sm:px-4">
						<SearchIcon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<label for="{formId}-q" class="sr-only">Название, навыки, компания</label>
						<input
							id="{formId}-q"
							name="q"
							type="search"
							bind:this={field}
							value={typed ?? search.text}
							placeholder="Должность, навык или компания"
							class="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
						/>
						{#if pending}
							<LoaderIcon class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
							<span class="sr-only" role="status">Ищем вакансии</span>
						{/if}
					</div>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Pill name="role" label="Роль" any="любая" options={search.roleOptions} current={search.roleKey} />
					<Pill name="grade" label="Грейд" any="любой" options={search.gradeOptions} current={search.gradeKey} />

					<fieldset class="contents">
						<legend class="sr-only">Формат работы</legend>
						{#each search.formatOptions as [key, name] (key)}
							<label class="group/chip relative cursor-pointer">
								<input
									type="checkbox"
									name="format"
									value={key}
									checked={search.workFormats.includes(key)}
									class="peer sr-only"
								/>
								<span
									class="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3.5 text-sm transition-colors duration-200 select-none peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 hover:border-ring/60"
								>
									<CheckIcon class="hidden size-3.5 group-has-checked/chip:block" aria-hidden="true" />
									{name}
								</span>
							</label>
						{/each}
					</fieldset>

					{#if search.filtered}
						<a
							href={pathOf(search.resetHref)}
							class="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<RotateCcwIcon class="size-3.5" aria-hidden="true" />
							Сбросить
						</a>
					{/if}
				</div>

				{#if view.degraded}
					<p
						class="inline-flex items-center gap-2 justify-self-start rounded-full border border-warning/40 bg-warning-subtle px-3 py-1 text-xs text-warning"
						data-notice="degraded"
					>
						<ZapIcon class="size-3.5 shrink-0" aria-hidden="true" />
						Смысловой поиск недоступен — ранжирование по словам
					</p>
				{/if}
			</form>
		</div>
	</section>

	<RecommendationNotice compact />

	{#if cards.length === 0}
		<section class="grid justify-items-center gap-3 rounded-3xl border border-dashed bg-card px-6 py-14 text-center">
			<div
				class="relative grid size-20 place-items-center overflow-hidden rounded-full bg-accent text-accent-foreground"
			>
				<div class="sweep absolute inset-0 rounded-full" aria-hidden="true"></div>
				<BriefcaseIcon class="relative size-8" aria-hidden="true" />
			</div>
			{#if search.filtered}
				<h2 class="font-heading text-h3">По запросу вакансий нет</h2>
				<p class="max-w-md text-sm text-muted-foreground">Уберите часть фильтров или измените запрос.</p>
				<a href={pathOf(search.resetHref)} class={buttonVariants({ variant: 'outline' })}>Сбросить фильтры</a>
			{:else}
				<h2 class="font-heading text-h3">Подходящих открытых вакансий сейчас нет</h2>
				<p class="max-w-md text-sm text-muted-foreground">
					Список обновляется по мере публикации вакансий. Чем полнее подтверждённый профиль, тем точнее подбор.
				</p>
				<a href={pathOf(view.profileHref)} class={buttonVariants({ variant: 'outline' })}>Дополнить профиль</a>
			{/if}
			{#if search.firstHref}
				<a href={pathOf(search.firstHref)} class="text-sm text-link underline underline-offset-4">К началу списка</a>
			{/if}
		</section>
	{:else}
		<section class="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Сводка по выдаче">
			<div class={tile}>
				<p class={cn(tileLabel, 'text-muted-foreground')}>
					<TargetIcon class="size-3.5" aria-hidden="true" />В выдаче
				</p>
				<p class="font-heading text-h2 numeric">{cards.length}{search.nextHref ? '+' : ''}</p>
				<div class="flex h-6 items-end gap-0.5" aria-hidden="true">
					{#each cards as item (item.id)}
						<span
							class={cn('w-full max-w-2 grow rounded-sm', toneOf(item.score).bar)}
							style:height="{Math.max(12, clamp01(item.score) * 100)}%"
						></span>
					{/each}
				</div>
				<p class="text-xs text-muted-foreground">
					{stats.strong}
					{plural(stats.strong, ['сильное совпадение', 'сильных совпадения', 'сильных совпадений'])}
				</p>
			</div>

			<div class={tile}>
				<p class={cn(tileLabel, 'text-muted-foreground')}>
					<TrendingUpIcon class="size-3.5" aria-hidden="true" />Лучшее совпадение
				</p>
				{#if stats.best}
					<p class={cn('font-heading text-h2 numeric', toneOf(stats.best.score).text)}>{stats.best.percent}</p>
					<a
						href={pathOf(stats.best.href)}
						class="line-clamp-2 text-xs text-muted-foreground hover:text-foreground hover:underline"
						>{stats.best.title} · {stats.best.company}</a
					>
				{/if}
			</div>

			<div class={tile}>
				<p class={cn(tileLabel, 'text-muted-foreground')}>
					<WalletIcon class="size-3.5" aria-hidden="true" />Зарплаты в месяц
				</p>
				{#if stats.median !== null}
					<p class="font-heading text-h2 numeric">{rouble(stats.median)}</p>
					<p class="text-xs text-muted-foreground">
						медиана по {stats.salaried}
						{plural(stats.salaried, ['вакансии', 'вакансиям', 'вакансиям'])}{stats.top !== null
							? ` · до ${rouble(stats.top)}`
							: ''}
					</p>
				{:else}
					<p class="font-heading text-h2 text-muted-foreground">—</p>
					<p class="text-xs text-muted-foreground">зарплаты в рублях в месяц на странице не указаны</p>
				{/if}
			</div>

			<div
				class={cn(
					tile,
					'col-span-2 lg:col-span-1',
					stats.gap ? 'border-primary/30 bg-accent/60 dark:bg-accent/40' : 'border-success/30'
				)}
			>
				{#if stats.gap}
					<p class={cn(tileLabel, 'text-accent-foreground')}>
						<SparklesIcon class="size-3.5" aria-hidden="true" />Точка роста
					</p>
					<p class="text-sm">
						Подтвердите <span class="font-heading font-medium">{stats.gap.name}</span> — закроете пробел в
						<span class="font-medium numeric">{stats.gap.count}</span>
						{plural(stats.gap.count, ['вакансии', 'вакансиях', 'вакансиях'])}{stats.gap.only > 0
							? `, в ${stats.gap.only} из них он единственный`
							: ''}.
					</p>
					<a href={pathOf(view.profileHref)} class="inline-flex items-center gap-1 text-xs text-link hover:underline">
						В профиль <ArrowRightIcon class="size-3" aria-hidden="true" />
					</a>
				{:else}
					<p class={cn(tileLabel, 'text-success')}>
						<CheckIcon class="size-3.5" aria-hidden="true" />Навыки
					</p>
					<p class="text-sm">Все обязательные навыки этих вакансий у вас подтверждены.</p>
				{/if}
			</div>
		</section>

		<div class="grid gap-4" data-testid="vacancy-list">
			<ul class="grid gap-4 lg:grid-cols-3">
				{#if featured}
					<li class="min-w-0 lg:col-span-2">
						<Card item={featured} featured />
					</li>
				{/if}
				{#if side}
					<li class="min-w-0">
						<Card item={side} />
					</li>
				{/if}
			</ul>
			{#if rest.length > 0}
				<ul class="grid gap-3" aria-label="Остальные вакансии">
					{#each rest as item (item.id)}
						<li class="min-w-0">
							<Row {item} />
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if search.firstHref || search.nextHref}
			<nav class="flex flex-wrap justify-center gap-3" aria-label="Страницы выдачи">
				{#if search.firstHref}
					<a href={pathOf(search.firstHref)} class={buttonVariants({ variant: 'ghost' })}> К началу списка </a>
				{/if}
				{#if search.nextHref}
					<a href={pathOf(search.nextHref)} class={buttonVariants({ variant: 'outline' })}>
						Следующие вакансии
						<ArrowRightIcon aria-hidden="true" />
					</a>
				{/if}
			</nav>
		{/if}
	{/if}
</div>

<style>
	.grow {
		transform-origin: bottom;
		animation: grow 0.9s cubic-bezier(0.2, 0, 0, 1) both;
	}

	.sweep {
		background: conic-gradient(from 0deg, color-mix(in oklab, var(--primary) 30%, transparent), transparent 22%);
		animation: spin 4s linear infinite;
	}

	@keyframes grow {
		from {
			transform: scaleY(0);
		}
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
</style>
