<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { componentShort as SHORT } from './score.js';
	import type { ComponentView } from './view.js';

	let { components, class: className }: { components: ComponentView[]; class?: string } = $props();

	const CX = 150;
	const CY = 108;
	const R = 72;
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

	function angleOf(index: number, count: number): number {
		return -Math.PI / 2 + (2 * Math.PI * index) / count;
	}

	function pointAt(index: number, count: number, scale: number): [number, number] {
		const angle = angleOf(index, count);
		return [CX + Math.cos(angle) * R * scale, CY + Math.sin(angle) * R * scale];
	}

	function polygon(count: number, scaleOf: (index: number) => number): string {
		return Array.from({ length: count }, (_, index) => pointAt(index, count, scaleOf(index)).join(',')).join(' ');
	}

	const count = $derived(components.length);
	const shape = $derived(polygon(count, (index) => Math.max(0.04, components[index]?.value ?? 0)));
	const summary = $derived(
		components
			.map(
				(component) =>
					`${component.label}: ${component.value === null ? 'не вычислено' : percent.format(component.value)}`
			)
			.join('; ')
	);
</script>

<svg
	viewBox="0 0 300 216"
	class={cn('h-auto w-full max-w-[22rem] overflow-visible', className)}
	role="img"
	aria-label="Профиль совпадения. {summary}"
>
	{#each [0.25, 0.5, 0.75, 1] as level (level)}
		<polygon
			points={polygon(count, () => level)}
			fill={level === 1 ? 'currentColor' : 'none'}
			fill-opacity="0.03"
			stroke="currentColor"
			stroke-opacity={level === 1 ? 0.22 : 0.1}
			class="text-foreground"
		/>
	{/each}
	{#each components as component, index (component.key)}
		{@const [x, y] = pointAt(index, count, 1)}
		<line x1={CX} y1={CY} x2={x} y2={y} class="text-foreground" stroke="currentColor" stroke-opacity="0.08" />
	{/each}

	<g class="shape text-primary dark:text-brand-300" style:transform-origin="{CX}px {CY}px">
		<polygon
			points={shape}
			fill="currentColor"
			fill-opacity="0.18"
			stroke="currentColor"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		{#each components as component, index (component.key)}
			{@const [x, y] = pointAt(index, count, Math.max(0.04, component.value ?? 0))}
			<circle
				cx={x}
				cy={y}
				r="3.5"
				fill={component.value === null ? 'var(--card)' : 'currentColor'}
				stroke="currentColor"
				stroke-width="1.5"
				stroke-dasharray={component.value === null ? '2 2' : undefined}
			>
				<title>{component.label}: {component.value === null ? 'не вычислено' : percent.format(component.value)}</title>
			</circle>
		{/each}
	</g>

	{#each components as component, index (component.key)}
		{@const angle = angleOf(index, count)}
		{@const [x, y] = pointAt(index, count, 1.16)}
		{@const cos = Math.cos(angle)}
		{@const sin = Math.sin(angle)}
		<text
			{x}
			y={y + (sin > 0.5 ? 9 : sin < -0.5 ? -2 : 3)}
			text-anchor={cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle'}
			class="fill-muted-foreground text-[10px]"
		>
			{SHORT[component.key]}
			<tspan class="fill-foreground font-medium"
				>{component.value === null ? '—' : Math.round(component.value * 100)}</tspan
			>
		</text>
	{/each}
</svg>

<style>
	.shape {
		animation: grow 0.9s cubic-bezier(0.2, 0, 0, 1) both;
	}

	@keyframes grow {
		from {
			transform: scale(0);
			opacity: 0;
		}
	}
</style>
