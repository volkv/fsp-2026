<script lang="ts">
	import { missingText, type Labels as CandidateLabels } from '$lib/components/candidate/model.js';
	import { CategoryAxes } from '$lib/components/product/index.js';
	import type { CategoryView, DisciplineCode, FspLevel } from '$lib/components/product/model.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { RUN_ORIGINS, RUN_OUTCOMES } from './model.js';

	type AxisStatus = 'established' | 'insufficient_data';

	interface Run {
		origin: string;
		outcome: string;
		computedAt: Date;
		assignments: {
			rank: 'primary' | 'secondary';
			role: { status: AxisStatus; key: string | null };
			grade: { status: AxisStatus; min: string | null; max: string | null; confidence: number | null };
			stack: { status: AxisStatus; skillKeys: string[] };
		}[];
		missing: Record<'role' | 'grade' | 'stack', { code: string; [key: string]: unknown }[]>;
	}

	/** One categorization run as the operator weighs it: its axes, how it was made and what grounds were missing. */
	let {
		run,
		labels,
		grades,
		fspLevels = []
	}: {
		run: Run;
		labels: CandidateLabels;
		grades: { key: string; name: string }[];
		fspLevels?: { discipline: string; level: string }[];
	} = $props();

	const DISCIPLINE_CODES: readonly string[] = ['algorithmic', 'product', 'uas', 'robotics', 'infosec'];
	const LEVELS: readonly string[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

	const primary = $derived(run.assignments.find((a) => a.rank === 'primary') ?? null);
	const view = $derived.by((): CategoryView | null => {
		if (!primary) return null;
		const scale = grades.map((g) => g.name);
		const index = (key: string | null) => grades.findIndex((g) => g.key === key);
		const { role, grade, stack } = primary;
		return {
			role:
				role.status === 'established' && role.key
					? { status: 'established', label: labels.roles[role.key] ?? role.key }
					: { status: 'insufficient_data' },
			grade:
				grade.status === 'established' && index(grade.min) >= 0 && index(grade.max) >= 0 && grade.confidence !== null
					? { status: 'established', scale, min: index(grade.min), max: index(grade.max), confidence: grade.confidence }
					: { status: 'insufficient_data' },
			stack:
				stack.status === 'established'
					? { status: 'established', skills: stack.skillKeys.map((key) => labels.skills[key] ?? key) }
					: { status: 'insufficient_data' },
			fspLevels: fspLevels
				.filter((item) => DISCIPLINE_CODES.includes(item.discipline) && LEVELS.includes(item.level))
				.map((item) => ({ discipline: item.discipline as DisciplineCode, level: item.level as FspLevel }))
		};
	});
	const missing = $derived([...run.missing.role, ...run.missing.grade, ...run.missing.stack]);
</script>

<div class="grid gap-3">
	<p class="text-sm text-muted-foreground">
		{RUN_ORIGINS[run.origin] ?? run.origin} · {RUN_OUTCOMES[run.outcome] ?? run.outcome} · {formatDateTime(
			run.computedAt
		)}
	</p>
	{#if view}
		<CategoryAxes category={view} />
	{:else}
		<p class="text-sm">Категория не установлена ни по одной оси.</p>
	{/if}
	{#if missing.length > 0}
		<div class="grid gap-1 text-sm">
			<p class="font-medium">Каких оснований не хватило</p>
			<ul class="list-disc pl-5 text-muted-foreground">
				{#each missing as item, index (index)}
					<li>{missingText(item, labels)}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
