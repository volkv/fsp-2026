<script lang="ts">
	import { enhance } from '$app/forms';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import CompanyTabs from '$lib/components/employer/company-tabs.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const secret = $derived(form && 'secret' in form ? form.secret : null);

	const EVENT_LABELS: Record<string, string> = {
		'invitation.accepted': 'Кандидат принял предложение',
		'invitation.declined': 'Кандидат отклонил предложение',
		'invitation.expired': 'Срок ответа на предложение истёк',
		'contacts.disclosed': 'Кандидат раскрыл контакты',
		'hiring.reported': 'Сообщён этап или исход найма',
		'application.received': 'Получен отклик кандидата',
		ping: 'Проверка'
	};
	const DELIVERY_STATUSES: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
		queued: { label: 'в очереди', tone: 'info' },
		delivered: { label: 'доставлено', tone: 'success' },
		failed: { label: 'не доставлено', tone: 'danger' },
		skipped: { label: 'пропущено', tone: 'neutral' }
	};
	const STAGES = [
		['accepted', 'Предложение принято (обязательно)'],
		['interview_scheduled', 'Собеседование назначено'],
		['interview_done', 'Собеседование проведено'],
		['offer_made', 'Оффер сделан'],
		['offer_accepted', 'Оффер принят'],
		['hired', 'Вышел на работу'],
		['not_hired', 'Найм не состоялся']
	] as const;
</script>

<PageHeader
	title="События для ATS"
	description="Платформа сама сообщает вашей системе найма о событиях: подписанный HMAC-SHA-256 вебхук или прямая передача в Хантфлоу. В событии только идентификаторы — данные интеграция читает по API своим ключом."
/>

<CompanyTabs role={data.role} />

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'pinged' in form}
	<FormMessage
		tone="success"
		text="Проверочное событие поставлено в очередь — результат появится в журнале доставок."
	/>
{:else if form && 'connected' in form}
	<FormMessage tone="success" text="Хантфлоу подключён." />
{:else if form && 'removed' in form}
	<FormMessage tone="success" text="Подписка удалена вместе с журналом доставок." />
{:else if form && 'tokenReplaced' in form}
	<FormMessage tone="success" text="Токен Хантфлоу заменён." />
{/if}

{#if secret}
	<Alert.Root class="border-success/40 bg-success-subtle" data-testid="webhook-secret">
		<WebhookIcon aria-hidden="true" class="text-success" />
		<Alert.Title>Секрет подписи «{secret.name}» — скопируйте его сейчас</Alert.Title>
		<Alert.Description class="grid gap-2">
			<p>
				Показывается один раз. Проверяйте заголовок <code class="font-mono">X-Signature</code>: HMAC-SHA-256 этим
				секретом от строки «X-Timestamp.тело запроса».
			</p>
			<code class="block overflow-x-auto rounded-md border bg-background p-3 font-mono text-sm break-all select-all"
				>{secret.value}</code
			>
		</Alert.Description>
	</Alert.Root>
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Подписки</h2></Card.Title>
		</Card.Header>
		<Card.Content>
			{#if data.subscriptions.length === 0}
				<p class="text-sm text-muted-foreground">Подписок пока нет.</p>
			{:else}
				<ul class="grid gap-4">
					{#each data.subscriptions as subscription (subscription.id)}
						<li class="grid gap-3 rounded-lg border p-4 text-sm" data-subscription={subscription.id}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="font-medium">
									{subscription.name}
									<span class="text-muted-foreground"
										>· {subscription.target === 'huntflow' ? 'Хантфлоу' : subscription.url}</span
									>
								</p>
								<StatusPill
									label={subscription.status === 'active' ? 'работает' : 'на паузе'}
									tone={subscription.status === 'active' ? 'success' : 'neutral'}
								/>
							</div>
							<p class="text-muted-foreground">
								Секрет {subscription.secretHint}{subscription.previousSecretUntil
									? ` · прежний подписывает до ${formatDateTime(subscription.previousSecretUntil)}`
									: ''}
							</p>
							<p class="flex flex-wrap gap-1">
								{#each subscription.events as type (type)}
									<span class="rounded-md bg-muted px-1.5 py-0.5 text-xs">{EVENT_LABELS[type] ?? type}</span>
								{/each}
							</p>
							<div class="flex flex-wrap gap-2">
								<form method="POST" action="?/ping" use:enhance>
									<CsrfInput />
									<input type="hidden" name="subscriptionId" value={subscription.id} />
									<Button type="submit" size="sm" variant="outline">Проверить доставку</Button>
								</form>
								<form method="POST" action="?/toggle" use:enhance>
									<CsrfInput />
									<input type="hidden" name="subscriptionId" value={subscription.id} />
									<input type="hidden" name="status" value={subscription.status === 'active' ? 'paused' : 'active'} />
									<Button type="submit" size="sm" variant="ghost"
										>{subscription.status === 'active' ? 'Пауза' : 'Возобновить'}</Button
									>
								</form>
								{#if subscription.target === 'webhook'}
									<form method="POST" action="?/rotate" use:enhance>
										<CsrfInput />
										<input type="hidden" name="subscriptionId" value={subscription.id} />
										<Button type="submit" size="sm" variant="ghost">Сменить секрет</Button>
									</form>
								{:else}
									<form method="POST" action="?/rotate" use:enhance class="flex gap-2">
										<CsrfInput />
										<input type="hidden" name="subscriptionId" value={subscription.id} />
										<Input name="token" type="password" placeholder="Новый токен" class="h-8 w-40" required />
										<Button type="submit" size="sm" variant="ghost">Заменить токен</Button>
									</form>
								{/if}
								<form method="POST" action="?/remove" use:enhance>
									<CsrfInput />
									<input type="hidden" name="subscriptionId" value={subscription.id} />
									<Button type="submit" size="sm" variant="ghost" class="text-destructive">Удалить</Button>
								</form>
							</div>
							{#if subscription.deliveries.length > 0}
								<details>
									<summary class="cursor-pointer font-medium">Журнал доставок</summary>
									<ul class="mt-2 grid gap-1" data-testid="deliveries">
										{#each subscription.deliveries as delivery (delivery.id)}
											{@const status = DELIVERY_STATUSES[delivery.status]}
											<li class="flex flex-wrap items-center gap-2">
												<span class="text-muted-foreground">{formatDateTime(delivery.occurredAt)}</span>
												<span>{EVENT_LABELS[delivery.eventType] ?? delivery.eventType}</span>
												{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
												<span class="text-xs text-muted-foreground"
													>попыток {delivery.attempts}{delivery.lastError ? ` · ${delivery.lastError}` : ''}</span
												>
											</li>
										{/each}
									</ul>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Новый вебхук</h2></Card.Title>
				<Card.Description>Адрес https:// вашей системы. Повторы при сбое — до 6 часов.</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/webhook" use:enhance class="grid gap-4">
					<CsrfInput />
					<Field.Field>
						<Field.Label for="webhook-name">Название</Field.Label>
						<Input id="webhook-name" name="name" maxlength={100} required placeholder="Например, наша ATS" />
					</Field.Field>
					<Field.Field data-invalid={problem?.fields.url !== undefined}>
						<Field.Label for="webhook-url">Адрес</Field.Label>
						<Input id="webhook-url" name="url" type="url" required placeholder="https://ats.example.ru/hooks/fsp" />
						{#if problem?.fields.url}<Field.Error>{problem.fields.url}</Field.Error>{/if}
					</Field.Field>
					<Field.Set>
						<Field.Legend variant="label">События</Field.Legend>
						<div class="grid gap-2">
							{#each data.eventTypes as type (type)}
								<label class="flex items-center gap-2 text-sm">
									<input type="checkbox" name="events" value={type} class="size-4 accent-primary" />
									{EVENT_LABELS[type] ?? type}
								</label>
							{/each}
						</div>
						{#if problem?.fields.events}<Field.Error>{problem.fields.events}</Field.Error>{/if}
					</Field.Set>
					<Button type="submit" class="justify-self-start">Создать вебхук</Button>
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Хантфлоу</h2></Card.Title>
				<Card.Description>
					Кандидат, принявший предложение, появится на вашей вакансии в Хантфлоу с раскрытыми вам контактами; этапы,
					которые вы отмечаете на платформе, переведут его в сопоставленные статусы.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if data.huntflowEnabled}
					<form method="POST" action="?/huntflow" use:enhance class="grid gap-3">
						<CsrfInput />
						<Field.Field>
							<Field.Label for="hf-name">Название</Field.Label>
							<Input id="hf-name" name="name" maxlength={100} required value="Хантфлоу" />
						</Field.Field>
						<Field.Field data-invalid={problem?.fields.token !== undefined}>
							<Field.Label for="hf-token">Токен API</Field.Label>
							<Input id="hf-token" name="token" type="password" required />
							{#if problem?.fields.token}<Field.Error>{problem.fields.token}</Field.Error>{/if}
						</Field.Field>
						<div class="grid grid-cols-2 gap-3">
							<Field.Field>
								<Field.Label for="hf-account">ID аккаунта</Field.Label>
								<Input id="hf-account" name="account_id" inputmode="numeric" required />
							</Field.Field>
							<Field.Field>
								<Field.Label for="hf-vacancy">ID вакансии</Field.Label>
								<Input id="hf-vacancy" name="vacancy_id" inputmode="numeric" required />
							</Field.Field>
						</div>
						<Field.Set>
							<Field.Legend variant="label">ID статусов Хантфлоу</Field.Legend>
							<div class="grid gap-2">
								{#each STAGES as [key, label] (key)}
									<label class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 text-sm">
										{label}
										<Input name={`status_${key}`} inputmode="numeric" required={key === 'accepted'} class="h-8" />
									</label>
								{/each}
							</div>
							{#if problem?.fields.settings}<Field.Error>{problem.fields.settings}</Field.Error>{/if}
						</Field.Set>
						<Button type="submit" class="justify-self-start">Подключить</Button>
					</form>
				{:else}
					<p class="text-sm text-muted-foreground">
						На этом стенде интеграция с Хантфлоу не включена. Вебхук работает с любой системой найма.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
