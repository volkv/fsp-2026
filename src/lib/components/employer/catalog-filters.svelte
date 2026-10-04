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
	 * Filters of the catalog by the category axes (role, grade with the «grade not established» group, stack core), the
	 * FSP level facet separate from the grade, work format, region and the «no category» facet. A GET form: the address
	 * of the page is the query.
	 */
	interface Values {
		text: string;
		roles: string[];
		grades: string[];
		includeGradeUnknown: boolean;
		stack: string;
		fspDiscipline: string;
		fspLevel: string;
		formats: string[];
		regions: string[];
		uncategorized: boolean;
	}

	let {
		values,
		roles,
		grades,
		formats,
		regions
	}: {
		values: Values;
		roles: NamedKey[];
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
		<Field.Label for="{id}-role">Роль</Field.Label>
		<NativeSelect id="{id}-role" name="role" value={values.roles[0] ?? ''}>
			<option value="">Любая</option>
			{#each roles as role (role.key)}
				<option value={role.key}>{role.name}</option>
			{/each}
		</NativeSelect>
	</Field.Field>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Грейд</legend>
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
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="gradeUnknown" checked={values.includeGradeUnknown} class="size-4 accent-primary" />
			И кандидаты с неустановленным грейдом — отдельной группой
		</label>
	</fieldset>

	<Field.Field>
		<Field.Label for="{id}-stack">Ядро стека</Field.Label>
		<Input
			id="{id}-stack"
			name="stack"
			value={values.stack}
			placeholder="Go, PostgreSQL"
			aria-describedby="{id}-stack-hint"
		/>
		<Field.Description id="{id}-stack-hint">Все навыки из списка — в ядре одной категории.</Field.Description>
	</Field.Field>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Уровень ФСП (отдельно от грейда)</legend>
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
			<span class="block text-xs text-muted-foreground">недостаточно данных для роли, грейда и стека</span>
		</span>
	</label>

	<Button type="submit" class="justify-self-start">
		<FilterIcon aria-hidden="true" />
		Показать
	</Button>
</form>
