<script lang="ts">
	import { resolve } from '$app/paths';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { DOCUMENT_KINDS } from '$lib/components/admin/model.js';
	import DocumentState from '$lib/components/admin/document-state.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const kinds = $derived([...new Set(data.documents.map((document) => document.kind))]);
</script>

<PageHeader
	title="Документы"
	description="Правовые документы и согласия по версиям. Опубликованная версия неизменяема; новую публикует посев документов при старте приложения."
/>

{#if data.documents.length === 0}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><FileTextIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Документы не опубликованы</Empty.Title>
			<Empty.Description>Их публикует посев документов при старте приложения из каталога legal/.</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Card.Root>
		<Card.Content>
			<Table.Root label="Правовые документы" data-testid="documents">
				<Table.Header>
					<Table.Row>
						<Table.Head>Документ</Table.Head>
						<Table.Head>Версия</Table.Head>
						<Table.Head>Состояние</Table.Head>
						<Table.Head>Опубликован</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each kinds as kind (kind)}
						{#each data.documents.filter((document) => document.kind === kind) as document (document.id)}
							<Table.Row data-document={document.kind} data-version={document.version}>
								<Table.Cell>
									<a
										class="font-medium underline-offset-4 hover:underline"
										href={resolve('/(app)/admin/documents/[id]', { id: document.id })}>{document.title}</a
									>
									<span class="block text-xs text-muted-foreground">{DOCUMENT_KINDS[kind]}</span>
								</Table.Cell>
								<Table.Cell class="tabular-nums">{document.version}</Table.Cell>
								<Table.Cell><DocumentState {document} /></Table.Cell>
								<Table.Cell class="whitespace-nowrap">
									{document.publishedAt ? formatDateTime(document.publishedAt) : '—'}
								</Table.Cell>
							</Table.Row>
						{/each}
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
{/if}
