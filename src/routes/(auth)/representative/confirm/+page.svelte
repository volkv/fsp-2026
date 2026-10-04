<script lang="ts">
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage title="Контакт законного представителя">
	{#if form?.confirmed}
		<FormMessage
			tone="success"
			text="Адрес подтверждён. Оператор ФСП свяжется с вами, чтобы проверить полномочия по документу; до этого профиль несовершеннолетнего остаётся скрытым."
		/>
	{:else if data.usable && form?.confirmed !== false}
		<p>
			Подтвердите, что этот адрес ваш и вы — законный представитель кандидата. Это не подпись согласия: согласие вы
			дадите после проверки полномочий.
		</p>
		<form method="POST">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="token" value={data.token} />
			<Button type="submit" size="lg">Подтвердить адрес</Button>
		</form>
	{:else}
		<FormMessage tone="error" text="Ссылка недействительна: она устарела или уже использована." />
	{/if}
</AuthPage>
