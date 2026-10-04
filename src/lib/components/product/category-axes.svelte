<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import InsufficientData from './insufficient-data.svelte';
	import { DISCIPLINES, type CategoryView } from './model.js';

	let { category, class: className }: { category: CategoryView; class?: string } = $props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });

	const noAxis = $derived(
		category.role.status === 'insufficient_data' &&
			category.grade.status === 'insufficient_data' &&
			category.stack.status === 'insufficient_data'
	);
</script>

<section
	class={cn('space-y-3', className)}
	aria-label="Категория кандидата"
	data-category-outcome={noAxis ? 'insufficient_data' : 'set'}
>
	{#if noAxis}
		<p class="text-sm">
			<span class="font-medium">Категория не установлена.</span>
			<span class="text-muted-foreground">Кандидат остаётся в каталоге и находится по навыкам и уровню ФСП.</span>
		</p>
	{/if}
	<dl class="grid gap-3 sm:grid-cols-3">
		<div
			class={cn('rounded-lg border p-3', category.role.status === 'insufficient_data' && 'border-dashed')}
			data-axis="role"
			data-status={category.role.status}
		>
			<dt class="mb-1 font-mono text-label text-muted-foreground">Роль</dt>
			<dd>
				{#if category.role.status === 'established'}
					<p class="font-medium">{category.role.label}</p>
				{:else}
					<InsufficientData hint={category.role.hint} />
				{/if}
				{#if category.desiredRole}
					<p class="mt-1 text-xs text-muted-foreground">Желаемая: {category.desiredRole}</p>
				{/if}
			</dd>
		</div>
		<div
			class={cn('rounded-lg border p-3', category.grade.status === 'insufficient_data' && 'border-dashed')}
			data-axis="grade"
			data-status={category.grade.status}
		>
			<dt class="mb-1 font-mono text-label text-muted-foreground">Грейд</dt>
			<dd>
				{#if category.grade.status === 'established'}
					{@const grade = category.grade}
					<p class="font-medium">
						{grade.min === grade.max ? grade.scale[grade.min] : `${grade.scale[grade.min]} – ${grade.scale[grade.max]}`}
					</p>
					<div class="mt-2 flex gap-0.5" aria-hidden="true">
						{#each grade.scale as label, index (label)}
							<span
								class={cn(
									'h-1.5 flex-1 rounded-full',
									index >= grade.min && index <= grade.max ? 'bg-primary' : 'bg-muted'
								)}
							></span>
						{/each}
					</div>
					<p class="mt-1 text-xs text-muted-foreground">
						Уверенность {percent.format(grade.confidence)}
					</p>
				{:else}
					<InsufficientData hint={category.grade.hint} />
				{/if}
			</dd>
		</div>
		<div
			class={cn('rounded-lg border p-3', category.stack.status === 'insufficient_data' && 'border-dashed')}
			data-axis="stack"
			data-status={category.stack.status}
		>
			<dt class="mb-1 font-mono text-label text-muted-foreground">Ядро стека</dt>
			<dd>
				{#if category.stack.status === 'established'}
					<p class="flex flex-wrap gap-1">
						{#each category.stack.skills as skill (skill)}
							<span class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{skill}</span>
						{/each}
					</p>
				{:else}
					<InsufficientData hint={category.stack.hint} />
				{/if}
			</dd>
		</div>
	</dl>
	{#if category.fspLevels && category.fspLevels.length > 0}
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<span class="text-muted-foreground">Уровень ФСП (отдельно от грейда):</span>
			{#each category.fspLevels as item (item.discipline)}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
				>
					{DISCIPLINES[item.discipline].short}
					<span class="font-mono">{item.level}</span>
				</span>
			{/each}
		</div>
	{/if}
</section>
