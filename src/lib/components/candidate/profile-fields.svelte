<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import ProfileSuggestion from './profile-suggestion.svelte';
	import { SUGGESTION_FIELDS, type ProfileSuggestionView, type SuggestionField } from './profile';

	/**
	 * The fields the candidate keeps by hand — the name, the contacts, the headline, the soft skills — and below the
	 * form, by field, what the reading of the resume found for them, with its quote and the decision on it.
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

	const fieldsResult = $derived(result?.target === 'fields' ? result : null);
	const fieldError = (name: string) => fieldsResult?.problem?.fields[name];
	const suggestionProblem = (id: string) =>
		result?.target === `suggestion:${id}` ? (result.problem?.message ?? null) : null;
	const of = (field: SuggestionField) => suggestions.filter((suggestion) => suggestion.field === field);
	const FIELD_ORDER: SuggestionField[] = ['full_name', 'phone', 'email', 'telegram', 'soft_skill'];
	let chosenSoftSkills = $derived<string[]>([...profile.softSkillKeys]);
	const softFull = $derived(chosenSoftSkills.length >= maxSoftSkills);
</script>

<form method="POST" action="?/saveProfile" use:enhance class="grid gap-6" data-testid="profile-fields-form">
	<CsrfInput />
	{#if fieldsResult?.problem}
		<FormMessage text={fieldsResult.problem.message} />
	{:else if fieldsResult && fieldsResult.saved !== undefined}
		<FormMessage tone="success" text={fieldsResult.saved > 0 ? 'Профиль сохранён.' : 'Изменений нет.'} />
	{/if}

	<fieldset class="grid gap-3">
		<legend class="mb-1 font-medium">ФИО</legend>
		<div class="grid gap-3 sm:grid-cols-3">
			<div class="grid gap-1.5">
				<Label for="last-name">Фамилия</Label>
				<Input id="last-name" name="last_name" autocomplete="family-name" value={profile.fullName?.last ?? ''} />
				{#if fieldError('last_name')}<p class="text-sm text-destructive">{fieldError('last_name')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="first-name">Имя</Label>
				<Input id="first-name" name="first_name" autocomplete="given-name" value={profile.fullName?.first ?? ''} />
				{#if fieldError('first_name')}<p class="text-sm text-destructive">{fieldError('first_name')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="middle-name">Отчество</Label>
				<Input
					id="middle-name"
					name="middle_name"
					autocomplete="additional-name"
					value={profile.fullName?.middle ?? ''}
				/>
				{#if fieldError('middle_name')}<p class="text-sm text-destructive">{fieldError('middle_name')}</p>{/if}
			</div>
		</div>
	</fieldset>

	<fieldset class="grid gap-3">
		<legend class="mb-1 font-medium">Контакты</legend>
		<div class="grid gap-3 sm:grid-cols-3">
			<div class="grid gap-1.5">
				<Label for="phone">Телефон</Label>
				<Input id="phone" name="phone" type="tel" autocomplete="tel" value={profile.phone ?? ''} />
				{#if fieldError('phone')}<p class="text-sm text-destructive">{fieldError('phone')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="telegram">Telegram</Label>
				<Input id="telegram" name="telegram" placeholder="@name" value={profile.telegram ?? ''} />
				{#if fieldError('telegram')}<p class="text-sm text-destructive">{fieldError('telegram')}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="email">Почта</Label>
				<Input id="email" value={profile.email} readonly aria-describedby="email-hint" />
				<p id="email-hint" class="text-xs text-muted-foreground">Почта аккаунта: меняется в настройках аккаунта.</p>
			</div>
		</div>
	</fieldset>

	<div class="grid gap-1.5">
		<Label for="headline">Желаемая должность</Label>
		<Input id="headline" name="headline" maxlength={200} value={profile.headline ?? ''} />
		{#if fieldError('headline')}<p class="text-sm text-destructive">{fieldError('headline')}</p>{/if}
	</div>

	<fieldset class="grid gap-3">
		<legend class="mb-1 font-medium">Мягкие навыки</legend>
		<p class="text-sm text-muted-foreground">
			С ваших слов: тест их не проверяет, в подбор они не идут. Видны только в вашем PDF-профиле. До {maxSoftSkills}.
		</p>
		<div class="flex flex-wrap gap-2">
			{#each softSkills as skill (skill.key)}
				<label
					class="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm has-checked:border-primary has-checked:bg-accent has-disabled:cursor-not-allowed has-disabled:opacity-60"
				>
					<input
						type="checkbox"
						name="soft_skill_keys"
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

	<Button type="submit" class="justify-self-start">Сохранить</Button>
</form>

{#if suggestions.length > 0}
	<section class="grid gap-4 border-t pt-4" aria-labelledby="found-title" data-testid="profile-suggestions">
		<div class="grid gap-1">
			<h3 id="found-title" class="font-medium">Найдено в резюме</h3>
			<p class="text-sm text-muted-foreground">
				Каждое значение — с цитатой из файла. Принятое значение записывается в поле, как если бы вы ввели его сами;
				поправить его можно в форме выше.
			</p>
		</div>
		{#each FIELD_ORDER as field (field)}
			{#if of(field).length > 0}
				<div class="grid gap-2">
					<span class="text-sm font-medium">{SUGGESTION_FIELDS[field]}</span>
					<ul class="grid gap-2 sm:grid-cols-2">
						{#each of(field) as suggestion (suggestion.id)}
							<ProfileSuggestion
								{suggestion}
								accountEmail={profile.email}
								problem={suggestionProblem(suggestion.id)}
								{onshow}
							/>
						{/each}
					</ul>
				</div>
			{/if}
		{/each}
	</section>
{/if}
