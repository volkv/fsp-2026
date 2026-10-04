<script lang="ts">
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { SIGN_IN_HREF } from '$lib/navigation.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage
	title="Подтвердите вход"
	description="Привязка и отвязка ФСП ID и смена пароля требуют входа не старше 10 минут."
>
	{#if data.hasPassword}
		<form method="POST" use:enhance class="grid gap-5">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="returnTo" value={data.returnTo} />
			{#if form?.message}
				<FormMessage tone="error" text={form.message} />
			{/if}
			<Field.Field>
				<Field.Label for="reauth-password">Пароль</Field.Label>
				<Input id="reauth-password" name="password" type="password" autocomplete="current-password" required />
			</Field.Field>
			<Button type="submit" size="lg">Подтвердить</Button>
		</form>
	{/if}
	{#if data.fspEnabled}
		<!-- A GET form, not a link: the query carries the return path; the page reloads into the provider. -->
		<form method="GET" action={resolve(SIGN_IN_HREF)} data-sveltekit-reload>
			<input type="hidden" name="reauth" value="1" />
			<input type="hidden" name="returnTo" value={data.returnTo} />
			<Button type="submit" variant={data.hasPassword ? 'outline' : 'default'} size="lg" class="w-full">
				<LogInIcon aria-hidden="true" />
				Подтвердить через ФСП ID
			</Button>
		</form>
	{/if}
</AuthPage>
