<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resolve } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { NamedKey } from './model.js';
	import NativeSelect from './native-select.svelte';

	/**
	 * Search of the external vacancies: words of the vacancy, role and work format. A GET form: the address of the page
	 * is the query, so a search can be shared and reopened.
	 */
	interface Values {
		text: string;
		roleKey: string | null;
		workFormats: string[];
	}

	let { values, roles, formats }: { values: Values; roles: NamedKey[]; formats: NamedKey[] } = $props();

	const id = $props.id();
	const filtered = $derived(values.text !== '' || values.roleKey !== null || values.workFormats.length > 0);
</script>

<form
	method="GET"
	class="grid gap-4 rounded-xl border bg-card p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
	aria-label="Поиск внешних вакансий"
	data-sveltekit-keepfocus
>
	<Field.Field>
		<Field.Label for="{id}-q">Название, навыки, организация</Field.Label>
		<Input id="{id}-q" name="q" type="search" value={values.text} placeholder="Например: Go, платёжные сервисы" />
	</Field.Field>

	<Field.Field>
		<Field.Label for="{id}-role">Роль</Field.Label>
		<NativeSelect id="{id}-role" name="role" value={values.roleKey ?? ''}>
			<option value="">Любая</option>
			{#each roles as role (role.key)}
				<option value={role.key}>{role.name}</option>
			{/each}
		</NativeSelect>
	</Field.Field>

	<fieldset class="grid gap-2">
		<legend class="mb-1 text-sm font-medium">Формат работы</legend>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each formats as format (format.key)}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="format"
						value={format.key}
						checked={values.workFormats.includes(format.key)}
						class="size-4 accent-primary"
					/>
					{format.name}
				</label>
			{/each}
		</div>
	</fieldset>

	<div class="flex flex-wrap items-end gap-3">
		<Button type="submit">
			<SearchIcon aria-hidden="true" />
			Найти
		</Button>
		{#if filtered}
			<a class={buttonVariants({ variant: 'ghost' })} href={resolve('/company/vacancies/external')}>Сбросить</a>
		{/if}
	</div>
</form>
