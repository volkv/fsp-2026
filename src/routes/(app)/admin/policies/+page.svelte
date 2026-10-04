<script lang="ts">
	import ScaleIcon from '@lucide/svelte/icons/scale';
	import { POLICY_KINDS } from '$lib/components/admin/model.js';
	import ParamValue from '$lib/components/admin/param-value.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Политики продукта"
	description="Параметры правил продукта по версиям, у каждого — основание: раздел модели или собственное продуктовое решение до ТЗ. Изменение — новая версия в справочнике policies/, её публикует посев при старте."
/>

{#if data.policies.kinds.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><ScaleIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Политики не опубликованы</Empty.Title>
			<Empty.Description>Их публикует посев политик при старте приложения.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="grid gap-6">
		{#each data.policies.kinds as policy (policy.kind)}
			<section aria-labelledby="policy-{policy.kind}" class="grid gap-3" data-policy={policy.kind}>
				<div class="grid gap-1">
					<h2 id="policy-{policy.kind}" class="font-heading text-h3">{POLICY_KINDS[policy.kind] ?? policy.kind}</h2>
					<p class="text-sm text-muted-foreground">
						<span class="font-mono text-xs">{policy.kind}</span>{#if policy.source}
							· основания: {policy.source}{/if}
					</p>
				</div>
				{#each policy.versions as version (version.id)}
					<Card.Root data-version={version.version}>
						<Card.Header>
							<Card.Title class="flex flex-wrap items-center gap-3 text-sm">
								<span class="font-medium">Версия {version.version}</span>
								{#if version.state === 'in_force'}
									<StatusPill label="действует" tone="success" />
								{:else if version.state === 'scheduled'}
									<StatusPill label="вступит в силу" tone="info" />
								{:else}
									<StatusPill label="заменена" />
								{/if}
								<span class="font-normal text-muted-foreground">с {formatDateTime(version.effectiveFrom)}</span>
							</Card.Title>
						</Card.Header>
						<Card.Content>
							<Table.Root label="Параметры версии {version.version}: {POLICY_KINDS[policy.kind] ?? policy.kind}">
								<Table.Header>
									<Table.Row>
										<Table.Head>Параметр</Table.Head>
										<Table.Head>Значение</Table.Head>
										<Table.Head>Основание</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each version.params as param (param.key)}
										<Table.Row data-param={param.key}>
											<Table.Cell class="font-mono text-xs">{param.key}</Table.Cell>
											<Table.Cell class="whitespace-normal"><ParamValue value={param.value} /></Table.Cell>
											<Table.Cell class="text-sm whitespace-normal">
												{#if param.basis === null}
													<span class="text-warning">основание не найдено в справочнике этой сборки</span>
												{:else if param.basis === 'product_default'}
													продуктовое решение до ТЗ
												{:else}
													{param.basis}
												{/if}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</Card.Content>
					</Card.Root>
				{/each}
			</section>
		{/each}
	</div>
{/if}
