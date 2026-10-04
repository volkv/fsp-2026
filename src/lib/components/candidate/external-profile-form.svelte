<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
	import type { ExternalProfileView } from './model.js';

	/**
	 * One action on a linked public profile, posted with the fields the server reads: a new code for its handle, the
	 * check of the code, a new reading. The button is disabled while the post is on its way.
	 */
	let {
		profile,
		action,
		variant = 'outline',
		pendingLabel,
		children
	}: {
		profile: ExternalProfileView;
		action: 'linkProfile' | 'confirmProfile' | 'refreshProfile';
		variant?: ButtonVariant;
		/** Shown on the button while the post is on its way. */
		pendingLabel?: string;
		children: Snippet;
	} = $props();

	let pending = $state(false);
</script>

<form
	method="POST"
	action="?/{action}"
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update({ reset: false });
			pending = false;
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name="platform" value={profile.platform} />
	{#if action === 'linkProfile'}
		<input type="hidden" name="handle" value={profile.handle} />
	{:else}
		<input type="hidden" name="profile_id" value={profile.id} />
	{/if}
	<Button type="submit" {variant} size="sm" disabled={pending}>
		{#if pending && pendingLabel !== undefined}{pendingLabel}{:else}{@render children()}{/if}
	</Button>
</form>
