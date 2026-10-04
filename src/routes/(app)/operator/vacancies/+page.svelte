<script lang="ts">
	import { resolve } from '$app/paths';
	import ScanTextIcon from '@lucide/svelte/icons/scan-text';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { COMPANY_STATUSES } from '$lib/components/employer/model.js';
	import { TEXT_CHECK_CATEGORIES, TEXT_FIELDS, waitText } from '$lib/components/operator/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Модерация вакансий"
	description="Проверка текста нашла в вакансии требование, которое закон не разрешает ставить условием найма. Часть таких требований законна — например, гражданство для допуска к гостайне: решение за оператором."
/>

{#if data.queue.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><ScanTextIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Вакансий на модерации нет</Empty.Title>
		</Empty.Header>
	</Empty.Root>
{:else}
	<ul class="grid gap-4" aria-label="Вакансии на модерации">
		{#each data.queue as item (item.vacancyId)}
			{@const company = COMPANY_STATUSES[item.company.status]}
			<li>
				<Card.Root data-moderation={item.vacancyId}>
					<Card.Header>
						<Card.Title>
							<h2 class="font-heading text-h3">
								<a
									class="underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/vacancies/[id]', { id: item.vacancyId })}>{item.title}</a
								>
							</h2>
						</Card.Title>
						<Card.Description class="flex flex-wrap items-center gap-2">
							<span class="font-medium text-foreground">{item.company.displayName}</span>
							<span>ИНН {item.company.inn}</span>
							<StatusPill label={company.label} tone={company.tone} />
						</Card.Description>
					</Card.Header>
					<Card.Content class="grid gap-3 text-sm">
						<p class="text-muted-foreground" data-testid="moderation-wait">
							На модерации с {formatDateTime(item.openedAt)} — {waitText(item.openedAt, data.now)}
							{#if item.resumeTo === 'paused'}· до правки была приостановлена{/if}
						</p>
						<ul class="grid gap-2" aria-label="Что нашла проверка текста">
							{#each item.findings as finding, index (index)}
								<li class="grid gap-1 rounded-lg border border-destructive/30 bg-danger-subtle px-3 py-2">
									<p class="text-xs text-muted-foreground">
										{TEXT_CHECK_CATEGORIES[finding.category] ?? finding.category} · правило
										<code class="font-mono">{finding.rule}</code> · {TEXT_FIELDS[finding.field] ?? finding.field}
									</p>
									<blockquote class="text-foreground/90">
										{finding.quote.before}<mark class="rounded-sm bg-background px-0.5 font-medium"
											>{finding.quote.text}</mark
										>{finding.quote.after}
									</blockquote>
								</li>
							{/each}
						</ul>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>
{/if}
