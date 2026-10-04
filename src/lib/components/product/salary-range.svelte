<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { SALARY_PERIODS, TAX_BASES, type SalaryComparison, type SalaryView } from './model.js';

	interface Props {
		salary: SalaryView;
		/** Result of `compareSalary` and what the range was compared with. */
		comparison?: { result: SalaryComparison; against: string };
		size?: 'sm' | 'lg';
		class?: string;
	}

	let { salary, comparison, size = 'sm', class: className }: Props = $props();

	const comparisonText: Record<SalaryComparison, string> = {
		lower: 'ниже',
		equal: 'совпадает с',
		higher: 'выше',
		overlap: 'пересекается с',
		not_comparable: 'несравнимо с'
	};

	const amount = $derived.by(() => {
		const { min, max, currency } = salary;
		const format = new Intl.NumberFormat('ru-RU', {
			style: 'currency',
			currency: currency ?? 'RUB',
			maximumFractionDigits: 0
		});
		if (min !== null && max !== null) return min === max ? format.format(min) : format.formatRange(min, max);
		if (min !== null) return `от ${format.format(min)}`;
		if (max !== null) return `до ${format.format(max)}`;
		return null;
	});
</script>

<div class={cn('inline-flex flex-col gap-0.5', className)} data-salary={amount === null ? 'not_stated' : 'stated'}>
	{#if amount === null}
		<span class="text-sm text-muted-foreground">Зарплата не указана</span>
	{:else}
		<span class={cn('font-heading font-medium numeric', size === 'lg' ? 'text-h3' : 'text-base')}>{amount}</span>
		<span class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
			{#if salary.period}<span>{SALARY_PERIODS[salary.period]}</span>{/if}
			{#if salary.taxBase === 'unknown'}
				<span class="rounded-sm bg-warning-subtle px-1 text-warning">{TAX_BASES.unknown}</span>
			{:else if salary.taxBase}
				<span>· {TAX_BASES[salary.taxBase]}</span>
			{/if}
		</span>
	{/if}
	{#if comparison}
		<span
			class={cn('text-xs', comparison.result === 'not_comparable' ? 'text-warning' : 'text-muted-foreground')}
			data-comparison={comparison.result}
		>
			{#if comparison.result === 'not_comparable'}
				Несравнимо с {comparison.against}: разные валюта, период или налоговая база
			{:else}
				Вилка {comparisonText[comparison.result]} {comparison.against}
			{/if}
		</span>
	{/if}
</div>
