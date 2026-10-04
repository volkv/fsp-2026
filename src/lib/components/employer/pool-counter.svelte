<script lang="ts">
	import UsersIcon from '@lucide/svelte/icons/users';
	import { formatDateTime, pluralize } from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';

	/**
	 * «In the pool: N confirmed candidates» of a vacancy (domain 13.3), as the matching service counted it for the
	 * current revision: with the date, «fewer than N» below the threshold, honest «not counted yet» and «not enough data».
	 * Next to it, «M matching without confirmation»: at the pool threshold by the score, but no required skill confirmed
	 * directly — with the required skills a platform test confirms.
	 */
	type SmallCount = { status: 'counted'; count: number } | { status: 'below_threshold'; threshold: number };
	type Matching = { unconfirmed: SmallCount; confirmableSkills: { key: string; name: string }[] };
	type Pool =
		| { status: 'counted'; count: number; countedAt: Date; matching: Matching }
		| { status: 'below_threshold'; threshold: number; countedAt: Date; matching: Matching }
		| { status: 'insufficient_data' }
		| { status: 'pending' };

	let { pool, class: className }: { pool: Pool; class?: string } = $props();
</script>

<div class={cn('grid gap-1.5 text-sm', className)}>
	<p class="flex items-start gap-2" data-testid="pool" data-pool-status={pool.status}>
		<UsersIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span>
			{#if pool.status === 'counted'}
				В пуле <span class="font-semibold numeric">{pool.count}</span>
				{pluralize(pool.count, ['подтверждённый кандидат', 'подтверждённых кандидата', 'подтверждённых кандидатов'])}
				<span class="block text-xs text-muted-foreground">посчитано {formatDateTime(pool.countedAt)}</span>
			{:else if pool.status === 'below_threshold'}
				В пуле меньше {pool.threshold} подтверждённых кандидатов
				<span class="block text-xs text-muted-foreground">
					точное малое число не показываем · посчитано {formatDateTime(pool.countedAt)}
				</span>
			{:else if pool.status === 'insufficient_data'}
				Пул не считается: у вакансии нет обязательных навыков
			{:else}
				Пул считается для текущей версии вакансии
			{/if}
		</span>
	</p>
	{#if pool.status === 'counted' || pool.status === 'below_threshold'}
		{@const unconfirmed = pool.matching.unconfirmed}
		{@const skills = pool.matching.confirmableSkills}
		<p class="pl-6" data-testid="pool-matching" data-matching-status={unconfirmed.status}>
			Подходящих без подтверждения:
			{#if unconfirmed.status === 'counted'}
				<span class="font-semibold numeric">{unconfirmed.count}</span>
			{:else}
				меньше {unconfirmed.threshold}
			{/if}
			<span class="block text-xs text-muted-foreground">
				подходят по соответствию, но ни один обязательный навык не подтверждён результатом ФСП или тестом платформы
			</span>
			<span class="block text-xs text-muted-foreground" data-testid="pool-confirmable">
				{#if skills.length > 0}
					тестом платформы подтверждаются: {skills.map((skill) => skill.name).join(', ')}
				{:else}
					тестов платформы по обязательным навыкам вакансии пока нет
				{/if}
			</span>
		</p>
	{/if}
</div>
