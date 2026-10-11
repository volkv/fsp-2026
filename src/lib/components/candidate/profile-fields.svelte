<script lang="ts">
	import ContactIcon from '@lucide/svelte/icons/contact';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import UserIcon from '@lucide/svelte/icons/user';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ProfileFound from './profile-found.svelte';
	import AutosaveInput, { type SaveState } from './autosave-input.svelte';
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

	/** The fields saved on their own; the soft skills are one field of the form. */
	type Field = 'last_name' | 'first_name' | 'middle_name' | 'headline' | 'phone' | 'telegram' | 'soft_skill_keys';
	const FIELDS: readonly string[] = [
		'last_name',
		'first_name',
		'middle_name',
		'headline',
		'phone',
		'telegram',
		'soft_skill_keys'
	] satisfies Field[];
	const isField = (name: string): name is Field => FIELDS.includes(name);
	const NAME_FIELDS: Field[] = ['last_name', 'first_name', 'middle_name'];
	const SAVED_SHOWN_MS = 2000;
	/** A save faster than this still shows its spinner that long, so that it is seen. */
	const SAVING_SHOWN_MS = 500;
	const SOFT_SKILLS_DELAY_MS = 600;

	let fieldState = $state<Record<Field, SaveState>>({
		last_name: 'idle',
		first_name: 'idle',
		middle_name: 'idle',
		headline: 'idle',
		phone: 'idle',
		telegram: 'idle',
		soft_skill_keys: 'idle'
	});
	let saveForm = $state<HTMLFormElement>();
	let nameGroup = $state<HTMLFieldSetElement>();
	// Bookkeeping of the queue, not shown: what changed since the last save and what the save in flight carries.
	let queued: Field[] = [];
	let inFlight: Field[] = [];
	let nameChanged: Field[] = [];
	let saving = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const savedAt: Partial<Record<Field, number>> = {};

	function schedule(fields: Field[], delay: number) {
		for (const field of fields) if (!queued.includes(field)) queued.push(field);
		clearTimeout(timer);
		timer = setTimeout(flush, delay);
	}

	function flush() {
		if (saving || queued.length === 0) return;
		inFlight = queued;
		queued = [];
		for (const field of inFlight) fieldState[field] = 'saving';
		saveForm?.requestSubmit();
	}

	/** A field changed and lost focus, or a soft skill was picked; the name waits for the focus to leave its fields. */
	function changed(event: Event) {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || !isField(input.name)) return;
		const field = input.name;
		if (NAME_FIELDS.includes(field)) {
			if (!nameChanged.includes(field)) nameChanged.push(field);
			return;
		}
		schedule([field], input.type === 'checkbox' ? SOFT_SKILLS_DELAY_MS : 0);
	}

	function nameFocusOut(event: FocusEvent) {
		if (nameChanged.length === 0) return;
		if (event.relatedTarget instanceof Node && nameGroup?.contains(event.relatedTarget)) return;
		const fields = nameChanged;
		nameChanged = [];
		schedule(fields, 0);
	}

	function showSaved(field: Field, now: number) {
		fieldState[field] = 'saved';
		savedAt[field] = now;
		setTimeout(() => {
			if (fieldState[field] === 'saved' && now === savedAt[field]) fieldState[field] = 'idle';
		}, SAVED_SHOWN_MS);
	}

	const submit: SubmitFunction = () => {
		saving = true;
		const started = Date.now();
		// Enter in a field sends the form at once, past the queue: it saves that field.
		if (inFlight.length === 0) {
			const active = document.activeElement;
			const field = active instanceof HTMLInputElement && isField(active.name) ? active.name : null;
			inFlight = field === null ? [] : NAME_FIELDS.includes(field) ? [...NAME_FIELDS] : [field];
			for (const each of inFlight) fieldState[each] = 'saving';
		}
		return async ({ result: answer, update }) => {
			await update({ reset: false, invalidateAll: true });
			const shown = Date.now() - started;
			if (shown < SAVING_SHOWN_MS) await new Promise((done) => setTimeout(done, SAVING_SHOWN_MS - shown));
			const now = Date.now();
			if (answer.type === 'success') {
				for (const field of inFlight) showSaved(field, now);
			} else {
				// A refused save keeps nothing. A field with a problem shows it; the others go with the next save.
				const problem =
					answer.type === 'failure'
						? (answer.data?.problem as { message: string; fields: Record<string, string> } | undefined)
						: undefined;
				const refused = Object.keys(problem?.fields ?? {}).filter(isField);
				for (const field of inFlight) {
					if (refused.length === 0 || refused.includes(field)) fieldState[field] = 'error';
					else {
						fieldState[field] = 'idle';
						if (!queued.includes(field)) queued.push(field);
					}
				}
				if (refused.length === 0) toast.error(problem?.message ?? 'Не удалось сохранить профиль. Повторите.');
			}
			inFlight = [];
			saving = false;
			if (answer.type === 'success') flush();
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
		<fieldset class="grid gap-3" bind:this={nameGroup} onfocusout={nameFocusOut}>
			<legend class="sr-only">ФИО</legend>
			<div class="grid gap-3 sm:grid-cols-3">
				<div class="grid gap-1.5">
					<Label for="last-name">Фамилия</Label>
					<AutosaveInput
						id="last-name"
						name="last_name"
						form={formId}
						autocomplete="family-name"
						value={profile.fullName?.last ?? ''}
						status={fieldState.last_name}
					/>
					{#if fieldError('last_name')}<p class="text-sm text-destructive">{fieldError('last_name')}</p>{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="first-name">Имя</Label>
					<AutosaveInput
						id="first-name"
						name="first_name"
						form={formId}
						autocomplete="given-name"
						value={profile.fullName?.first ?? ''}
						status={fieldState.first_name}
					/>
					{#if fieldError('first_name')}<p class="text-sm text-destructive">{fieldError('first_name')}</p>{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="middle-name">Отчество</Label>
					<AutosaveInput
						id="middle-name"
						name="middle_name"
						form={formId}
						autocomplete="additional-name"
						value={profile.fullName?.middle ?? ''}
						status={fieldState.middle_name}
					/>
					{#if fieldError('middle_name')}<p class="text-sm text-destructive">{fieldError('middle_name')}</p>{/if}
				</div>
			</div>
		</fieldset>

		<div class="grid gap-1.5">
			<Label for="headline">Желаемая должность</Label>
			<AutosaveInput
				id="headline"
				name="headline"
				form={formId}
				maxlength={200}
				placeholder="Например, бэкенд-разработчик"
				value={profile.headline ?? ''}
				status={fieldState.headline}
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
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="grid gap-1.5">
				<Label for="phone">Телефон</Label>
				<AutosaveInput
					id="phone"
					name="phone"
					form={formId}
					type="tel"
					autocomplete="tel"
					value={profile.phone ?? ''}
					status={fieldState.phone}
				/>
				{#if fieldError('phone')}<p class="text-sm text-destructive">{fieldError('phone')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="telegram">Telegram</Label>
				<AutosaveInput
					id="telegram"
					name="telegram"
					form={formId}
					placeholder="@name"
					value={profile.telegram ?? ''}
					status={fieldState.telegram}
				/>
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
		<fieldset class="grid gap-3">
			<legend class="sr-only">Мягкие навыки</legend>
			<p class="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
				Выбрано {chosenSoftSkills.length} из {maxSoftSkills}
				<SaveStatus status={fieldState.soft_skill_keys} />
			</p>
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
