<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import XIcon from '@lucide/svelte/icons/x';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { ReviewState } from './quotes';

	/**
	 * The candidate's decision on a field or an experience entry: confirm what is right, reject what is not, return a
	 * rejected one. The buttons offer only a change of the current decision.
	 */
	let {
		action,
		idField,
		id,
		review: current,
		subject
	}: {
		action: '?/reviewClaim' | '?/reviewEntry';
		idField: 'claim_id' | 'entry_id';
		id: string;
		review: ReviewState;
		/** What is decided on, for the names of the buttons. */
		subject: string;
	} = $props();

	let pending = $state(false);
</script>

<form
	method="POST"
	{action}
	class="flex flex-wrap gap-2"
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update({ reset: false });
			pending = false;
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name={idField} value={id} />
	{#if current === 'pending'}
		<Button type="submit" name="decision" value="confirm" size="sm" disabled={pending}>
			<CheckIcon aria-hidden="true" />
			Подтвердить<span class="sr-only"> «{subject}»</span>
		</Button>
	{/if}
	{#if current !== 'rejected'}
		<Button type="submit" name="decision" value="reject" size="sm" variant="outline" disabled={pending}>
			<XIcon aria-hidden="true" />
			Отклонить<span class="sr-only"> «{subject}»</span>
		</Button>
	{:else}
		<Button type="submit" name="decision" value="confirm" size="sm" variant="outline" disabled={pending}>
			<UndoIcon aria-hidden="true" />
			Вернуть<span class="sr-only"> «{subject}»</span>
		</Button>
	{/if}
</form>
