<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { page } from '$app/state';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { ACTOR_KINDS, OUTCOMES } from './model.js';
	import ParamValue from './param-value.svelte';

	/** One event of the journal as the page receives it: identifiers and codes, no addresses or texts. */
	interface JournalEntry {
		id: string;
		occurredAt: Date;
		action: string;
		outcome: string;
		actorKind: string;
		actorUserId: string | null;
		actorCompanyId: string | null;
		apiKeyId: string | null;
		objectType: string | null;
		objectId: string | null;
		subjectCandidateId: string | null;
		requestId: string;
		details: unknown;
	}

	interface Props {
		view: {
			actions: readonly string[];
			/** The query as typed. */
			raw: Record<string, string>;
			problems: readonly { path?: string | undefined; message: string }[];
			/** `null` while the filters have problems. */
			journal: { entries: JournalEntry[]; nextCursor: string | null } | null;
		};
		/** The page of the journal in its cabinet: the filters reset to it and the next page is read from it. */
		base: ResolvedPathname;
	}

	/** The action journal with its filters, the same in every cabinet that may read it (`audit.read`). */
	let { view, base }: Props = $props();

	const problemOf = (path: string) => view.problems.find((problem) => problem.path === path)?.message ?? null;
	const value = (name: string) => view.raw[name] ?? '';
	const nextQuery = $derived(
		view.journal?.nextCursor
			? [
					...[...page.url.searchParams.entries()].filter(([key]) => key !== 'cursor'),
					['cursor', view.journal.nextCursor]
				]
					.map(([key, item]) => `${encodeURIComponent(key ?? '')}=${encodeURIComponent(item ?? '')}`)
					.join('&')
			: null
	);
	const FIELDS = [
		{ name: 'actor', label: 'Актор (ID аккаунта)', width: 'w-80' },
		{ name: 'objectType', label: 'Тип объекта', width: 'w-40' },
		{ name: 'objectId', label: 'ID объекта', width: 'w-80' }
	] as const;
</script>

<form method="GET" class="grid gap-4 rounded-lg border p-4" data-testid="journal-filters">
	<div class="flex flex-wrap items-end gap-3">
		<Field.Field class="w-72" data-invalid={problemOf('action') ? true : undefined}>
			<Field.Label for="filter-action">Событие</Field.Label>
			<NativeSelect id="filter-action" name="action" value={value('action')}>
				<option value="">Любое</option>
				{#each view.actions as action (action)}
					<option value={action}>{action}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field class="w-40">
			<Field.Label for="filter-outcome">Исход</Field.Label>
			<NativeSelect id="filter-outcome" name="outcome" value={value('outcome')}>
				<option value="">Любой</option>
				{#each Object.entries(OUTCOMES) as [key, outcome] (key)}
					<option value={key}>{outcome.label}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		{#each FIELDS as field (field.name)}
			{@const problem = problemOf(field.name)}
			<Field.Field class={field.width} data-invalid={problem ? true : undefined}>
				<Field.Label for="filter-{field.name}">{field.label}</Field.Label>
				<Input
					id="filter-{field.name}"
					name={field.name}
					value={value(field.name)}
					autocomplete="off"
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? `filter-${field.name}-problem` : undefined}
				/>
				{#if problem}<Field.Error id="filter-{field.name}-problem">{problem}</Field.Error>{/if}
			</Field.Field>
		{/each}
		{#each [{ name: 'from', label: 'С даты' }, { name: 'to', label: 'По дату' }] as field (field.name)}
			{@const problem = problemOf(field.name)}
			<Field.Field class="w-44" data-invalid={problem ? true : undefined}>
				<Field.Label for="filter-{field.name}">{field.label}</Field.Label>
				<Input
					id="filter-{field.name}"
					type="date"
					name={field.name}
					value={value(field.name)}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? `filter-${field.name}-problem` : undefined}
				/>
				{#if problem}<Field.Error id="filter-{field.name}-problem">{problem}</Field.Error>{/if}
			</Field.Field>
		{/each}
	</div>
	<div class="flex flex-wrap gap-3">
		<Button type="submit">Показать</Button>
		<a class={buttonVariants({ variant: 'outline' })} href={base}>Сбросить</a>
	</div>
	{#if problemOf('cursor')}<p class="text-sm text-destructive">{problemOf('cursor')}</p>{/if}
</form>

{#if view.journal}
	{#if view.journal.entries.length === 0}
		<p class="text-sm text-muted-foreground" data-testid="journal-empty">Событий с такими условиями нет.</p>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Журнал действий" data-testid="journal">
					<Table.Header>
						<Table.Row>
							<Table.Head>Когда</Table.Head>
							<Table.Head>Событие</Table.Head>
							<Table.Head>Актор</Table.Head>
							<Table.Head>Объект</Table.Head>
							<Table.Head>Подробности</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each view.journal.entries as entry (entry.id)}
							{@const outcome = OUTCOMES[entry.outcome]}
							<Table.Row data-action={entry.action} class="align-top">
								<Table.Cell class="whitespace-nowrap">{formatDateTime(entry.occurredAt)}</Table.Cell>
								<Table.Cell>
									<span class="font-mono text-xs">{entry.action}</span>
									{#if outcome}<span class="block"><StatusPill label={outcome.label} tone={outcome.tone} /></span>{/if}
								</Table.Cell>
								<Table.Cell class="text-xs">
									{ACTOR_KINDS[entry.actorKind] ?? entry.actorKind}
									{#if entry.actorUserId}<span class="block font-mono">{entry.actorUserId}</span>{/if}
									{#if entry.apiKeyId}<span class="block font-mono">ключ {entry.apiKeyId}</span>{/if}
									{#if entry.actorCompanyId}<span class="block font-mono">компания {entry.actorCompanyId}</span>{/if}
								</Table.Cell>
								<Table.Cell class="text-xs">
									{#if entry.objectType}
										<span class="font-mono">{entry.objectType}</span>
										<span class="block font-mono break-all">{entry.objectId}</span>
									{:else}
										—
									{/if}
									{#if entry.subjectCandidateId}
										<span class="block text-muted-foreground"
											>кандидат <span class="font-mono">{entry.subjectCandidateId}</span></span
										>
									{/if}
								</Table.Cell>
								<Table.Cell class="max-w-md whitespace-normal">
									{#if entry.details}<ParamValue value={entry.details} />{/if}
									<span class="block font-mono text-xs text-muted-foreground">запрос {entry.requestId}</span>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
				{#if nextQuery}
					<a class={buttonVariants({ variant: 'outline', class: 'mt-4' })} href="{base}?{nextQuery}"
						>Более ранние события</a
					>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
{/if}
