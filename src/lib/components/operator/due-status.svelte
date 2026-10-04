<script lang="ts">
	import AlarmClockIcon from '@lucide/svelte/icons/alarm-clock';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import { dueText } from './model.js';

	/**
	 * Due time of a case: past due, near it, or in time. The state is decided by the server at the moment of the page;
	 * words carry it, the tone only supports them.
	 */
	let {
		dueAt,
		now,
		overdue,
		dueSoon,
		class: className
	}: { dueAt: Date; now: Date; overdue: boolean; dueSoon: boolean; class?: string } = $props();

	const phase = $derived(overdue ? 'overdue' : dueSoon ? 'soon' : 'in_time');
</script>

<span
	class={cn(
		'inline-flex items-center gap-1.5 text-sm',
		phase === 'overdue' && 'font-medium text-destructive',
		phase === 'soon' && 'text-warning',
		phase === 'in_time' && 'text-muted-foreground',
		className
	)}
	data-due={phase}
	title={`Срок: ${formatDateTime(dueAt)}`}
>
	{#if phase === 'overdue'}
		<CircleAlertIcon class="size-4 shrink-0" aria-hidden="true" />
	{:else if phase === 'soon'}
		<AlarmClockIcon class="size-4 shrink-0" aria-hidden="true" />
	{:else}
		<TimerIcon class="size-4 shrink-0" aria-hidden="true" />
	{/if}
	{dueText(dueAt, now)}
</span>
