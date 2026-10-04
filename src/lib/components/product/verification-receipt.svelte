<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { cn } from '$lib/components/utils.js';
	import { formatDate, RECEIPT_SOURCE_TRUST, RECEIPT_SOURCES, RECEIPT_STATUSES, type ReceiptView } from './model.js';
	import TrustChip from './trust-chip.svelte';

	let {
		receipt,
		simulator = false,
		verifyHref,
		class: className
	}: {
		receipt: ReceiptView;
		/**
		 * The statement says its source is the simulator of FSP on a demonstration stand (`source_simulator`), not the
		 * federation itself.
		 */
		simulator?: boolean;
		/** Public check page of the receipt, once it exists; already passed through `resolve()`. */
		verifyHref?: ResolvedPathname;
		class?: string;
	} = $props();

	const valid = $derived(receipt.status === 'valid');
	const titleId = $props.id();
</script>

<Card.Root class={cn('gap-4', className)} role="article" aria-labelledby={titleId} data-receipt-status={receipt.status}>
	<Card.Header class="gap-2">
		<div class="flex flex-wrap items-center gap-2">
			<TrustChip level={RECEIPT_SOURCE_TRUST[receipt.source]} />
			<Badge
				variant="outline"
				class={cn(valid ? 'border-success/40 text-success' : 'border-destructive/40 text-destructive')}
			>
				{#if valid}<CircleCheckIcon aria-hidden="true" />{:else}<CircleSlashIcon aria-hidden="true" />{/if}
				{RECEIPT_STATUSES[receipt.status]}
			</Badge>
			{#if simulator}
				<Badge
					variant="outline"
					class="border-warning/40 bg-warning-subtle text-warning"
					data-testid="receipt-simulator"
				>
					<FlaskConicalIcon aria-hidden="true" />
					Имитатор ФСП
				</Badge>
			{/if}
		</div>
		<Card.Title id={titleId} class="text-base">Квитанция проверки: {receipt.title}</Card.Title>
		<Card.Description>
			{#if simulator}
				Источник — демонстрационный имитатор ФСП, а не сама федерация: спортсмен и результаты синтетические, сверено
				{formatDate(receipt.verifiedAt)}.
			{:else}
				Источник — {RECEIPT_SOURCES[receipt.source]}, сверено {formatDate(receipt.verifiedAt)}.
			{/if}
			{receipt.disclosure === 'exact'
				? 'Показаны точные сведения.'
				: 'Сведения обобщены: точное соревнование и место видны после согласия кандидата.'}
		</Card.Description>
	</Card.Header>
	<Card.Content class="grid gap-4 sm:grid-cols-2">
		<section aria-label="Что подтверждает">
			<p class="mb-2 text-sm font-semibold">Подтверждает</p>
			<ul class="space-y-1.5 text-sm">
				{#each receipt.asserts as item (item.label)}
					<li class="flex gap-2">
						<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
						<span><span class="text-muted-foreground">{item.label}:</span> {item.value}</span>
					</li>
				{/each}
			</ul>
		</section>
		<section aria-label="Чего не подтверждает">
			<p class="mb-2 text-sm font-semibold">Не подтверждает</p>
			<ul class="space-y-1.5 text-sm">
				{#each receipt.doesNotAssert as item (item)}
					<li class="flex gap-2">
						<CircleSlashIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span>{item}</span>
					</li>
				{/each}
			</ul>
		</section>
	</Card.Content>
	<Card.Footer class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
		<dl class="grid gap-0.5 text-xs text-muted-foreground">
			<div class="flex gap-1.5">
				<dt>Идентификатор:</dt>
				<dd class="font-mono break-all text-foreground">{receipt.handle}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt>Подпись:</dt>
				<dd class="font-mono">Ed25519 · ключ {receipt.signingKeyId}</dd>
			</div>
		</dl>
		{#if verifyHref}
			<a href={verifyHref} class={buttonVariants({ variant: 'outline', size: 'sm' })}>
				Проверить подпись
				<ExternalLinkIcon aria-hidden="true" />
			</a>
		{/if}
	</Card.Footer>
</Card.Root>
