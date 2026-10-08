<script lang="ts">
	import type { CoveredRequirement } from '$lib/server/assessments/vacancy-spec';
	import { coverageText } from './test-spec';

	/** Requirements of a vacancy or a need, each with how the test covers it; a required one filled, a nice one outlined. */
	let { list }: { list: CoveredRequirement[] } = $props();
</script>

<ul class="grid gap-1.5 text-sm">
	{#each list as r (`${r.requirement}:${r.skillKey ?? r.name}`)}
		<li class="flex flex-wrap items-baseline gap-x-2" data-testid="spec-requirement" data-tested={r.tested}>
			<span
				class="font-mono text-xs {r.requirement === 'required'
					? 'rounded-md bg-muted px-1.5'
					: 'rounded-md border px-1.5'}"
			>
				{r.name}
			</span>
			<span class={r.tested ? '' : 'text-muted-foreground'}>{coverageText(r.coverage)}</span>
		</li>
	{/each}
</ul>
