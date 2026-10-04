<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { NOTIFICATION_CATEGORIES } from '$lib/components/candidate/model.js';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const settings = $derived(data.settings);
	const consent = $derived(data.telegramConsent);
	const telegramActive = $derived(settings.channels.telegram === 'active');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const link = $derived(form && 'telegramLink' in form ? form.telegramLink : null);

	const TELEGRAM_STATES = {
		active: { label: 'Привязан', tone: 'success' },
		not_linked: { label: 'Не привязан', tone: 'neutral' },
		unlinked: { label: 'Отвязан', tone: 'neutral' },
		blocked_by_user: { label: 'Бот заблокирован в Telegram', tone: 'warning' }
	} as const;
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader
		title="Настройки уведомлений"
		description="Уведомления всегда есть в интерфейсе. Почта и Telegram — дополнительные каналы: в Telegram уходит только вид события и ссылка, а письмо называет компанию и вакансию, о которых оно, — без сумм и личных данных другой стороны."
	>
		{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/notifications')}>Уведомления</a
			>{/snippet}
	</PageHeader>

	{#if problem}
		<FormMessage text={problem.message} />
	{:else if form && 'channelsSaved' in form}
		<FormMessage tone="success" text="Каналы сохранены." />
	{:else if form && 'consentGiven' in form}
		<FormMessage tone="success" text="Согласие дано: теперь можно привязать Telegram." />
	{:else if form && 'consentRevoked' in form}
		<FormMessage
			tone="success"
			text="Согласие отозвано, Telegram отвязан. Уведомления остаются в интерфейсе и на почте."
		/>
	{:else if form && 'telegramUnlinked' in form}
		<FormMessage tone="success" text="Telegram отвязан." />
	{/if}

	<SectionCard title="Каналы по темам" testId="channel-settings">
		<form method="POST" action="?/channels" use:enhance class="grid gap-4">
			<CsrfInput />
			<table class="w-full text-sm">
				<caption class="sr-only">Каналы уведомлений по темам</caption>
				<thead>
					<tr class="border-b text-left text-muted-foreground">
						<th scope="col" class="py-2 pr-3 font-medium">Тема</th>
						<th scope="col" class="w-24 py-2 pr-3 text-center font-medium">Почта</th>
						<th scope="col" class="w-24 py-2 text-center font-medium">Telegram</th>
					</tr>
				</thead>
				<tbody>
					{#each settings.categories as item (item.category)}
						{@const meta = NOTIFICATION_CATEGORIES[item.category]}
						<tr class="border-b last:border-0">
							<th scope="row" class="py-2 pr-3 text-left font-normal">
								<span class="block font-medium">{meta?.label ?? item.category}</span>
								<span class="block text-xs text-muted-foreground">{meta?.hint ?? ''}</span>
							</th>
							<td class="py-2 pr-3 text-center">
								{#if item.required.includes('email')}
									<input type="hidden" name="channel_{item.category}" value="email" />
								{/if}
								<input
									type="checkbox"
									name="channel_{item.category}"
									value="email"
									class="size-4 accent-primary"
									checked={item.channels.includes('email')}
									disabled={item.required.includes('email')}
									aria-label="{meta?.label ?? item.category}: почта"
								/>
							</td>
							<td class="py-2 text-center">
								<input
									type="checkbox"
									name="channel_{item.category}"
									value="telegram"
									class="size-4 accent-primary"
									checked={item.channels.includes('telegram')}
									aria-label="{meta?.label ?? item.category}: Telegram"
								/>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="text-xs text-muted-foreground">
				Telegram получает уведомления, только пока он привязан и действует согласие на этот канал.
			</p>
			<Button type="submit" variant="outline" class="justify-self-start">Сохранить каналы</Button>
		</form>
	</SectionCard>

	<SectionCard
		title="Telegram"
		description="В Telegram не отправляем имён, компаний и сумм — только «новое приглашение» и ссылку."
		testId="telegram"
	>
		{#snippet actions()}
			<StatusPill
				label={TELEGRAM_STATES[settings.channels.telegram].label}
				tone={TELEGRAM_STATES[settings.channels.telegram].tone}
			/>
		{/snippet}
		{#if !settings.channels.telegramAvailable}
			<p class="text-sm text-muted-foreground">Telegram на этой установке не подключён.</p>
		{:else if !consent}
			<p class="text-sm text-muted-foreground">
				Уведомления в Telegram сейчас доступны профилю кандидата: канал держится на его отдельном согласии.
			</p>
		{:else if !consent.subjectGranted}
			{#if consent.text}
				<form method="POST" action="?/telegramConsent" use:enhance class="grid gap-3">
					<CsrfInput />
					<input type="hidden" name="documentId" value={consent.text.id} />
					<details class="rounded-lg border text-sm" open>
						<summary class="cursor-pointer px-3 py-2 font-medium">
							{consent.text.title} · редакция {consent.text.version}
						</summary>
						<div class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line">{consent.text.body}</div>
					</details>
					<Button type="submit" class="justify-self-start">Даю согласие на уведомления в Telegram</Button>
				</form>
			{:else}
				<p class="text-sm text-muted-foreground">Текст согласия на Telegram не опубликован.</p>
			{/if}
		{:else}
			{#if !consent.effective}
				<p class="text-sm text-muted-foreground">Согласие вступит в силу вместе с согласием законного представителя.</p>
			{/if}
			<div class="flex flex-wrap gap-3">
				{#if !telegramActive && consent.effective}
					<form method="POST" action="?/telegramLink" use:enhance>
						<CsrfInput />
						<Button type="submit">
							<SendIcon aria-hidden="true" />
							Получить ссылку для привязки
						</Button>
					</form>
				{/if}
				{#if telegramActive}
					<form method="POST" action="?/telegramUnlink" use:enhance>
						<CsrfInput />
						<Button type="submit" variant="outline">Отвязать Telegram</Button>
					</form>
				{/if}
				<form method="POST" action="?/telegramRevoke" use:enhance>
					<CsrfInput />
					<Button type="submit" variant="outline">Отозвать согласие</Button>
				</form>
			</div>
			{#if link}
				<p class="grid gap-1 rounded-lg border p-3 text-sm" data-testid="telegram-link">
					<a
						href={link.url}
						class="{buttonVariants({ variant: 'link' })} h-auto justify-self-start p-0"
						target="_blank"
						rel="external noopener noreferrer"
						>Открыть бота и нажать «Старт»<span class="sr-only"> (откроется в новой вкладке)</span></a
					>
					<span class="text-xs text-muted-foreground"
						>Ссылка одноразовая, действует до {formatDateTime(link.expiresAt)}.</span
					>
				</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Отзыв согласия сразу отвязывает бота и стирает идентификатор чата; уведомления останутся в интерфейсе и на
				почте.
			</p>
		{/if}
	</SectionCard>
</div>
