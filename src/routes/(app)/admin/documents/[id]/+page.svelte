<script lang="ts">
	import { resolve } from '$app/paths';
	import { DOCUMENT_FORMS, DOCUMENT_KINDS } from '$lib/components/admin/model.js';
	import DocumentState from '$lib/components/admin/document-state.svelte';
	import ParamValue from '$lib/components/admin/param-value.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const document = $derived(data.document);
	const list = (values: string[]) => (values.length === 0 ? '—' : values.join(', '));
</script>

<PageHeader title={document.title} description="{DOCUMENT_KINDS[document.kind]}, версия {document.version}">
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/admin/documents')}>Документы</a>
	{/snippet}
	{#snippet actions()}
		<DocumentState {document} />
	{/snippet}
</PageHeader>

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header><Card.Title><h2 class="font-heading text-h3">Текст</h2></Card.Title></Card.Header>
		<Card.Content>
			<!-- The text is shown as published: paragraphs and line breaks of the source are kept. -->
			<article class="text-sm leading-relaxed whitespace-pre-line" data-testid="document-body">{document.body}</article>
		</Card.Content>
	</Card.Root>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header><Card.Title><h2 class="font-heading text-h3">Реквизиты версии</h2></Card.Title></Card.Header>
			<Card.Content>
				<dl class="grid gap-2 text-sm">
					<div>
						<dt class="text-muted-foreground">Форма</dt>
						<dd>{DOCUMENT_FORMS[document.form] ?? document.form}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Опубликована</dt>
						<dd>{document.publishedAt ? formatDateTime(document.publishedAt) : 'не опубликована'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Заменена</dt>
						<dd>{document.supersededAt ? formatDateTime(document.supersededAt) : 'действует'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Повторное согласие при новой версии</dt>
						<dd>{document.requiresReconsent ? 'требуется' : 'не требуется'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Цели</dt>
						<dd class="font-mono text-xs">{list(document.purposes)}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Категории данных</dt>
						<dd class="font-mono text-xs">{list(document.dataCategories)}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Действия с данными</dt>
						<dd class="font-mono text-xs">{list(document.operations)}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">SHA-256 текста</dt>
						<dd class="font-mono text-xs break-all">{document.bodySha256}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header><Card.Title><h2 class="font-heading text-h3">Оператор и обработчики</h2></Card.Title></Card.Header>
			<Card.Content class="grid gap-3 text-sm">
				<div>
					<p class="text-muted-foreground">Оператор на момент публикации</p>
					<ParamValue value={document.operatorSnapshot} />
				</div>
				<div>
					<p class="text-muted-foreground">Обрабатывающие по поручению</p>
					<ParamValue value={document.processorsSnapshot} />
				</div>
			</Card.Content>
		</Card.Root>
		{#if document.siblings.length > 1}
			<Card.Root>
				<Card.Header><Card.Title><h2 class="font-heading text-h3">Все версии</h2></Card.Title></Card.Header>
				<Card.Content>
					<ul class="grid gap-1 text-sm">
						{#each document.siblings as sibling (sibling.id)}
							<li>
								{#if sibling.id === document.id}
									<span aria-current="page" class="font-medium">Версия {sibling.version}</span>
								{:else}
									<a
										class="underline-offset-4 hover:underline"
										href={resolve('/(app)/admin/documents/[id]', { id: sibling.id })}>Версия {sibling.version}</a
									>
								{/if}
								<span class="text-muted-foreground">
									— {sibling.supersededAt ? 'заменена' : sibling.publishedAt ? 'действует' : 'черновик'}
								</span>
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
