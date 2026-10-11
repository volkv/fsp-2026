<script lang="ts">
	import { resolve } from '$app/paths';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { PARTNERSHIP_KINDS } from '$lib/components/operator/model.js';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Пулы партнёра"
	description="Компания — партнёр соревнования ФСП (кейсодатель, спонсор): пока партнёрство действует, ей виден пул финалистов, давших согласие."
/>

{#if data.partnerships.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><HandshakeIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Компания не партнёр соревнований</Empty.Title>
			<Empty.Description>Партнёрство открывает оператор ФСП по договору или положению соревнования.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-3" data-tour="pools-list">
		{#each data.partnerships as partnership (partnership.id)}
			<li class="grid gap-1 rounded-xl border bg-card p-4">
				{#if partnership.open}
					<a
						class="font-heading text-h3 text-link hover:underline"
						href={resolve('/(app)/company/(member)/partner-pools/[partnershipId]', { partnershipId: partnership.id })}
						>{partnership.competitionTitle ?? `Соревнование ${partnership.competitionRef}`}</a
					>
				{:else}
					<span class="font-heading text-h3"
						>{partnership.competitionTitle ?? `Соревнование ${partnership.competitionRef}`}</span
					>
				{/if}
				<p class="text-sm text-muted-foreground">
					{PARTNERSHIP_KINDS[partnership.kind] ?? partnership.kind} · с {formatDate(
						partnership.validFrom
					)}{partnership.validTo ? ` по ${formatDate(partnership.validTo)}` : ''} · {partnership.open
						? 'пул открыт'
						: 'партнёрство не действует, пул закрыт'}
				</p>
			</li>
		{/each}
	</ul>
{/if}
