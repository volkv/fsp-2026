<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { ManualExperienceEntry } from './profile';
	import SkillPicker from './skill-picker.svelte';

	/** A place of work stated by hand: a new one (`entry` is `null`) or the edit of one; it is shown in a dialog. */
	let {
		entry,
		target,
		skills,
		roles,
		problem,
		ondone
	}: {
		entry: ManualExperienceEntry | null;
		/** The target of the answers of this form: `experience:new` or `experience:<id>`. */
		target: string;
		skills: { key: string; name: string }[];
		roles: { key: string; name: string }[];
		problem: { message: string; fields: Record<string, string> } | null;
		/** Called once the form is saved, and on «Отмена». */
		ondone: () => void;
	} = $props();

	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
</script>

<form
	method="POST"
	action={entry === null ? '?/addExperience' : '?/updateExperience'}
	use:enhance={() =>
		async ({ result: answer, update }) => {
			await update({ reset: entry === null });
			if (answer.type === 'success') ondone();
		}}
	class="grid gap-3"
	data-testid={entry === null ? 'experience-add' : 'experience-edit'}
>
	<CsrfInput />
	{#if entry !== null}<input type="hidden" name="entry_id" value={entry.id} />{/if}
	{#if problem}<FormMessage text={problem.message} />{/if}
	<div class="grid gap-3 sm:grid-cols-2">
		<div class="grid gap-1.5">
			<Label for="{target}-title">Должность</Label>
			<Input id="{target}-title" name="position_title" required maxlength={200} value={entry?.positionTitle ?? ''} />
			{#if problem?.fields.position_title}<p class="text-sm text-destructive">{problem.fields.position_title}</p>{/if}
		</div>
		<div class="grid gap-1.5">
			<Label for="{target}-organization">Компания</Label>
			<Input
				id="{target}-organization"
				name="organization_name"
				maxlength={200}
				value={entry?.organizationName ?? ''}
			/>
		</div>
		<div class="grid gap-1.5">
			<Label for="{target}-role">Роль</Label>
			<select id="{target}-role" name="role_key" class={selectClass}>
				<option value="" selected={entry?.roleKey == null}>Не выбрана</option>
				{#each roles as role (role.key)}
					<option value={role.key} selected={entry?.roleKey === role.key}>{role.name}</option>
				{/each}
			</select>
			{#if problem?.fields.role_key}<p class="text-sm text-destructive">{problem.fields.role_key}</p>{/if}
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div class="grid gap-1.5">
				<Label for="{target}-from">Начало</Label>
				<Input id="{target}-from" name="period_from" type="month" required value={entry?.periodFrom ?? ''} />
				{#if problem?.fields.period_from}<p class="text-sm text-destructive">{problem.fields.period_from}</p>{/if}
			</div>
			<div class="grid gap-1.5">
				<Label for="{target}-to">Окончание</Label>
				<Input id="{target}-to" name="period_to" type="month" value={entry?.periodTo ?? ''} />
				{#if problem?.fields.period_to}<p class="text-sm text-destructive">{problem.fields.period_to}</p>{/if}
			</div>
		</div>
	</div>
	<label class="flex items-center gap-2 text-sm">
		<input type="checkbox" name="is_current" class="size-4 accent-primary" checked={entry?.isCurrent ?? false} />
		Работаю сейчас
	</label>
	<SkillPicker {skills} name="skill_keys" chosen={entry?.skillKeys ?? []} max={30} label="Стек на этой работе" />
	{#if problem?.fields.skill_keys}<p class="text-sm text-destructive">{problem.fields.skill_keys}</p>{/if}
	<div class="grid gap-1.5">
		<Label for="{target}-description">Чем занимались</Label>
		<Textarea id="{target}-description" name="description" maxlength={1000} rows={3} value={entry?.description ?? ''} />
	</div>
	<div class="flex flex-wrap justify-end gap-2">
		<Button type="button" variant="outline" onclick={ondone}>Отмена</Button>
		<Button type="submit">{entry === null ? 'Добавить' : 'Сохранить'}</Button>
	</div>
</form>
