<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * Skills of the taxonomy chosen by name: the chosen ones as removable chips sent under `name`, and a search over the
	 * names of the vocabulary to add more, up to `max`.
	 */
	let {
		skills,
		name,
		chosen = [],
		max,
		label
	}: {
		skills: readonly { key: string; name: string }[];
		name: string;
		chosen?: readonly string[];
		max: number;
		label: string;
	} = $props();

	let picked = $derived<string[]>([...chosen]);
	let query = $state('');
	const id = $props.id();
	const skillName = $derived(new Map(skills.map((skill) => [skill.key, skill.name])));
	const needle = $derived(query.trim().toLocaleLowerCase('ru'));
	const found = $derived(
		needle === ''
			? []
			: skills
					.filter((skill) => !picked.includes(skill.key) && skill.name.toLocaleLowerCase('ru').includes(needle))
					.slice(0, 12)
	);
	const full = $derived(picked.length >= max);
</script>

<div class="grid gap-2">
	<span class="text-sm font-medium" id="{id}-label">{label}</span>
	{#each picked as key (key)}
		<input type="hidden" {name} value={key} />
	{/each}
	<div class="flex flex-wrap gap-2" role="group" aria-live="polite" aria-labelledby="{id}-label">
		{#each picked as key (key)}
			<button
				type="button"
				class="rounded-full border border-primary bg-accent px-3 py-1 text-sm"
				aria-label="Убрать {skillName.get(key) ?? key}"
				onclick={() => {
					picked = picked.filter((item) => item !== key);
				}}
			>
				{skillName.get(key) ?? key} ×
			</button>
		{:else}
			<span class="text-sm text-muted-foreground">Не выбрано.</span>
		{/each}
	</div>
	<Input
		bind:value={query}
		placeholder={full ? `Не больше ${max}` : 'Найти навык, например PostgreSQL'}
		disabled={full}
		autocomplete="off"
		aria-label="Найти навык"
	/>
	{#if found.length > 0}
		<div class="flex flex-wrap gap-2">
			{#each found as skill (skill.key)}
				<button
					type="button"
					class="rounded-full border px-3 py-1 text-sm"
					onclick={() => {
						picked = [...picked, skill.key];
						query = '';
					}}
				>
					+ {skill.name}
				</button>
			{/each}
		</div>
	{:else if needle !== ''}
		<p class="text-sm text-muted-foreground">Такого навыка в справочнике нет.</p>
	{/if}
</div>
