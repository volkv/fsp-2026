<script lang="ts">
	import ContactIcon from '@lucide/svelte/icons/contact';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import UserIcon from '@lucide/svelte/icons/user';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ProfileFound from './profile-found.svelte';
	import SettingsSection from './settings-section.svelte';
	import type { ProfileSuggestionView } from './profile';

	/**
	 * The fields the candidate keeps by hand, in three sections — the basics (the name and the headline), the contacts,
	 * the soft skills — and in each, by field, what the reading of the resume found for it, with its quote and the
	 * decision on it. The fields of the three sections are saved together by one form: a decision on a found value is
	 * a form of its own, and forms do not nest, so the fields belong to the form by its id.
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
</script>

<div class="grid" data-testid="profile-fields">
	<SettingsSection
		title="Основное"
		icon={UserIcon}
		description="Как к вам обращаться и какую работу вы ищете. Заполните вручную или примите найденное в резюме. ФИО хранится зашифрованным: компания видит его только после вашего согласия на раскрытие."
		testId="profile-basics"
	>
		<fieldset class="grid gap-3">
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
		icon={ContactIcon}
		description="Телефон и Telegram — для связи с работодателем. Хранятся зашифрованными и раскрываются компании только с вашего согласия. Почта — адрес входа в учётную запись."
		testId="profile-contacts"
	>
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
		icon={HandshakeIcon}
		description="С ваших слов: тест их не проверяет, в подбор они не идут. Видны только в вашем PDF-профиле."
		testId="profile-soft-skills"
	>
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

	<!-- One bar saves the three sections above; it stays in sight while any of them is on the screen. -->
	<div class="pointer-events-none sticky bottom-4 z-10 grid lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] lg:gap-x-12">
		<form
			id={formId}
			method="POST"
			action="?/saveProfile"
			use:enhance
			class="pointer-events-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur lg:col-start-2"
			data-testid="profile-fields-form"
		>
			<CsrfInput />
			{#if fieldsResult?.problem}
				<FormMessage class="min-w-0 flex-1 py-2" text={fieldsResult.problem.message} />
			{:else if fieldsResult && fieldsResult.saved !== undefined}
				<FormMessage
					class="min-w-0 flex-1 py-2"
					tone="success"
					text={fieldsResult.saved > 0 ? 'Профиль сохранён.' : 'Изменений нет.'}
				/>
			{:else}
				<p class="min-w-0 flex-1 px-1 text-sm text-muted-foreground">
					Основное, контакты и мягкие навыки сохраняются вместе.
				</p>
			{/if}
			<Button type="submit">Сохранить</Button>
		</form>
	</div>
</div>
