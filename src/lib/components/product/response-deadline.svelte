<script lang="ts">
	import TimerIcon from '@lucide/svelte/icons/timer';
	import { cn } from '$lib/components/utils.js';
	import { formatDateTime, pluralize } from './model.js';

	/** Response deadline of the current invitation terms version (domain §13.5), counting down live. */
	let {
		dueAt,
		label = 'Ответить до',
		class: className
	}: { dueAt: Date | string; label?: string; class?: string } = $props();

	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	let now = $state(Date.now());

	const due = $derived(typeof dueAt === 'string' ? new Date(dueAt) : dueAt);
	const remaining = $derived(due.getTime() - now);
	const phase = $derived(remaining <= 0 ? 'expired' : remaining <= DAY ? 'soon' : 'open');
	const tick = $derived(remaining > 0 && remaining < HOUR ? 1000 : 30_000);

	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, tick);
		return () => {
			clearInterval(id);
		};
	});

	const left = $derived.by(() => {
		if (remaining <= 0) return 'Срок ответа истёк';
		const days = Math.floor(remaining / DAY);
		const hours = Math.floor((remaining % DAY) / HOUR);
		const minutes = Math.floor((remaining % HOUR) / MINUTE);
		if (days > 0) return `осталось ${days} ${pluralize(days, ['день', 'дня', 'дней'])} ${hours} ч`;
		if (hours > 0) return `осталось ${hours} ч ${minutes} мин`;
		const seconds = Math.floor((remaining % MINUTE) / 1000);
		return `осталось ${minutes} мин ${seconds} с`;
	});
</script>

<div
	class={cn(
		'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
		phase === 'open' && 'bg-card',
		phase === 'soon' && 'border-warning/50 bg-warning-subtle text-warning',
		phase === 'expired' && 'border-dashed bg-muted text-muted-foreground',
		className
	)}
	data-deadline={phase}
>
	<TimerIcon class="size-4 shrink-0" aria-hidden="true" />
	<span>
		<span class="block text-xs {phase === 'open' ? 'text-muted-foreground' : ''}">
			{label} <time datetime={due.toISOString()}>{formatDateTime(due)}</time>
		</span>
		<span class="block font-mono font-medium numeric">{left}</span>
	</span>
</div>
