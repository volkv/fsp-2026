<script lang="ts">
	import FilterIcon from '@lucide/svelte/icons/filter';
	import { DISCIPLINES, type DisciplineCode } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { NamedKey } from './model.js';
	import NativeSelect from './native-select.svelte';
	import RegionFilter from './region-filter.svelte';

	/**
	 * Filters of the catalog by the category in force (specialization, grade, the stack a test confirmed), the FSP level
	 * facet apart from the category, work format, region and the facet «категория не подтверждена». A GET form: the
	 * address of the page is the query. Without category filters the search goes over the whole base, and a candidate
	 * without a category is marked in the list.
	 */
	interface Values {
		text: string;
		specializations: string[];
		grades: string[];
		stack: string;
		fspDiscipline: string;
		fspLevel: string;
		formats: string[];
		regions: string[];
		uncategorized: boolean;
	}

	let {
		values,
		specializations,
		grades,
		formats,
		regions
	}: {
		values: Values;
		/** Specializations and grades of the catalog of categories. */
		specializations: NamedKey[];
		grades: NamedKey[];
		formats: NamedKey[];
		regions: readonly { code: string; name: string }[];
	} = $props();

	const id = $props.id();
	const disciplines = Object.entries(DISCIPLINES).filter(([code]) => code !== 'unknown') as [
		DisciplineCode,
		{ name: string; short: string }
	][];
</script>

<form
	method="GET"
	class="grid gap-4 rounded-xl border bg-card p-4"
	aria-label="Фильтры кандидатов"
	data-sveltekit-keepfocus
>
	<Field.Field>
		<Field.Label for="{id}-q">Поиск по профилям</Field.Label>
		<Input
			id="{id}-q"
			name="q"
			type="search"
			value={values.text}
			placeholder="Например: Go, высоконагруженные сервисы"
		/>
	</Field.Field>

	<Field.Field>
		<Field.Label for="{id}-specialization">Специализация категории</Field.Label>
		<NativeSelect id="{id}-specialization" name="specialization" value={values.specializations[0] ?? ''}>
			<option value="">Любая</option>
			{#each specializations as specialization (specialization.key)}
				<option value={specialization.key}>{specialization.name}</option>
			{/each}
		</NativeSelect>
	</Field.Field>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Грейд категории</legend>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each grades as grade (grade.key)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="grade"
						value={grade.key}
						checked={values.grades.includes(grade.key)}
						class="size-4 accent-primary"
					/>
					{grade.name}
				</label>
			{/each}
		</div>
	</fieldset>

	<Field.Field>
		<Field.Label for="{id}-stack">Стек, подтверждённый тестом</Field.Label>
		<Input
			id="{id}-stack"
			name="stack"
			value={values.stack}
			placeholder="Go, PostgreSQL"
			aria-describedby="{id}-stack-hint"
		/>
		<Field.Description id="{id}-stack-hint"
			>Все навыки из списка — в подтверждённом стеке одной категории.</Field.Description
		>
	</Field.Field>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Уровень ФСП (отдельно от категории)</legend>
		<div class="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<NativeSelect name="fspDiscipline" value={values.fspDiscipline} aria-label="Дисциплина">
				<option value="">Любая дисциплина</option>
				{#each disciplines as [code, discipline] (code)}
					<option value={code}>{discipline.short}</option>
				{/each}
			</NativeSelect>
			<NativeSelect name="fspLevel" value={values.fspLevel} aria-label="Уровень не ниже">
				<option value="">Уровень не ниже</option>
				{#each ['L1', 'L2', 'L3', 'L4', 'L5'] as level (level)}
					<option value={level}>{level}</option>
				{/each}
			</NativeSelect>
		</div>
	</fieldset>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Формат работы</legend>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each formats as format (format.key)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="format"
						value={format.key}
						checked={values.formats.includes(format.key)}
						class="size-4 accent-primary"
					/>
					{format.name}
				</label>
			{/each}
		</div>
	</fieldset>

	<RegionFilter {regions} value={values.regions} />

	<label class="flex items-start gap-2 text-sm">
		<input type="checkbox" name="uncategorized" checked={values.uncategorized} class="mt-0.5 size-4 accent-primary" />
		<span>
			Только без категории
			<span class="block text-xs text-muted-foreground"
				>кандидаты, ещё не прошедшие тест на грейд; не сочетается с фильтрами категории</span
			>
		</span>
	</label>

	<Button type="submit" class="justify-self-start">
		<FilterIcon aria-hidden="true" />
		Показать
	</Button>
</form>
