<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { LOGIN_HREF } from '$lib/navigation.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage title="Новый пароль" description="После смены все открытые сеансы завершатся.">
	{#if form && 'reset' in form}
		<FormMessage tone="success" text="Пароль изменён. Войдите с новым паролем." />
		<a href={resolve(LOGIN_HREF)} class={buttonVariants({ size: 'lg' })}>Войти</a>
	{:else if data.usable}
		<form method="POST" use:enhance class="grid gap-5">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="token" value={data.token} />
			{#if form?.message}
				<FormMessage tone="error" text={form.message} />
			{/if}
			<Field.Group>
				<Field.Field>
					<Field.Label for="reset-password">Новый пароль</Field.Label>
					<Input id="reset-password" name="password" type="password" autocomplete="new-password" required />
					<Field.Description>Не короче 10 символов.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="reset-repeat">Ещё раз</Field.Label>
					<Input id="reset-repeat" name="repeat" type="password" autocomplete="new-password" required />
				</Field.Field>
			</Field.Group>
			<Button type="submit" size="lg">Сохранить пароль</Button>
		</form>
	{:else}
		<FormMessage tone="error" text="Ссылка недействительна: она устарела или уже использована. Запросите новую." />
		<a href={resolve('/password/forgot')} class={buttonVariants({ variant: 'outline' })}>Запросить ссылку</a>
	{/if}
</AuthPage>
