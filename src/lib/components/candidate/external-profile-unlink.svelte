<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { EXTERNAL_PLATFORMS, type ExternalProfileView } from './model.js';

	/** Unlinking asks first: the data of a verified profile stops counting and employers no longer see the link. */
	let { profile }: { profile: ExternalProfileView } = $props();

	let open = $state(false);
	let pending = $state(false);
	const formId = $derived(`external-unlink-${profile.id}`);
	const name = $derived(`${EXTERNAL_PLATFORMS[profile.platform].name} ${profile.handle}`);
</script>

<form
	id={formId}
	method="POST"
	action="?/unlinkProfile"
	class="contents"
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update({ reset: false });
			pending = false;
			open = false;
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name="profile_id" value={profile.id} />
	<input type="hidden" name="platform" value={profile.platform} />
</form>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
		{profile.status === 'verified' ? 'Отвязать' : 'Отменить'}
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Отвязать {name}?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if profile.status === 'verified'}
					Данные профиля перестанут учитываться, работодатели больше не увидят ссылку на него. Привязать снова можно
					новым кодом.
				{:else}
					Хэндл и код будут удалены.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Оставить</AlertDialog.Cancel>
			<Button type="submit" form={formId} variant="destructive" disabled={pending}>Отвязать</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
