<script lang="ts">
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { cn } from '$lib/components/utils.js';
	import { formatDelta, formatMetric, METRIC_GROUPS, METRIC_STATUSES, METRICS } from './model.js';

	interface MetricRow {
		key: string;
		value: number | null;
		baseline: number | null;
		delta: number | null;
		n: number | null;
		threshold: { min: number | null; max: number | null } | null;
		status: 'pass' | 'fail' | 'missing' | 'no_threshold' | 'no_value';
	}

	/**
	 * One group of metrics of a run: the value as a bar on the 0–1 scale, the threshold as a line, the baseline as a tick.
	 * A value outside 0–1 has no bar; the numbers are always written out.
	 */
	let { group, metrics, failed }: { group: string; metrics: MetricRow[]; failed: number } = $props();

	/** Known metrics in the order of the model; others after them by key. The stored order is lost in `jsonb`. */
	const KNOWN = Object.keys(METRICS);
	const rank = (key: string) => (KNOWN.includes(key) ? KNOWN.indexOf(key) : KNOWN.length);
	const ordered = $derived([...metrics].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)));

	const inUnit = (value: number | null): value is number => value !== null && value >= 0 && value <= 1;
	const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
	const bound = (threshold: MetricRow['threshold']) =>
		threshold?.min !== null && threshold?.min !== undefined ? threshold.min : (threshold?.max ?? null);
	const thresholdText = (threshold: MetricRow['threshold']) => {
		if (!threshold) return 'не задан';
		const parts = [];
		if (threshold.min !== null) parts.push(`≥ ${formatMetric(threshold.min)}`);
		if (threshold.max !== null) parts.push(`≤ ${formatMetric(threshold.max)}`);
		return parts.join(' и ');
	};
</script>

<section class="grid gap-3 rounded-lg border p-4" aria-labelledby="group-{group}" data-metric-group={group}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 id="group-{group}" class="font-medium">{METRIC_GROUPS[group] ?? group}</h3>
		{#if failed > 0}
			<StatusPill label="порог не пройден: {failed}" tone="danger" />
		{/if}
	</div>
	<ul class="grid gap-4">
		{#each ordered as metric (metric.key)}
			{@const status = METRIC_STATUSES[metric.status]}
			{@const limit = bound(metric.threshold)}
			<li class="grid gap-1.5" data-metric={metric.key} data-status={metric.status}>
				<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
					<span class="font-medium">{METRICS[metric.key] ?? metric.key}</span>
					<span class="flex flex-wrap items-baseline gap-3">
						<span class="font-heading text-lg tabular-nums" data-value>{formatMetric(metric.value)}</span>
						{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
					</span>
				</div>
				{#if inUnit(metric.value)}
					<div class="relative h-2.5 rounded-full bg-muted" aria-hidden="true">
						<div
							class={cn(
								'h-full rounded-full',
								metric.status === 'fail' ? 'bg-destructive' : metric.status === 'pass' ? 'bg-success' : 'bg-primary'
							)}
							style:width={percent(metric.value)}
						></div>
						{#if inUnit(limit)}
							<div class="absolute -top-1 h-4.5 w-0.5 bg-foreground" style:left={percent(limit)}></div>
						{/if}
						{#if inUnit(metric.baseline)}
							<div
								class="absolute top-0 h-full w-1 rounded-sm bg-warning"
								style:left={`calc(${percent(metric.baseline)} - 2px)`}
							></div>
						{/if}
					</div>
				{/if}
				<p class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
					<span>порог: {thresholdText(metric.threshold)}</span>
					<span>базовый вариант: {formatMetric(metric.baseline)}</span>
					<span>разница: {formatDelta(metric.delta)}</span>
					{#if metric.n !== null}<span>n = {metric.n}</span>{/if}
				</p>
			</li>
		{/each}
	</ul>
</section>
