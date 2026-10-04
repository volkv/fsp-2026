<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * Regions of the catalog filter from the reference of regions: a search by name narrows the list, each chosen region
	 * posts its code as `region` of the GET form. Chosen regions stay in the list whatever the search says; without
	 * scripts the whole list is shown.
	 */
	let {
		regions,
		value
	}: {
		regions: readonly { code: string; name: string }[];
		/** The codes of the query. */
		value: string[];
	} = $props();

	const id = $props.id();
	let query = $state('');
	// The codes of the query until the employer changes the choice; a new query after the search takes over again.
	let chosen = $derived(value);

	const needle = $derived(query.trim().toLocaleLowerCase('ru'));
	const found = $derived(
		needle === '' ? regions : regions.filter((region) => region.name.toLocaleLowerCase('ru').includes(needle))
	);
	const chosenNames = $derived(regions.filter((region) => chosen.includes(region.code)).map((region) => region.name));

	function toggle(code: string, checked: boolean) {
		chosen = checked ? [...chosen, code] : chosen.filter((item) => item !== code);
	}
</script>

<fieldset class="grid gap-2" data-testid="region-filter">
	<legend class="mb-1 text-sm font-medium">Регион</legend>
	<label class="grid gap-1.5 text-sm">
		<span class="sr-only">Найти регион</span>
		<Input
			type="search"
			bind:value={query}
			placeholder="Найти регион"
			autocomplete="off"
			onkeydown={(event: KeyboardEvent) => {
				// Enter narrows the list, it does not send the filters.
				if (event.key === 'Enter') event.preventDefault();
			}}
			aria-describedby="{id}-summary"
		/>
	</label>
	<p id="{id}-summary" class="text-xs text-muted-foreground" aria-live="polite">
		{#if chosenNames.length > 0}
			Выбрано: {chosenNames.join(', ')}
		{:else if needle !== ''}
			Найдено: {found.length}
		{:else}
			Любой из {regions.length}
		{/if}
	</p>
	<ul class="grid max-h-48 gap-1.5 overflow-y-auto rounded-md border p-2">
		{#each regions as region (region.code)}
			<li hidden={!chosen.includes(region.code) && !found.includes(region)}>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="region"
						value={region.code}
						checked={chosen.includes(region.code)}
						onchange={(event) => {
							toggle(region.code, event.currentTarget.checked);
						}}
						class="size-4 shrink-0 accent-primary"
					/>
					{region.name}
				</label>
			</li>
		{/each}
		{#if needle !== '' && found.length === 0}
			<li class="text-sm text-muted-foreground">Такого региона нет в справочнике</li>
		{/if}
	</ul>
</fieldset>
