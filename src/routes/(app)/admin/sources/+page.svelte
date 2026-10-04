<script lang="ts">
	import { resolve } from '$app/paths';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { IMPORT_MODES, IMPORT_STATUSES, SOURCE_TERMS } from '$lib/components/admin/model.js';
	import {
		everyHours,
		INCOMPLETE_REASONS,
		JOB_ERRORS,
		JOB_STATUSES,
		REJECTED_REASONS,
		RUN_COUNTS
	} from '$lib/components/admin/sources-model.js';
	import SourcesSwitch from '$lib/components/admin/sources-switch.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DemoLockNotice from '$lib/components/product/demo-lock-notice.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const done = $derived.by(() => {
		if (!form || !('done' in form) || !form.done) return null;
		const { name, enabled, changed } = form.done;
		if (!changed) return `«${name}» уже ${enabled ? 'включён' : 'выключен'} — ничего не изменилось.`;
		return enabled
			? `«${name}» включён: полный импорт поставлен в очередь, его ход — в карточке источника. Запись — в журнале.`
			: `«${name}» выключен: импорт по расписанию и проверки актуальности остановлены. Запись — в журнале.`;
	});
</script>

<PageHeader
	title="Источники вакансий"
	description="Внешние источники агрегатора: условия использования, расписание импорта и его последний результат. Включает и выключает источник администратор."
/>

{#if problem}
	<FormMessage text={problem.message} />
{:else if done}
	<FormMessage tone="success" text={done} />
{/if}

{#if data.demoLocked}
	<DemoLockNotice
		text="Источники вакансий общие для всех посетителей стенда: в демо-сессии их состояние можно посмотреть, но не переключить."
	/>
{/if}

<section class="grid gap-4">
	<div class="flex flex-wrap items-end justify-between gap-2">
		<p class="max-w-3xl text-sm text-muted-foreground">
			Источник, ответивший отказом по правам или условиям, выключается сам до решения администратора. Источник с
			условиями «запрещено» включить нельзя.
		</p>
		<a
			class="text-sm font-medium text-link underline-offset-4 hover:underline"
			href="{resolve('/admin/audit')}?action=vacancies.import_completed">Импорты в журнале</a
		>
	</div>

	{#if data.sources.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Title>Источников нет</Empty.Title>
				<Empty.Description>Их регистрирует посев политик при старте приложения.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<ul class="grid gap-4 lg:grid-cols-2" data-testid="vacancy-sources">
			{#each data.sources as source (source.key)}
				{@const terms = SOURCE_TERMS[source.terms.status]}
				{@const run = source.lastRun}
				{@const job = source.lastJob}
				{@const jobStatus = job ? JOB_STATUSES[job.status] : undefined}
				<li>
					<Card.Root class="h-full" data-source={source.key} data-enabled={source.enabled}>
						<Card.Header>
							<Card.Title><h2 class="text-base font-medium">{source.name}</h2></Card.Title>
							<Card.Description>
								<a
									class="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline"
									href={source.siteUrl}
									rel="external noopener noreferrer"
									target="_blank"
									>{new URL(source.siteUrl).host}<ExternalLinkIcon class="size-3" aria-hidden="true" /></a
								>
								<span class="block font-mono text-xs">{source.key} · {source.adapterVersion}</span>
							</Card.Description>
							<Card.Action>
								{#if source.control === 'no_adapter'}
									<StatusPill label="Только посев демо" />
								{:else if source.control === 'terms_forbidden'}
									<StatusPill label="Запрещено условиями" tone="danger" />
								{:else if data.demoLocked}
									<StatusPill label="В демо недоступно" />
								{:else}
									<SourcesSwitch
										source={source.key}
										name={source.name}
										enabled={source.enabled}
										attribution={source.terms.attribution}
										storeDescription={source.terms.store_description}
									/>
								{/if}
							</Card.Action>
						</Card.Header>
						<Card.Content class="grid gap-4 text-sm">
							<p class="flex flex-wrap gap-2">
								<StatusPill
									label={source.enabled ? 'включён' : 'выключен'}
									tone={source.enabled ? 'success' : 'neutral'}
								/>
								{#if terms}<StatusPill label="условия: {terms.label}" tone={terms.tone} />{/if}
								{#if jobStatus}<StatusPill label={jobStatus.label} tone={jobStatus.tone} />{/if}
							</p>
							{#if source.control === 'no_adapter'}
								<p class="text-muted-foreground">
									Синтетическая лента демонстрационного стенда: её загружает только посев демо-данных.
								</p>
							{:else if source.control === 'terms_forbidden'}
								<p class="text-muted-foreground">
									Условия использования запрещают импорт: источник выключен и не включается, пока условия не изменятся.
								</p>
							{/if}

							<dl class="grid gap-1">
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Подпись по условиям</dt>
									<dd>{source.terms.attribution}</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Описания вакансий</dt>
									<dd>{source.terms.store_description ? 'хранятся' : 'не хранятся, только ссылка'}</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Условия проверены</dt>
									<dd>
										<a
											class="text-link underline-offset-4 hover:underline"
											href={source.terms.url}
											rel="external noopener noreferrer"
											target="_blank">{source.terms.checked_at}</a
										>
									</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Полный импорт</dt>
									<dd>{everyHours(source.schedule.full_every_hours)}</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Инкрементальный импорт</dt>
									<dd>
										{source.schedule.incremental_every_hours === null
											? 'нет'
											: everyHours(source.schedule.incremental_every_hours)}
									</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Проверка актуальности</dt>
									<dd>через {source.schedule.check_after_hours} ч без подтверждения</dd>
								</div>
								<div class="flex flex-wrap justify-between gap-x-3">
									<dt class="text-muted-foreground">Актуальных публикаций</dt>
									<dd class="tabular-nums" data-testid="active-postings">{source.activePostings}</dd>
								</div>
							</dl>

							<div class="grid gap-1" data-testid="last-run">
								<h3 class="font-medium">Последний импорт</h3>
								{#if run}
									<p>
										{IMPORT_MODES[run.mode] ?? run.mode}, {IMPORT_STATUSES[run.status] ??
											run.status}{run.completeness === 'partial' ? ', неполный' : ''} — {formatDateTime(run.startedAt)}
									</p>
									{#if run.incompleteReason}
										<p class="text-muted-foreground">
											{INCOMPLETE_REASONS[run.incompleteReason] ?? run.incompleteReason}
										</p>
									{/if}
									{#if run.counts}
										<ul class="flex flex-wrap gap-x-3 gap-y-1">
											{#each RUN_COUNTS as item (item.key)}
												<li><span class="tabular-nums">{run.counts[item.key]}</span> {item.label}</li>
											{/each}
											{#each Object.entries(run.counts.rejected) as [reason, n] (reason)}
												<li>
													<span class="tabular-nums">{n}</span> отклонено: {REJECTED_REASONS[reason] ?? reason}
												</li>
											{/each}
										</ul>
									{/if}
								{:else}
									<p class="text-muted-foreground">не запускался</p>
								{/if}
								{#if job?.error && (job.status === 'failed' || job.status === 'queued')}
									<p class="text-destructive" data-testid="job-error">
										Ошибка задания{job.status === 'queued'
											? ` (попытка ${job.attempts} из ${job.maxAttempts}, повторится)`
											: ''}:
										{JOB_ERRORS[job.error.code] ?? job.error.code}
										<span class="block font-mono text-xs text-muted-foreground">{job.error.message}</span>
									</p>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>
				</li>
			{/each}
		</ul>
	{/if}
</section>
