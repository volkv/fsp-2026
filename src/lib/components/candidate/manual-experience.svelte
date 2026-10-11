<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import ManualExperienceForm from './manual-experience-form.svelte';
	import type { ManualExperienceEntry as Entry } from './profile';

	/**
	 * Experience the candidate states by hand: places of work with the role, the period to the month and the stack. The
	 * section lists them; a place of work is added and edited in a dialog, removed from its card. Marked «указано
	 * кандидатом» wherever it is shown.
	 */
	let {
		entries,
		months,
		skills,
		roles,
		result
	}: {
		entries: Entry[];
		months: string | null;
		skills: { key: string; name: string }[];
		roles: { key: string; name: string }[];
		result: { target?: string; problem?: { message: string; fields: Record<string, string> } } | null;
	} = $props();

	/** The dialog of a place of work: `new` — adding one, otherwise the id of the one edited; `null` — closed. */
	let editing = $state<string | null>(null);
	const editedEntry = $derived(entries.find((entry) => entry.id === editing) ?? null);
	const resultOf = (target: string) => (result?.target === target ? result : null);
	const roleName = $derived(new Map(roles.map((role) => [role.key, role.name])));
	const skillName = $derived(new Map(skills.map((skill) => [skill.key, skill.name])));
	const monthFormat = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	const month = (value: string) => monthFormat.format(new Date(`${value}-01T00:00:00Z`));
</script>

<div class="grid gap-4" data-testid="manual-experience">
	{#if months !== null}<p class="text-sm">Стаж по этим местам работы: <span class="font-medium">{months}</span></p>{/if}
	{#if entries.length > 0}
		<ul class="grid gap-3">
			{#each entries as entry (entry.id)}
				<li class="grid gap-1 rounded-lg border p-3 text-sm">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="font-medium">
							{entry.positionTitle}{entry.organizationName ? ` · ${entry.organizationName}` : ''}
						</span>
						<span class="text-xs text-muted-foreground">указано вами</span>
					</div>
					<p class="text-muted-foreground">
						{month(entry.periodFrom)} — {entry.periodTo === null ? 'по настоящее время' : month(entry.periodTo)}
						{entry.roleKey ? ` · ${roleName.get(entry.roleKey) ?? entry.roleKey}` : ''}
					</p>
					{#if entry.skillKeys.length > 0}
						<p>{entry.skillKeys.map((key) => skillName.get(key) ?? key).join(', ')}</p>
					{/if}
					{#if entry.description}<p class="whitespace-pre-line">{entry.description}</p>{/if}
					{#if editing === null && resultOf(`experience:${entry.id}`)?.problem}
						<FormMessage text={resultOf(`experience:${entry.id}`)?.problem?.message ?? ''} />
					{/if}
					<div class="flex flex-wrap gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onclick={() => {
								editing = entry.id;
							}}>Изменить</Button
						>
						<form method="POST" action="?/removeExperience" use:enhance>
							<CsrfInput />
							<input type="hidden" name="entry_id" value={entry.id} />
							<Button type="submit" size="sm" variant="ghost">Удалить</Button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">Мест работы пока нет.</p>
	{/if}
	<Button
		type="button"
		variant="outline"
		class="justify-self-start"
		onclick={() => {
			editing = 'new';
		}}
	>
		<PlusIcon aria-hidden="true" />
		Добавить место работы
	</Button>
</div>

<Dialog.Root
	open={editing !== null}
	onOpenChange={(open) => {
		if (!open) editing = null;
	}}
>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{editedEntry ? 'Изменить место работы' : 'Добавить место работы'}</Dialog.Title>
			<Dialog.Description>
				Место работы с ваших слов: попадёт в PDF-профиль с пометкой «указано кандидатом».
			</Dialog.Description>
		</Dialog.Header>
		{#key editing}
			<ManualExperienceForm
				entry={editedEntry}
				target={editedEntry ? `experience:${editedEntry.id}` : 'experience:new'}
				{skills}
				{roles}
				problem={resultOf(editedEntry ? `experience:${editedEntry.id}` : 'experience:new')?.problem ?? null}
				ondone={() => {
					editing = null;
				}}
			/>
		{/key}
	</Dialog.Content>
</Dialog.Root>
