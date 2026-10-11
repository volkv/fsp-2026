<script lang="ts">
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { SUGGESTION_STATUSES, type ProfileSuggestionView } from './profile';

	/**
	 * A value of a profile field the reading of the resume found: the value, the quote it rests on — a click shows the
	 * words in the resume text — and the candidate's decision. Accepting writes the value into the field; the e-mail of
	 * the profile is the account's, so a found address is only compared with it.
	 */
	let {
		suggestion,
		accountEmail,
		problem,
		onshow
	}: {
		suggestion: ProfileSuggestionView;
		/** The address of the account; `null` when the page has no address suggestion to compare. */
		accountEmail: string | null;
		problem: string | null;
		/** Shows the quote in the resume text; `null` — the text is not on the page. */
		onshow: ((key: string) => void) | null;
	} = $props();

	const status = $derived(SUGGESTION_STATUSES[suggestion.status]);
	const isEmail = $derived(suggestion.field === 'email');
	const sameEmail = $derived(isEmail && suggestion.value === accountEmail);
</script>

<li class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="profile-suggestion" data-field={suggestion.field}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<span class="font-medium">{suggestion.label}</span>
		<StatusPill tone={status.tone} label={status.label} />
	</div>
	{#if onshow}
		<button
			type="button"
			class="flex items-start gap-1.5 text-left text-xs text-link underline-offset-4 hover:underline"
			onclick={() => {
				onshow(suggestion.sourceKey);
			}}
		>
			<QuoteIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span>«{suggestion.quote.text}» — показать в резюме</span>
		</button>
	{:else}
		<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
			<QuoteIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span>«{suggestion.quote.text}»</span>
		</p>
	{/if}
	{#if isEmail}
		<p class="text-xs text-muted-foreground">
			{sameEmail
				? 'Совпадает с почтой аккаунта.'
				: 'Отличается от почты аккаунта: компании и PDF-профиль получают почту аккаунта, в демо-режиме её сменить нельзя.'}
		</p>
	{/if}
	{#if problem}<FormMessage text={problem} />{/if}
	{#if suggestion.status === 'pending'}
		<form method="POST" action="?/decideSuggestion" use:enhance class="flex flex-wrap gap-2">
			<CsrfInput />
			<input type="hidden" name="suggestion_id" value={suggestion.id} />
			{#if !isEmail}
				<Button type="submit" name="decision" value="accepted" size="sm">Принять в профиль</Button>
			{/if}
			<Button type="submit" name="decision" value="rejected" size="sm" variant="outline">
				{isEmail ? 'Скрыть' : 'Отклонить'}
			</Button>
		</form>
	{/if}
</li>
