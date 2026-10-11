<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { toast } from 'svelte-sonner';
	import { tick } from 'svelte';
	import {
		CATALOG_SCOPE,
		HIDDEN_REASONS,
		SEARCH_STATUSES,
		type SearchStatus
	} from '$lib/components/candidate/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';

	/**
	 * The readiness to receive offers — the one switch of showing the profile to employers. Searching or open to offers
	 * puts the profile in the catalog: without the catalog consent in force the choice asks for it once, over its text,
	 * and saves both. «Не ищу» takes the profile out of the catalog and keeps the consent; the consent is withdrawn only
	 * on the page of consents. A choice is saved at once.
	 */
	interface Props {
		status: SearchStatus;
		catalog: {
			consented: boolean;
			hiddenReason: string | null;
			adult: boolean;
			canGrant: boolean;
			text: { id: string; title: string; version: number; body: string } | null;
			scopeFields: readonly string[];
		};
	}

	let { status, catalog }: Props = $props();

	const STATUSES = Object.keys(SEARCH_STATUSES) as SearchStatus[];
	const scopes = Object.keys(CATALOG_SCOPE) as (keyof typeof CATALOG_SCOPE)[];
	const action = `${resolve('/me/profile')}?/searchStatus`;

	let selected = $derived<SearchStatus>(status);
	let consentOpen = $state(false);
	let pending = $state(false);
	/** The refusal of the consent, shown in its dialog; other outcomes go to a toast. */
	let consentProblem = $state<string | null>(null);
	let statusForm = $state<HTMLFormElement>();

	/** Showing the profile needs the consent the candidate can give now and has not. */
	const asksConsent = (choice: SearchStatus) =>
		choice !== 'not_looking' && !catalog.consented && catalog.canGrant && catalog.text !== null;

	/** Why the profile is not in the catalog while the status says it could be. */
	const reason = $derived(
		selected === 'not_looking' || catalog.hiddenReason === null || catalog.hiddenReason === 'not_looking'
			? null
			: (HIDDEN_REASONS[catalog.hiddenReason] ?? null)
	);

	async function choose(choice: SearchStatus) {
		selected = choice;
		consentProblem = null;
		if (asksConsent(choice)) {
			consentOpen = true;
			return;
		}
		// The hidden field takes the choice on the next update; the form is sent after it.
		await tick();
		statusForm?.requestSubmit();
	}

	/** The consent dialog closed without the consent: the choice goes back to the saved status. */
	function dismiss() {
		consentOpen = false;
		selected = status;
	}

	const submit: SubmitFunction = () => {
		pending = true;
		return async ({ result }) => {
			pending = false;
			if (result.type === 'success') {
				consentOpen = false;
				toast.success('Статус поиска сохранён');
				await invalidateAll();
			} else if (result.type === 'failure') {
				const failure = result.data?.problem as { message?: string } | undefined;
				const text = failure?.message ?? 'Не удалось сохранить. Повторите.';
				if (consentOpen) consentProblem = text;
				else {
					toast.error(text);
					selected = status;
				}
			} else {
				await applyAction(result);
			}
		};
	};
</script>

<div class="grid gap-3" data-testid="search-status" data-status={status} data-consented={catalog.consented}>
	<form bind:this={statusForm} method="POST" {action} use:enhance={submit} class="grid gap-3">
		<CsrfInput />
		<input type="hidden" name="search_status" value={selected} />
		<fieldset class="grid gap-2 sm:grid-cols-3" disabled={pending}>
			<legend class="sr-only">Статус поиска</legend>
			{#each STATUSES as choice (choice)}
				<label
					class="flex cursor-pointer gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-accent has-disabled:cursor-wait"
				>
					<input
						type="radio"
						name="search_status_choice"
						value={choice}
						class="mt-0.5 size-4 accent-primary"
						checked={selected === choice}
						onchange={() => {
							void choose(choice);
						}}
					/>
					<span class="grid gap-0.5">
						<span class="font-medium">{SEARCH_STATUSES[choice].label}</span>
						<span class="text-xs text-muted-foreground">{SEARCH_STATUSES[choice].hint}</span>
					</span>
				</label>
			{/each}
		</fieldset>
	</form>

	{#if asksConsent(selected)}
		<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
			Профиль не виден работодателям: нет согласия на показ.
			<Button
				type="button"
				variant="link"
				class="h-auto p-0"
				onclick={() => {
					consentOpen = true;
				}}>Дать согласие</Button
			>
		</p>
	{:else if reason}
		<p class="text-sm text-muted-foreground">{reason}</p>
	{/if}
</div>

{#if catalog.text}
	<Dialog.Root
		bind:open={consentOpen}
		onOpenChange={(open) => {
			if (!open) dismiss();
		}}
	>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title>Показать профиль работодателям</Dialog.Title>
				<Dialog.Description>
					Чтобы компании находили вас сами, нужно один раз согласиться на показ. Проверенные компании увидят псевдоним,
					категорию, навыки с квитанциями и обобщённые достижения — без имени и контактов. Отозвать согласие можно на
					странице «Видимость и согласия».
				</Dialog.Description>
			</Dialog.Header>
			<form method="POST" {action} use:enhance={submit} class="grid gap-4">
				<CsrfInput />
				<input type="hidden" name="search_status" value={selected} />
				<input type="hidden" name="documentId" value={catalog.text.id} />
				{#if catalog.adult}
					<fieldset class="grid gap-3">
						<legend class="mb-1 text-sm font-medium">Что добавить к обобщённой карточке</legend>
						{#each scopes as scope (scope)}
							<label class="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									name="scope_fields"
									value={scope}
									class="mt-0.5 size-4 accent-primary"
									checked={catalog.scopeFields.includes(scope)}
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
						>{catalog.text.title} · редакция {catalog.text.version}</summary
					>
					<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="max-h-56 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
						role="region"
						aria-label="Текст согласия"
						tabindex="0"
					>
						{catalog.text.body}
					</div>
				</details>
				{#if consentProblem}
					<FormMessage text={consentProblem} />
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={dismiss}>Отмена</Button>
					<Button type="submit" disabled={pending}>Согласен, показать профиль</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}
