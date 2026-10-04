<script lang="ts">
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { REGISTER_HREF, SIGN_IN_HREF } from '$lib/navigation.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let pending = $state(false);
</script>

<AuthPage title="Вход" description="Спортсменам ФСП удобнее входить через ФСП ID — достижения подтянутся сами.">
	{#if data.notice}
		<FormMessage tone="error" text={data.notice} />
	{/if}

	{#if data.fspEnabled}
		<form method="GET" action={resolve(SIGN_IN_HREF)} data-sveltekit-reload>
			{#if data.returnTo}
				<input type="hidden" name="returnTo" value={data.returnTo} />
			{/if}
			<Button type="submit" size="lg" class="w-full">
				<LogInIcon aria-hidden="true" />
				Войти через ФСП ID
			</Button>
		</form>
		<div class="flex items-center gap-3 text-sm text-muted-foreground">
			<Separator class="flex-1" />
			или по почте
			<Separator class="flex-1" />
		</div>
	{/if}

	<form
		method="POST"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update({ reset: false });
				pending = false;
			};
		}}
		class="grid gap-5"
	>
		<CsrfField viewer={data.viewer} />
		<input type="hidden" name="returnTo" value={data.returnTo ?? ''} />
		{#if form?.message}
			<FormMessage tone="error" text={form.message} />
		{/if}
		<Field.Group>
			<Field.Field>
				<Field.Label for="login-email">Почта</Field.Label>
				<Input id="login-email" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="login-password">Пароль</Field.Label>
				<Input id="login-password" name="password" type="password" autocomplete="current-password" required />
			</Field.Field>
		</Field.Group>
		<Button type="submit" size="lg" disabled={pending}>Войти</Button>
	</form>

	{#snippet footer()}
		<a class="text-link underline underline-offset-4" href={resolve('/password/forgot')}>Забыли пароль?</a>
		<a class="text-link underline underline-offset-4" href={resolve(REGISTER_HREF)}>Зарегистрироваться</a>
	{/snippet}
</AuthPage>
