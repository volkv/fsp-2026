<script lang="ts">
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const letter = $derived(data.letter);

	/** The text of the letter in pieces: plain text and the links, which open as they would from the mailbox. */
	const pieces = $derived(
		letter.text.split(/(https?:\/\/\S+)/).map((text, index) => ({ text, link: index % 2 === 1 }))
	);
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader title={letter.subject}>
		{#snippet eyebrow()}
			<a href={resolve('/demo/mail')} class="text-link hover:underline">Письма сессии</a>
		{/snippet}
	</PageHeader>

	<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
		<dt class="text-muted-foreground">Кому</dt>
		<dd data-testid="demo-letter-recipient">
			{letter.recipient.kind === 'representative' ? 'Законный представитель' : letter.recipient.name},
			{letter.recipient.address}
		</dd>
		<dt class="text-muted-foreground">Когда</dt>
		<dd>{formatDateTime(letter.at)}</dd>
	</dl>

	{#if letter.status === 'sent'}
		<Alert.Root>
			<Alert.Title>Письмо ушло в почтовый ящик стенда</Alert.Title>
			<Alert.Description>
				{#if letter.recipient.kind === 'representative'}
					Ссылка в письме одноразовая и открывается без входа — так её получил бы представитель.
				{:else}
					Ссылка в письме одноразовая и открывается без входа — так её получил бы владелец учётки.
				{/if}
			</Alert.Description>
		</Alert.Root>
	{:else}
		<Alert.Root>
			<Alert.Title>Письмо было бы отправлено</Alert.Title>
			<Alert.Description>
				У участников демо-сессии нет подключённых каналов, поэтому уведомление показано здесь. Ссылка открывается в
				кабинете получателя — войдите в его роль на странице ролей сессии.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<article class="rounded-lg border p-4 text-sm leading-relaxed whitespace-pre-wrap" data-testid="demo-letter-text">
		{#each pieces as piece, index (index)}{#if piece.link}<a
					href={piece.text}
					rel="external"
					class="break-all text-link underline underline-offset-4"
					data-testid="demo-letter-link">{piece.text}</a
				>{:else}{piece.text}{/if}{/each}
	</article>
</div>
