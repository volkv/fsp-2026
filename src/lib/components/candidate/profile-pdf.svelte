<script lang="ts">
	import FileDownIcon from '@lucide/svelte/icons/file-down';
	import { resolve } from '$app/paths';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { ATTESTATION_STATUSES, type AttestationStatus } from './profile';

	/**
	 * The PDF profile: one layout for everybody, made for the candidate and kept nowhere. The candidate picks the
	 * contacts that go on the page; the QR code of each category leads to its signed confirmation, which says nothing of
	 * who holds it — the holder code proves it to whom the candidate chooses.
	 */
	let {
		hasName,
		hasPhone,
		hasTelegram,
		attestations
	}: {
		hasName: boolean;
		hasPhone: boolean;
		hasTelegram: boolean;
		attestations: { handle: string; holderCode: string; status: AttestationStatus; issuedAt: Date; url: string }[];
	} = $props();
</script>

<div class="grid gap-4" data-testid="profile-pdf">
	{#if hasName}
		<form method="GET" action={resolve('/me/profile/pdf')} class="grid gap-3" data-sveltekit-reload>
			<fieldset class="flex flex-wrap gap-4 text-sm">
				<legend class="mb-2 font-medium">Контакты на странице</legend>
				<label class="flex items-center gap-2">
					<input type="checkbox" name="phone" class="size-4 accent-primary" checked={hasPhone} disabled={!hasPhone} />
					Телефон
				</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" name="email" class="size-4 accent-primary" checked />
					Почта
				</label>
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						name="telegram"
						class="size-4 accent-primary"
						checked={hasTelegram}
						disabled={!hasTelegram}
					/>
					Telegram
				</label>
			</fieldset>
			<button type="submit" class={buttonVariants({ class: 'justify-self-start' })}>
				<FileDownIcon aria-hidden="true" />
				Скачать PDF-профиль
			</button>
		</form>
	{:else}
		<p class="text-sm text-muted-foreground">
			Укажите фамилию и имя в форме выше: подтверждение категории привязывается к владельцу по ФИО, без него PDF не
			формируется.
		</p>
	{/if}

	{#if attestations.length > 0}
		<div class="grid gap-2">
			<h3 class="font-medium">Подтверждения категорий</h3>
			<p class="text-sm text-muted-foreground">
				Куда ведут QR-коды ваших PDF. Код владельца — ваш секрет: передайте его вместе со ссылкой тому, кому хотите
				доказать, что подтверждение ваше; он проверит его вместе с вашим ФИО.
			</p>
			<ul class="grid gap-2">
				{#each attestations as attestation (attestation.handle)}
					<li
						class="grid gap-1 rounded-lg border p-3 text-sm"
						data-testid="attestation"
						data-status={attestation.status}
					>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<a
								class="font-medium break-all text-link underline underline-offset-4"
								href={resolve('/verify/categories/[handle]', { handle: attestation.handle })}>{attestation.url}</a
							>
							<StatusPill
								tone={ATTESTATION_STATUSES[attestation.status].tone}
								label={ATTESTATION_STATUSES[attestation.status].label}
							/>
						</div>
						<p class="text-muted-foreground">Выдано {formatDateTime(attestation.issuedAt)}</p>
						<p>Код владельца: <span class="font-mono break-all">{attestation.holderCode}</span></p>
						<p class="text-xs text-muted-foreground">
							Ссылка с кодом: <span class="font-mono break-all">{attestation.url}?code={attestation.holderCode}</span>
						</p>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
