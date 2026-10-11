<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { formatFigure } from './content.js';

	/**
	 * A figure of the scoreboard: the server renders the final value; in the browser its digits run through random
	 * values and lock left to right when the figure comes into view. Reduced motion keeps the final value.
	 */
	let { value, class: className }: { value: number; class?: string } = $props();

	const DURATION = 1400;
	const STEP = 55;

	const final = $derived(formatFigure(value));
	let shown = $state<string | null>(null);
	let node = $state<HTMLElement>();

	function scramble(text: string, progress: number): string {
		const digits = Array.from(text).filter((char) => /\d/.test(char)).length;
		let index = 0;
		return Array.from(text)
			.map((char) => {
				if (!/\d/.test(char)) return char;
				const lockAt = 0.35 + 0.65 * (index / Math.max(digits, 1));
				index += 1;
				return progress >= lockAt ? char : String(Math.floor(Math.random() * 10));
			})
			.join('');
	}

	$effect(() => {
		const target = final;
		if (!node || typeof IntersectionObserver === 'undefined') return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		let frame = 0;
		let started = 0;
		let last = 0;
		const tick = (now: number) => {
			if (!started) started = now;
			const progress = (now - started) / DURATION;
			if (progress >= 1) {
				shown = null;
				return;
			}
			if (now - last >= STEP) {
				shown = scramble(target, progress);
				last = now;
			}
			frame = requestAnimationFrame(tick);
		};
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer.disconnect();
					frame = requestAnimationFrame(tick);
				}
			},
			{ threshold: 0.6 }
		);
		observer.observe(node);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			shown = null;
		};
	});
</script>

<span bind:this={node} class={cn('inline-block accent-figure whitespace-nowrap', className)}>
	<span aria-hidden="true">{shown ?? final}</span>
	<span class="sr-only">{final}</span>
</span>
