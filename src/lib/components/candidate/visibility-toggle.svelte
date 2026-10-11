<script lang="ts">
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import { applyAction, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { CATALOG_SCOPE, HIDDEN_REASONS } from '$lib/components/candidate/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	interface Props {
		visibility: {
			on: boolean;
			hiddenReason: string | null;
			adult: boolean;
			canGrant: boolean;
			/** The current edition of the consent text was agreed to before: turning on needs no second reading. */
			agreed: boolean;
			scopeFields: readonly string[];
			text: { id: string; title: string; version: number; body: string } | null;
		};
	}

	let { visibility }: Props = $props();

	const scopes = Object.keys(CATALOG_SCOPE) as (keyof typeof CATALOG_SCOPE)[];
	const visibilityPage = resolve('/me/visibility');

	let open = $state(false);
	let pending = $state(false);
	let problem = $state<string | null>(null);
	let revokeForm = $state<HTMLFormElement>();
	let regrantForm = $state<HTMLFormElement>();

	/**
	 * Turning the profile on is a consent: the first time and after a new edition of the text it is given over the text,
	 * otherwise at a click under the edition agreed to before. Turning it off withdraws it at once.
	 */
	const blocked = $derived(!visibility.on && (!visibility.canGrant || visibility.text === null));
	const reason = $derived(
		!visibility.canGrant
			? visibility.hiddenReason === 'age_unknown'
				? HIDDEN_REASONS.age_unknown
				: 'До 18 лет показ включается после подтверждения законного представителя.'
			: visibility.text === null
				? 'Текст согласия на показ ещё не опубликован.'
				: visibility.on && visibility.hiddenReason !== null
					? HIDDEN_REASONS[visibility.hiddenReason]
					: null
	);

	function toggle() {
		problem = null;
		if (visibility.on) revokeForm?.requestSubmit();
		else if (visibility.agreed) regrantForm?.requestSubmit();
		else open = true;
	}

	const submit: SubmitFunction = () => {
		pending = true;
		problem = null;
		return async ({ result }) => {
			pending = false;
			if (result.type === 'success') {
				open = false;
				await invalidateAll();
			} else if (result.type === 'failure') {
				const failure = result.data?.problem as { message?: string } | undefined;
				problem = failure?.message ?? 'Не удалось сохранить. Повторите.';
			} else {
				await applyAction(result);
			}
		};
	};
</script>

<div
	class="grid justify-items-start gap-1 sm:justify-items-end"
	data-testid="visibility-toggle"
	data-on={visibility.on}
>
	<label
		class="inline-flex cursor-pointer items-center gap-3 rounded-full border bg-card py-1.5 pr-1.5 pl-4 shadow-xs transition-colors has-disabled:cursor-not-allowed {visibility.on
			? 'border-success/40'
			: ''}"
	>
		{#if visibility.on}
			<EyeIcon class="size-4 text-success" aria-hidden="true" />
		{:else}
			<EyeOffIcon class="size-4 text-muted-foreground" aria-hidden="true" />
		{/if}
		<span class="text-sm font-medium">
			{visibility.on ? 'Виден работодателям' : 'Скрыт от работодателей'}
		</span>
		<button
			type="button"
			role="switch"
			aria-checked={visibility.on}
			aria-label="Показ работодателям"
			aria-busy={pending}
			disabled={blocked || pending}
			onclick={toggle}
			class="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none {visibility.on
				? 'bg-success'
				: 'bg-input'}"
		>
			<span
				class="pointer-events-none block size-6 rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none {visibility.on
					? 'translate-x-5'
					: 'translate-x-0'}"
			></span>
		</button>
	</label>
	{#if problem && !open}
		<p class="max-w-80 text-xs text-destructive sm:text-right" role="alert">{problem}</p>
	{:else if reason}
		<p class="max-w-80 text-xs text-muted-foreground sm:text-right">{reason}</p>
	{/if}
</div>

<form
	bind:this={revokeForm}
	method="POST"
	action="{visibilityPage}?/catalogRevoke"
	use:enhance={submit}
	class="hidden"
	aria-hidden="true"
>
	<CsrfInput />
</form>

{#if visibility.text && visibility.agreed}
	<form
		bind:this={regrantForm}
		method="POST"
		action="{visibilityPage}?/catalogGrant"
		use:enhance={submit}
		class="hidden"
		aria-hidden="true"
	>
		<CsrfInput />
		<input type="hidden" name="documentId" value={visibility.text.id} />
		{#each visibility.scopeFields as scope (scope)}
			<input type="hidden" name="scope_fields" value={scope} />
		{/each}
	</form>
{:else if visibility.text}
	<Dialog.Root bind:open>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>Показать профиль работодателям</Dialog.Title>
				<Dialog.Description>
					Проверенные компании увидят псевдоним, категорию, навыки с квитанциями и обобщённые достижения — без имени и
					контактов. Выключить можно в любой момент.
				</Dialog.Description>
			</Dialog.Header>
			<form method="POST" action="{visibilityPage}?/catalogGrant" use:enhance={submit} class="grid gap-4">
				<CsrfInput />
				<input type="hidden" name="documentId" value={visibility.text.id} />
				{#if visibility.adult}
					<fieldset class="grid gap-3">
						<legend class="mb-1 text-sm font-medium">Что добавить к обобщённой карточке</legend>
						{#each scopes as scope (scope)}
							<label class="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									name="scope_fields"
									value={scope}
									class="mt-0.5 size-4 accent-primary"
									checked={visibility.scopeFields.includes(scope)}
								/>
								<span class="grid gap-0.5">
									<span class="font-medium">{CATALOG_SCOPE[scope].label}</span>
									<span class="text-xs text-muted-foreground">{CATALOG_SCOPE[scope].hint}</span>
								</span>
							</label>
						{/each}
					</fieldset>
				{/if}
				<details class="rounded-lg border text-sm">
					<summary class="cursor-pointer px-3 py-2 font-medium"
						>{visibility.text.title} · редакция {visibility.text.version}</summary
					>
					<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="max-h-56 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
						role="region"
						aria-label="Текст согласия"
						tabindex="0"
					>
						{visibility.text.body}
					</div>
				</details>
				{#if problem}
					<FormMessage text={problem} />
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (open = false)}>Отмена</Button>
					<Button type="submit" disabled={pending}>Даю согласие и показываю профиль</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
