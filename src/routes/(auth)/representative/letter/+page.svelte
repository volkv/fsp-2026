<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage
	title="Письмо законному представителю"
	description="Пришлём на адрес представителя, полномочия которого проверил оператор ФСП, новое письмо со ссылкой на согласия: по ней недостающие согласия подписываются, а данные — отзываются. Ссылка действует 7 дней."
>
	{#if form?.requested}
		<FormMessage
			tone="success"
			text="Если по этому адресу есть законный представитель с подтверждёнными полномочиями, письмо уже в пути. Повторно его можно запросить через 5 минут. Проверьте и папку «Спам»."
		/>
	{:else}
		<form method="POST" use:enhance class="grid gap-5">
			<CsrfField viewer={data.viewer} />
			<Field.Field>
				<Field.Label for="representative-email">Почта представителя</Field.Label>
				<Input id="representative-email" name="email" type="email" autocomplete="email" required />
			</Field.Field>
			<Button type="submit" size="lg">Прислать письмо</Button>
		</form>
	{/if}
</AuthPage>
