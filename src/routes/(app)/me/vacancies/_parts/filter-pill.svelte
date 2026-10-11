<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn } from '$lib/components/utils.js';

	/** A native select as a filter pill: the caption stays inside, the chosen value is highlighted. */
	let {
		name,
		label,
		any,
		options,
		current
	}: { name: string; label: string; any: string; options: [string, string][]; current: string | null } = $props();
</script>

<label
	class={cn(
		'relative inline-flex h-9 max-w-full min-w-0 items-center gap-1 rounded-md border bg-card pl-3 text-sm transition-colors focus-within:ring-3 focus-within:ring-ring/50 hover:border-ring/60',
		current !== null && 'border-primary/50 bg-accent text-accent-foreground'
	)}
>
	<span class={current !== null ? 'opacity-80' : 'text-muted-foreground'}>{label}</span>
	<select
		{name}
		class="h-full max-w-[11rem] min-w-0 cursor-pointer appearance-none truncate bg-transparent pr-8 font-medium outline-none [&>option]:bg-popover [&>option]:text-popover-foreground"
	>
		<option value="" selected={current === null}>{any}</option>
		{#each options as [key, title] (key)}
			<option value={key} selected={key === current}>{title}</option>
		{/each}
	</select>
	<ChevronDownIcon
		class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 opacity-60"
		aria-hidden="true"
	/>
</label>
