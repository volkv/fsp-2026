<script lang="ts" module>
	/** What the vacancies of the candidate's category require, as the category page receives it. */
	export type DemandSkillStatus = 'missing' | 'claimed' | 'derived' | 'public_profile';

	export interface DemandCohortView {
		specialization: string;
		gradeKeys: string[] | null;
		widenedFrom: { gradeKeys: string[]; vacancies: number } | null;
	}

	export interface DemandGapView {
		skillKey: string;
		vacancies: number;
		share: number;
		status: DemandSkillStatus;
		path: {
			tests: { assessmentId: string; kind: 'code_task' | 'quiz'; title: string }[];
			fspDisciplines: string[];
		};
	}

	export type DemandView =
		| { status: 'no_category' }
		| { status: 'evidence_recalculating' }
		| { status: 'insufficient_data'; cohort: DemandCohortView; vacancies: number; threshold: number; asOf: Date }
		| {
				status: 'available';
				cohort: DemandCohortView;
				threshold: number;
				asOf: Date;
				source: {
					vacancies: number;
					own: number;
					external: number;
					latestSeenAt: Date | null;
					synthetic: boolean;
				};
				gaps: DemandGapView[];
				confirmed: { skillKey: string; share: number }[];
		  };
</script>

<script lang="ts">
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import { resolve } from '$app/paths';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { InsufficientData } from '$lib/components/product/index.js';
	import { formatDate, pluralize } from '$lib/components/product/model.js';
	import { disciplineShort, gradeName, skillName, type Labels } from './model.js';
	import SectionCard from './section-card.svelte';

	/**
	 * «Что ищет рынок в твоей категории»: the most required skills of the active vacancies of the candidate's category —
	 * of the roles its specialization serves, of its grade and the next one — that the candidate has not confirmed, with their share of the vacancies, where the count comes from, and how
	 * each skill can be confirmed. A share is the market's demand, never a promise of an invitation or a grade.
	 */
	let { demand, labels }: { demand: DemandView; labels: Labels } = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

	const STATUS: Record<DemandSkillStatus, { label: string; tone: 'neutral' | 'warning' | 'info' }> = {
		missing: { label: 'нет в профиле', tone: 'neutral' },
		claimed: { label: 'заявлено, не подтверждено', tone: 'warning' },
		derived: { label: 'выведено из смежного навыка', tone: 'info' },
		public_profile: { label: 'публичный профиль, не проверено', tone: 'info' }
	};

	const TEST_KIND = { code_task: 'Задача', quiz: 'Квиз' } as const;

	function grades(keys: readonly string[]): string {
		const first = keys[0];
		const last = keys.at(-1);
		if (first === undefined || last === undefined) return '';
		return first === last ? gradeName(labels, first) : `${gradeName(labels, first)}–${gradeName(labels, last)}`;
	}

	function cohortLabel(cohort: DemandCohortView): string {
		const specialization = labels.specializations[cohort.specialization] ?? cohort.specialization;
		return cohort.gradeKeys === null
			? `${specialization} · все грейды`
			: `${specialization} · ${grades(cohort.gradeKeys)}`;
	}

	/** The available result, narrowed once for the template. */
	const available = $derived(demand.status === 'available' ? demand : null);

	const vacanciesWord = (n: number) => pluralize(n, ['вакансия', 'вакансии', 'вакансий']);
</script>

<SectionCard
	title="Что ищет рынок в твоей категории"
	description="Самые частые обязательные навыки активных вакансий твоей категории — её специализации, твоего грейда и следующего — те, которых у тебя нет или которые не подтверждены. Доля — это спрос рынка, а не гарантия: подтверждённый навык не обещает ни приглашения, ни повышения грейда."
	testId="market-demand"
>
	{#if demand.status === 'no_category'}
		<InsufficientData
			hint="Категория не подтверждена — спрос рынка категории посчитаем, когда тест подтвердит специализацию и грейд."
		/>
	{:else if demand.status === 'evidence_recalculating'}
		<InsufficientData
			hint="Основания профиля пересчитываются — спрос посчитаем, когда станет известно, что у тебя подтверждено."
		/>
	{:else if demand.status === 'insufficient_data'}
		<div class="grid gap-2" data-demand-state="insufficient_data">
			<InsufficientData
				hint={`Активных вакансий ${cohortLabel(demand.cohort)} сейчас: ${demand.vacancies}, меньше ${demand.threshold} — на такой выборке доля навыка ничего не говорит.`}
			/>
			{#if demand.cohort.widenedFrom}
				<p class="text-xs text-muted-foreground">
					В грейдах {grades(demand.cohort.widenedFrom.gradeKeys)} — {demand.cohort.widenedFrom.vacancies}, поэтому
					посчитаны все грейды специализации.
				</p>
			{/if}
		</div>
	{:else if available}
		{@const cohort = cohortLabel(available.cohort)}
		<div class="grid gap-4" data-demand-state="available">
			<p class="text-sm text-muted-foreground" data-testid="demand-source">
				По {available.source.vacancies} активным {pluralize(available.source.vacancies, [
					'вакансии',
					'вакансиям',
					'вакансиям'
				])}
				{cohort}: {available.source.own} на платформе, {available.source.external} из внешних источников. Данные на {formatDate(
					available.asOf
				)}{#if available.source.latestSeenAt}, самая свежая вакансия — от {formatDate(
						available.source.latestSeenAt
					)}{/if}.
				{#if available.source.synthetic}Среди них есть демонстрационные вакансии стенда.{/if}
			</p>
			{#if available.cohort.widenedFrom}
				<p class="text-sm">
					В грейдах {grades(available.cohort.widenedFrom.gradeKeys)} активных {vacanciesWord(
						available.cohort.widenedFrom.vacancies
					)}
					{available.cohort.widenedFrom.vacancies} — меньше {available.threshold}, поэтому посчитаны все грейды
					специализации.
				</p>
			{/if}

			{#if available.gaps.length === 0}
				<p class="text-sm" data-testid="demand-no-gaps">
					Все частые требования вакансий {cohort} у тебя уже подтверждены.
				</p>
			{:else}
				<ul class="grid gap-3" data-testid="demand-gaps">
					{#each available.gaps as gap (gap.skillKey)}
						<li class="grid gap-2 rounded-lg border p-3 text-sm" data-skill={gap.skillKey} data-status={gap.status}>
							<div class="flex flex-wrap items-baseline justify-between gap-2">
								<span class="font-medium">{skillName(labels, gap.skillKey)}</span>
								<StatusPill label={STATUS[gap.status].label} tone={STATUS[gap.status].tone} />
							</div>
							<p data-testid="demand-share">
								Обязателен в {percent.format(gap.share)} вакансий {cohort}
								<span class="text-muted-foreground">({gap.vacancies} из {available.source.vacancies})</span>
							</p>
							<div
								class="h-1.5 overflow-hidden rounded-full bg-muted"
								role="presentation"
								style:--share={`${Math.round(gap.share * 100)}%`}
							>
								<div class="h-full w-(--share) rounded-full bg-link"></div>
							</div>
							{#if gap.path.tests.length > 0 || gap.path.fspDisciplines.length > 0}
								<ul class="grid gap-1" data-testid="demand-path">
									{#each gap.path.tests as test (test.assessmentId)}
										<li class="flex items-start gap-1.5">
											<FlaskConicalIcon class="mt-0.5 size-4 shrink-0 text-link" aria-hidden="true" />
											<a
												class="text-link underline-offset-4 hover:underline"
												href={resolve('/(app)/me/tests/[assessmentId]', { assessmentId: test.assessmentId })}
												>{TEST_KIND[test.kind]} «{test.title}»</a
											>
											<span class="text-muted-foreground">— засчитанный результат подтвердит платформа</span>
										</li>
									{/each}
									{#if gap.path.fspDisciplines.length > 0}
										<li class="flex items-start gap-1.5">
											<TrophyIcon class="mt-0.5 size-4 shrink-0 text-link" aria-hidden="true" />
											<span>
												Подтверждается личным результатом ФСП: {gap.path.fspDisciplines.map(disciplineShort).join(', ')}
											</span>
										</li>
									{/if}
								</ul>
							{:else}
								<p class="text-muted-foreground" data-testid="demand-path">
									Теста платформы по навыку пока нет, и результаты ФСП его прямо не подтверждают: остаётся опыт в резюме
									— работодатель увидит его как заявленный.
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if available.confirmed.length > 0}
				<p class="text-sm" data-testid="demand-confirmed">
					Уже подтверждено из частых требований: {available.confirmed
						.map((item) => `${skillName(labels, item.skillKey)} (${percent.format(item.share)})`)
						.join(', ')}.
				</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Доля считает, как часто навык обязателен в вакансиях, и не измеряет, насколько он поможет именно тебе: вакансии
				с навыком — не обещание приглашения. Грейд ставят по подтверждённым основаниям, а не по закрытым пунктам этого
				списка.
			</p>
		</div>
	{/if}
</SectionCard>
