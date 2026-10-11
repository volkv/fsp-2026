<script lang="ts">
	import ProfileSuggestion from './profile-suggestion.svelte';
	import { SUGGESTION_FIELDS, type ProfileSuggestionView, type SuggestionField } from './profile';

	/** What the reading of the resume found for the fields of one section of the profile, by field. */
	let {
		fields,
		suggestions,
		accountEmail,
		problemOf,
		onshow
	}: {
		fields: SuggestionField[];
		suggestions: ProfileSuggestionView[];
		accountEmail: string;
		/** The refusal of the last decision on a found value, if it was about this one. */
		problemOf: (id: string) => string | null;
		onshow: ((key: string) => void) | null;
	} = $props();

	const groups = $derived(
		fields
			.map((field) => ({ field, found: suggestions.filter((suggestion) => suggestion.field === field) }))
			.filter((group) => group.found.length > 0)
	);
</script>

{#if groups.length > 0}
	<div class="grid gap-3 rounded-lg bg-muted/50 p-4" data-testid="profile-suggestions">
		<div class="grid gap-0.5">
			<h3 class="text-sm font-medium">Найдено в резюме</h3>
			<p class="text-xs text-muted-foreground">
				Каждое значение — с цитатой из файла. Принятое записывается в поле, как если бы вы ввели его сами.
			</p>
		</div>
		{#each groups as group (group.field)}
			<div class="grid gap-2">
				{#if fields.length > 1}<span class="text-xs font-medium">{SUGGESTION_FIELDS[group.field]}</span>{/if}
				<ul class="grid gap-2 sm:grid-cols-2">
					{#each group.found as suggestion (suggestion.id)}
						<ProfileSuggestion {suggestion} {accountEmail} problem={problemOf(suggestion.id)} {onshow} />
					{/each}
				</ul>
			</div>
		{/each}
	</div>
{/if}
