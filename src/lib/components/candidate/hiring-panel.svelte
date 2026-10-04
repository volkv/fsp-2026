<script lang="ts">
	import { enhance } from '$app/forms';
	import { HiringStages } from '$lib/components/product/index.js';
	import {
		formatDate,
		HIRING_OUTCOMES,
		HIRING_STAGES,
		type HiringOutcome,
		type HiringParty,
		type HiringStage,
		type HiringView
	} from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { reasonText } from './model.js';

	/** The hiring process an acceptance opened, as the candidate sees it: each side reports on its own (domain 13.7). */
	interface Report {
		id: string;
		party: HiringParty;
		kind: 'stage' | 'outcome';
		stage: HiringStage | null;
		outcome: HiringOutcome | null;
		startDate: string | null;
		supersedesReportId: string | null;
		reportedAt: Date;
	}

	interface Props {
		process: {
			id: string;
			openedAt: Date;
			outcomeDueAt: Date;
			outcome: HiringView['outcome']['state'];
			overdue: boolean;
			otherSideDiffers: boolean;
			reports: Report[];
		};
		stages: string[];
		outcomeReasonCodes: string[];
	}

	let { process, stages, outcomeReasonCodes }: Props = $props();

	const inForce = $derived.by(() => {
		const superseded = new Set(process.reports.flatMap((report) => report.supersedesReportId ?? []));
		return process.reports.filter((report) => !superseded.has(report.id));
	});

	const view = $derived.by((): HiringView => {
		const byStage: Partial<Record<HiringStage, HiringParty[]>> = {};
		for (const report of inForce) {
			if (report.kind !== 'stage' || report.stage === null) continue;
			const parties = byStage[report.stage] ?? [];
			if (!parties.includes(report.party)) parties.push(report.party);
			byStage[report.stage] = parties;
		}
		return {
			stages: byStage,
			outcome: {
				state: process.outcome,
				reports: inForce.flatMap((report) =>
					report.kind === 'outcome' && report.outcome !== null ? [{ party: report.party, outcome: report.outcome }] : []
				)
			}
		};
	});

	const own = $derived(inForce.filter((report) => report.party === 'candidate'));
	const ownOutcome = $derived(own.find((report) => report.kind === 'outcome') ?? null);
	const openStages = $derived(
		HIRING_STAGES.filter(
			(stage) =>
				stages.includes(stage.key) && !own.some((report) => report.kind === 'stage' && report.stage === stage.key)
		)
	);
	const outcomes = Object.entries(HIRING_OUTCOMES) as [HiringOutcome, string][];
	let chosenOutcome = $state<HiringOutcome | ''>('');

	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
</script>

<div class="grid gap-5" data-testid="hiring-panel" data-outcome={process.outcome}>
	<p class="text-sm text-muted-foreground">
		Процесс открыт {formatDate(process.openedAt)}. {process.overdue
			? `Срок исхода (${formatDate(process.outcomeDueAt)}) прошёл — стороны получают напоминания.`
			: `Исход ждём до ${formatDate(process.outcomeDueAt)}.`} Каждая сторона сообщает его сама, молчание исходом не считается.
	</p>
	<HiringStages hiring={view} />
	{#if process.otherSideDiffers}
		<p class="rounded-lg bg-warning-subtle p-3 text-sm text-warning" data-testid="hiring-diverged">
			Компания отметила исход иначе, чем ты. Расхождение видят обе стороны и оператор ФСП в агрегатах; причины другой
			стороны не показываются.
		</p>
	{/if}

	<div class="grid gap-5 md:grid-cols-2">
		{#if openStages.length > 0}
			<form method="POST" action="?/report" use:enhance class="grid content-start gap-3 rounded-lg border p-4">
				<CsrfInput />
				<input type="hidden" name="processId" value={process.id} />
				<input type="hidden" name="kind" value="stage" />
				<label class="grid gap-1.5 text-sm">
					<span class="font-medium">Сообщить этап</span>
					<select name="stage" class={selectClass} required>
						{#each openStages as stage (stage.key)}
							<option value={stage.key}>{stage.label}</option>
						{/each}
					</select>
				</label>
				<Button type="submit" variant="outline" size="sm" class="justify-self-start">Отметить этап</Button>
			</form>
		{/if}

		<form method="POST" action="?/report" use:enhance class="grid content-start gap-3 rounded-lg border p-4">
			<CsrfInput />
			<input type="hidden" name="processId" value={process.id} />
			<input type="hidden" name="kind" value="outcome" />
			{#if ownOutcome}
				<input type="hidden" name="supersedes" value={ownOutcome.id} />
				<p class="text-sm">
					Ты сообщил: <span class="font-medium">{ownOutcome.outcome ? HIRING_OUTCOMES[ownOutcome.outcome] : '—'}</span>
					{#if ownOutcome.startDate}, выход {formatDate(ownOutcome.startDate)}{/if}. Можно исправить.
				</p>
			{/if}
			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">{ownOutcome ? 'Исправить исход' : 'Сообщить исход'}</span>
				<select name="outcome" class={selectClass} bind:value={chosenOutcome} required>
					<option value="" disabled>— выбери —</option>
					{#each outcomes as [key, label] (key)}
						<option value={key}>{label}</option>
					{/each}
				</select>
			</label>
			{#if chosenOutcome === 'hired'}
				<label class="grid gap-1.5 text-sm">
					<span>Дата выхода</span>
					<input type="date" name="start_date" class={selectClass} />
				</label>
			{/if}
			{#if outcomeReasonCodes.length > 0 && chosenOutcome !== '' && chosenOutcome !== 'hired'}
				<label class="grid gap-1.5 text-sm">
					<span>Причина (компания её не увидит)</span>
					<select name="reason_code" class={selectClass}>
						<option value="">— не указывать —</option>
						{#each outcomeReasonCodes as code (code)}
							<option value={code}>{reasonText(code)}</option>
						{/each}
					</select>
				</label>
			{/if}
			<Button type="submit" variant="outline" size="sm" class="justify-self-start">Сообщить</Button>
		</form>
	</div>
</div>
