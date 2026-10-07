<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { FSP_LOGO, type LogoPart } from './logo.js';

	/**
	 * The short FSP logo, theme-aware as the brandbook prescribes (see `logo.ts`). Size it by height (`h-8`); the width
	 * follows the logo's proportions.
	 */
	let { class: className, title }: { class?: string; title?: string } = $props();

	const fill: Record<LogoPart, string> = {
		light: 'fill-(--fsp-sign-light)',
		red: 'fill-brand-red',
		blue: 'fill-brand-500',
		lettering: 'fill-foreground'
	};
</script>

<svg
	viewBox="0 0 {FSP_LOGO.width} {FSP_LOGO.height}"
	class={cn(
		'w-auto shrink-0 [--fsp-sign-light:var(--color-ink-150)] dark:[--fsp-sign-light:var(--color-ink-50)]',
		className
	)}
	role={title ? 'img' : undefined}
	aria-hidden={title ? undefined : 'true'}
	aria-label={title}
	xmlns="http://www.w3.org/2000/svg"
>
	{#each FSP_LOGO.paths as path, index (index)}
		<path class={fill[path.part]} d={path.d} />
	{/each}
</svg>
