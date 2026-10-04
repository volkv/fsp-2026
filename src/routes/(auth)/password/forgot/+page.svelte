<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { LOGIN_HREF } from '$lib/navigation.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage title="Восстановление пароля" description="Пришлём письмо со ссылкой: она действует 1 час.">
	{#if form?.requested}
		{#if form.inDemoSession}
			<div class="grid gap-3" data-testid="forgot-demo-session">
				<FormMessage
					tone="success"
					text="Если адрес зарегистрирован в вашей демо-сессии, письмо со ссылкой — в «Письмах сессии»: почтовый ящик стенда не открывается снаружи. Учётке вне демо-сессии письмо ушло на её почту."
				/>
				<a class="text-link underline underline-offset-4" href={resolve('/demo/mail')}>Открыть письма сессии</a>
			</div>
		{:else}
			<FormMessage tone="success" text="Если адрес зарегистрирован, письмо уже в пути. Проверьте и папку «Спам»." />
		{/if}
	{:else}
		<form method="POST" use:enhance class="grid gap-5">
			<CsrfField viewer={data.viewer} />
			<Field.Field>
				<Field.Label for="forgot-email">Почта</Field.Label>
				<Input id="forgot-email" name="email" type="email" autocomplete="email" required />
			</Field.Field>
			<Button type="submit" size="lg">Отправить ссылку</Button>
		</form>
	{/if}

	{#snippet footer()}
		<a class="text-link underline underline-offset-4" href={resolve(LOGIN_HREF)}>Вернуться ко входу</a>
	{/snippet}
</AuthPage>
