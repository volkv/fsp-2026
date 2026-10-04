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
	title="Достижения из ФСП"
	description="Отдельное согласие на получение результатов соревнований, разрядов и членства в сборной из систем ФСП."
	width="wide"
>
	{#if form?.message}
		<FormMessage tone="error" text={form.message} />
	{/if}
	<section aria-labelledby="import-title" class="grid gap-3">
		<h2 id="import-title" class="font-heading text-h3">
			{data.document.title} <span class="text-sm text-muted-foreground">· редакция {data.document.version}</span>
		</h2>
		<div
			class="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed whitespace-pre-line"
			data-testid="consent-text"
		>
			{data.document.body}
		</div>
	</section>
	<form method="POST" class="flex flex-wrap gap-3">
		<CsrfField viewer={data.viewer} />
		<input type="hidden" name="documentId" value={data.document.id} />
		<Button type="submit" size="lg">Даю согласие и подтверждаю</Button>
		<a href={resolve('/account')} class={buttonVariants({ variant: 'outline', size: 'lg' })}>Отмена</a>
	</form>
</AuthPage>
