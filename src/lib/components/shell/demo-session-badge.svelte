<script lang="ts">
	import TimerIcon from '@lucide/svelte/icons/timer';
	import { resolve } from '$app/paths';
	import { cn } from '$lib/components/utils.js';
	import { timeLeft } from './viewer.js';

	interface Props {
		expiresAt: Date;
		/**
		 * In the header line: below the large width only «Демо» and the time are shown, where the line has no room for
		 * the whole phrase; screen readers get the whole phrase at any width.
		 */
		compact?: boolean;
		class?: string;
	}

	let { expiresAt, compact = false, class: className }: Props = $props();

	/** The clock of the page: taken again on mount and every half minute, so the time left follows the visit. */
	let now = $state(Date.now());
	$effect(() => {
		now = Date.now();
		const timer = setInterval(() => {
			now = Date.now();
		}, 30_000);
		return () => {
			clearInterval(timer);
		};
	});

	const left = $derived(timeLeft(expiresAt, now));
</script>

<a
	href={resolve('/demo')}
	class={cn(
		'inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning-subtle px-2.5 py-0.5 text-xs font-medium text-warning hover:border-warning focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
		className
	)}
	data-testid="demo-session-badge"
>
	<TimerIcon class="size-3.5" aria-hidden="true" />
	<span>Демо<span class={cn(compact && 'max-lg:sr-only')}>-сессия, удалится через</span> {left}</span>
</a>
