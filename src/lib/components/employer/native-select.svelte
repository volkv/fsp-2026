<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { cn } from '$lib/components/utils.js';

	/**
	 * A native select styled like the inputs of the design system: it works without scripts, so a form of the cabinet
	 * posts the same with and without them.
	 */
	let {
		class: className,
		children,
		value = $bindable(),
		...rest
	}: Omit<HTMLSelectAttributes, 'value'> & { value?: string } = $props();
</script>

<select
	bind:value
	class={cn(
		'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30',
		className
	)}
	{...rest}
>
	{@render children?.()}
</select>
