<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Приглашение в команду — ФСП | Карьера</title>
</svelte:head>

<div class="mx-auto w-full max-w-lg px-4 py-10 sm:px-6 sm:py-14">
	<Card.Root>
		<Card.Header>
			<Card.Title class="font-heading text-h2"><h1>Приглашение в команду компании</h1></Card.Title>
			<Card.Description class="text-base">
				Вступить можно под адресом, на который пришло письмо. Учётная запись кандидата и участие в другой компании с
				этим не совмещаются.
			</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-4">
			{#if form?.problem}
				<FormMessage text={form.problem.message} />
			{/if}
			{#if data.token === ''}
				<FormMessage text="В ссылке нет кода приглашения. Откройте ссылку из письма целиком." />
			{:else}
				<form method="POST" action="?/accept" use:enhance>
					<CsrfInput />
					<input type="hidden" name="token" value={data.token} />
					<Button type="submit">Вступить в команду</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
