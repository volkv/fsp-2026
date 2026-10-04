<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * The region of the candidate from the reference of regions: a search narrows the list, the list posts the code.
	 * Without scripts the whole list is shown. The chosen region stays in the list whatever the search says.
	 */
	let {
		regions,
		value,
		error
	}: {
		regions: readonly { code: string; name: string }[];
		/** The stored code; `undefined` — the region is not stated. */
		value: string | undefined;
		error: string | undefined;
	} = $props();

	const id = $props.id();
	let query = $state('');
	// The stored code until the candidate picks another one; a new stored value after saving takes over again.
	let chosen = $derived(value ?? '');

	const needle = $derived(query.trim().toLocaleLowerCase('ru'));
	const found = $derived(regions.filter((region) => region.name.toLocaleLowerCase('ru').includes(needle)));
	const shown = $derived(
		needle === '' ? regions : regions.filter((region) => region.code === chosen || found.includes(region))
	);

	let search = $state<HTMLInputElement | null>(null);
	// A reset of the form (after a save) empties the search field without an input event: the list follows it.
	$effect(() => {
		const form = search?.form;
		if (!form) return;
		const clear = () => {
			query = '';
		};
		form.addEventListener('reset', clear);
		return () => {
			form.removeEventListener('reset', clear);
		};
	});

	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
</script>

<div class="grid gap-3 sm:grid-cols-2" data-testid="region-picker">
	<label class="grid gap-1.5 text-sm">
		<span>Найти регион</span>
		<Input
			type="search"
			bind:ref={search}
			bind:value={query}
			placeholder="Начни вводить название"
			autocomplete="off"
			onkeydown={(event: KeyboardEvent) => {
				// Enter narrows the list, it does not send the whole form.
				if (event.key === 'Enter') event.preventDefault();
			}}
			aria-describedby="{id}-found"
		/>
		<span id="{id}-found" class="text-xs text-muted-foreground" aria-live="polite">
			{needle === '' ? `Регионов в справочнике: ${regions.length}` : `Найдено: ${found.length}`}
		</span>
	</label>
	<label class="grid content-start gap-1.5 text-sm">
		<span>Регион</span>
		<select
			name="region_code"
			class={selectClass}
			onchange={(event) => {
				chosen = event.currentTarget.value;
			}}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? `${id}-error` : undefined}
		>
			<option value="" selected={chosen === ''}>не указан</option>
			{#each shown as region (region.code)}
				<option value={region.code} selected={region.code === chosen}>{region.name}</option>
			{/each}
		</select>
		{#if error}<span id="{id}-error" class="text-destructive">{error}</span>{/if}
	</label>
</div>
