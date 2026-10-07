<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader
		title="Письма сессии"
		description={data.scope === 'all'
			? 'Что ваша демо-сессия отправила по почте: подтверждение почты и сброс пароля зарегистрированных в ней учёток, письма законному представителю подростка со ссылками подписания и уведомления участников. Почтовый ящик стенда не открывается снаружи — письма здесь.'
			: 'Письма учёткам, зарегистрированным в вашей демо-сессии, — подтверждение почты и сброс пароля: почтовый ящик стенда не открывается снаружи, поэтому письмо здесь. Остальные письма сессии видны после входа в неё.'}
	>
		{#snippet actions()}
			<a href={resolve('/demo')} class={buttonVariants({ variant: 'outline' })}>К ролям сессии</a>
		{/snippet}
	</PageHeader>

	{#if data.letters.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><MailIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Писем пока нет</Empty.Title>
				<Empty.Description>
					{#if data.scope === 'all'}
						Они появятся, когда вы зарегистрируете учётку в этой сессии, оператор подтвердит полномочия представителя,
						подросток примет приглашение или участникам придёт уведомление.
					{:else}
						Письмо появится здесь, когда вы зарегистрируете учётку в этой демо-сессии или запросите сброс её пароля.
					{/if}
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<ul class="grid gap-2" data-testid="demo-letter-list">
			{#each data.letters as letter (letter.id)}
				<li>
					<a
						href={resolve('/(app)/demo/mail/[id]', { id: letter.id })}
						class="grid gap-1 rounded-lg border p-3 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
						data-testid="demo-letter"
						data-status={letter.status}
					>
						<span class="flex flex-wrap items-center gap-2">
							<span class="text-sm font-semibold">{letter.subject}</span>
							{#if letter.status === 'sent'}
								<Badge variant="secondary">Отправлено</Badge>
							{:else}
								<Badge variant="outline">Было бы отправлено</Badge>
							{/if}
						</span>
						<span class="text-xs text-muted-foreground">
							{letter.recipient.kind === 'representative' ? 'Законному представителю' : letter.recipient.name} · {letter
								.recipient.address} · {formatDateTime(letter.at)}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
