<script lang="ts" module>
	/** How many needs of companies match the candidate's category, as the category page receives it. */
	export type NeedDemandView =
		| { status: 'no_category' }
		| {
				status: 'available';
				category: { specialization: string; grade: string };
				needs: { value: number } | { below: number };
				threshold: number;
				salary: {
					gross: { needs: number; min: number; max: number } | null;
					net: { needs: number; min: number; max: number } | null;
				};
				skills: { skillKey: string; needs: number; share: number }[];
				asOf: Date;
		  };
</script>

<script lang="ts">
	import { categoryName } from '$lib/components/product/model.js';
	import SectionCard from './section-card.svelte';
	import { skillName, type Labels } from './model.js';

	/**
	 * «Спрос»: the active needs of companies that match the candidate's category — a count, the median range and the
	 * skills they ask for; an aggregate only, never a need or a company, and nothing that would name one below the
	 * threshold.
	 */
	let { demand, labels }: { demand: NeedDemandView; labels: Labels } = $props();

	const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
</script>

{#if demand.status === 'available'}
	<SectionCard
		title="Спрос на вашу категорию"
		description={`Потребности компаний, которые ищут ${categoryName(demand.category, labels)}. Только агрегат: меньше ${demand.threshold} не показываем точно.`}
		testId="need-demand"
	>
		<p class="text-sm">
			Совпало потребностей:
			<span class="font-medium numeric" data-testid="need-count">
				{'value' in demand.needs ? demand.needs.value : `меньше ${demand.needs.below}`}
			</span>
		</p>
		{#if demand.salary.gross || demand.salary.net}
			<ul class="grid gap-1 text-sm">
				{#if demand.salary.gross}
					<li>
						Медианная вилка до вычета НДФЛ: {money.formatRange(demand.salary.gross.min, demand.salary.gross.max)}
						<span class="text-muted-foreground">· по {demand.salary.gross.needs} потребностям</span>
					</li>
				{/if}
				{#if demand.salary.net}
					<li>
						Медианная вилка на руки: {money.formatRange(demand.salary.net.min, demand.salary.net.max)}
						<span class="text-muted-foreground">· по {demand.salary.net.needs} потребностям</span>
					</li>
				{/if}
			</ul>
		{/if}
		{#if demand.skills.length > 0}
			<p class="text-sm">
				<span class="text-muted-foreground">Чаще всего требуют:</span>
				{demand.skills
					.map((skill) => `${skillName(labels, skill.skillKey)} — ${percent.format(skill.share)}`)
					.join(', ')}
			</p>
		{/if}
	</SectionCard>
{/if}
