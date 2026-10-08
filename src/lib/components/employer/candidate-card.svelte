<script lang="ts">
	import { resolve } from '$app/paths';
	import FileSearchIcon from '@lucide/svelte/icons/file-search';
	import {
		AchievementBadge,
		CategoryList,
		SalaryRange,
		TrustChip,
		VerificationReceipt
	} from '$lib/components/product/index.js';
	import {
		AWARDS,
		categoryName,
		COMPETITION_LEVELS,
		DISCIPLINES,
		pluralize,
		type AchievementView,
		type Award,
		type CompetitionLevel,
		type DisciplineCode,
		type EvskRank,
		type ReceiptView,
		type TrustMark
	} from '$lib/components/product/model.js';
	import { assertion } from '$lib/components/candidate/model.js';
	import SignalsSummary from '$lib/components/assessments/signals-summary.svelte';
	import type { SignalSummaryView } from '$lib/components/assessments/model.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { categoryBadges, disciplineName, fspLevelChips, labelOf, type CardCategory, type Labels } from './model.js';

	/** The catalog card of a candidate: what the company may see before contacts, with the grounds of every claim. */
	interface Achievement {
		/** Handles of this achievement's receipts among `receipts`. */
		receiptHandles: string[];
		/** FSP published the result, but it is not official yet: not an achievement, shown with its mark. */
		preliminary: boolean;
		generalized: {
			discipline?: string;
			competitionLevel?: string;
			season?: number;
			resultGroup?: string;
			format?: string;
			computedIndicator?: string | null;
		};
		exact?: {
			competitionTitle: string;
			stage: string | null;
			place: number | null;
			team: { name: string; role: string | null } | null;
		};
	}
	interface Card {
		isMinor?: boolean;
		/** Name of the stated region; the card carries its code too, which the page does not show. */
		regionName?: string | null;
		preferences?: {
			workFormats: string[];
			employmentForms: string[];
			relocation: boolean | null;
			searchStatus: 'active' | 'open_to_offers' | 'not_looking';
			salaryExpectation: {
				min: number | null;
				max: number | null;
				currency: string;
				period: 'month' | 'year' | 'hour' | 'project';
				taxBase: 'gross' | 'net' | 'unknown';
			} | null;
		};
		categories?: CardCategory[];
		desiredRoleKeys?: string[];
		fspLevels?: { discipline: string; level: string; lastResultOn: string | null }[];
		skills?: {
			skillKey: string;
			strengthBand: 'weak' | 'moderate' | 'strong';
			attestation: 'direct' | 'derived' | 'claimed';
			badgeTrust: string | null;
		}[];
		fspAchievements?: Achievement[];
		experience?: {
			roleKey?: string | null;
			duration?: { minMonths: number; maxMonths: number } | null;
			appliedSkillKeys?: string[];
		}[];
		experienceSummary?: { total: { minMonths: number; maxMonths: number } } | null;
		externalProfiles?: { platform: 'codeforces' | 'github'; handle: string; verified: boolean }[];
	}
	interface Receipt {
		handle: string;
		level: 'generalized' | 'exact';
		status: 'valid' | 'superseded' | 'annulled' | 'not_valid';
		verifiedAt: string;
		asserts: Record<string, string | number>;
		doesNotAssert: string[];
		signingKeyId: string;
		simulator: boolean;
	}

	interface Props {
		card: Card;
		/** The evidence of the profile (skills, FSP levels) is in force, being recalculated, or not computed yet. */
		evidenceState: 'available' | 'recalculating' | 'none';
		receipts: Receipt[];
		labels: Labels & { terms: { work_format: Record<string, string>; employment_form: Record<string, string> } };
		/** The signal totals of the attempt behind each category of the card. */
		signals: { specialization: string; grade: string; summary: SignalSummaryView }[];
	}

	let { card, evidenceState, receipts, labels, signals }: Props = $props();

	const BANDS = { weak: 'слабое основание', moderate: 'среднее основание', strong: 'сильное основание' } as const;
	const SEARCH = { active: 'Ищет работу', open_to_offers: 'Открыт к предложениям', not_looking: 'Не ищет' } as const;

	const skillName = (key: string) => labels.skills[key] ?? key;
	const months = (range: { minMonths: number; maxMonths: number }) => {
		const years = (value: number) => {
			const y = Math.floor(value / 12);
			const m = value % 12;
			return (
				[y > 0 ? `${y} ${pluralize(y, ['год', 'года', 'лет'])}` : '', m > 0 ? `${m} мес.` : '']
					.filter(Boolean)
					.join(' ') || 'меньше месяца'
			);
		};
		return range.minMonths === range.maxMonths
			? years(range.minMonths)
			: `от ${years(range.minMonths)} до ${years(range.maxMonths)}`;
	};

	function trustOf(skill: NonNullable<Card['skills']>[number]): TrustMark {
		if (skill.attestation === 'derived') return 'derived';
		if (skill.attestation === 'claimed' || skill.badgeTrust === null) return 'claimed';
		return skill.badgeTrust as TrustMark;
	}

	/** A full achievement for the badge; the generalized minor view (discipline and level only) is shown as text. */
	function achievementView(item: Achievement): AchievementView | null {
		const g = item.generalized;
		if (g.season === undefined || g.discipline === undefined || g.competitionLevel === undefined) return null;
		return {
			discipline: (g.discipline in DISCIPLINES ? g.discipline : 'unknown') as DisciplineCode | 'unknown',
			level: (g.competitionLevel in COMPETITION_LEVELS ? g.competitionLevel : 'unknown') as
				CompetitionLevel | 'unknown',
			award: ((g.resultGroup ?? 'unknown') in AWARDS ? (g.resultGroup ?? 'unknown') : 'unknown') as Award | 'unknown',
			format: g.format === 'onsite' || g.format === 'online' ? g.format : 'unknown',
			season: g.season,
			team: item.exact?.team != null,
			evskIndicator: (g.computedIndicator ?? null) as EvskRank | null,
			...(item.exact
				? {
						exact: {
							competition: item.exact.competitionTitle,
							place: item.exact.place,
							...(item.exact.team ? { teamName: item.exact.team.name } : {})
						}
					}
				: {})
		};
	}

	function receiptView(receipt: Receipt): ReceiptView {
		const season = receipt.asserts.season;
		const discipline = receipt.asserts.discipline;
		return {
			handle: receipt.handle,
			source: 'fsp',
			title: [discipline === undefined ? null : assertion('discipline', discipline).value, season]
				.filter((part) => part !== null && part !== undefined)
				.join(', '),
			verifiedAt: receipt.verifiedAt,
			status: receipt.status,
			disclosure: receipt.level,
			// The wording of the public check page: codes such as the stage are named, never shown raw.
			asserts: Object.entries(receipt.asserts).map(([key, value]) => assertion(key, value)),
			doesNotAssert: receipt.doesNotAssert,
			signingKeyId: receipt.signingKeyId
		};
	}

	const desiredRole = $derived(
		card.desiredRoleKeys && card.desiredRoleKeys.length > 0
			? card.desiredRoleKeys.map((key) => labels.roles[key] ?? key).join(', ')
			: null
	);
</script>

<div class="grid gap-6" data-testid="candidate-card" data-projection="catalog">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Категория</h2></Card.Title>
			<Card.Description>
				Специализация и грейд, подтверждённые тестом на грейд, с определяющими блоками грейда. Уровень ФСП и навыки из
				резюме — доказательства профиля: они уточняют ранжирование, но категорию не назначают.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-3">
			<CategoryList
				categories={categoryBadges(card.categories ?? [], labels)}
				fspLevels={fspLevelChips(card.fspLevels ?? [])}
			/>
			{#each signals as entry (entry.specialization)}
				<SignalsSummary summary={entry.summary} title={`Сигналы теста: ${categoryName(entry, labels)}`} />
			{/each}
			{#if desiredRole}
				<p class="text-sm text-muted-foreground">Желаемые роли: {desiredRole}</p>
			{/if}
			{#if evidenceState === 'recalculating'}
				<p class="text-sm text-muted-foreground">
					Доказательства профиля пересчитываются после изменения — навыки и уровень ФСП появятся после пересчёта.
					Категория от этого не зависит.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid gap-6 lg:grid-cols-2">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что подтверждено</h2></Card.Title>
				<Card.Description>Каждый навык — с уровнем доверия к его источнику.</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if (card.skills ?? []).length === 0}
					<p class="text-sm text-muted-foreground">Навыки не установлены.</p>
				{:else}
					<ul class="grid gap-2" aria-label="Навыки">
						{#each card.skills ?? [] as skill (skill.skillKey)}
							<li class="flex flex-wrap items-center gap-2 text-sm" data-skill={skill.skillKey}>
								<TrustChip level={trustOf(skill)} skill={skillName(skill.skillKey)} />
								<span class="text-muted-foreground">{BANDS[skill.strengthBand]}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Опыт и ожидания</h2></Card.Title>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				{#if card.preferences}
					<dl class="grid gap-2 sm:grid-cols-2">
						<div>
							<dt class="text-muted-foreground">Статус поиска</dt>
							<dd>{SEARCH[card.preferences.searchStatus]}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Регион</dt>
							<dd>{card.regionName ?? 'не указан'}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Формат</dt>
							<dd>
								{card.preferences.workFormats.length > 0
									? card.preferences.workFormats.map((key) => labels.terms.work_format[key] ?? key).join(', ')
									: 'не указан'}
							</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Ожидания по зарплате</dt>
							<dd>
								{#if card.preferences.salaryExpectation}
									<SalaryRange salary={card.preferences.salaryExpectation} />
								{:else}
									не указаны
								{/if}
							</dd>
						</div>
					</dl>
				{/if}
				{#if card.experienceSummary}
					<p><span class="text-muted-foreground">Коммерческий опыт:</span> {months(card.experienceSummary.total)}</p>
				{/if}
				{#if (card.experience ?? []).length > 0}
					<ul class="grid gap-2">
						{#each card.experience ?? [] as entry, index (index)}
							<li class="rounded-md border p-2">
								<span class="font-medium"
									>{entry.roleKey ? (labels.roles[entry.roleKey] ?? entry.roleKey) : 'Роль не распознана'}</span
								>
								{#if entry.duration}<span class="text-muted-foreground"> · {months(entry.duration)}</span>{/if}
								{#if entry.appliedSkillKeys && entry.appliedSkillKeys.length > 0}
									<span class="block text-xs text-muted-foreground">
										{entry.appliedSkillKeys.map(skillName).join(', ')}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-muted-foreground">Записей об опыте работы нет.</p>
				{/if}
				{#if (card.externalProfiles ?? []).length > 0}
					<p>
						<span class="text-muted-foreground">Публичные профили:</span>
						{(card.externalProfiles ?? [])
							.map((profile) => `${profile.platform === 'github' ? 'GitHub' : 'Codeforces'} ${profile.handle}`)
							.join(', ')}
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<section class="grid gap-4" aria-labelledby="achievements-heading">
		<h2 id="achievements-heading" class="font-heading text-h3">Достижения ФСП</h2>
		{#if (card.fspAchievements ?? []).length === 0}
			<p class="text-sm text-muted-foreground">
				Достижений ФСП в профиле нет — кандидат оценивается по остальным доказательствам на равных.
			</p>
		{:else}
			{#if card.isMinor}
				<p class="text-sm text-muted-foreground">
					Кандидату нет 18 лет: достижения показаны обобщённо — дисциплина и уровень.
				</p>
			{/if}
			<ul class="grid gap-4">
				{#each card.fspAchievements ?? [] as item, index (index)}
					{@const view = achievementView(item)}
					{@const factReceipts = receipts.filter((receipt) => item.receiptHandles.includes(receipt.handle))}
					<li class="grid gap-3" data-preliminary={item.preliminary}>
						{#if item.preliminary}
							<p class="text-xs font-medium text-warning" data-testid="preliminary-result">
								Предварительный результат: ФСП ещё не объявила его официальным, это пока не достижение.
							</p>
						{/if}
						{#if view}
							<AchievementBadge achievement={view} />
						{:else}
							<p class="rounded-xl border p-4 text-sm">
								{disciplineName(item.generalized.discipline)}
								· {labelOf(COMPETITION_LEVELS, item.generalized.competitionLevel)}
							</p>
						{/if}
						{#each factReceipts as receipt (receipt.handle)}
							<VerificationReceipt
								receipt={receiptView(receipt)}
								simulator={receipt.simulator}
								verifyHref={resolve('/verify/[handle]', { handle: receipt.handle })}
							/>
						{:else}
							<p class="flex items-start gap-2 text-xs text-muted-foreground">
								<FileSearchIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
								{item.preliminary
									? 'Факт получен из данных ФСП по ФСП ID кандидата. Квитанцию проверки выпустим, когда результат станет официальным.'
									: 'Факт получен из данных ФСП по ФСП ID кандидата. Квитанция проверки для вашей компании ещё не выпущена.'}
							</p>
						{/each}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
