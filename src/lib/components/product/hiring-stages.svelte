<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import { cn } from '$lib/components/utils.js';
	import {
		HIRING_OUTCOMES,
		HIRING_PARTIES,
		HIRING_STAGES,
		type HiringOutcomeState,
		type HiringParty,
		type HiringView
	} from './model.js';

	let { hiring, class: className }: { hiring: HiringView; class?: string } = $props();

	const outcomeStates: Record<HiringOutcomeState, { label: string; tone: string }> = {
		pending: { label: 'Исход ожидается', tone: 'text-muted-foreground' },
		single_party: { label: 'Исход отмечен одной стороной', tone: 'text-info' },
		confirmed: { label: 'Исход подтверждён обеими сторонами', tone: 'text-success' },
		diverged: { label: 'Стороны отметили исход по-разному', tone: 'text-warning' },
		unknown: { label: 'Исход неизвестен: стороны не сообщили', tone: 'text-muted-foreground' }
	};

	const reached = $derived(HIRING_STAGES.findLastIndex((stage) => (hiring.stages[stage.key]?.length ?? 0) > 0));

	function reporters(parties: HiringParty[] | undefined): string {
		if (!parties || parties.length === 0) return '';
		if (parties.length > 1) return `сообщили ${parties.map((party) => HIRING_PARTIES[party]).join(' и ')}`;
		return parties[0] === 'company' ? 'сообщила компания' : 'сообщил кандидат';
	}
</script>

<!-- Columns follow the width of the place the stages stand in, not of the window: in a side column four labels do not fit. -->
<div class={cn('@container space-y-3', className)}>
	<ol class="grid gap-2 @sm:grid-cols-2 @2xl:grid-cols-4" aria-label="Этапы найма">
		{#each HIRING_STAGES as stage, index (stage.key)}
			{@const done = index <= reached}
			<li
				class={cn(
					'flex items-start gap-2 rounded-lg border p-2.5 text-sm',
					done ? 'border-primary/40 bg-accent text-accent-foreground' : 'border-dashed text-muted-foreground'
				)}
				aria-current={index === reached ? 'step' : undefined}
				data-done={done}
			>
				<span
					class={cn(
						'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-xs',
						done && 'border-primary bg-primary text-primary-foreground'
					)}
					aria-hidden="true"
				>
					{#if done}<CheckIcon class="size-3" />{:else}{index + 1}{/if}
				</span>
				<span class="min-w-0 hyphens-auto">
					<span class="block font-medium">{stage.label}</span>
					{#if hiring.stages[stage.key]?.length}
						<span class="block text-xs opacity-90">{reporters(hiring.stages[stage.key])}</span>
					{:else if !done}
						<span class="sr-only">не отмечено</span>
					{/if}
				</span>
			</li>
		{/each}
	</ol>
	<p class="text-sm" data-outcome-state={hiring.outcome.state}>
		<span class={cn('font-medium', outcomeStates[hiring.outcome.state].tone)}>
			{outcomeStates[hiring.outcome.state].label}
		</span>
		{#each hiring.outcome.reports as report (report.party)}
			<span class="text-muted-foreground"> · {HIRING_PARTIES[report.party]}: {HIRING_OUTCOMES[report.outcome]}</span>
		{/each}
	</p>
</div>
