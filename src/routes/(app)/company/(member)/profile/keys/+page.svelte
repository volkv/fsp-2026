<script lang="ts">
	import { enhance } from '$app/forms';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CompanyTabs from '$lib/components/employer/company-tabs.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const created = $derived(form && 'created' in form ? form.created : null);

	const PERMISSION_LABELS: Record<string, string> = {
		'catalog.search': 'Поиск по каталогу кандидатов',
		'candidate.card.read': 'Карточки кандидатов',
		'vacancy.write': 'Вакансии компании',
		'invitation.create': 'Отправка приглашений',
		'invitation.revise': 'Пересмотр и отзыв приглашений',
		'invitation.read': 'Чтение приглашений',
		'hiring.report': 'Этапы и исходы найма',
		'vacancy.external.read': 'Внешние вакансии',
		'match.read': 'Соответствие кандидатов вакансиям',
		'market.read': 'Рынок категорий',
		'partner_pool.read': 'Пул финалистов партнёрского соревнования',
		'receipt.verify': 'Проверка квитанций'
	};

	function keyState(key: (typeof data.keys)[number]): { label: string; tone: 'success' | 'neutral' | 'danger' } {
		if (key.revokedAt) return { label: `Отозван ${formatDate(key.revokedAt)}`, tone: 'danger' };
		if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return { label: 'Срок истёк', tone: 'neutral' };
		return { label: 'Действует', tone: 'success' };
	}
</script>

<PageHeader
	title="Ключи API"
	description="Ключ действует от имени создавшего его владельца и только с выбранными правами. Секрет показывается один раз."
/>

<CompanyTabs role={data.role} />

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'revoked' in form}
	<FormMessage tone="success" text="Ключ отозван: запросы с ним больше не принимаются." />
{/if}

{#if created}
	<Alert.Root class="border-success/40 bg-success-subtle" data-testid="api-key-secret">
		<KeyRoundIcon aria-hidden="true" class="text-success" />
		<Alert.Title>Ключ «{created.name}» создан — скопируйте его сейчас</Alert.Title>
		<Alert.Description class="grid gap-2">
			<p>Платформа хранит только хэш секрета: после ухода со страницы показать ключ ещё раз невозможно.</p>
			<code class="block overflow-x-auto rounded-md border bg-background p-3 font-mono text-sm break-all select-all"
				>{created.token}</code
			>
			<p class="text-xs">Заголовок запроса: <code class="font-mono">Authorization: Bearer &lt;ключ&gt;</code></p>
		</Alert.Description>
	</Alert.Root>
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Ключи компании</h2></Card.Title>
		</Card.Header>
		<Card.Content>
			{#if data.keys.length === 0}
				<p class="text-sm text-muted-foreground">Ключей пока нет.</p>
			{:else}
				<ul class="grid gap-3">
					{#each data.keys as key (key.id)}
						{@const state = keyState(key)}
						<li class="grid gap-2 rounded-lg border p-4 text-sm" data-key={key.prefix}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="font-medium">
									{key.name} <span class="font-mono text-xs text-muted-foreground">fspk_{key.prefix}_…</span>
								</p>
								<StatusPill label={state.label} tone={state.tone} />
							</div>
							<p class="text-muted-foreground">
								Создан {formatDateTime(key.createdAt)}{key.expiresAt
									? ` · действует до ${formatDate(key.expiresAt)}`
									: ''}
								· {key.lastUsedAt
									? `последнее использование ${formatDateTime(key.lastUsedAt)}`
									: 'ещё не использовался'}
							</p>
							<p class="flex flex-wrap gap-1">
								{#each key.permissions as permission (permission)}
									<span class="rounded-md bg-muted px-1.5 py-0.5 text-xs"
										>{PERMISSION_LABELS[permission] ?? permission}</span
									>
								{/each}
							</p>
							{#if !key.revokedAt}
								<form method="POST" action="?/revoke" use:enhance class="justify-self-start">
									<CsrfInput />
									<input type="hidden" name="keyId" value={key.id} />
									<Button type="submit" size="sm" variant="ghost" class="text-destructive">Отозвать</Button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Новый ключ</h2></Card.Title>
			<Card.Description>Ключи выдаются только проверенной компании.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/create" use:enhance class="grid gap-4">
				<CsrfInput />
				<Field.Field data-invalid={problem?.fields.name !== undefined}>
					<Field.Label for="key-name">Название</Field.Label>
					<Input id="key-name" name="name" maxlength={100} placeholder="Например, интеграция с ATS" required />
					{#if problem?.fields.name}<Field.Error>{problem.fields.name}</Field.Error>{/if}
				</Field.Field>
				<Field.Set>
					<Field.Legend variant="label">Права ключа</Field.Legend>
					<div class="grid gap-2">
						{#each data.grantable as permission (permission)}
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" name="permissions" value={permission} class="size-4 accent-primary" />
								{PERMISSION_LABELS[permission] ?? permission}
							</label>
						{/each}
					</div>
					{#if problem?.fields.permissions}<Field.Error>{problem.fields.permissions}</Field.Error>{/if}
				</Field.Set>
				<Field.Field data-invalid={problem?.fields.expiresAt !== undefined}>
					<Field.Label for="key-expires">Действует до (необязательно)</Field.Label>
					<Input id="key-expires" name="expiresAt" type="date" />
					{#if problem?.fields.expiresAt}<Field.Error>{problem.fields.expiresAt}</Field.Error>{/if}
				</Field.Field>
				<Button type="submit" class="justify-self-start">Создать ключ</Button>
			</form>
		</Card.Content>
	</Card.Root>
</div>
