<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import { resolve } from '$app/paths';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { FORMAT_LABELS, incompleteText, REFUSALS, VARIANT_LABELS } from './model.js';

	interface Entry {
		eventId: string;
		at: string;
		operatorName: string | null;
		file: { id: string; name: string; available: boolean } | null;
		result:
			| {
					kind: 'imported';
					variant: string;
					format: string;
					profile: string;
					complete: boolean;
					incompleteReason: string | null;
					rowsRead: number;
					rowIssues: number;
					matched: number;
					athletes: number;
					inserted: number;
					removed: number;
			  }
			| { kind: 'refused'; reason: string };
	}

	/** Loads of batches from the journal, the latest first: who, when, which file and what it did. */
	let { history }: { history: Entry[] } = $props();
</script>

<section aria-labelledby="history-heading" class="grid gap-4" data-testid="batch-history">
	<h2 id="history-heading" class="font-heading text-h3">История загрузок</h2>
	{#if history.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><ArchiveIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Пакетов ещё не загружали</Empty.Title>
				<Empty.Description
					>Здесь появится каждая загрузка: кто, когда, какой файл и сколько результатов привязано.</Empty.Description
				>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Table.Root label="История загрузок пакетов результатов ФСП">
			<Table.Header>
				<Table.Row>
					<Table.Head>Когда и кто</Table.Head>
					<Table.Head>Файл</Table.Head>
					<Table.Head class="text-right">Строк / ошибок</Table.Head>
					<Table.Head class="text-right">Привязано</Table.Head>
					<Table.Head class="text-right">Новых / снято</Table.Head>
					<Table.Head>Полнота</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each history as entry (entry.eventId)}
					{@const result = entry.result}
					<Table.Row data-batch-event={entry.eventId} data-result={result.kind}>
						<Table.Cell>
							{formatDateTime(entry.at)}
							<span class="block text-xs text-muted-foreground">{entry.operatorName ?? 'оператор без имени'}</span>
						</Table.Cell>
						<Table.Cell class="whitespace-normal">
							{#if entry.file?.available}
								<a
									class="font-medium text-primary underline-offset-4 hover:underline"
									href={resolve('/(app)/operator/fsp-import/files/[id]', { id: entry.file.id })}
									download
								>
									{entry.file.name}
								</a>
							{:else}
								<span>{entry.file?.name ?? 'файл удалён'}</span>
							{/if}
							{#if result.kind === 'imported'}
								<span class="block text-xs text-muted-foreground">
									{VARIANT_LABELS[result.variant] ?? result.variant} · {FORMAT_LABELS[result.format] ?? result.format} · профиль
									<span class="font-mono">{result.profile}</span>
								</span>
							{/if}
						</Table.Cell>
						{#if result.kind === 'imported'}
							{@const incomplete = incompleteText(result.incompleteReason)}
							<Table.Cell class="text-right tabular-nums">{result.rowsRead} / {result.rowIssues}</Table.Cell>
							<Table.Cell class="text-right tabular-nums" data-matched={result.matched}>
								{result.matched}
								<span class="block text-xs text-muted-foreground">кандидатов: {result.athletes}</span>
							</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{result.inserted} / {result.removed}</Table.Cell>
							<Table.Cell>
								{#if result.complete}
									<StatusPill label="Полный" tone="info" />
								{:else}
									<StatusPill label="Неполный" />
									<span class="block text-xs text-muted-foreground">{incomplete}</span>
								{/if}
							</Table.Cell>
						{:else if result.kind === 'refused'}
							<Table.Cell colspan={3} class="text-right">
								<StatusPill label="Не загружен" tone="danger" />
								<span class="block text-xs text-muted-foreground">{REFUSALS[result.reason] ?? result.reason}</span>
							</Table.Cell>
							<Table.Cell>—</Table.Cell>
						{/if}
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{/if}
</section>
