<script lang="ts">
	import {
		AchievementBadge,
		CategoryAxes,
		DegradedModeNotice,
		HiringStages,
		InsufficientData,
		InvitationStatus,
		MatchBreakdown,
		RecommendationNotice,
		ResponseDeadline,
		SalaryRange,
		TrustChip,
		TrustSignal,
		VerificationReceipt
	} from '$lib/components/product/index.js';
	import {
		INVITATION_STATUSES,
		type InvitationStatus as Status,
		type TrustMark
	} from '$lib/components/product/model.js';
	import { achievements, categories, hiring, match, receipts, salaries } from './samples.js';
	import ShowcaseSection from './showcase-section.svelte';
	import Specimen from './specimen.svelte';

	const marks: TrustMark[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed', 'derived'];
	const statuses = Object.keys(INVITATION_STATUSES) as Status[];
	const signals = [3, 2, 1, 0] as const;

	const HOUR = 3_600_000;
	const openedAt = Date.now();
	const deadlines = [
		{ caption: 'Срок не близко', dueAt: new Date(openedAt + 3 * 24 * HOUR + 4 * HOUR) },
		{ caption: 'Меньше суток', dueAt: new Date(openedAt + 5 * HOUR) },
		{ caption: 'Меньше часа — секунды', dueAt: new Date(openedAt + 0.5 * HOUR) },
		{ caption: 'Срок истёк', dueAt: new Date(openedAt - HOUR) }
	];
</script>

<ShowcaseSection
	id="product"
	title="Продуктовые компоненты"
	description="Сущности модели (docs/domain.md): доверие к факту, квитанции, достижения ФСП, категория по осям, соответствие, вилка, приглашение и найм. На витрине — примеры состояний, не реальные люди и результаты."
>
	<Specimen title="Чип доверия: 4 уровня и вывод без бейджа (наведите или сфокусируйте — подсказка)">
		<div class="space-y-4" data-testid="trust-chips">
			<div class="flex flex-wrap items-center gap-2">
				{#each marks as level (level)}
					<TrustChip {level} />
				{/each}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				{#each marks as level (level)}
					<TrustChip {level} skill="Python" signal />
				{/each}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm text-muted-foreground">Кабинет кандидата:</span>
				<TrustChip level="fsp_verified" register="sport" size="md" signal />
				<TrustChip level="platform_verified" register="sport" size="md" signal />
			</div>
			<div class="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
				Сигнал узлов:
				{#each signals as filled (filled)}
					<span class="inline-flex items-center gap-1 text-link"><TrustSignal {filled} /></span>
				{/each}
			</div>
		</div>
	</Specimen>

	<div class="grid gap-4 xl:grid-cols-3">
		{#each receipts as item (item.receipt.handle)}
			<Specimen title="Квитанция: {item.caption}">
				<VerificationReceipt receipt={item.receipt} />
			</Specimen>
		{/each}
	</div>

	<div class="grid gap-4 md:grid-cols-2">
		{#each achievements as item (item.caption)}
			<Specimen title="Достижение ФСП: {item.caption}">
				<AchievementBadge achievement={item.achievement} />
			</Specimen>
		{/each}
	</div>

	<div class="grid gap-4">
		{#each categories as item (item.caption)}
			<Specimen title="Категория: {item.caption}">
				<CategoryAxes category={item.category} />
			</Specimen>
		{/each}
		<Specimen title="Недостаточно данных — отдельно">
			<InsufficientData hint="Рынок категории: выборка меньше порога." />
		</Specimen>
	</div>

	<div class="grid gap-4 lg:grid-cols-[3fr_2fr]">
		<Specimen title="Разложение соответствия вакансии">
			<MatchBreakdown {match} />
		</Specimen>
		<Specimen title="Вилка зарплаты">
			<ul class="space-y-4">
				{#each salaries as item (item.caption)}
					<li class="grid gap-1">
						<span class="text-xs text-muted-foreground">{item.caption}</span>
						<SalaryRange salary={item.salary} comparison={item.comparison} size="lg" />
					</li>
				{/each}
			</ul>
		</Specimen>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Статус приглашения">
			<div class="flex flex-wrap gap-2">
				{#each statuses as status (status)}
					<InvitationStatus {status} />
				{/each}
			</div>
		</Specimen>
		<Specimen title="Срок ответа">
			<div class="flex flex-wrap gap-2" data-testid="deadlines">
				{#each deadlines as item (item.caption)}
					<ResponseDeadline dueAt={item.dueAt} />
				{/each}
			</div>
		</Specimen>
	</div>

	<div class="grid gap-4">
		{#each hiring as item (item.caption)}
			<Specimen title="Этапы найма: {item.caption}">
				<HiringStages hiring={item.hiring} />
			</Specimen>
		{/each}
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Плашка рекомендательной системы">
			<div class="space-y-3">
				<RecommendationNotice />
				<RecommendationNotice compact />
			</div>
		</Specimen>
		<Specimen title="Упрощённый режим без модели">
			<div class="space-y-3">
				<DegradedModeNotice operations={['embed']} />
				<DegradedModeNotice operations={['extract', 'rerank']} />
			</div>
		</Specimen>
	</div>
</ShowcaseSection>
