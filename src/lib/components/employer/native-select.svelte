<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import { cn } from '$lib/components/utils.js';

	/**
	 * A native select styled like the inputs of the design system: it works without scripts, so a form of the cabinet
	 * posts the same with and without them. The arrow of the system gives way to the one of the select trigger.
	 */
	let {
		class: className,
		children,
		value = $bindable(),
		...rest
	}: Omit<HTMLSelectAttributes, 'value'> & { value?: string } = $props();
</script>

<div class={cn('relative w-full min-w-0', className)}>
	<select
		bind:value
		class="h-9 w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-input bg-background py-1 pr-9 pl-2.5 text-sm shadow-xs transition-[color,box-shadow] outline-none hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 [&>option]:bg-popover [&>option]:text-popover-foreground"
		{...rest}
	>
		{@render children?.()}
	</select>
	<ChevronDownIcon
		aria-hidden="true"
		class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
	/>
</div>
