<script lang="ts">
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';

	type Cell = { value: number } | { below: number };
	type Rate = { exact: number } | { below: number } | null;

	interface Audit {
		threshold: number;
		computedAt: Date;
		shortlists: { ranked: number; skipped: number };
		outcomes: {
			outcome: string;
			provenance: 'synthetic' | 'live' | 'mixed' | 'empty';
			dimensions: {
				dimension: string;
				groups: {
					key: string;
					eligible: Cell;
					selected: Cell;
					rate: Rate;
					ratio: Rate;
					flagged: boolean;
					reference: boolean;
				}[];
			}[];
		}[];
	}

	/** The four-fifths rule over groups of candidates: a signal for a look into the data, not a finding. */
	let { audit }: { audit: Audit } = $props();

	const OUTCOMES: Record<string, { title: string; about: string }> = {
		top10: {
			title: 'Первые 10 подборки',
			about:
				'Кандидаты в выдаче открытых подборок по потребностям — пересчитанных сейчас так, как их видит компания; отобран — в первых 10 хотя бы одной.'
		},
		offer: {
			title: 'Предложение',
			about: 'Кандидаты в каталоге или получившие предложение; отобран — получил предложение хотя бы от одной компании.'
		},
		accept: {
			title: 'Принятие',
			about: 'Кандидаты с предложением; отобран — принял хотя бы одно.'
		}
	};
	const DIMENSIONS: Record<string, string> = {
		fsp: 'Участие в ФСП',
		age: 'Возраст',
		region: 'Регион, указанный кандидатом'
	};
	const GROUPS: Record<string, string> = {
		fsp: 'с результатами ФСП',
		no_fsp: 'без результатов ФСП',
		minor: '14–17 лет',
		'18_24': '18–24 года',
		'25_34': '25–34 года',
		'35_44': '35–44 года',
		'45_plus': '45 лет и старше',
		unknown: 'возраст не установлен',
		moscow: 'Москва',
		saint_petersburg: 'Санкт-Петербург',
		other: 'другие регионы',
		none: 'не указан'
	};
	const PROVENANCE: Record<Audit['outcomes'][number]['provenance'], { label: string; tone: 'warning' | 'neutral' }> = {
		synthetic: { label: 'только синтетика засева', tone: 'warning' },
		mixed: { label: 'есть синтетика засева', tone: 'warning' },
		live: { label: 'живые данные', tone: 'neutral' },
		empty: { label: 'данных нет', tone: 'neutral' }
	};

	const count = (cell: Cell) => ('value' in cell ? String(cell.value) : `< ${cell.below}`);
	const percent = (value: number) => `${(value * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
	const fraction = (value: number) =>
		value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const shown = (rate: Rate, format: (value: number) => string) =>
		rate === null ? '—' : 'exact' in rate ? format(rate.exact) : `< ${format(rate.below)}`;
</script>

<section aria-labelledby="fairness-heading" class="grid gap-4" data-testid="fairness-audit">
	<div class="grid gap-1">
		<h2 id="fairness-heading" class="font-heading text-h3">Равенство исходов по группам</h2>
		<p class="max-w-3xl text-sm text-muted-foreground">
			Правило четырёх пятых: доля отобранных в группе против наибольшей доли среди групп того же разреза. Отношение ниже
			0,8 — сигнал посмотреть в данные, а не вывод о предвзятости: группы различаются грейдом, специализацией и
			активностью. Пол, гражданство и семейное положение платформа не собирает — по ним разрезов нет. Группа меньше
			{audit.threshold} человек показана как «&lt; {audit.threshold}» без доли; от 1 до {audit.threshold - 1} отобранных —
			только верхней границей доли, флаг ставится, если ниже 0,8 даже она. Демо-сессии не считаются. Посчитано
			{formatDateTime(audit.computedAt)}; подборок пересчитано: {audit.shortlists
				.ranked}{#if audit.shortlists.skipped > 0}, без активного сотрудника компании пропущено: {audit.shortlists
					.skipped}{/if}.
		</p>
	</div>
	{#each audit.outcomes as outcome (outcome.outcome)}
		{@const about = OUTCOMES[outcome.outcome]}
		{@const provenance = PROVENANCE[outcome.provenance]}
		<Card.Root data-fairness-outcome={outcome.outcome}>
			<Card.Header>
				<Card.Title class="flex flex-wrap items-center gap-2">
					<h3 class="text-base font-medium">{about?.title ?? outcome.outcome}</h3>
					<StatusPill label={provenance.label} tone={provenance.tone} />
				</Card.Title>
				{#if about}<Card.Description>{about.about}</Card.Description>{/if}
			</Card.Header>
			<Card.Content class="grid gap-4 lg:grid-cols-3">
				{#each outcome.dimensions as dimension (dimension.dimension)}
					<Table.Root
						label="{about?.title ?? outcome.outcome}: {DIMENSIONS[dimension.dimension] ?? dimension.dimension}"
						data-fairness-dimension={dimension.dimension}
					>
						<Table.Header>
							<Table.Row>
								<Table.Head>{DIMENSIONS[dimension.dimension] ?? dimension.dimension}</Table.Head>
								<Table.Head class="text-right">Всего</Table.Head>
								<Table.Head class="text-right">Отобрано</Table.Head>
								<Table.Head class="text-right">Доля</Table.Head>
								<Table.Head class="text-right">К наибольшей</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each dimension.groups as group (group.key)}
								<Table.Row data-fairness-group={group.key} data-flagged={group.flagged ? 'true' : undefined}>
									<Table.Cell>
										{GROUPS[group.key] ?? group.key}
										{#if group.flagged}
											<StatusPill label="ниже 0,8" tone="danger" />
										{:else if group.reference}
											<StatusPill label="наибольшая доля" tone="neutral" />
										{/if}
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{count(group.eligible)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{count(group.selected)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{shown(group.rate, percent)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{shown(group.ratio, fraction)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/each}
			</Card.Content>
		</Card.Root>
	{/each}
</section>
