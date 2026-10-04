<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { FORMAT_LABELS, incompleteText, ISSUE_LABELS, ISSUES_SHOWN, VARIANT_LABELS } from './model.js';

	interface Issue {
		row: number;
		page?: number;
		column: string | null;
		code: string;
		message: string;
	}

	interface Preview {
		fileName: string;
		format: string;
		variant: string;
		profile: string;
		complete: boolean;
		incompleteReason: string | null;
		ocrUsed: boolean;
		rowsRead: number;
		rowsValid: number;
		issues: Issue[];
		competitions: { id: string; title: string; startDate: string; ekpNumber: string | null }[];
		rows: { matched: number; withoutFspId: number; notLinked: number; noConsent: number };
		athletes: number;
		taxonomyMissing: boolean;
	}

	/**
	 * What an import of the checked batch would do: rows read and rejected, where the valid rows go, whether the batch
	 * withdraws results it does not list. `confirm` holds the confirmation, shown while the preview is current.
	 */
	let { preview, stale, confirm }: { preview: Preview; stale: boolean; confirm: Snippet } = $props();

	const shownIssues = $derived(preview.issues.slice(0, ISSUES_SHOWN));
	const hasPages = $derived(preview.issues.some((issue) => issue.page !== undefined));
	const routing = $derived([
		{ key: 'matched', label: 'Привяжутся к кандидатам', value: preview.rows.matched, tone: 'success' as const },
		{ key: 'without-fsp-id', label: 'Без ФСП ID', value: preview.rows.withoutFspId, tone: 'neutral' as const },
		{
			key: 'not-linked',
			label: 'ФСП ID не связан с аккаунтом',
			value: preview.rows.notLinked,
			tone: 'neutral' as const
		},
		{ key: 'no-consent', label: 'Нет согласия на импорт', value: preview.rows.noConsent, tone: 'neutral' as const }
	]);
</script>

<section aria-labelledby="preview-heading" class="grid gap-4" data-testid="batch-preview" data-stale={stale}>
	<div class="flex flex-wrap items-center gap-3">
		<h2 id="preview-heading" class="font-heading text-h3">Предпросмотр пакета</h2>
		<StatusPill
			label="{VARIANT_LABELS[preview.variant] ?? preview.variant} · {FORMAT_LABELS[preview.format] ?? preview.format}"
		/>
		<span class="text-sm text-muted-foreground">
			{preview.fileName} · профиль <span class="font-mono">{preview.profile}</span>
		</span>
	</div>

	{#if stale}
		<Alert.Root role="status">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Description
				>Файл, профиль или отметка полноты изменились: проверьте пакет заново перед загрузкой.</Alert.Description
			>
		</Alert.Root>
	{/if}

	<div class="grid gap-4 lg:grid-cols-2">
		<Card.Root>
			<Card.Header><Card.Title><h3 class="font-heading text-base font-medium">Строки</h3></Card.Title></Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-3 gap-3 text-sm">
					<div data-count="read">
						<dt class="text-muted-foreground">В файле</dt>
						<dd class="font-heading text-h3 tabular-nums">{preview.rowsRead}</dd>
					</div>
					<div data-count="valid">
						<dt class="text-muted-foreground">Разобрано</dt>
						<dd class="font-heading text-h3 tabular-nums">{preview.rowsValid}</dd>
					</div>
					<div data-count="issues">
						<dt class="text-muted-foreground">С ошибками</dt>
						<dd class={['font-heading text-h3 tabular-nums', preview.issues.length > 0 && 'text-destructive']}>
							{preview.issues.length}
						</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Title><h3 class="font-heading text-base font-medium">Куда попадут разобранные строки</h3></Card.Title>
				<Card.Description>Сейчас; при загрузке основания проверяются заново для каждого кандидата.</Card.Description>
			</Card.Header>
			<Card.Content>
				<dl class="grid gap-2 text-sm">
					{#each routing as item (item.key)}
						<div class="flex items-baseline justify-between gap-3" data-routing={item.key}>
							<dt>{item.label}</dt>
							<dd><StatusPill label={String(item.value)} tone={item.value > 0 ? item.tone : 'neutral'} /></dd>
						</div>
					{/each}
				</dl>
				<p class="mt-3 text-sm text-muted-foreground">
					Кандидатов с результатами пакета: {preview.athletes}. Строки без привязки не сохраняются.
				</p>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid gap-2 text-sm" data-testid="batch-completeness" data-complete={preview.complete}>
		{#if preview.complete}
			<p>
				<StatusPill label="Полный пакет" tone="info" /> Результаты его соревнований, которых нет в файле, будут сняты с профилей.
			</p>
		{:else}
			<p>
				<StatusPill label="Неполный пакет" />
				Отсутствующие результаты не снимаются: {incompleteText(preview.incompleteReason)}.
			</p>
		{/if}
		{#if preview.ocrUsed}
			<p class="text-warning">Протокол распознан со скана: сверьте разобранные строки с исходником.</p>
		{/if}
	</div>

	{#if preview.competitions.length > 0}
		<div class="grid gap-2">
			<h3 class="font-heading text-base font-medium">Соревнования пакета</h3>
			<ul class="grid gap-1 text-sm">
				{#each preview.competitions as competition (competition.id)}
					<li>
						{competition.title}, {formatDate(competition.startDate)}
						{#if competition.ekpNumber}<span class="text-muted-foreground">· ЕКП {competition.ekpNumber}</span>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if preview.issues.length > 0}
		<div class="grid gap-2" data-testid="batch-issues">
			<h3 class="font-heading text-base font-medium">Строки с ошибками</h3>
			<p class="text-sm text-muted-foreground">
				Номер строки — как в файле; данные людей из ячеек здесь не показываются.
				{#if preview.issues.length > shownIssues.length}Показаны первые {shownIssues.length} из {preview.issues
						.length}.{/if}
			</p>
			<Table.Root label="Строки пакета с ошибками">
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-20 text-right">Строка</Table.Head>
						{#if hasPages}<Table.Head class="w-20 text-right">Страница</Table.Head>{/if}
						<Table.Head>Колонка</Table.Head>
						<Table.Head>Ошибка</Table.Head>
						<Table.Head>Что не так</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each shownIssues as issue, i (i)}
						<Table.Row data-issue-row={issue.row} data-issue-code={issue.code}>
							<Table.Cell class="text-right tabular-nums">{issue.row}</Table.Cell>
							{#if hasPages}<Table.Cell class="text-right tabular-nums">{issue.page ?? '—'}</Table.Cell>{/if}
							<Table.Cell>{issue.column ?? '—'}</Table.Cell>
							<Table.Cell>{ISSUE_LABELS[issue.code] ?? issue.code}</Table.Cell>
							<Table.Cell class="whitespace-normal">{issue.message}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if preview.taxonomyMissing}
		<Alert.Root variant="destructive" role="alert">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Description
				>Справочники не опубликованы: пакет нельзя загрузить, пока администратор их не опубликует.</Alert.Description
			>
		</Alert.Root>
	{:else if !stale}
		<div class="grid gap-3" data-testid="batch-confirm">
			{@render confirm()}
		</div>
	{/if}
</section>
