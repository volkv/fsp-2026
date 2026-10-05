<script lang="ts">
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let pending = $state(false);
	const id = $props.id();
</script>

<AuthPage
	title="Своё резюме в демо-сессии"
	description="Посмотрите, как платформа разберёт ваше резюме: оно заменит резюме героя в вашей копии профиля."
	width="wide"
>
	{#if !data.candidate}
		<FormMessage
			tone="error"
			text="Своё резюме загружается в профиль кандидата-героя вашей демо-сессии. Откройте демо и войдите как кандидат."
		/>
		<a href={resolve('/demo')} class={buttonVariants({ class: 'w-fit' })}>К выбору роли</a>
	{:else}
		<p class="text-sm" data-testid="own-resume-term">
			Резюме и всё, что из него получено, удалится вместе с демо-сессией: через {data.ownResumeHours} ч после загрузки, после
			{data.idleHours} ч без действий в сессии{data.nightlyReset ? ' или при ночном сбросе стенда' : ''} — не позже {data.endsAt
				? formatDateTime(data.endsAt)
				: ''}.
		</p>

		<article
			class="rounded-lg border p-4 text-sm leading-relaxed whitespace-pre-line"
			aria-label="{data.document.title}, редакция {data.document.version}"
			data-testid="document-body"
		>
			{data.document.body}
		</article>

		<form
			method="POST"
			enctype="multipart/form-data"
			class="grid gap-4"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
				};
			}}
		>
			<CsrfField />
			{#if form?.problem}
				<FormMessage tone="error" text={form.problem.message} />
			{/if}
			<input type="hidden" name="document" value={data.document.id} />
			<label class="flex items-start gap-3 text-sm">
				<input type="checkbox" name="agree" required class="mt-0.5 size-4 accent-primary" />
				<span>Даю {data.document.title.toLowerCase()} (редакция {data.document.version})</span>
			</label>
			<div class="grid gap-1.5 text-sm">
				<label for="{id}-file" class="font-medium">Файл резюме</label>
				<Input
					id="{id}-file"
					type="file"
					name="file"
					accept=".pdf,.docx,.doc,.rtf,.odt,.txt,.png,.jpg,.jpeg"
					required
				/>
				<p class="text-muted-foreground">PDF или DOCX до 10 МиБ.</p>
			</div>
			<Button type="submit" class="w-fit" disabled={pending}>
				<UploadIcon aria-hidden="true" />
				{pending ? 'Загружаем…' : 'Согласиться и загрузить'}
			</Button>
		</form>
	{/if}
</AuthPage>
