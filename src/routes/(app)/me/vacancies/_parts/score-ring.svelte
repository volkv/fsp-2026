<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { clamp01, toneOf } from './score.js';

	let {
		score,
		size = 76,
		stroke = 7,
		class: className
	}: { score: number; size?: number; stroke?: number; class?: string } = $props();

	const value = $derived(clamp01(score));
	const tone = $derived(toneOf(value));
	const radius = $derived((size - stroke) / 2);
	const circumference = $derived(2 * Math.PI * radius);
	const rounded = $derived(Math.round(value * 100));
	const large = $derived(size >= 120);
</script>

<div
	class={cn('relative grid shrink-0 place-items-center', tone.text, className)}
	style:width="{size}px"
	style:height="{size}px"
	role="img"
	aria-label="Соответствие {rounded} %, {tone.label}"
>
	<svg viewBox="0 0 {size} {size}" class="size-full -rotate-90" aria-hidden="true">
		<circle
			cx={size / 2}
			cy={size / 2}
			r={radius}
			fill="none"
			stroke="currentColor"
			stroke-opacity="0.14"
			stroke-width={stroke}
		/>
		<circle
			class="arc"
			cx={size / 2}
			cy={size / 2}
			r={radius}
			fill="none"
			stroke="currentColor"
			stroke-width={stroke}
			stroke-linecap="round"
			stroke-dasharray={circumference}
			stroke-dashoffset={circumference * (1 - value)}
			style:--full={circumference}
		/>
	</svg>
	<span class="absolute inset-0 grid place-items-center" aria-hidden="true">
		<span class="flex items-baseline font-heading leading-none font-medium numeric">
			<span class={large ? 'text-[2.5rem]' : size >= 70 ? 'text-xl' : 'text-base'}>{rounded}</span>
			<span class={large ? 'text-base' : 'text-[0.65rem]'}>%</span>
		</span>
	</span>
</div>

<style>
	.arc {
		filter: drop-shadow(0 0 4px color-mix(in oklab, currentColor 45%, transparent));
		animation: fill-arc 1.1s cubic-bezier(0.2, 0, 0, 1) both;
	}

	@keyframes fill-arc {
		from {
			stroke-dashoffset: var(--full);
		}
	}
</style>
