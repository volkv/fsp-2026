<script lang="ts">
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { LOGIN_HREF, ONBOARDING_HREF } from '$lib/navigation.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage title="Подтверждение почты">
	{#if form?.verified}
		<FormMessage tone="success" text="Почта подтверждена." />
		<a href={resolve(data.viewer ? ONBOARDING_HREF : LOGIN_HREF)} class={buttonVariants({ size: 'lg' })}>
			{data.viewer ? 'Продолжить регистрацию' : 'Войти'}
		</a>
	{:else if data.usable && form?.verified !== false}
		<p>Нажмите кнопку, чтобы подтвердить, что адрес ваш.</p>
		<form method="POST">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="token" value={data.token} />
			<Button type="submit" size="lg">Подтвердить почту</Button>
		</form>
	{:else}
		<FormMessage
			tone="error"
			text="Ссылка недействительна: она устарела, уже использована или скопирована не полностью. Запросите новое письмо на странице регистрации."
		/>
		<a href={resolve(data.viewer ? ONBOARDING_HREF : LOGIN_HREF)} class={buttonVariants({ variant: 'outline' })}>
			{data.viewer ? 'К шагам регистрации' : 'Войти'}
		</a>
	{/if}
</AuthPage>
