<script lang="ts">
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';

	/**
	 * Deleting a resume asks first: the file, its text and everything extracted from it are removed for good, and a
	 * resume that counted in the profile leaves the category.
	 */
	let {
		resumeDocumentId,
		name,
		counted
	}: {
		resumeDocumentId: string;
		name: string;
		/** The current resume, whose fields feed the profile. */ counted: boolean;
	} = $props();

	let open = $state(false);
	let pending = $state(false);
	const formId = $derived(`resume-delete-${resumeDocumentId}`);
</script>

<form
	id={formId}
	method="POST"
	action="?/delete"
	class="contents"
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update();
			pending = false;
			open = false;
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name="resume_document_id" value={resumeDocumentId} />
</form>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })} aria-label="Удалить резюме «{name}»">
		<Trash2Icon aria-hidden="true" />
		Удалить
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Удалить резюме «{name}»?</AlertDialog.Title>
			<AlertDialog.Description>
				Файл, его текст и всё, что из него извлечено, удалятся насовсем — восстановить не получится.
				{#if counted}
					Опыт и навыки из этого резюме перестанут учитываться в профиле, категория пересчитается.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Оставить</AlertDialog.Cancel>
			<Button type="submit" form={formId} variant="destructive" disabled={pending}>Удалить насовсем</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
