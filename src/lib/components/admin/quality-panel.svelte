<script lang="ts">
	import { resolve } from '$app/paths';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import MetricGroup from './metric-group.svelte';
	import { evalSplit, formatBytes, PROCESSING_MODES, PROVENANCES } from './model.js';

	type Status = 'pass' | 'fail' | 'missing' | 'no_threshold' | 'no_value';

	interface RunSummary {
		id: string;
		createdAt: Date;
		productRevision: string;
		datasetId: string;
		datasetSize: number;
		datasetProvenance: string;
		split: string;
		processingMode: string;
	}

	interface Panel {
		run:
			| (RunSummary & {
					versions: { component: string; value: string }[];
					groups:
						| {
								key: string;
								failed: number;
								metrics: {
									key: string;
									value: number | null;
									baseline: number | null;
									delta: number | null;
									n: number | null;
									threshold: { min: number | null; max: number | null } | null;
									status: Status;
								}[];
						  }[]
						| null;
					formatProblem: string | null;
					report: { fileId: string; name: string; sizeBytes: number; sha256: string; status: string } | null;
			  })
			| null;
		history: (RunSummary & { failed: number | null; metricCount: number | null })[];
		total: number;
	}

	/** The quality of the models as measured by one evaluation run, and the runs before it. */
	let { panel, latest }: { panel: Panel; latest: boolean } = $props();

	const run = $derived(panel.run);
	const failed = $derived(run?.groups?.reduce((sum, group) => sum + group.failed, 0) ?? 0);
	const measured = $derived(
		run === null
			? 'Цифры записанных прогонов оценки'
			: `Цифры конкретного прогона оценки на ${evalSplit(run.split).about}`
	);
</script>

{#snippet back()}
	<a class="underline-offset-4 hover:underline" href={resolve('/admin/quality')}>Последний прогон</a>
{/snippet}

<PageHeader
	title="Качество моделей"
	description="{measured}. Пороги заданы до прогона, сравнение — с базовым вариантом."
	eyebrow={latest ? undefined : back}
/>

{#if run === null}
	<Empty.Root class="border" data-testid="quality-empty">
		<Empty.Header>
			<Empty.Media variant="icon"><GaugeIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Прогонов оценки ещё не было</Empty.Title>
			<Empty.Description>
				Панель показывает только записанные прогоны и не рисует цифр сама. Прогон оценки запускает отдельный стенд: он
				вызывает те же разбор, нормализацию, категоризацию и соответствие, что и продукт, на размеченной выборке — её
				рабочей или отложенной части — с порогами, заданными заранее, и записывает результат в <code>eval_runs</code>.
				После первого прогона здесь появятся метрики с порогами, сравнение с базовым вариантом и история.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<section aria-labelledby="run-heading" class="grid gap-4" data-eval-run={run.id}>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 id="run-heading" class="font-heading text-h3">
				{latest ? 'Последний прогон' : 'Прогон'} от {formatDateTime(run.createdAt)}
			</h2>
			{#if run.groups}
				<StatusPill
					label={failed === 0 ? 'все пороги пройдены' : `порог не пройден: ${failed}`}
					tone={failed === 0 ? 'success' : 'danger'}
				/>
			{/if}
		</div>
		<Card.Root>
			<Card.Content>
				<dl class="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
					<div>
						<dt class="text-muted-foreground">Выборка</dt>
						<dd><span class="font-mono text-xs">{run.datasetId}</span>, {run.datasetSize} шт.</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Происхождение и разбиение</dt>
						<dd data-testid="eval-split">
							{PROVENANCES[run.datasetProvenance] ?? run.datasetProvenance}, {evalSplit(run.split).label}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Режим обработки</dt>
						<dd>
							{PROCESSING_MODES[run.processingMode] ?? run.processingMode}
							{#if run.processingMode !== 'model'}
								<span class="block text-xs text-warning">упрощённый режим: часть операций шла без модели</span>
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Ревизия продукта</dt>
						<dd class="font-mono text-xs">{run.productRevision}</dd>
					</div>
				</dl>
			</Card.Content>
		</Card.Root>

		{#if run.formatProblem !== null || run.groups === null}
			<Card.Root class="border-warning/50" data-testid="format-problem">
				<Card.Header>
					<Card.Title
						><h3 class="text-base font-medium">Метрики записаны в формате, который панель не читает</h3></Card.Title
					>
					<Card.Description>
						Цифры не показаны, чтобы не выдать их за проверенные. Что не так: <span class="font-mono text-xs"
							>{run.formatProblem}</span
						>
					</Card.Description>
				</Card.Header>
			</Card.Root>
		{:else if run.groups.length === 0}
			<p class="text-sm text-muted-foreground">В прогоне нет ни одной метрики.</p>
		{:else}
			<div class="grid gap-4 lg:grid-cols-2">
				{#each run.groups as group (group.key)}
					<MetricGroup group={group.key} metrics={group.metrics} failed={group.failed} />
				{/each}
			</div>
			<p class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
				<span class="flex items-center gap-1.5"><span class="inline-block h-3 w-0.5 bg-foreground"></span>порог</span>
				<span class="flex items-center gap-1.5"
					><span class="inline-block h-2.5 w-1 rounded-sm bg-warning"></span>базовый вариант</span
				>
			</p>
		{/if}

		<div class="grid gap-4 md:grid-cols-2">
			<Card.Root>
				<Card.Header><Card.Title><h3 class="text-base font-medium">Версии</h3></Card.Title></Card.Header>
				<Card.Content>
					{#if run.versions.length === 0}
						<p class="text-sm text-muted-foreground">Версии в прогоне не записаны.</p>
					{:else}
						<dl class="grid gap-1 text-sm">
							{#each run.versions as line (line.component)}
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">{line.component}</dt>
									<dd class="font-mono text-xs break-all">{line.value}</dd>
								</div>
							{/each}
						</dl>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header><Card.Title><h3 class="text-base font-medium">Отчёт прогона</h3></Card.Title></Card.Header>
				<Card.Content class="text-sm">
					{#if run.report}
						<dl class="grid gap-1">
							<div>
								<dt class="inline text-muted-foreground">Файл:</dt>
								<dd class="inline">{run.report.name}</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">Размер:</dt>
								<dd class="inline">{formatBytes(run.report.sizeBytes)}</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">SHA-256:</dt>
								<dd class="inline font-mono text-xs break-all">{run.report.sha256}</dd>
							</div>
						</dl>
						{#if run.report.status === 'deleted'}
							<p class="mt-2 text-muted-foreground">Файл отчёта удалён из хранилища.</p>
						{:else}
							<a
								class="mt-2 inline-flex text-link underline-offset-4 hover:underline"
								href="{resolve('/(app)/admin/quality/[id]/report', { id: run.id })}?file={run.report.fileId}"
								data-testid="eval-report-download"
							>
								Скачать отчёт
							</a>
						{/if}
					{:else}
						<p class="text-muted-foreground">Прогон записан без файла отчёта.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</section>
{/if}

{#if panel.history.length > 0}
	<section aria-labelledby="history-heading" class="grid gap-4">
		<h2 id="history-heading" class="font-heading text-h3">История прогонов ({panel.total})</h2>
		<Card.Root>
			<Card.Content>
				<Table.Root label="История прогонов оценки" data-testid="eval-history">
					<Table.Header>
						<Table.Row>
							<Table.Head>Когда</Table.Head>
							<Table.Head>Выборка</Table.Head>
							<Table.Head>Режим</Table.Head>
							<Table.Head>Ревизия</Table.Head>
							<Table.Head>Пороги</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each panel.history as item (item.id)}
							<Table.Row data-eval-history={item.id} aria-current={item.id === run?.id ? 'true' : undefined}>
								<Table.Cell class="whitespace-nowrap">
									<a
										class="underline-offset-4 hover:underline"
										href={resolve('/(app)/admin/quality/[id]', { id: item.id })}>{formatDateTime(item.createdAt)}</a
									>
								</Table.Cell>
								<Table.Cell>
									<span class="font-mono text-xs">{item.datasetId}</span>, {item.datasetSize} шт.,
									{PROVENANCES[item.datasetProvenance] ?? item.datasetProvenance}, {evalSplit(item.split).label}
								</Table.Cell>
								<Table.Cell>{PROCESSING_MODES[item.processingMode] ?? item.processingMode}</Table.Cell>
								<Table.Cell class="font-mono text-xs">{item.productRevision}</Table.Cell>
								<Table.Cell>
									{#if item.failed === null}
										<StatusPill label="формат не распознан" tone="warning" />
									{:else if item.failed === 0}
										<StatusPill label="пройдены ({item.metricCount})" tone="success" />
									{:else}
										<StatusPill label="порог не пройден: {item.failed} из {item.metricCount}" tone="danger" />
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	</section>
{/if}
