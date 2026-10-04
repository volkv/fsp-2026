<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CountCell from './count-cell.svelte';
	import { PARTNERSHIP_KINDS, POOL_AWARDS, POOL_STAGES, type Cell } from './model.js';

	interface Partnership {
		id: string;
		company: { id: string; displayName: string };
		competitionRef: string;
		kind: string;
		poolRule: { min_award: string; stages: string[] };
		status: 'active' | 'ended';
		validFrom: string;
		validTo: string | null;
		basis: string;
		poolOpen: boolean;
		fitting: Cell;
	}

	/** Partnerships with their pool rule, whether the pool is open now, and the end action for an active one. */
	let {
		partnerships,
		competitionTitles,
		showCompany = true
	}: { partnerships: Partnership[]; competitionTitles: Record<string, string>; showCompany?: boolean } = $props();
</script>

<ul class="grid gap-3" aria-label="Партнёрства">
	{#each partnerships as partnership (partnership.id)}
		<li
			class="grid gap-2 rounded-lg border p-4 text-sm"
			data-partnership={partnership.id}
			data-status={partnership.status}
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="font-medium">
					{competitionTitles[partnership.competitionRef] ?? partnership.competitionRef}
					{#if showCompany}
						<span class="text-muted-foreground">·</span>
						<a
							class="underline-offset-4 hover:underline"
							href={resolve('/(app)/operator/companies/[id]', { id: partnership.company.id })}
							>{partnership.company.displayName}</a
						>
					{/if}
				</p>
				{#if partnership.status === 'ended'}
					<StatusPill label="Завершено" />
				{:else if partnership.poolOpen}
					<StatusPill label="Пул открыт" tone="success" />
				{:else}
					<StatusPill label="Пул закрыт: вне срока или компания не проверена" tone="warning" />
				{/if}
			</div>
			<dl class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
				<div>
					<dt class="inline text-muted-foreground">Вид:</dt>
					<dd class="inline">{PARTNERSHIP_KINDS[partnership.kind] ?? partnership.kind}</dd>
				</div>
				<div>
					<dt class="inline text-muted-foreground">Срок:</dt>
					<dd class="inline">
						{formatDate(partnership.validFrom)} — {partnership.validTo
							? formatDate(partnership.validTo)
							: 'без даты окончания'}
					</dd>
				</div>
				<div>
					<dt class="inline text-muted-foreground">Правило пула:</dt>
					<dd class="inline">
						{POOL_AWARDS[partnership.poolRule.min_award] ?? partnership.poolRule.min_award},
						{partnership.poolRule.stages.map((stage) => POOL_STAGES[stage] ?? stage).join(', ')}
					</dd>
				</div>
				<div>
					<dt class="inline text-muted-foreground">С подходящим результатом на платформе:</dt>
					<dd class="inline"><CountCell cell={partnership.fitting} /></dd>
				</div>
				<div class="sm:col-span-2">
					<dt class="inline text-muted-foreground">Основание:</dt>
					<dd class="inline">{partnership.basis}</dd>
				</div>
			</dl>
			{#if partnership.status === 'active'}
				<form method="POST" action="?/endPartnership" use:enhance>
					<CsrfInput />
					<input type="hidden" name="partnershipId" value={partnership.id} />
					<Button type="submit" variant="outline" size="sm">Завершить сегодня</Button>
				</form>
			{/if}
		</li>
	{/each}
</ul>
