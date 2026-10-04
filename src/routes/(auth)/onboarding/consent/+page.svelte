<script lang="ts">
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage
	title="Согласие на обработку персональных данных"
	description="Отдельное согласие: без него профиль не ведётся. Отозвать его можно в любой момент в настройках."
	width="wide"
>
	{#if form?.message}
		<FormMessage tone="error" text={form.message} />
	{/if}
	{#if data.document}
		<section aria-labelledby="consent-title" class="grid gap-3">
			<h2 id="consent-title" class="font-heading text-h3">
				{data.document.title} <span class="text-sm text-muted-foreground">· редакция {data.document.version}</span>
			</h2>
			<div
				class="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed whitespace-pre-line"
				data-testid="consent-text"
			>
				{data.document.body}
			</div>
		</section>
		{#if data.minor}
			<p class="text-sm text-muted-foreground">
				Вам меньше 18 лет: согласие вступит в силу, когда его подпишет и законный представитель. До этого профиль скрыт
				от работодателей.
			</p>
		{/if}
		<form method="POST" class="flex flex-wrap gap-3">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="documentId" value={data.document.id} />
			<Button type="submit" size="lg">Даю согласие</Button>
			<a href={resolve('/onboarding')} class={buttonVariants({ variant: 'outline', size: 'lg' })}>Не сейчас</a>
		</form>
	{:else}
		<FormMessage tone="error" text="Текст согласия ещё не опубликован. Вернитесь к этому шагу позже." />
	{/if}
</AuthPage>
