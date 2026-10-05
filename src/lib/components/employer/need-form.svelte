<script lang="ts">
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import NativeSelect from './native-select.svelte';

	/**
	 * The fields of a hiring need (domain 13.10): the role, specialization and the range of grades of the catalog of
	 * categories, skills by their names, requirements outside the taxonomy as written, the team, the format, the region, a
	 * range in roubles per month and whether FSP results matter. The parent form posts them; the server resolves skill
	 * names by the taxonomy.
	 */
	interface Props {
		options: {
			roles: { key: string; name: string; tested: boolean }[];
			specializations: { key: string; title: string }[];
			grades: { key: string; title: string }[];
			workFormats: { key: string; name: string }[];
			regions: { code: string; name: string }[];
		};
		values?: {
			roleKey?: string;
			specialization?: string;
			grade?: { min: string; max: string };
			skills: string;
			niceSkills: string;
			otherSkills?: string;
			otherNiceSkills?: string;
			team?: string;
			workFormat?: string;
			regionCode?: string;
			salary?: { min: number; max: number; taxBase: 'gross' | 'net' };
			fspRelevant?: boolean;
		};
		problems?: Record<string, string>;
	}

	let { options, values, problems = {} }: Props = $props();
	const id = $props.id();
</script>

<div class="grid gap-4" data-testid="need-form-fields">
	<div class="grid gap-3 sm:grid-cols-2">
		<Field.Field data-invalid={problems['form.role_key'] !== undefined}>
			<Field.Label for="{id}-role">Роль</Field.Label>
			<NativeSelect id="{id}-role" name="role_key" value={values?.roleKey ?? ''}>
				<option value="">Не указана</option>
				{#each options.roles as item (item.key)}
					<option value={item.key}>{item.name}{item.tested ? '' : ' — тестом не подтверждается'}</option>
				{/each}
			</NativeSelect>
			<Field.Description>Без специализации подборка берёт категории роли.</Field.Description>
			{#if problems['form.role_key']}<Field.Error>{problems['form.role_key']}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={problems['form.specialization'] !== undefined}>
			<Field.Label for="{id}-spec">Специализация</Field.Label>
			<NativeSelect id="{id}-spec" name="specialization" value={values?.specialization ?? ''}>
				<option value="">Не указана — по роли</option>
				{#each options.specializations as item (item.key)}
					<option value={item.key}>{item.title}</option>
				{/each}
			</NativeSelect>
			{#if problems['form.specialization']}<Field.Error>{problems['form.specialization']}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={problems['form.grade.max'] !== undefined}>
			<Field.Label for="{id}-grade-min">Грейд: от и до</Field.Label>
			<div class="grid grid-cols-2 gap-2">
				<NativeSelect id="{id}-grade-min" name="grade_min" value={values?.grade?.min ?? ''} aria-label="Грейд от">
					<option value="">Не указан</option>
					{#each options.grades as item (item.key)}
						<option value={item.key}>{item.title}</option>
					{/each}
				</NativeSelect>
				<NativeSelect name="grade_max" value={values?.grade?.max ?? ''} aria-label="Грейд до">
					<option value="">Тот же</option>
					{#each options.grades as item (item.key)}
						<option value={item.key}>{item.title}</option>
					{/each}
				</NativeSelect>
			</div>
			<Field.Description>Подборка возьмёт категории всех грейдов диапазона.</Field.Description>
			{#if problems['form.grade.max']}<Field.Error>{problems['form.grade.max']}</Field.Error>{/if}
		</Field.Field>
	</div>
	<Field.Field data-invalid={problems['form.skill_keys'] !== undefined}>
		<Field.Label for="{id}-skills">Обязательные навыки</Field.Label>
		<Input id="{id}-skills" name="skill_keys" value={values?.skills ?? ''} placeholder="Go, PostgreSQL" />
		<Field.Description>Через запятую, как в таксономии навыков.</Field.Description>
		{#if problems['form.skill_keys']}<Field.Error>{problems['form.skill_keys']}</Field.Error>{/if}
	</Field.Field>
	<Field.Field data-invalid={problems['form.nice_skill_keys'] !== undefined}>
		<Field.Label for="{id}-nice">Желательные навыки</Field.Label>
		<Input id="{id}-nice" name="nice_skill_keys" value={values?.niceSkills ?? ''} placeholder="Kafka" />
		{#if problems['form.nice_skill_keys']}<Field.Error>{problems['form.nice_skill_keys']}</Field.Error>{/if}
	</Field.Field>
	<div class="grid gap-3 sm:grid-cols-2">
		<Field.Field>
			<Field.Label for="{id}-other">Другие обязательные требования</Field.Label>
			<Input id="{id}-other" name="other_skills" value={values?.otherSkills ?? ''} placeholder="Hugging Face" />
			<Field.Description>Вне таксономии: платформа их не подтверждает — проверьте на собеседовании.</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label for="{id}-other-nice">Другие желательные требования</Field.Label>
			<Input id="{id}-other-nice" name="other_nice_skills" value={values?.otherNiceSkills ?? ''} />
		</Field.Field>
	</div>
	<Field.Field>
		<Field.Label for="{id}-team">О команде (необязательно)</Field.Label>
		<Textarea id="{id}-team" name="team" rows={2} maxlength={500} value={values?.team ?? ''} />
	</Field.Field>
	<div class="grid gap-3 sm:grid-cols-2">
		<Field.Field>
			<Field.Label for="{id}-format">Формат работы</Field.Label>
			<NativeSelect id="{id}-format" name="work_format" value={values?.workFormat ?? ''}>
				<option value="">Не важен</option>
				{#each options.workFormats as item (item.key)}
					<option value={item.key}>{item.name}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
		<Field.Field data-invalid={problems['form.region_code'] !== undefined}>
			<Field.Label for="{id}-region">Регион</Field.Label>
			<NativeSelect id="{id}-region" name="region_code" value={values?.regionCode ?? ''}>
				<option value="">Не важен</option>
				{#each options.regions as item (item.code)}
					<option value={item.code}>{item.name}</option>
				{/each}
			</NativeSelect>
		</Field.Field>
	</div>
	<fieldset class="grid gap-3">
		<legend class="mb-1 text-sm font-medium">Вилка в рублях в месяц (необязательно)</legend>
		<div class="grid gap-3 sm:grid-cols-3">
			<Field.Field data-invalid={problems['form.salary.min'] !== undefined}>
				<Field.Label for="{id}-min">От, ₽</Field.Label>
				<Input id="{id}-min" name="salary_min" inputmode="numeric" value={values?.salary?.min ?? ''} />
			</Field.Field>
			<Field.Field data-invalid={problems['form.salary.max'] !== undefined}>
				<Field.Label for="{id}-max">До, ₽</Field.Label>
				<Input id="{id}-max" name="salary_max" inputmode="numeric" value={values?.salary?.max ?? ''} />
				{#if problems['form.salary.max']}<Field.Error>{problems['form.salary.max']}</Field.Error>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="{id}-tax">Налоговая база</Field.Label>
				<NativeSelect id="{id}-tax" name="salary_tax_base" value={values?.salary?.taxBase ?? 'gross'}>
					<option value="gross">До вычета НДФЛ</option>
					<option value="net">На руки</option>
				</NativeSelect>
			</Field.Field>
		</div>
	</fieldset>
	<label class="flex items-center gap-2 text-sm">
		<input type="checkbox" name="fsp_relevant" class="size-4" checked={values?.fspRelevant ?? false} />
		Результаты соревнований ФСП важны для этой потребности
	</label>
</div>
