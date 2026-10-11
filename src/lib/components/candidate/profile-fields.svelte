<script lang="ts">
	import ContactIcon from '@lucide/svelte/icons/contact';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import UserIcon from '@lucide/svelte/icons/user';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ProfileFound from './profile-found.svelte';
	import SaveStatus from './save-status.svelte';
	import SettingsSection from './settings-section.svelte';
	import type { ProfileSuggestionView } from './profile';

	/**
	 * The fields the candidate keeps by hand, in three sections — the basics (the name and the headline), the contacts,
	 * the soft skills — and in each, by field, what the reading of the resume found for it, with its quote and the
	 * decision on it. A change is saved at once: a text field when it loses focus, the name when the focus leaves its
	 * three fields (the surname goes only with the first name), the soft skills shortly after the last click; the title
	 * of the section shows the saving and its outcome. The three sections are saved by one form: a decision on a found
	 * value is a form of its own, and forms do not nest, so the fields belong to the form by its id.
	 */
	let {
		profile,
		suggestions,
		softSkills,
		maxSoftSkills,
		result,
		onshow
	}: {
		profile: {
			fullName: { last: string; first: string; middle: string | null } | null;
			phone: string | null;
			telegram: string | null;
			email: string;
			headline: string | null;
			softSkillKeys: string[];
		};
		suggestions: ProfileSuggestionView[];
		softSkills: { key: string; name: string }[];
		maxSoftSkills: number;
		/** The answer of the last action of this section: a message, field problems, the target it is about. */
		result: {
			target?: string;
			saved?: number;
			problem?: { message: string; fields: Record<string, string> };
		} | null;
		onshow: ((key: string) => void) | null;
	} = $props();

	const formId = $props.id();
	const fieldsResult = $derived(result?.target === 'fields' ? result : null);
	const fieldError = (name: string) => fieldsResult?.problem?.fields[name];
	const suggestionProblem = (id: string) =>
		result?.target === `suggestion:${id}` ? (result.problem?.message ?? null) : null;
	let chosenSoftSkills = $derived<string[]>([...profile.softSkillKeys]);
	const softFull = $derived(chosenSoftSkills.length >= maxSoftSkills);

	type Section = 'basics' | 'contacts' | 'soft';
	type SaveState = 'idle' | 'saving' | 'saved' | 'error';
	/** The section of each field, to show where a save or a field problem belongs. */
	const SECTION_OF: Record<string, Section> = {
		last_name: 'basics',
		first_name: 'basics',
		middle_name: 'basics',
		headline: 'basics',
		phone: 'contacts',
		telegram: 'contacts',
		soft_skill_keys: 'soft'
	};
	/** A refusal not tied to a field (fields show their own problems under them). */
	const generalProblem = $derived(
		fieldsResult?.problem && Object.keys(fieldsResult.problem.fields).length === 0 ? fieldsResult.problem.message : null
	);
	const SAVED_SHOWN_MS = 2500;
	const SOFT_SKILLS_DELAY_MS = 600;

	let saveState = $state<Record<Section, SaveState>>({ basics: 'idle', contacts: 'idle', soft: 'idle' });
	let saveForm = $state<HTMLFormElement>();
	let nameGroup = $state<HTMLFieldSetElement>();
	// Bookkeeping of the queue, not shown: what changed since the last save and what the save in flight carries.
	let queued: Section[] = [];
	let inFlight: Section[] = [];
	let saving = false;
	let nameChanged = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const savedAt: Record<Section, number> = { basics: 0, contacts: 0, soft: 0 };

	function schedule(section: Section, delay: number) {
		if (!queued.includes(section)) queued.push(section);
		clearTimeout(timer);
		timer = setTimeout(flush, delay);
	}

	function flush() {
		if (saving || queued.length === 0) return;
		inFlight = queued;
		queued = [];
		for (const section of inFlight) saveState[section] = 'saving';
		saveForm?.requestSubmit();
	}

	/** A field changed and lost focus, or a soft skill was picked; the name waits for the focus to leave its fields. */
	function changed(event: Event) {
		const field = event.target;
		if (!(field instanceof HTMLInputElement)) return;
		const section = SECTION_OF[field.name];
		if (section === undefined) return;
		if (nameGroup?.contains(field)) {
			nameChanged = true;
			return;
		}
		schedule(section, field.type === 'checkbox' ? SOFT_SKILLS_DELAY_MS : 0);
	}

	function nameFocusOut(event: FocusEvent) {
		if (!nameChanged || (event.relatedTarget instanceof Node && nameGroup?.contains(event.relatedTarget))) return;
		nameChanged = false;
		schedule('basics', 0);
	}

	const submit: SubmitFunction = () => {
		saving = true;
		// Enter in a field sends the form at once, past the queue: it saves the section of that field.
		if (inFlight.length === 0) {
			const active = document.activeElement;
			const section = active instanceof HTMLInputElement ? SECTION_OF[active.name] : undefined;
			inFlight = section === undefined ? ['basics', 'contacts', 'soft'] : [section];
			for (const each of inFlight) saveState[each] = 'saving';
		}
		return async ({ result: answer, update }) => {
			await update({ reset: false, invalidateAll: true });
			// A refused save keeps nothing: every section it carried stays unsaved.
			const outcome = answer.type === 'success' ? 'saved' : 'error';
			const now = Date.now();
			for (const section of inFlight) {
				saveState[section] = outcome;
				if (outcome === 'saved') {
					savedAt[section] = now;
					setTimeout(() => {
						if (saveState[section] === 'saved' && Date.now() - savedAt[section] >= SAVED_SHOWN_MS) {
							saveState[section] = 'idle';
						}
					}, SAVED_SHOWN_MS);
				}
			}
			inFlight = [];
			saving = false;
			flush();
		};
	};
</script>

<div class="grid" data-testid="profile-fields" onchange={changed}>
	<SettingsSection
		title="Основное"
		panel
		icon={UserIcon}
		description="Как к вам обращаться и какую работу вы ищете. Заполните вручную или примите найденное в резюме. ФИО хранится зашифрованным: компания видит его только после вашего согласия на раскрытие."
		testId="profile-basics"
	>
		{#snippet status()}<SaveStatus status={saveState.basics} />{/snippet}
		{#if saveState.basics === 'error' && generalProblem}<FormMessage text={generalProblem} />{/if}
		<fieldset class="grid gap-3" bind:this={nameGroup} onfocusout={nameFocusOut}>
			<legend class="sr-only">ФИО</legend>
			<div class="grid gap-3 sm:grid-cols-3">
				<div class="grid gap-1.5">
					<Label for="last-name">Фамилия</Label>
					<Input
						id="last-name"
						name="last_name"
						form={formId}
						autocomplete="family-name"
						value={profile.fullName?.last ?? ''}
					/>
					{#if fieldError('last_name')}<p class="text-sm text-destructive">{fieldError('last_name')}</p>{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="first-name">Имя</Label>
					<Input
						id="first-name"
						name="first_name"
						form={formId}
						autocomplete="given-name"
						value={profile.fullName?.first ?? ''}
					/>
					{#if fieldError('first_name')}<p class="text-sm text-destructive">{fieldError('first_name')}</p>{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="middle-name">Отчество</Label>
					<Input
						id="middle-name"
						name="middle_name"
						form={formId}
						autocomplete="additional-name"
						value={profile.fullName?.middle ?? ''}
					/>
					{#if fieldError('middle_name')}<p class="text-sm text-destructive">{fieldError('middle_name')}</p>{/if}
				</div>
			</div>
		</fieldset>

		<div class="grid gap-1.5">
			<Label for="headline">Желаемая должность</Label>
			<Input
				id="headline"
				name="headline"
				form={formId}
				maxlength={200}
				placeholder="Например, бэкенд-разработчик"
				value={profile.headline ?? ''}
			/>
			{#if fieldError('headline')}<p class="text-sm text-destructive">{fieldError('headline')}</p>{/if}
		</div>

		<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
			<div class="grid min-w-0 gap-0.5">
				<p class="text-xs text-muted-foreground">Предпочтения поиска</p>
				<p class="text-sm font-medium">Роли, формат и занятость, регион, ожидания по зарплате</p>
			</div>
			<a href={resolve('/me/settings')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>Предпочтения</a>
		</div>

		<ProfileFound
			fields={['full_name']}
			{suggestions}
			accountEmail={profile.email}
			problemOf={suggestionProblem}
			{onshow}
		/>
	</SettingsSection>

	<SettingsSection
		title="Контакты"
		panel
		icon={ContactIcon}
		description="Телефон и Telegram — для связи с работодателем. Хранятся зашифрованными и раскрываются компании только с вашего согласия. Почта — адрес входа в учётную запись."
		testId="profile-contacts"
	>
		{#snippet status()}<SaveStatus status={saveState.contacts} />{/snippet}
		{#if saveState.contacts === 'error' && generalProblem}<FormMessage text={generalProblem} />{/if}
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="grid gap-1.5">
				<Label for="phone">Телефон</Label>
				<Input id="phone" name="phone" form={formId} type="tel" autocomplete="tel" value={profile.phone ?? ''} />
				{#if fieldError('phone')}<p class="text-sm text-destructive">{fieldError('phone')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="telegram">Telegram</Label>
				<Input id="telegram" name="telegram" form={formId} placeholder="@name" value={profile.telegram ?? ''} />
				{#if fieldError('telegram')}<p class="text-sm text-destructive">{fieldError('telegram')}</p>{/if}
			</div>
		</div>

		<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3">
			<div class="grid min-w-0 gap-0.5">
				<p class="text-xs text-muted-foreground">Почта</p>
				<p class="truncate text-sm font-medium" title={profile.email} data-testid="profile-email">{profile.email}</p>
			</div>
			<a href={resolve('/account')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>Учётная запись</a>
		</div>

		<ProfileFound
			fields={['phone', 'email', 'telegram']}
			{suggestions}
			accountEmail={profile.email}
			problemOf={suggestionProblem}
			{onshow}
		/>
	</SettingsSection>

	<SettingsSection
		title="Мягкие навыки"
		panel
		icon={HandshakeIcon}
		description="С ваших слов: тест их не проверяет, в подбор они не идут. Видны только в вашем PDF-профиле."
		testId="profile-soft-skills"
	>
		{#snippet status()}<SaveStatus status={saveState.soft} />{/snippet}
		{#if saveState.soft === 'error' && generalProblem}<FormMessage text={generalProblem} />{/if}
		<fieldset class="grid gap-3">
			<legend class="sr-only">Мягкие навыки</legend>
			<p class="text-sm text-muted-foreground">Выбрано {chosenSoftSkills.length} из {maxSoftSkills}</p>
			<div class="flex flex-wrap gap-2">
				{#each softSkills as skill (skill.key)}
					<label
						class="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm has-checked:border-primary has-checked:bg-accent has-disabled:cursor-not-allowed has-disabled:opacity-60"
					>
						<input
							type="checkbox"
							name="soft_skill_keys"
							form={formId}
							value={skill.key}
							class="size-4 accent-primary"
							bind:group={chosenSoftSkills}
							disabled={softFull && !chosenSoftSkills.includes(skill.key)}
						/>
						{skill.name}
					</label>
				{/each}
			</div>
			{#if fieldError('soft_skill_keys')}<p class="text-sm text-destructive">{fieldError('soft_skill_keys')}</p>{/if}
		</fieldset>

		<ProfileFound
			fields={['soft_skill']}
			{suggestions}
			accountEmail={profile.email}
			problemOf={suggestionProblem}
			{onshow}
		/>
	</SettingsSection>

	<!-- The fields above belong to this form by its id; it is sent by their changes, not by a button. -->
	<form
		bind:this={saveForm}
		id={formId}
		method="POST"
		action="?/saveProfile"
		use:enhance={submit}
		class="hidden"
		data-testid="profile-fields-form"
	>
		<CsrfInput />
	</form>
</div>
