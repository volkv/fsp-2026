<script lang="ts">
	import ChartNoAxesColumnIcon from '@lucide/svelte/icons/chart-no-axes-column';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { InsufficientData } from '$lib/components/product/index.js';
	import { formatDate, pluralize, SALARY_PERIODS, TAX_BASES } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';

	/** The position of a vacancy range against the market of its category, as the page of the vacancy gives it. */
	interface MarketPositionView {
		/** `no_specialization` — the role is not chosen or is of no specialization: no market of a category. */
		state: 'no_specialization' | 'evaluated';
		items: {
			indicator: 'vacancy_ranges' | 'external_reference';
			status: 'compared' | 'not_comparable' | 'insufficient_data';
			comparison: 'lower' | 'equal' | 'higher' | 'overlap' | null;
			/** The position in words, with «оценка» and «демо-данные» where they apply. */
			text: string;
			/** The combination the figure was collected for. */
			category: string | null;
			/** What a compared figure stands on. */
			basis: {
				sampleSize: number;
				median: number;
				p25: number;
				p75: number;
				currency: string;
				period: 'month' | 'year' | 'hour' | 'project';
				taxBase: 'gross' | 'net' | 'unknown';
				windowFrom: string;
				windowTo: string;
				estimated: boolean;
				provenance: 'live' | 'synthetic' | 'mixed';
			} | null;
		}[];
	}

	let { position, class: className }: { position: MarketPositionView; class?: string } = $props();

	const titleId = $props.id();

	const NAMES = { vacancy_ranges: 'Вилки вакансий', external_reference: 'Внешний ориентир' } as const;

	const INSUFFICIENT_HINTS = {
		vacancy_ranges:
			'Вакансий этой категории с полной вилкой меньше, чем нужно для честной медианы. Сравним, когда их станет больше.',
		external_reference: 'У внешнего источника нет данных по этой категории в той же валюте и периоде.'
	} as const;

	function money(value: number, currency: string): string {
		return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
	}

	function sample(indicator: MarketPositionView['items'][number]['indicator'], size: number): string {
		return indicator === 'vacancy_ranges'
			? `${size} ${pluralize(size, ['вакансия', 'вакансии', 'вакансий'])}`
			: `выборка источника — ${size}`;
	}

	const PROVENANCE = { live: null, synthetic: 'демо-данные, не рынок', mixed: 'часть данных — демонстрационные' };
</script>

<section
	class={cn('grid gap-3 rounded-xl border bg-muted/30 p-4', className)}
	aria-labelledby={titleId}
	data-testid="market-position"
	data-state={position.state}
>
	<h3 id={titleId} class="flex items-center gap-2 text-sm font-semibold">
		<ChartNoAxesColumnIcon class="size-4 text-muted-foreground" aria-hidden="true" />
		Вилка и рынок категории
	</h3>
	{#if position.state === 'no_specialization'}
		<InsufficientData
			hint="Рынок считается по категории — специализации и грейду. Выберите роль вакансии, которая относится к одной из специализаций справочника."
		/>
	{:else}
		<ul class="grid gap-3">
			{#each position.items as item (item.indicator)}
				<li class="grid gap-1" data-indicator={item.indicator} data-status={item.status}>
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{NAMES[item.indicator]}</p>
					{#if item.status === 'insufficient_data'}
						<InsufficientData hint={INSUFFICIENT_HINTS[item.indicator]} />
					{:else if item.status === 'not_comparable'}
						<p class="flex items-start gap-1.5 text-sm text-warning">
							<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{item.text}</span>
						</p>
						{#if item.category}
							<p class="text-xs text-muted-foreground">Категория: {item.category}</p>
						{/if}
					{:else if item.basis}
						<p class="text-sm font-medium" data-comparison={item.comparison}>{item.text}</p>
						<p class="text-xs text-muted-foreground">
							Медиана {money(item.basis.median, item.basis.currency)}, половина значений — от
							{money(item.basis.p25, item.basis.currency)} до {money(item.basis.p75, item.basis.currency)}
							{SALARY_PERIODS[item.basis.period]}, {TAX_BASES[item.basis.taxBase]}.
						</p>
						<p class="text-xs text-muted-foreground">
							{sample(item.indicator, item.basis.sampleSize)} · данные за {formatDate(
								item.basis.windowFrom
							)}–{formatDate(item.basis.windowTo)}
							{#if item.category}· категория: {item.category}{/if}
							{#if item.basis.estimated}· расчётная оценка, не наблюдение{/if}
							{#if PROVENANCE[item.basis.provenance]}· {PROVENANCE[item.basis.provenance]}{/if}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="text-xs text-muted-foreground">
			Сравниваем только в одной валюте, за один период и с той же налоговой базой: «на руки» и «до вычета НДФЛ» — разные
			рынки.
		</p>
	{/if}
</section>
