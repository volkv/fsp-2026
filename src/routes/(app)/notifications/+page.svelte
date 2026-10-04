<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { NOTIFICATION_CATEGORIES } from '$lib/components/candidate/model.js';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { cn } from '$lib/components/utils.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const inbox = $derived(data.inbox);
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader
		title="Уведомления"
		description="В Telegram — только вид события и ссылка сюда, без имён, компаний и сумм. Письмо называет компанию и вакансию, о которых оно, но не суммы и не личные данные другой стороны: кандидат в письмах компании — псевдоним."
	>
		{#snippet actions()}
			<a href={resolve('/account/notifications')} class={buttonVariants({ variant: 'outline' })}>Настройки</a>
			{#if inbox.unread > 0}
				<form method="POST" action="?/readAll" use:enhance>
					<CsrfInput />
					<Button type="submit" variant="outline">Прочитать все</Button>
				</form>
			{/if}
		{/snippet}
	</PageHeader>

	{#if inbox.items.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><BellIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Уведомлений нет</Empty.Title>
				<Empty.Description>Здесь появятся приглашения, изменения условий и сроки ответа.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<p class="text-sm text-muted-foreground" data-testid="unread-count">Непрочитанных: {inbox.unread}</p>
		<ul class="grid gap-2" data-testid="notification-list">
			{#each inbox.items as item (item.id)}
				<li>
					<a
						href={resolve('/(app)/notifications/[id]', { id: item.id })}
						data-sveltekit-preload-data="off"
						class={cn(
							'flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
							item.readAt === null && 'border-primary/40 bg-accent/40'
						)}
						data-read={item.readAt !== null}
					>
						<span class="grid gap-0.5">
							<span class={cn('text-sm', item.readAt === null && 'font-semibold')}>{item.title}</span>
							<span class="text-xs text-muted-foreground">
								{NOTIFICATION_CATEGORIES[item.category]?.label ?? item.category} · {formatDateTime(item.createdAt)}
							</span>
						</span>
						{#if item.readAt === null}
							<span class="size-2 shrink-0 rounded-full bg-primary" aria-label="не прочитано"></span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
		<div class="flex gap-3">
			{#if data.cursor}
				<a href={resolve('/notifications')} class={buttonVariants({ variant: 'outline' })}>К новым</a>
			{/if}
			{#if inbox.nextCursor}
				<a
					href="{resolve('/notifications')}?cursor={encodeURIComponent(inbox.nextCursor)}"
					class={buttonVariants({ variant: 'outline' })}>Раньше</a
				>
			{/if}
		</div>
	{/if}
</div>
