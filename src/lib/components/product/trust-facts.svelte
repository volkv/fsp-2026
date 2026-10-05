<script lang="ts">
	import { cn } from '$lib/components/utils.js';

	type FactKey =
		| 'applications_answered'
		| 'first_step_in_time'
		| 'outcome_reported'
		| 'outcome_agreed'
		| 'salary_lowered'
		| 'offers_withdrawn'
		| 'complaints_upheld';

	interface Trust {
		windowDays: number;
		minObservations: number;
		facts: ({ key: FactKey; status: 'shown'; count: number; of: number } | { key: FactKey; status: 'no_data' })[];
	}

	/**
	 * Facts of trust in a company: each one «so many of so many» with the number of observations, or «no data» below the
	 * threshold. No overall score: the reader weighs the facts.
	 */
	let { trust, class: className }: { trust: Trust; class?: string } = $props();

	const LABELS: Record<FactKey, { title: string; shown: (count: number, of: number) => string }> = {
		applications_answered: {
			title: 'Ответы на отклики',
			shown: (count, of) => `ответила на ${count} из ${of} откликов`
		},
		first_step_in_time: {
			title: 'Первый шаг после принятия',
			shown: (count, of) => `${count} из ${of} принятых предложений: этап или исход найма отмечен в течение 7 дней`
		},
		outcome_reported: {
			title: 'Исход найма',
			shown: (count, of) => `сообщила по ${count} из ${of} принятых предложений`
		},
		outcome_agreed: {
			title: 'Совпадение с кандидатами',
			shown: (count, of) => `исход совпал с сообщением кандидата в ${count} из ${of} случаев`
		},
		salary_lowered: {
			title: 'Снижение вилки',
			shown: (count, of) => `в ${count} из ${of} новых версий условий вилка ниже прежней`
		},
		offers_withdrawn: {
			title: 'Отозванные предложения',
			shown: (count, of) => `${count} из ${of} предложений отозваны до ответа кандидата`
		},
		complaints_upheld: {
			title: 'Обоснованные жалобы кандидатов',
			shown: (count, of) => `${count} на ${of} предложений`
		}
	};
</script>

<div class={cn('grid gap-2', className)} data-testid="trust-facts">
	<dl class="grid gap-1.5 text-sm">
		{#each trust.facts as fact (fact.key)}
			<div class="grid gap-0.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-3" data-fact={fact.key}>
				<dt class="text-muted-foreground">{LABELS[fact.key].title}</dt>
				<dd>
					{#if fact.status === 'shown'}
						{LABELS[fact.key].shown(fact.count, fact.of)}
					{:else}
						<span class="text-muted-foreground">нет данных</span>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
	<p class="text-xs text-muted-foreground">
		По предложениям компании за {trust.windowDays} дней. Факт показывается от {trust.minObservations} наблюдений, иначе —
		«нет данных». Общей оценки нет: каждый факт — как он есть.
	</p>
</div>
