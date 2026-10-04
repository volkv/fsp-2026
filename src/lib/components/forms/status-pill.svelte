<script lang="ts">
	import { cn } from '$lib/components/utils.js';

	/** A status in words with a tone; the words carry the meaning, the tone only supports them. */
	let {
		label,
		tone = 'neutral',
		class: className
	}: { label: string; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; class?: string } = $props();

	const tones = {
		neutral: 'border-border bg-muted text-muted-foreground',
		info: 'border-info/30 bg-info-subtle text-info',
		success: 'border-success/40 bg-success-subtle text-success',
		warning: 'border-warning/40 bg-warning-subtle text-warning',
		danger: 'border-destructive/40 bg-danger-subtle text-destructive'
	} as const;
</script>

<span
	class={cn(
		'inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium whitespace-nowrap',
		tones[tone],
		className
	)}
>
	{label}
</span>
