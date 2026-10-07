<script lang="ts">
	import { resolve } from '$app/paths';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import ModeSwitch from '$lib/components/admin/mode-switch.svelte';
	import {
		EFFECTIVE_MODES,
		INPUT_TYPES,
		MODEL_ERROR_CODES,
		MODEL_ERROR_REASONS,
		MODEL_OPERATIONS,
		PROBES,
		PROCESSING_MODES
	} from '$lib/components/admin/model.js';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DemoLockNotice from '$lib/components/product/demo-lock-notice.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const models = $derived(data.models);
	const integrations = $derived(data.integrations);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const done = $derived.by(() => {
		if (!form || !('done' in form) || !form.done) return null;
		const title = MODEL_OPERATIONS[form.done.operation]?.title ?? form.done.operation;
		if (!form.done.changed) return `«${title}» уже в этом режиме — ничего не изменилось.`;
		return form.done.mode === 'off'
			? `«${title}» выключена: процессы перейдут на путь без модели в течение нескольких секунд. Запись — в журнале.`
			: `«${title}» включена. Запись — в журнале.`;
	});
	const ENV_HINT: Record<string, string> = {
		extract: 'LLM_BASE_URL и LLM_MODEL',
		embed: 'EMBED_BASE_URL, EMBED_MODEL и EMBED_SPACE_ID',
		rerank: 'RERANK_BASE_URL и RERANK_MODEL'
	};
	const DAY_ORDER = ['model', 'rules_only', 'partial', 'failed'] as const;
</script>

<PageHeader
	title="Кабинет администратора"
	description="Модели и их режим, состояние интеграций; источники вакансий, справочники, персонал, качество моделей и журнал — в разделах выше."
/>

{#if problem}
	<FormMessage text={problem.message} />
{:else if done}
	<FormMessage tone="success" text={done} />
{/if}

<section aria-labelledby="models-heading" class="grid gap-4">
	<div class="flex flex-wrap items-end justify-between gap-2">
		<div class="grid gap-1">
			<h2 id="models-heading" class="font-heading text-h3">Модели</h2>
			<p class="max-w-3xl text-sm text-muted-foreground">
				Каждую операцию можно выключить во время работы: продукт перейдёт в явный упрощённый режим без модели, а не
				подменит результат. Действует во всех процессах за несколько секунд, без перезапуска.
			</p>
		</div>
		<a
			class="text-sm font-medium text-link underline-offset-4 hover:underline"
			href="{resolve('/admin/audit')}?action=ml.mode_changed">История переключений в журнале</a
		>
	</div>

	{#if data.demoLocked}
		<DemoLockNotice
			text="Режим моделей общий для всех посетителей стенда: в демо-сессии его можно посмотреть, но не переключить. Роли персонала и справочники в демо тоже только для просмотра."
		/>
	{/if}

	{#if !models.modeStoreReadable}
		<FormMessage
			text="Хранилище режимов (Redis) не читается: вызовы моделей отвечают «недоступно», режим не угадывается. Переключение невозможно, пока хранилище не вернётся."
		/>
	{/if}

	<ul class="grid gap-4 lg:grid-cols-3">
		{#each models.operations as state (state.operation)}
			{@const meta = MODEL_OPERATIONS[state.operation]}
			{@const effective = EFFECTIVE_MODES[state.effective]}
			<li>
				<Card.Root class="h-full" data-model-operation={state.operation} data-effective={state.effective}>
					<Card.Header>
						<Card.Title><h3 class="text-base font-medium">{meta?.title ?? state.operation}</h3></Card.Title>
						<Card.Description>{meta?.purpose}</Card.Description>
						<Card.Action>
							{#if data.demoLocked}
								<StatusPill label="В демо недоступно" />
							{:else}
								<ModeSwitch
									operation={state.operation}
									title={meta?.title ?? state.operation}
									mode={state.mode}
									configured={state.settings !== null}
									fallback={meta?.fallback ?? ''}
								/>
							{/if}
						</Card.Action>
					</Card.Header>
					<Card.Content class="grid gap-3 text-sm">
						{#if effective}
							<p data-testid="effective-mode"><StatusPill label={effective.label} tone={effective.tone} /></p>
						{/if}
						{#if state.effective !== 'model'}
							<p class="flex gap-2 text-muted-foreground">
								<CpuIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{meta?.fallback}
							</p>
						{/if}
						{#if state.settings}
							<dl class="grid gap-1">
								{#each state.settings as line (line.label)}
									<div class="flex flex-wrap justify-between gap-x-3">
										<dt class="text-muted-foreground">{line.label}</dt>
										<dd class="font-mono text-xs break-all">{line.value}</dd>
									</div>
								{/each}
							</dl>
						{:else}
							<p class="text-muted-foreground">
								Рантайм не задан в окружении ({ENV_HINT[state.operation]}). Переключатель хранит режим на случай, когда
								его зададут.
							</p>
						{/if}
						<div>
							<p class="text-muted-foreground">Вызовы за 24 часа:</p>
							<ul class="flex flex-wrap gap-x-3 gap-y-1">
								{#each DAY_ORDER as mode (mode)}
									<li><span class="tabular-nums">{state.lastDay[mode]}</span> {PROCESSING_MODES[mode]}</li>
								{/each}
							</ul>
						</div>
					</Card.Content>
				</Card.Root>
			</li>
		{/each}
	</ul>

	<Card.Root>
		<Card.Header>
			<Card.Title><h3 class="text-base font-medium">Последние вызовы без модели</h3></Card.Title>
			<Card.Description>
				Конверты результатов, где модель не отработала: код ошибки адаптера и что обрабатывалось. Содержимое входа не
				показывается.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if models.problems.length === 0}
				<p class="text-sm text-muted-foreground">Таких вызовов нет: все записанные результаты получены моделью.</p>
			{:else}
				<Table.Root label="Последние вызовы без модели" data-testid="model-problems">
					<Table.Header>
						<Table.Row>
							<Table.Head>Когда</Table.Head>
							<Table.Head>Операция</Table.Head>
							<Table.Head>Режим</Table.Head>
							<Table.Head>Ошибка</Table.Head>
							<Table.Head>Вход</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each models.problems as row (row.id)}
							<Table.Row>
								<Table.Cell class="whitespace-nowrap">{formatDateTime(row.createdAt)}</Table.Cell>
								<Table.Cell>{MODEL_OPERATIONS[row.operation]?.title ?? row.operation}</Table.Cell>
								<Table.Cell>{PROCESSING_MODES[row.processingMode]}</Table.Cell>
								<Table.Cell>
									{#if row.code}
										<span class="font-mono text-xs">{row.code}</span>
										<span class="block text-xs text-muted-foreground">
											{row.reason
												? (MODEL_ERROR_REASONS[row.reason] ?? row.reason)
												: (MODEL_ERROR_CODES[row.code] ?? '')}
										</span>
									{:else}
										—
									{/if}
								</Table.Cell>
								<Table.Cell>{row.inputType ? (INPUT_TYPES[row.inputType] ?? row.inputType) : '—'}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>
</section>

<section aria-labelledby="integrations-heading" class="grid gap-4">
	<h2 id="integrations-heading" class="font-heading text-h3">Интеграции</h2>
	<ul class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
		<li>
			<Card.Root class="h-full" data-integration="storage">
				<Card.Header><Card.Title><h3 class="text-base font-medium">База данных и Redis</h3></Card.Title></Card.Header>
				<Card.Content class="text-sm">
					<p class="flex flex-wrap items-start gap-2">
						<StatusPill
							label="PostgreSQL: {PROBES[integrations.database].label}"
							tone={PROBES[integrations.database].tone}
						/>
						<StatusPill label="Redis: {PROBES[integrations.redis].label}" tone={PROBES[integrations.redis].tone} />
					</p>
				</Card.Content>
			</Card.Root>
		</li>
		<li>
			<Card.Root class="h-full" data-integration="docparse">
				<Card.Header>
					<Card.Title><h3 class="text-base font-medium">Разбор документов (docparse)</h3></Card.Title>
					<Card.Description class="font-mono text-xs break-all">{integrations.docparse.url}</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					<p>
						<StatusPill
							label={PROBES[integrations.docparse.probe.status].label}
							tone={PROBES[integrations.docparse.probe.status].tone}
						/>
					</p>
					<p class="text-muted-foreground">{integrations.docparse.probe.detail}</p>
				</Card.Content>
			</Card.Root>
		</li>
		<li>
			<Card.Root class="h-full" data-integration="sandbox">
				<Card.Header>
					<Card.Title><h3 class="text-base font-medium">Песочница кода</h3></Card.Title>
					<Card.Description class="font-mono text-xs break-all">{integrations.sandbox.url}</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					<p>
						<StatusPill
							label={PROBES[integrations.sandbox.probe.status].label}
							tone={PROBES[integrations.sandbox.probe.status].tone}
						/>
					</p>
					<p class="text-muted-foreground">{integrations.sandbox.probe.detail}</p>
					<p class="text-muted-foreground">
						Одновременных запусков на процесс: {integrations.sandbox.maxConcurrentRuns}
					</p>
				</Card.Content>
			</Card.Root>
		</li>
		<li>
			<Card.Root class="h-full" data-integration="fsp-id">
				<Card.Header><Card.Title><h3 class="text-base font-medium">Вход через ФСП ID</h3></Card.Title></Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					{#if integrations.fspId}
						<p>
							<StatusPill
								label={PROBES[integrations.fspId.probe.status].label}
								tone={PROBES[integrations.fspId.probe.status].tone}
							/>
						</p>
						<p class="text-muted-foreground">{integrations.fspId.probe.detail}</p>
						<dl class="grid gap-1">
							<div>
								<dt class="inline text-muted-foreground">Провайдер:</dt>
								<dd class="inline font-mono text-xs break-all">{integrations.fspId.issuer}</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">Клиент:</dt>
								<dd class="inline font-mono text-xs">{integrations.fspId.clientId}</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">Области:</dt>
								<dd class="inline font-mono text-xs">{integrations.fspId.scopes}</dd>
							</div>
						</dl>
					{:else}
						<StatusPill label="Не настроен" />
						<p class="text-muted-foreground">Вход только по почте и паролю (FSP_ID_* не заданы).</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</li>
		<li>
			<Card.Root class="h-full" data-integration="fsp-achievements">
				<Card.Header><Card.Title><h3 class="text-base font-medium">API достижений ФСП</h3></Card.Title></Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					{#if integrations.fspAchievements}
						<p>
							<StatusPill
								label={integrations.fspAchievements.adapter === 'mock' ? 'Имитатор ФСП' : 'API ФСП'}
								tone={integrations.fspAchievements.adapter === 'mock' ? 'warning' : 'info'}
							/>
						</p>
						<dl class="grid gap-1">
							<div>
								<dt class="inline text-muted-foreground">Адрес:</dt>
								<dd class="inline font-mono text-xs">{integrations.fspAchievements.host}</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">Последнее событие вебхука:</dt>
								<dd class="inline">
									{integrations.fspAchievements.lastWebhookAt
										? formatDateTime(integrations.fspAchievements.lastWebhookAt)
										: 'не приходило'}
								</dd>
							</div>
							<div>
								<dt class="inline text-muted-foreground">Связанных спортсменов:</dt>
								<dd class="inline tabular-nums">{integrations.fspAchievements.activeAthleteLinks}</dd>
							</div>
						</dl>
					{:else}
						<StatusPill label="Не настроен" />
						<p class="text-muted-foreground">Импорт достижений выключен (FSP_ACHIEVEMENTS_* не заданы).</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</li>
		<li>
			<Card.Root class="h-full" data-integration="telegram">
				<Card.Header><Card.Title><h3 class="text-base font-medium">Telegram</h3></Card.Title></Card.Header>
				<Card.Content class="grid gap-1 text-sm">
					{#if integrations.telegram}
						<p><StatusPill label="Настроен" tone="success" /></p>
						<p>Бот <span class="font-mono text-xs">@{integrations.telegram.botUsername}</span></p>
						<p class="text-muted-foreground">Подключённых каналов: {integrations.telegram.activeChannels}</p>
					{:else}
						<StatusPill label="Не настроен" />
						<p class="text-muted-foreground">Уведомления только в кабинете и на почту (TELEGRAM_* не заданы).</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</li>
	</ul>
</section>
