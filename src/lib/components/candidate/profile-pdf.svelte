<script lang="ts">
	import FileDownIcon from '@lucide/svelte/icons/file-down';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	/**
	 * The PDF profile: one layout for everybody, made for the candidate and kept nowhere. A button opens a dialog where
	 * the candidate picks the contacts that go on the page; a contact not filled in cannot be picked.
	 */
	let {
		hasName,
		hasPhone,
		hasTelegram
	}: {
		hasName: boolean;
		hasPhone: boolean;
		hasTelegram: boolean;
	} = $props();

	let open = $state(false);
</script>

<Button onclick={() => (open = true)} data-testid="profile-pdf-open">
	<FileDownIcon aria-hidden="true" />
	Скачать PDF
</Button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Скачать PDF-профиль</Dialog.Title>
			<Dialog.Description>
				Ваш профиль одним файлом — для отклика или собеседования. Категорию в нём любой проверит по QR-коду.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-5" data-testid="profile-pdf">
			{#if hasName}
				<form
					method="GET"
					action={resolve('/me/profile/pdf')}
					class="grid gap-4"
					data-sveltekit-reload
					onsubmit={() => {
						// The download goes on after the submission; the dialog closes in the next task, not under it.
						setTimeout(() => (open = false));
					}}
				>
					<fieldset class="flex flex-wrap gap-4 text-sm">
						<legend class="mb-2 font-medium">Какие контакты указать</legend>
						<label class="flex items-center gap-2 has-disabled:cursor-not-allowed has-disabled:opacity-60">
							<input
								type="checkbox"
								name="phone"
								class="size-4 accent-primary"
								checked={hasPhone}
								disabled={!hasPhone}
							/>
							Телефон
							{#if !hasPhone}<span class="text-muted-foreground">— не указан</span>{/if}
						</label>
						<label class="flex items-center gap-2 has-disabled:cursor-not-allowed has-disabled:opacity-60">
							<input type="checkbox" name="email" class="size-4 accent-primary" checked />
							Почта
						</label>
						<label class="flex items-center gap-2 has-disabled:cursor-not-allowed has-disabled:opacity-60">
							<input
								type="checkbox"
								name="telegram"
								class="size-4 accent-primary"
								checked={hasTelegram}
								disabled={!hasTelegram}
							/>
							Telegram
							{#if !hasTelegram}<span class="text-muted-foreground">— не указан</span>{/if}
						</label>
					</fieldset>
					<Dialog.Footer>
						<Button type="button" variant="outline" onclick={() => (open = false)}>Отмена</Button>
						<Button type="submit">
							<FileDownIcon aria-hidden="true" />
							Скачать PDF
						</Button>
					</Dialog.Footer>
				</form>
			{:else}
				<p class="text-sm text-muted-foreground">
					Сначала укажите фамилию и имя в разделе «Основное»: без них PDF не собрать — подтверждение категории привязано
					к вашему ФИО.
				</p>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
